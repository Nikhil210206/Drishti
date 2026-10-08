import { STATIONS, CLASSES, QUOTAS, station, trainsFor, findTrain } from "./data.js";

const app = document.getElementById("app");
const GOOD = new URLSearchParams(location.search).get("a11y") === "good";
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const today = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fromIso = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const nice = (s) => fromIso(s).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

// Search form state survives navigation like a real site.
const form = JSON.parse(sessionStorage.getItem("pr_form") || "null") || {
  from: "", to: "", date: iso(addDays(today(), 1)), cls: "ALL", quota: "GN",
};
const saveForm = () => sessionStorage.setItem("pr_form", JSON.stringify(form));
let draft = JSON.parse(sessionStorage.getItem("pr_draft") || "null");
const saveDraft = () => sessionStorage.setItem("pr_draft", JSON.stringify(draft));

// Bookings and complaints go to the dev server (apps/dev-harness/src/mock-api.ts), where the eval
// checks them. The practice copy on Drishti's website has no server: there they stay in this tab,
// numbered the same way.
async function api(kind, body) {
  try {
    const res = await fetch(`api/${kind}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (res.ok) return await res.json();
  } catch {}
  const saved = JSON.parse(sessionStorage.getItem(`pr_api_${kind}`) || "[]");
  const id = kind === "bookings" ? { pnr: String(4123456700 + saved.length) } : { id: `CMP${1000 + saved.length}` };
  const rec = { ...body, ...id, createdAt: new Date().toISOString() };
  sessionStorage.setItem(`pr_api_${kind}`, JSON.stringify([...saved, rec]));
  return rec;
}

function route() {
  const [path, qs] = (location.hash.slice(1) || "/").split("?");
  const q = new URLSearchParams(qs || "");
  window.scrollTo(0, 0);
  const pages = { "/": searchPage, "/results": resultsPage, "/passengers": passengersPage, "/review": reviewPage, "/pay": payPage, "/done": donePage, "/help": helpPage, "/docs": docsPage };
  (pages[path] || searchPage)(q);
  document.title = `Pathik Rail — ${{ "/": "Book Train Tickets", "/results": "Trains", "/passengers": "Passenger Details", "/review": "Review Journey", "/pay": "Payment", "/done": "Booking Confirmed", "/help": "Help & Complaints", "/docs": "My Documents" }[path] || "Book Train Tickets"}`;
  if (GOOD) fixA11y();
}
window.addEventListener("hashchange", route);
document.addEventListener("click", (e) => {
  const go = e.target.closest("[data-go]");
  if (go) location.hash = go.dataset.go;
});

// ---------------------------------------------------------------- search
function searchPage() {
  app.innerHTML = `
  <div class="hero">
    <div class="hero-title">Book train tickets across India</div>
    <div class="hero-sub">Fast booking · Tatkal · Instant refunds</div>
    <div class="card search-card">
      <div class="row stations">
        <div class="field stn" id="from-field">
          <div class="lbl">FROM</div>
          <input class="stn-input" id="fromInput" autocomplete="off" value="${esc(form.from ? `${station(form.from).name} (${form.from})` : "")}" />
          <div class="sugg" id="fromSugg"></div>
        </div>
        <div class="swap-btn" id="swap" data-a11y-label="Swap stations"><svg viewBox="0 0 24 24"><path d="M7 7h13l-3-3M17 17H4l3 3"/></svg></div>
        <div class="field stn" id="to-field">
          <div class="lbl">TO</div>
          <input class="stn-input" id="toInput" autocomplete="off" value="${esc(form.to ? `${station(form.to).name} (${form.to})` : "")}" />
          <div class="sugg" id="toSugg"></div>
        </div>
      </div>
      <div class="row">
        <div class="field">
          <div class="lbl">DATE</div>
          <div class="date-box" id="dateBox" data-a11y-label="Journey date">${nice(form.date)}</div>
          <div class="chips">
            <div class="chip" data-day="0">Today</div>
            <div class="chip" data-day="1">Tomorrow</div>
            <div class="chip" data-day="2">Day after</div>
          </div>
        </div>
        <div class="field">
          <div class="lbl">CLASS</div>
          <div class="dd" id="clsDd" data-a11y-label="Class">
            <div class="dd-value">${form.cls === "ALL" ? "All Classes" : CLASSES.find((c) => c.code === form.cls).name}</div><span class="caret">▾</span>
          </div>
          <div class="dd-list" id="clsList">
            <div class="dd-opt" data-v="ALL">All Classes</div>
            ${CLASSES.map((c) => `<div class="dd-opt" data-v="${c.code}">${c.name}</div>`).join("")}
          </div>
        </div>
      </div>
      <div class="row quota">
        ${QUOTAS.map((qt) => `<div class="radio ${form.quota === qt.code ? "on" : ""}" data-q="${qt.code}"><span class="dot-r"></span>${qt.name}</div>`).join("")}
      </div>
      <div class="err" id="searchErr"></div>
      <div class="btn-primary" id="searchBtn">SEARCH TRAINS</div>
    </div>
    <div class="notice">Tatkal booking opens at 10:00 AM for AC classes and 11:00 AM for non-AC classes, one day before the journey.</div>
  </div>`;

  stationPicker("from");
  stationPicker("to");
  $("#swap").onclick = () => {
    [form.from, form.to] = [form.to, form.from];
    saveForm();
    searchPage();
  };
  $("#dateBox").onclick = openCalendar;
  app.querySelectorAll(".chip").forEach((c) => (c.onclick = () => {
    form.date = iso(addDays(today(), Number(c.dataset.day)));
    saveForm();
    $("#dateBox").textContent = nice(form.date);
  }));
  $("#clsDd").onclick = (e) => {
    e.stopPropagation();
    $("#clsList").classList.toggle("open");
  };
  app.querySelectorAll(".dd-opt").forEach((o) => (o.onclick = () => {
    form.cls = o.dataset.v;
    saveForm();
    $("#clsDd .dd-value").textContent = o.textContent;
    $("#clsList").classList.remove("open");
  }));
  app.querySelectorAll(".radio").forEach((r) => (r.onclick = () => {
    form.quota = r.dataset.q;
    saveForm();
    app.querySelectorAll(".radio").forEach((x) => x.classList.toggle("on", x === r));
  }));
  $("#searchBtn").onclick = () => {
    const err = $("#searchErr");
    if (!form.from || !form.to) return (err.textContent = "Please select valid From and To stations from the list.");
    if (form.from === form.to) return (err.textContent = "From and To stations cannot be the same.");
    location.hash = `#/results?from=${form.from}&to=${form.to}&date=${form.date}&cls=${form.cls}&quota=${form.quota}`;
  };
}

function stationPicker(which) {
  const input = $(`#${which}Input`);
  const box = $(`#${which}Sugg`);
  const render = () => {
    const q = input.value.trim().toLowerCase().replace(/\(.*\)/, "").trim();
    if (!q) {
      box.innerHTML = "";
      box.classList.remove("open");
      return;
    }
    const hits = STATIONS.filter((s) => s.name.toLowerCase().includes(q) || s.city.toLowerCase().includes(q) || s.code.toLowerCase() === q).slice(0, 6);
    box.innerHTML = hits.length
      ? hits.map((s) => `<div class="sugg-item" data-code="${s.code}"><span class="s-name">${s.name}</span><span class="s-code">${s.code}</span><span class="s-city">${s.city}</span></div>`).join("")
      : `<div class="sugg-empty">No stations found</div>`;
    box.classList.add("open");
    box.querySelectorAll(".sugg-item").forEach((it) => (it.onclick = () => {
      form[which] = it.dataset.code;
      saveForm();
      input.value = `${station(it.dataset.code).name} (${it.dataset.code})`;
      box.classList.remove("open");
      box.innerHTML = "";
    }));
    if (GOOD) fixA11y();
  };
  input.addEventListener("input", () => {
    form[which] = "";
    render();
  });
  input.addEventListener("keyup", render);
}

function openCalendar() {
  let month = fromIso(form.date);
  month = new Date(month.getFullYear(), month.getMonth(), 1);
  const overlay = document.createElement("div");
  overlay.className = "cal-overlay";
  const draw = () => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    const lead = (first.getDay() + 6) % 7;
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(`<div class="cal-day empty"></div>`);
    for (let d = 1; d <= days; d++) {
      const date = new Date(month.getFullYear(), month.getMonth(), d);
      const past = date < today();
      const tooFar = date > addDays(today(), 120);
      cells.push(`<div class="cal-day ${past || tooFar ? "off" : ""} ${iso(date) === form.date ? "sel" : ""}" data-date="${iso(date)}">${d}</div>`);
    }
    overlay.innerHTML = `
      <div class="cal">
        <div class="cal-head">
          <div class="cal-nav cal-prev"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></div>
          <div class="cal-title">${month.toLocaleDateString("en-IN", { month: "long", year: "numeric" })}</div>
          <div class="cal-nav cal-next"><svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg></div>
          <div class="cal-close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></div>
        </div>
        <div class="cal-grid">${["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((w) => `<div class="cal-w">${w}</div>`).join("")}${cells.join("")}</div>
      </div>`;
    overlay.querySelector(".cal-prev").onclick = () => ((month = new Date(month.getFullYear(), month.getMonth() - 1, 1)), draw());
    overlay.querySelector(".cal-next").onclick = () => ((month = new Date(month.getFullYear(), month.getMonth() + 1, 1)), draw());
    overlay.querySelector(".cal-close").onclick = () => overlay.remove();
    overlay.querySelectorAll(".cal-day[data-date]:not(.off)").forEach((c) => (c.onclick = () => {
      form.date = c.dataset.date;
      saveForm();
      overlay.remove();
      const box = $("#dateBox");
      if (box) box.textContent = nice(form.date);
    }));
    if (GOOD) fixA11y();
  };
  draw();
  document.body.appendChild(overlay);
}

// ---------------------------------------------------------------- results
function resultsPage(q) {
  const from = q.get("from"), to = q.get("to"), date = q.get("date"), cls = q.get("cls") || "ALL", quota = q.get("quota") || "GN";
  let trains = trainsFor(from, to, date);
  if (cls !== "ALL") trains = trains.filter((t) => t.classes.some((c) => c.code === cls));
  const a = station(from), b = station(to);
  app.innerHTML = `
  <div class="page">
    <div class="res-head">
      <div><b>${a?.name} (${from})</b> <span class="arrow">→</span> <b>${b?.name} (${to})</b></div>
      <div class="muted">${nice(date)} · ${QUOTAS.find((x) => x.code === quota).name} quota · ${trains.length} trains found</div>
      <div class="link-btn" data-go="#/">Modify search</div>
    </div>
    <div class="legend">
      <span><i class="dot green"></i>Available</span><span><i class="dot orange"></i>RAC</span><span><i class="dot red"></i>Waiting list</span>
      <span class="muted">Number next to the dot = seats / queue position</span>
    </div>
    <div class="train-list">
      ${trains.map((t) => `
      <div class="train-card">
        <div class="t-top"><span class="t-name">${t.name}</span><span class="t-no">(${t.no})</span></div>
        <div class="t-times">
          <div><span class="t-time">${t.dep}</span><span class="t-stn">${from}</span></div>
          <div class="t-dur">${t.duration}</div>
          <div><span class="t-time">${t.arr}${t.nextDay ? '<sup>+1</sup>' : ""}</span><span class="t-stn">${to}</span></div>
        </div>
        <div class="t-classes">
          ${t.classes.filter((c) => cls === "ALL" || c.code === cls).map((c) => `
          <div class="cls-box">
            <div class="cls-code">${c.code}</div>
            <div class="cls-fare">₹${c.fare}</div>
            <div class="cls-av"><i class="dot ${c.status === "AVL" ? "green" : c.status === "RAC" ? "orange" : "red"}"></i>${c.n}</div>
            <div class="bk-btn" data-train="${t.no}" data-cls="${c.code}" data-a11y-label="Book ${c.code} on ${t.name}"><svg class="i-ticket" viewBox="0 0 24 24"><path d="M3 7h18v3a2 2 0 000 4v3H3v-3a2 2 0 000-4z"/></svg></div>
          </div>`).join("")}
        </div>
      </div>`).join("")}
    </div>
  </div>`;
  app.querySelectorAll(".bk-btn").forEach((b) => (b.onclick = () => {
    draft = { from, to, date, quota, trainNo: b.dataset.train, cls: b.dataset.cls, passengers: [{ name: "", age: "", gender: "", berth: "No preference" }], mobile: "" };
    saveDraft();
    location.hash = "#/passengers";
  }));
}

// ---------------------------------------------------------------- passengers
function passengersPage() {
  if (!draft) return (location.hash = "#/");
  const t = findTrain(draft.from, draft.to, draft.date, draft.trainNo);
  const c = t.classes.find((x) => x.code === draft.cls);
  app.innerHTML = `
  <div class="page narrow">
    ${journeyStrip(t, c)}
    <div class="card">
      <div class="sec-title">Passenger Details</div>
      <div id="paxList">
        ${draft.passengers.map((p, i) => `
        <div class="pax">
          <div class="pax-no">Passenger ${i + 1}</div>
          <div class="pax-grid">
            <div><div class="lbl">Name</div><input class="txt pax-name" data-i="${i}" value="${esc(p.name)}" /></div>
            <div><div class="lbl">Age</div><input class="txt pax-age" data-i="${i}" value="${esc(p.age)}" inputmode="numeric" /></div>
            <div><div class="lbl">Gender</div>
              <div class="seg">${["Male", "Female", "Transgender"].map((g) => `<div class="seg-opt ${p.gender === g ? "on" : ""}" data-i="${i}" data-g="${g}">${g}</div>`).join("")}</div>
            </div>
            <div><div class="lbl">Berth preference</div>
              <select class="txt pax-berth" data-i="${i}">${["No preference", "Lower", "Middle", "Upper", "Side Lower", "Side Upper"].map((b) => `<option ${p.berth === b ? "selected" : ""}>${b}</option>`).join("")}</select>
            </div>
          </div>
          ${i > 0 ? `<div class="rm-pax" data-i="${i}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></div>` : ""}
        </div>`).join("")}
      </div>
      <div class="add-pax" id="addPax"><span class="plus">+</span> Add passenger</div>
      <div class="lbl" style="margin-top:18px">Mobile number (for ticket SMS)</div>
      <input class="txt" id="mobile" value="${esc(draft.mobile)}" inputmode="numeric" />
      <div class="err" id="paxErr"></div>
      <div class="btn-primary" id="paxContinue">CONTINUE</div>
    </div>
  </div>`;
  const sync = () => saveDraft();
  app.querySelectorAll(".pax-name").forEach((el) => (el.oninput = () => ((draft.passengers[el.dataset.i].name = el.value), sync())));
  app.querySelectorAll(".pax-age").forEach((el) => (el.oninput = () => ((draft.passengers[el.dataset.i].age = el.value), sync())));
  app.querySelectorAll(".pax-berth").forEach((el) => (el.onchange = () => ((draft.passengers[el.dataset.i].berth = el.value), sync())));
  app.querySelectorAll(".seg-opt").forEach((el) => (el.onclick = () => {
    draft.passengers[el.dataset.i].gender = el.dataset.g;
    sync();
    el.parentElement.querySelectorAll(".seg-opt").forEach((x) => x.classList.toggle("on", x === el));
  }));
  app.querySelectorAll(".rm-pax").forEach((el) => (el.onclick = () => {
    draft.passengers.splice(Number(el.dataset.i), 1);
    sync();
    passengersPage();
  }));
  $("#addPax").onclick = () => {
    if (draft.passengers.length >= 6) return;
    draft.passengers.push({ name: "", age: "", gender: "", berth: "No preference" });
    sync();
    passengersPage();
  };
  $("#mobile").oninput = (e) => ((draft.mobile = e.target.value), sync());
  $("#paxContinue").onclick = () => {
    const err = $("#paxErr");
    for (const [i, p] of draft.passengers.entries()) {
      if (!p.name.trim()) return (err.textContent = `Enter the name of passenger ${i + 1}.`);
      const age = Number(p.age);
      if (!age || age < 1 || age > 120) return (err.textContent = `Enter a valid age for passenger ${i + 1}.`);
      if (!p.gender) return (err.textContent = `Select the gender of passenger ${i + 1}.`);
    }
    if (!/^[6-9]\d{9}$/.test(draft.mobile.replace(/\D/g, ""))) return (err.textContent = "Enter a valid 10-digit mobile number.");
    location.hash = "#/review";
  };
}

function journeyStrip(t, c) {
  return `<div class="strip"><b>${t.name} (${t.no})</b> · ${draft.from} ${t.dep} → ${draft.to} ${t.arr} · ${nice(draft.date)} · ${c.code} · ${QUOTAS.find((q) => q.code === draft.quota).name}</div>`;
}

const FEE = 20;
const totalFor = (c) => c.fare * draft.passengers.length + FEE;

// ---------------------------------------------------------------- review
function reviewPage() {
  if (!draft) return (location.hash = "#/");
  const t = findTrain(draft.from, draft.to, draft.date, draft.trainNo);
  const c = t.classes.find((x) => x.code === draft.cls);
  app.innerHTML = `
  <div class="page narrow">
    ${journeyStrip(t, c)}
    <div class="card">
      <div class="sec-title">Review your journey</div>
      <table class="rev">
        <tr><td>Train</td><td>${t.name} (${t.no})</td></tr>
        <tr><td>From</td><td>${station(draft.from).name} (${draft.from}) at ${t.dep}</td></tr>
        <tr><td>To</td><td>${station(draft.to).name} (${draft.to}) at ${t.arr}${t.nextDay ? " (next day)" : ""}</td></tr>
        <tr><td>Date</td><td>${nice(draft.date)}</td></tr>
        <tr><td>Class</td><td>${CLASSES.find((x) => x.code === c.code).name}</td></tr>
        <tr><td>Passengers</td><td>${draft.passengers.map((p) => `${esc(p.name)} (${p.age}, ${p.gender})`).join(", ")}</td></tr>
      </table>
      <div class="fare">
        <div><span>Ticket fare × ${draft.passengers.length}</span><span>₹${c.fare * draft.passengers.length}</span></div>
        <div><span>Convenience fee</span><span>₹${FEE}</span></div>
        <div class="total"><span>Total</span><span>₹${totalFor(c)}</span></div>
      </div>
      <div class="btn-primary" id="toPay">PROCEED TO PAY</div>
      <div class="link-btn" data-go="#/passengers">Edit passengers</div>
    </div>
  </div>`;
  $("#toPay").onclick = () => (location.hash = "#/pay");
}

// ---------------------------------------------------------------- pay
function payPage() {
  if (!draft) return (location.hash = "#/");
  const t = findTrain(draft.from, draft.to, draft.date, draft.trainNo);
  const c = t.classes.find((x) => x.code === draft.cls);
  const total = totalFor(c);
  app.innerHTML = `
  <div class="page narrow">
    ${journeyStrip(t, c)}
    <div class="card">
      <div class="sec-title">Payment</div>
      <div class="demo-note">Demo payment — no real money moves and no card or UPI PIN is ever asked for.</div>
      <div class="pay-opts">
        <div class="radio on"><span class="dot-r"></span>UPI (demo@pathikupi)</div>
        <div class="radio"><span class="dot-r"></span>Wallet</div>
      </div>
      <div class="fare"><div class="total"><span>Amount payable</span><span>₹${total}</span></div></div>
      <div class="btn-primary pay" id="payBtn">PAY ₹${total}</div>
      <div class="link-btn" data-go="#/review">Back</div>
    </div>
  </div>`;
  app.querySelectorAll(".pay-opts .radio").forEach((r) => (r.onclick = () => app.querySelectorAll(".pay-opts .radio").forEach((x) => x.classList.toggle("on", x === r))));
  $("#payBtn").onclick = async () => {
    $("#payBtn").textContent = "Processing…";
    const b = await api("bookings", { train: t.name, trainNo: t.no, from: draft.from, to: draft.to, date: draft.date, cls: c.code, quota: draft.quota, passengers: draft.passengers, total });
    sessionStorage.setItem("pr_last", JSON.stringify(b));
    draft = null;
    sessionStorage.removeItem("pr_draft");
    location.hash = `#/done?pnr=${b.pnr}`;
  };
}

function donePage(q) {
  const b = JSON.parse(sessionStorage.getItem("pr_last") || "null");
  if (!b) return (location.hash = "#/");
  const coach = b.cls === "SL" ? "S4" : b.cls === "3A" ? "B2" : b.cls === "2A" ? "A1" : b.cls === "1A" ? "H1" : b.cls === "CC" ? "C3" : "D5";
  app.innerHTML = `
  <div class="page narrow">
    <div class="card success">
      <div class="ok-mark">✓</div>
      <div class="sec-title">Booking confirmed</div>
      <div class="pnr">PNR ${q.get("pnr")}</div>
      <div>${b.train} (${b.trainNo}) · ${b.from} → ${b.to} · ${nice(b.date)} · ${b.cls}</div>
      <ul class="seats">${b.passengers.map((p, i) => `<li>${esc(p.name)} — ${coach}, seat ${12 + i * 3}</li>`).join("")}</ul>
      <div>Amount paid: ₹${b.total}</div>
      <div class="btn-secondary" data-go="#/">Book another ticket</div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- help / complaint (Kivi compose demo)
function helpPage() {
  app.innerHTML = `
  <div class="page narrow">
    <div class="card">
      <div class="sec-title">Help &amp; Complaints</div>
      <div class="lbl">Category</div>
      <div class="dd" id="catDd"><div class="dd-value">Select category</div><span class="caret">▾</span></div>
      <div class="dd-list" id="catList">${["Refund", "Cleanliness", "Staff behaviour", "Food quality", "Accessibility", "Other"].map((c) => `<div class="dd-opt">${c}</div>`).join("")}</div>
      <div class="lbl" style="margin-top:14px">PNR (optional)</div>
      <input class="txt" id="cPnr" />
      <div class="lbl" style="margin-top:14px">Describe your issue</div>
      <textarea class="txt area" id="cText" rows="6"></textarea>
      <div class="err" id="cErr"></div>
      <div class="btn-primary" id="cSubmit">SUBMIT COMPLAINT</div>
      <div id="cDone"></div>
    </div>
  </div>`;
  let cat = "";
  $("#catDd").onclick = (e) => (e.stopPropagation(), $("#catList").classList.toggle("open"));
  app.querySelectorAll("#catList .dd-opt").forEach((o) => (o.onclick = () => {
    cat = o.textContent;
    $("#catDd .dd-value").textContent = cat;
    $("#catList").classList.remove("open");
  }));
  $("#cSubmit").onclick = async () => {
    const text = $("#cText").value.trim();
    if (!cat) return ($("#cErr").textContent = "Please select a category.");
    if (text.length < 10) return ($("#cErr").textContent = "Please describe your issue (at least 10 characters).");
    const r = await api("complaints", { category: cat, text, pnr: $("#cPnr").value });
    $("#cErr").textContent = "";
    $("#cDone").innerHTML = `<div class="success-msg">Complaint registered. Reference number ${r.id}. We will respond within 48 hours.</div>`;
  };
}

// ---------------------------------------------------------------- documents (Sarvam Vision demo)
function docsPage() {
  const docs = [
    ["sunlit-bill-bn.pdf", "বিদ্যুৎ বিল — সেপ্টেম্বর ২০২৬ (Sunlit Power, বাংলা)"],
    ["sunlit-bill-ta.pdf", "மின் கட்டண ரசீது — செப்டம்பர் 2026 (Sunlit Power, தமிழ்)"],
    ["sunlit-bill-hi.pdf", "बिजली बिल — सितंबर 2026 (Sunlit Power, हिन्दी)"],
    ["pathik-refund-letter.png", "Refund letter — scanned (Pathik Rail)"],
  ];
  app.innerHTML = `
  <div class="page narrow">
    <div class="card">
      <div class="sec-title">My Documents</div>
      <div class="muted">Bills and letters shared with your Pathik account.</div>
      <div class="doc-list">
        ${docs.map(([f, label]) => `<a class="doc" href="docs/${f}" target="_blank"><span class="doc-ic"></span>${label}</a>`).join("")}
      </div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- a11y fix-up (comparison mode)
function fixA11y() {
  const clickable = "[data-go],.swap-btn,.chip,.dd,.dd-opt,.radio,.btn-primary,.btn-secondary,.link-btn,.sugg-item,.cal-day[data-date],.cal-nav,.cal-close,.bk-btn,.seg-opt,.add-pax,.rm-pax";
  document.querySelectorAll(clickable).forEach((el) => {
    if (el.dataset.fixed) return;
    el.dataset.fixed = "1";
    el.setAttribute("role", el.classList.contains("radio") || el.classList.contains("seg-opt") ? "radio" : el.classList.contains("dd-opt") || el.classList.contains("sugg-item") ? "option" : "button");
    el.tabIndex = 0;
    if (el.dataset.a11yLabel) el.setAttribute("aria-label", el.dataset.a11yLabel);
    if (el.classList.contains("cal-prev")) el.setAttribute("aria-label", "Previous month");
    if (el.classList.contains("cal-next")) el.setAttribute("aria-label", "Next month");
    if (el.classList.contains("cal-close")) el.setAttribute("aria-label", "Close calendar");
    if (el.classList.contains("rm-pax")) el.setAttribute("aria-label", "Remove passenger");
    el.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), el.click()));
  });
  document.querySelectorAll(".dot").forEach((d) => {
    const s = d.classList.contains("green") ? "Available" : d.classList.contains("orange") ? "RAC" : "Waiting list";
    d.setAttribute("role", "img");
    d.setAttribute("aria-label", s);
  });
  document.querySelectorAll("input,select,textarea").forEach((el) => {
    const lbl = el.previousElementSibling?.classList.contains("lbl") ? el.previousElementSibling : el.parentElement?.querySelector(".lbl");
    if (lbl && !el.getAttribute("aria-label")) el.setAttribute("aria-label", lbl.textContent.trim());
  });
}

document.addEventListener("click", () => document.querySelectorAll(".dd-list.open").forEach((l) => l.classList.remove("open")));
route();

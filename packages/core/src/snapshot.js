// Injected into the page (Playwright page.evaluate, or chrome.scripting.executeScript in the
// extension). Builds Drishti's "page model": a compact, numbered outline of what a blind user
// needs — headings, text, and every control, including the div-buttons and unlabelled icons
// that screen readers skip. Returns plain data.
//
// Keep it self-contained: no imports and no references to anything outside the function,
// because it is serialised and run inside the page.
export function snapshotPage(opts) {
  const MAX_CHARS = opts?.maxChars ?? 11000;
  const MAX_ELEMENTS = opts?.maxElements ?? 220;
  const W = window;
  if (!W.__drishtiNextId) W.__drishtiNextId = 1;

  const INTERACTIVE_ROLES = new Set([
    "button",
    "link",
    "checkbox",
    "radio",
    "combobox",
    "option",
    "tab",
    "menuitem",
    "switch",
    "slider",
    "textbox",
    "searchbox",
    "listbox",
    "spinbutton",
    "menuitemcheckbox",
    "menuitemradio",
    "treeitem",
  ]);
  const ICON_WORDS = [
    [/search|magnif|find/, "search"],
    [/cart|basket|bag/, "cart"],
    [/close|times|cross|dismiss|x-mark/, "close"],
    [/hamburger|burger|menu/, "menu"],
    [/swap|exchange|interchange|switch-stn|arrows/, "swap"],
    [/calendar|date/, "calendar"],
    [/user|profile|account|avatar/, "account"],
    [/home|house/, "home"],
    [/back|arrow-left|chevron-left|prev/, "back"],
    [/next|arrow-right|chevron-right|forward/, "next"],
    [/edit|pencil/, "edit"],
    [/trash|delete|bin/, "delete"],
    [/plus|add/, "add"],
    [/minus|remove/, "remove"],
    [/mic/, "microphone"],
    [/help|question|support/, "help"],
    [/info/, "information"],
    [/filter/, "filter"],
    [/sort/, "sort"],
    [/share/, "share"],
    [/download/, "download"],
    [/heart|fav|wishlist/, "favourite"],
    [/bell|notif/, "notifications"],
    [/setting|gear|cog/, "settings"],
    [/ticket|book/, "book ticket"],
    [/pdf|doc|file/, "document"],
    [/phone|call/, "call"],
    [/mail|envelope/, "email"],
    [/logout|sign-?out/, "log out"],
  ];
  const COMPOSITE_ROLES = new Set(["listbox", "menu", "menubar", "tablist", "tree", "radiogroup", "grid", "toolbar"]);
  // Real controls. A container holding one is not itself a control, and is walked into.
  const CONTROLS = ["input:not([type=hidden])", "select", "textarea", "button", "a[href]", "[contenteditable]:not([contenteditable=false])"]
    .concat(Array.from(INTERACTIVE_ROLES, (r) => `[role="${r}"]`))
    .join(",");
  // Form fields. A pointer-cursor wrapper around one (IRCTC's station box) is not a control itself.
  const FIELDS =
    'input:not([type=hidden]),select,textarea,[role="textbox"],[role="searchbox"],[role="combobox"],[role="listbox"],[role="option"]';
  const JUNK = new Set([
    "btn",
    "button",
    "icon",
    "ic",
    "fa",
    "fas",
    "far",
    "svg",
    "material",
    "icons",
    "glyph",
    "wrapper",
    "wrap",
    "container",
    "inner",
    "lg",
    "sm",
    "md",
    "xs",
    "primary",
    "secondary",
    "active",
    "item",
    "el",
    "i",
    "css",
    "js",
  ]);

  // Nodes inside iframes belong to another realm (so instanceof checks fail there), and
  // their styles must come from that frame's window.
  const isEl = (n) => !!n && n.nodeType === 1;
  const styleOf = (el) => (el.ownerDocument.defaultView || W).getComputedStyle(el);
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const clip = (s, n = 90) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

  function visible(el) {
    if (!isEl(el)) return false;
    const s = styleOf(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (el.closest('[aria-hidden="true"]')) return false;
    return true;
  }

  /**
   * Inline or display:contents wrappers (Angular component hosts, custom elements) can measure
   * 0×0 while their block children are on screen, so walk through them instead of pruning.
   */
  function passThrough(el) {
    const s = styleOf(el);
    if (s.display !== "inline" && s.display !== "contents") return false;
    if (Number(s.opacity) === 0 || el.closest('[aria-hidden="true"]')) return false;
    return el.children.length > 0 || !!el.shadowRoot;
  }

  /** Off-canvas panels (slid out with left: 100vw, etc.) are not open dialogs. */
  function onScreen(el) {
    const r = el.getBoundingClientRect();
    return r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
  }

  function isInteractive(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "a" && el.hasAttribute("href")) return true;
    if (["button", "select", "textarea", "summary"].includes(tag)) return true;
    if (tag === "input") return el.type !== "hidden";
    if (el.isContentEditable && el.getAttribute("contenteditable") !== "false") return true;
    const role = el.getAttribute("role");
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if (el.hasAttribute("onclick")) return true;
    const ti = el.getAttribute("tabindex");
    if (ti !== null && Number(ti) >= 0) return true;
    // Clickable divs: pointer cursor that starts here (not inherited from a clickable parent),
    // unless it wraps form fields (IRCTC wraps its station input and suggestions in one).
    const cur = styleOf(el).cursor;
    if (cur === "pointer" && !el.querySelector(FIELDS)) {
      const p = el.parentElement;
      if (!p || styleOf(p).cursor !== "pointer") {
        const r = el.getBoundingClientRect();
        if (r.width * r.height < 250000) return true;
      }
    }
    return false;
  }

  function roleOf(el) {
    const role = el.getAttribute("role");
    if (role) return role;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "select";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const t = (el.type || "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(t)) return "button";
      if (t === "checkbox" || t === "radio") return t;
      if (t === "range") return "slider";
      if (t === "number") return "spinbutton";
      if (t === "search") return "searchbox";
      if (t === "date") return "date";
      return "textbox";
    }
    if (el.isContentEditable) return "textbox";
    return "clickable";
  }

  function textOf(el) {
    return clean(el.innerText || el.textContent || "");
  }

  function iconName(el) {
    const bits = [];
    const collect = (n) => {
      if (!n || !n.getAttribute) return;
      bits.push(
        n.getAttribute("class") || "",
        n.id || "",
        n.getAttribute("name") || "",
        n.getAttribute("data-icon") || "",
        n.getAttribute("data-testid") || "",
      );
      if (n.tagName === "IMG") bits.push((n.getAttribute("src") || "").split("/").pop());
      if (n.tagName && n.tagName.toLowerCase() === "use") bits.push(n.getAttribute("href") || n.getAttribute("xlink:href") || "");
    };
    collect(el);
    el.querySelectorAll("*").forEach((c, i) => i < 8 && collect(c));
    const svgTitle = el.querySelector("svg title");
    if (svgTitle && clean(svgTitle.textContent)) return clean(svgTitle.textContent);
    const hay = bits.join(" ").toLowerCase();
    for (const [re, word] of ICON_WORDS) if (re.test(hay)) return word;
    const tokens = hay.split(/[^a-z]+/).filter((t) => t.length > 2 && !JUNK.has(t));
    return tokens.length ? tokens.slice(0, 3).join(" ") : "";
  }

  /** Visual label next to an unlabelled field (e.g. <div class="lbl">Age</div><input>). */
  function nearbyLabel(el) {
    let n = el;
    for (let depth = 0; depth < 3 && n; depth++) {
      let sib = n.previousElementSibling;
      for (let k = 0; k < 2 && sib; k++) {
        const t = textOf(sib);
        if (t && t.length <= 40 && !sib.querySelector("input,select,textarea")) return t;
        sib = sib.previousElementSibling;
      }
      n = n.parentElement;
    }
    return "";
  }

  function accessibleName(el) {
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = clean(
        by
          .split(/\s+/)
          .map((id) => el.ownerDocument.getElementById(id)?.textContent || "")
          .join(" "),
      );
      if (t) return { name: clip(t, 120), inferred: false };
    }
    // Some sites put whole error messages or HTML in aria-label; keep names short.
    const aria = clean(el.getAttribute("aria-label"));
    if (aria) return { name: clip(aria, 120), inferred: false };
    const tag = el.tagName.toLowerCase();
    if (["input", "select", "textarea"].includes(tag)) {
      if (el.id) {
        const lab = el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lab && clean(lab.textContent)) return { name: clean(lab.textContent), inferred: false };
      }
      const wrap = el.closest("label");
      if (wrap) {
        const t =
          clean(
            Array.from(wrap.childNodes)
              .filter((c) => c !== el && c.nodeType === 3)
              .map((c) => c.textContent)
              .join(" "),
          ) || textOf(wrap);
        if (t) return { name: t, inferred: false };
      }
      const ph = clean(el.getAttribute("placeholder"));
      if (ph) return { name: ph, inferred: false };
      const title = clean(el.getAttribute("title"));
      if (title) return { name: title, inferred: false };
      const near = nearbyLabel(el);
      if (near) return { name: near, inferred: true };
      const icon = iconName(el);
      return { name: icon, inferred: !!icon };
    }
    if (tag === "img") {
      const alt = clean(el.getAttribute("alt"));
      if (alt) return { name: alt, inferred: false };
    }
    const title = clean(el.getAttribute("title"));
    // A listbox or menu is not named by its options' text; the options are listed themselves.
    if (COMPOSITE_ROLES.has(el.getAttribute("role"))) return { name: title, inferred: false };
    const txt = textOf(el);
    if (txt) return { name: clip(txt), inferred: false };
    const imgAlt = clean(el.querySelector("img[alt]")?.getAttribute("alt"));
    if (imgAlt) return { name: imgAlt, inferred: false };
    if (title) return { name: title, inferred: false };
    const icon = iconName(el);
    return { name: icon, inferred: !!icon };
  }

  function colourName(rgb) {
    const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
    if (!m || (m[4] !== undefined && Number(m[4]) < 0.3)) return "";
    const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const palette = [
      ["red", 220, 40, 40],
      ["green", 30, 160, 70],
      ["orange", 240, 150, 30],
      ["yellow", 235, 200, 40],
      ["blue", 40, 100, 220],
      ["grey", 150, 150, 150],
      ["purple", 140, 60, 180],
    ];
    let best = "",
      bd = Infinity;
    for (const [n, pr, pg, pb] of palette) {
      const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
      if (d < bd) ((bd = d), (best = n));
    }
    return bd < 9000 ? best : "";
  }

  /** Small empty coloured shapes carry meaning only by colour (status dots) — name them. */
  function colourMark(el) {
    if (textOf(el) || el.children.length) return "";
    const r = el.getBoundingClientRect();
    if (r.width > 24 || r.height > 24) return "";
    const c = colourName(styleOf(el).backgroundColor);
    return c ? `(colour: ${c})` : "";
  }

  function stateOf(el) {
    const s = [];
    const tag = el.tagName.toLowerCase();
    if (tag === "select") {
      const sel = el.options[el.selectedIndex];
      if (sel) s.push(`selected="${clip(clean(sel.text), 40)}"`);
      const opts = Array.from(el.options)
        .slice(0, 12)
        .map((o) => clean(o.text))
        .filter(Boolean);
      s.push(`options=[${opts.join(" | ")}${el.options.length > 12 ? " | …" : ""}]`);
    } else if (tag === "input" || tag === "textarea") {
      if (el.type === "checkbox" || el.type === "radio") s.push(el.checked ? "checked" : "unchecked");
      else s.push(`value="${clip(el.value || "", 60)}"`);
      if (el.type === "password") s.push("password-field");
    } else if (el.isContentEditable) {
      s.push(`value="${clip(textOf(el), 60)}"`);
    }
    const aria = (a) => el.getAttribute(a);
    if (aria("aria-checked")) s.push(aria("aria-checked") === "true" ? "checked" : "unchecked");
    if (aria("aria-selected") === "true") s.push("selected");
    if (aria("aria-expanded")) s.push(aria("aria-expanded") === "true" ? "expanded" : "collapsed");
    if (el.disabled || aria("aria-disabled") === "true") s.push("disabled");
    if (aria("aria-invalid") === "true") s.push("invalid");
    if (el.required || aria("aria-required") === "true") s.push("required");
    // Visual-only selection states that custom widgets use (class "on", "active", "selected").
    const cls = (el.getAttribute("class") || "").toLowerCase();
    if (/\b(on|active|selected|checked|is-selected|is-active)\b/.test(cls) && !s.includes("selected")) s.push("looks-selected");
    if (el.ownerDocument.activeElement === el) s.push("focused");
    return s.join(" ");
  }

  function idFor(el) {
    let id = el.getAttribute("data-drishti-id");
    if (!id) {
      id = String(W.__drishtiNextId++);
      el.setAttribute("data-drishti-id", id);
    }
    return id;
  }

  // ---------- walk ----------
  const dialogs = Array.from(
    document.querySelectorAll('dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"],.modal.show,.modal.open'),
  ).filter((el) => visible(el) && onScreen(el));
  // Unmarked overlays: a fixed layer covering most of the viewport is a modal in practice.
  for (const el of document.body.children) {
    if (!visible(el) || !onScreen(el) || dialogs.includes(el)) continue;
    const s = styleOf(el);
    const r = el.getBoundingClientRect();
    if (s.position === "fixed" && r.width * r.height > innerWidth * innerHeight * 0.5 && textOf(el)) dialogs.push(el);
  }
  const root = dialogs.length ? dialogs[dialogs.length - 1] : document.body;
  const lines = [];
  const elements = {};
  const pdfLinks = [];
  let count = 0;

  function describeControl(el, prefix = "") {
    const id = idFor(el);
    const { name, inferred } = accessibleName(el);
    const role = roleOf(el);
    const state = stateOf(el);
    const href = el.tagName === "A" ? el.getAttribute("href") || "" : "";
    elements[id] = {
      role,
      name,
      inferred,
      tag: el.tagName.toLowerCase(),
      type: (el.getAttribute("type") || "").toLowerCase(),
      href,
      inForm: !!el.closest("form"),
      autocomplete: (el.getAttribute("autocomplete") || "").toLowerCase(),
      fieldHint: clean([el.getAttribute("name"), el.id, el.getAttribute("placeholder")].join(" ")),
    };
    if (href && /\.pdf(\?|#|$)/i.test(href)) {
      // A malformed href or an about:blank base must not break the whole snapshot.
      try {
        pdfLinks.push({ id, href: new URL(href, document.baseURI).href, name });
      } catch {}
    }
    count++;
    return `${prefix}[${id}] ${role} "${name || "unlabelled"}"${inferred ? " (inferred)" : ""}${state ? " " + state : ""}`;
  }

  function isRepeatedRow(el) {
    const p = el.parentElement;
    if (!p || !el.className || typeof el.className !== "string") return false;
    const same = Array.from(p.children).filter((c) => c.tagName === el.tagName && c.className === el.className);
    if (same.length < 3) return false;
    return textOf(el).length > 12 && !!el.querySelector("*");
  }

  function flattenRow(el) {
    const parts = [];
    const walkRow = (n) => {
      if (n.nodeType === 3) {
        const t = clean(n.textContent);
        if (t) parts.push(t);
        return;
      }
      if (!isEl(n)) return;
      if (!visible(n)) {
        if (passThrough(n)) n.childNodes.forEach(walkRow);
        return;
      }
      if (n !== el && isInteractive(n)) {
        parts.push(describeControl(n));
        // Same rule as walk(): composite widgets keep their options.
        if (!["select", "input", "textarea", "button", "a"].includes(n.tagName.toLowerCase()) && n.querySelector(CONTROLS)) {
          n.childNodes.forEach(walkRow);
        }
        return;
      }
      const mark = colourMark(n);
      if (mark) parts.push(mark);
      n.childNodes.forEach(walkRow);
    };
    el.childNodes.forEach(walkRow);
    return parts.join(" · ");
  }

  function walk(node, depth) {
    if (count >= MAX_ELEMENTS) return;
    if (node.nodeType === 3) {
      const t = clean(node.textContent);
      if (t.length >= 2) lines.push({ kind: "text", text: clip(t, 220) });
      return;
    }
    if (!isEl(node)) return;
    const tag = node.tagName.toLowerCase();
    if (["script", "style", "noscript", "template", "head", "meta", "link"].includes(tag)) return;
    if (!visible(node)) {
      if (passThrough(node)) (node.shadowRoot || node).childNodes.forEach((c) => walk(c, depth + 1));
      return;
    }
    if (/^h[1-6]$/.test(tag) || node.getAttribute("role") === "heading") {
      lines.push({ kind: "heading", text: `${"#".repeat(Math.min(Number(tag[1]) || 2, 3))} ${clip(textOf(node), 120)}` });
      return;
    }
    if (!isInteractive(node) && isRepeatedRow(node)) {
      lines.push({ kind: "row", text: `ROW: ${clip(flattenRow(node), 600)}` });
      return;
    }
    if (isInteractive(node)) {
      lines.push({ kind: "control", text: describeControl(node) });
      // Selects and inputs have no meaningful children; clickable containers might.
      if (["select", "input", "textarea", "button", "a"].includes(tag)) return;
      // Composite widgets (listbox, menu, tablist) hold their options as [role] children.
      if (node.querySelector(`${CONTROLS},[tabindex],[onclick]`)) node.childNodes.forEach((c) => walk(c, depth + 1));
      return;
    }
    const mark = colourMark(node);
    if (mark) lines.push({ kind: "text", text: mark });
    if (node.shadowRoot) node.shadowRoot.childNodes.forEach((c) => walk(c, depth + 1));
    if (tag === "iframe") {
      try {
        const doc = node.contentDocument;
        if (doc?.body) doc.body.childNodes.forEach((c) => walk(c, depth + 1));
      } catch {}
      return;
    }
    node.childNodes.forEach((c) => walk(c, depth + 1));
  }
  walk(root, 0);

  // Merge consecutive short text fragments into readable lines.
  const merged = [];
  for (const l of lines) {
    const prev = merged[merged.length - 1];
    if (l.kind === "text" && prev?.kind === "text" && prev.text.length + l.text.length < 200) prev.text += " " + l.text;
    else merged.push({ ...l });
  }

  // Budget: drop plain text before controls if the page is huge.
  let out = merged.map((l) => (l.kind === "text" ? `- ${l.text}` : l.text));
  let total = out.join("\n").length;
  if (total > MAX_CHARS) {
    out = merged.filter((l) => l.kind !== "text" || l.text.length < 80).map((l) => (l.kind === "text" ? `- ${l.text}` : l.text));
    total = out.join("\n").length;
    if (total > MAX_CHARS) {
      let acc = 0;
      out = out.filter((l) => (acc += l.length + 1) <= MAX_CHARS);
      out.push("… (page continues — scroll or ask to read more)");
    }
  }

  const alerts = Array.from(document.querySelectorAll('[role="alert"],.error,.err,.alert,.toast,[aria-live="assertive"],[class*="error"]'))
    .filter(visible)
    .map((a) => clip(textOf(a), 160))
    .filter(Boolean);

  return {
    url: location.href,
    title: document.title,
    dialog: dialogs.length ? clip(accessibleName(root).name || textOf(root).slice(0, 60), 80) : "",
    text: out.join("\n"),
    elements,
    pdfLinks,
    alerts,
    focused: document.activeElement?.getAttribute?.("data-drishti-id") || "",
    scroll: { y: Math.round(scrollY), max: Math.max(0, document.documentElement.scrollHeight - innerHeight) },
  };
}

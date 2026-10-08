import { useEffect, useMemo, useRef, useState } from "react";
import { useDrishti, type Output, type Step } from "./useDrishti";
import type { PanelTransport } from "./transport";

const LANGS = [
  ["auto", "Auto-detect", "✦"],
  ["hi-IN", "Hindi", "हिन्दी"],
  ["ta-IN", "Tamil", "தமிழ்"],
  ["bn-IN", "Bengali", "বাংলা"],
  ["te-IN", "Telugu", "తెలుగు"],
  ["kn-IN", "Kannada", "ಕನ್ನಡ"],
  ["ml-IN", "Malayalam", "മലയാളം"],
  ["mr-IN", "Marathi", "मराठी"],
  ["gu-IN", "Gujarati", "ગુજરાતી"],
  ["pa-IN", "Punjabi", "ਪੰਜਾਬੀ"],
  ["od-IN", "Odia", "ଓଡ଼ିଆ"],
  ["en-IN", "English", "English"],
] as const;

const VOICES = ["kavya", "priya", "shruti", "kavitha", "ritu", "shubh", "aditya", "rahul", "gokul", "rohan"];

const EXAMPLES = [
  { lang: "हिन्दी", text: "कल चेन्नई से बेंगलुरु की स्लीपर टिकट बुक करो" },
  { lang: "தமிழ்", text: "நாளை மும்பையிலிருந்து புனேக்கு என்ன ரயில்கள் இருக்கு?" },
  { lang: "বাংলা", text: "কাল হাওড়া থেকে পাটনার ট্রেন দেখাও" },
  { lang: "తెలుగు", text: "ఈ పేజీలో ఏముంది?" },
  { lang: "मराठी", text: "मला जेवणाबद्दल तक्रार नोंदवायची आहे" },
  { lang: "English", text: "Open my documents and read the electricity bill" },
];

const TOOL_LABEL: Record<string, string> = {
  click: "Click",
  type_text: "Type",
  fill_form: "Fill form",
  select_option: "Choose",
  press_key: "Key",
  scroll: "Scroll",
  go_back: "Back",
  navigate: "Open",
  read_page: "Read page",
  read_document: "Sarvam Vision",
  ask_user: "Ask you",
  compose_with_kivi: "Kivi compose",
  done: "Reply",
};

type Tab = "activity" | "conversation" | "document" | "stats";

/** Where typed keys are text, not commands. */
const TEXT_FIELDS = "input,textarea,select";

/** Commands from outside the panel: the extension's global shortcuts. */
export type RemoteCommand = "talk" | "stop" | "yes" | "no";

export interface AppProps {
  transport: PanelTransport;
  /** Global shortcuts (they work from the web page too); subscribe returns an unsubscribe. */
  remote?: { subscribe(fn: (c: RemoteCommand) => void): () => void };
  /** The shortcut keys as Chrome has them, for the hints. */
  shortcuts?: Partial<Record<RemoteCommand, string>>;
  /** The microphone could not start. */
  onMicError?: (e: unknown) => void;
  /** The microphone is capturing. */
  onMicReady?: () => void;
}

export default function App({ transport, remote, shortcuts = {}, onMicError, onMicReady }: AppProps) {
  const d = useDrishti(transport, { onMicError, onMicReady });
  const [text, setText] = useState("");
  const [composeText, setComposeText] = useState("");
  const [tab, setTab] = useState<Tab>("activity");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [started, setStarted] = useState(false);
  const kiviTimer = useRef<number | undefined>(undefined);
  const composeRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);

  const state = d.listening
    ? "listening"
    : d.awaiting?.kind === "confirm"
      ? "confirm"
      : d.speaking
        ? "speaking"
        : d.thinking || d.task.state === "running"
          ? "thinking"
          : "idle";
  const stateLabel = {
    listening: "Listening…",
    confirm: "Waiting for your yes / no",
    speaking: "Speaking",
    thinking: "Working on it",
    idle: d.connected ? `Ready — hold Space${shortcuts.talk ? ` or press ${shortcuts.talk}` : ""} to talk` : "Connecting…",
  }[state];

  // Keyboard: hold Space or ` to talk (outside text fields), Esc to stop, Y/N answers a confirmation
  // that has focus. Screen readers keep plain keys for themselves in browse mode, so their users
  // have the global shortcuts (Alt+Shift+D and friends) instead, which work from the web page too.
  useEffect(() => {
    const typing = (e: KeyboardEvent) => !!(e.target as HTMLElement)?.closest(TEXT_FIELDS);
    const down = (e: KeyboardEvent) => {
      if (e.key === "Escape") return d.stop();
      if (typing(e)) return;
      if (e.code === "Backquote" || e.code === "Space") {
        // Every press, repeats too: a held Space must never also press a focused button (Yes).
        e.preventDefault();
        if (e.repeat) return;
        setStarted(true);
        void d.pttStart();
      }
      if (e.repeat) return;
      // Only on the confirmation itself: a "y" that lands anywhere else is a typo, not a yes.
      const onDialog = dialogRef.current?.contains(e.target as Node);
      if (d.awaiting?.kind === "confirm" && onDialog && (e.key === "y" || e.key === "n")) d.answer(e.key === "y" ? "yes" : "no");
    };
    const up = (e: KeyboardEvent) => (e.code === "Backquote" || e.code === "Space") && !typing(e) && d.pttEnd();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [d]);

  // The global shortcuts, from the extension.
  useEffect(
    () =>
      remote?.subscribe((c) => {
        setStarted(true);
        if (c === "talk") void d.toggleTalk();
        else if (c === "stop") d.stop();
        else if (d.awaiting) d.answer(c);
      }),
    [remote, d],
  );

  // A confirmation takes focus (its question is read with it), but not the Yes button: a stray
  // Enter or Space must not confirm a payment. Nor does it take focus from a text field: the user
  // may be mid-word, and their next "y" would land on it. There it is announced (or spoken)
  // instead. Focus goes back where it was afterwards.
  const confirmQ = d.awaiting?.kind === "confirm" ? d.awaiting.question : null;
  useEffect(() => {
    if (!confirmQ || !document.hasFocus()) return;
    const before = document.activeElement as HTMLElement | null;
    if (before?.closest(TEXT_FIELDS)) return;
    const dialog = dialogRef.current;
    const input = inputRef.current;
    dialog?.focus();
    return () => {
      // Only if focus was left on the dialog (now gone): not if the user has moved on.
      const now = document.activeElement;
      if (now && now !== document.body && !dialog?.contains(now)) return;
      // Back where it was, or to the command box if that can't take it (Send is disabled once the box is empty).
      if (before?.isConnected && before !== document.body && !(before as HTMLButtonElement).disabled) before.focus();
      else input?.focus();
    };
  }, [confirmQ]);

  useEffect(() => {
    if (d.compose) {
      setComposeText("");
      setTimeout(() => composeRef.current?.focus(), 50);
    }
  }, [d.compose]);

  useEffect(() => {
    if (d.doc) setTab("document");
  }, [d.doc]);

  // Kivi types a whole sentence in one burst; auto-submit once it settles.
  const onCommandInput = (v: string) => {
    const burst = v.length - text.length > 8;
    setText(v);
    clearTimeout(kiviTimer.current);
    if (burst) kiviTimer.current = window.setTimeout(() => submit(v, "kivi"), 900);
  };
  const submit = (v = text, source: "typed" | "kivi" = "typed") => {
    if (!v.trim()) return;
    clearTimeout(kiviTimer.current);
    setStarted(true);
    d.sendText(v.trim(), source);
    setText("");
  };

  const lastUser = [...d.lines].reverse().find((l) => l.who === "user");
  const lastMe = [...d.lines].reverse().find((l) => l.who === "drishti");
  const avg = (xs?: number[]) => (xs?.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

  return (
    <div className={`shell state-${state}`}>
      <header className="top">
        <div className="brand">
          <EyeMark />
          <div>
            <div className="brand-name">
              दृष्टि <span>Drishti</span>
            </div>
            <div className="brand-sub">Your voice, the whole web</div>
          </div>
        </div>
        <div className="top-right">
          <StatusDot ok={d.connected} label={transport.label} />
          {/* Closed is idle: the microphone's socket reopens when the user next talks. */}
          <StatusDot ok={d.status.stt === "open"} label="Saaras" idle={!d.status.stt || d.status.stt === "closed"} />
          <StatusDot ok={d.status.browser === "ready"} label="Browser" />
          <button className="icon-btn" aria-label="Settings" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((o) => !o)}>
            <GearIcon />
          </button>
        </div>
      </header>

      {settingsOpen && <Settings d={d} onClose={() => setSettingsOpen(false)} />}

      <section className="stage" aria-label="Voice">
        <button
          className="orb"
          aria-label={d.listening ? "Stop listening and send" : "Talk to Drishti"}
          aria-pressed={d.listening}
          // Hold with a mouse, finger or pen.
          onPointerDown={() => (setStarted(true), void d.pttStart())}
          onPointerUp={d.pttEnd}
          onPointerLeave={() => d.listening && d.pttEnd()}
          // A screen reader's or the keyboard's press (no pointer, detail 0) toggles instead.
          onClick={(e) => e.detail === 0 && (setStarted(true), void d.toggleTalk())}
          style={{ ["--lvl" as string]: Math.min(1, d.level * 2.2).toFixed(2) }}
        >
          <span className="ring r1" />
          <span className="ring r2" />
          <span className="ring r3" />
          <span className="core">
            <EyeMark big />
          </span>
        </button>
        <div className="state-label">
          {stateLabel}
          <span className="lang-pill" title={d.langLocked ? "Language fixed" : "Detected automatically"}>
            {d.lang.native}
            {d.langLocked ? " 🔒" : ""}
          </span>
        </div>

        <div className="captions">
          <div className="cap-user">{d.partial ? <em>{d.partial}</em> : (lastUser?.text ?? "")}</div>
          <div className="cap-me">{lastMe?.text ?? (started ? "" : "Namaste! Tell me what you want to do on the web.")}</div>
        </div>
        <Announcer d={d} />
      </section>

      {d.awaiting && (
        <section
          className={`card prompt ${d.awaiting.kind}`}
          role="alertdialog"
          aria-label={d.awaiting.kind === "confirm" ? "Confirmation needed" : "Question"}
          aria-describedby="prompt-q"
          tabIndex={-1}
          ref={dialogRef}
        >
          <div className="prompt-kicker" aria-hidden>
            {d.awaiting.kind === "confirm" ? "🛡️ Your confirmation is needed" : "❓ Drishti is asking"}
          </div>
          <div className="prompt-q" id="prompt-q">
            {d.awaiting.question}
          </div>
          {d.awaiting.kind === "confirm" ? (
            <div className="prompt-actions">
              <button className="btn yes" onClick={() => d.answer("yes")} aria-keyshortcuts={keys("Y", shortcuts.yes)}>
                Yes, go ahead <kbd>Y</kbd>
              </button>
              <button className="btn no" onClick={() => d.answer("no")} aria-keyshortcuts={keys("N", shortcuts.no)}>
                No <kbd>N</kbd>
              </button>
            </div>
          ) : (
            <div className="prompt-hint">Answer by voice (hold Space) or type below.</div>
          )}
        </section>
      )}

      {d.compose && (
        <section className="card compose">
          <div className="compose-head">
            <span className="kivi-badge">Kivi</span>
            <span>{d.compose.field ? `Writing: ${d.compose.field}` : "Dictate your message"}</span>
          </div>
          <div className="prompt-q small">{d.compose.prompt}</div>
          <textarea
            ref={composeRef}
            value={composeText}
            onChange={(e) => setComposeText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && d.submitCompose(composeText)}
            placeholder="Hold Fn and speak — Kivi types here. ⌘↩ when done."
            rows={4}
          />
          <div className="prompt-actions">
            <button className="btn primary" disabled={!composeText.trim()} onClick={() => d.submitCompose(composeText)}>
              Read it back to me
            </button>
            <button className="btn ghost" onClick={() => d.submitCompose("")}>
              Cancel
            </button>
          </div>
        </section>
      )}

      {!started && d.lines.length === 0 && (
        <section className="card examples">
          <div className="section-title">Try saying</div>
          <div className="example-grid">
            {EXAMPLES.map((ex) => (
              <button key={ex.text} className="example" onClick={() => submit(ex.text)}>
                <span className="ex-lang">{ex.lang}</span>
                <span className="ex-text">{ex.text}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="card panel">
        <div className="tabs" role="tablist">
          {(["activity", "conversation", "document", "stats"] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
              {t === "activity" ? `Activity${d.steps.length ? ` · ${d.steps.length}` : ""}` : t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        <div className="tab-body">
          {tab === "activity" && <Activity steps={d.steps} task={d.task} />}
          {tab === "conversation" && <Conversation lines={d.lines} />}
          {tab === "document" && <DocumentView doc={d.doc} />}
          {tab === "stats" && (
            <Stats turn={avg(d.metrics.turn_latency)} llm={avg(d.metrics.llm_step)} task={d.task.ms} cost={d.cost} audits={d.audits} />
          )}
        </div>
      </section>

      {d.errors.length > 0 && (
        <button className="toast" onClick={d.dismissError} role="alert">
          ⚠️ {d.errors[d.errors.length - 1]} <span className="muted">(dismiss)</span>
        </button>
      )}

      <footer className="dock">
        <div className="command">
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => onCommandInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Type, or hold Fn and speak with Kivi…"
            aria-label="Command for Drishti"
          />
          <button className="btn primary send" onClick={() => submit()} disabled={!text.trim()} aria-label="Send">
            ↑
          </button>
          <button className="btn stop" onClick={d.stop} aria-label="Stop (Esc)">
            ■
          </button>
        </div>
        <div className="hints">
          <span>
            <kbd>Space</kbd> hold to talk
          </span>
          {shortcuts.talk && (
            <span>
              <kbd>{shortcuts.talk}</kbd> talk from any page
            </span>
          )}
          <span>
            <kbd>Fn</kbd> Kivi dictation
          </span>
          <span>
            <kbd>Esc</kbd> stop
          </span>
          <span className="spacer" />
          <span className="cost">₹{d.cost.toFixed(2)} spent</span>
        </div>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------- pieces

const keys = (...k: (string | undefined)[]) => k.filter(Boolean).join(" ") || undefined;

/**
 * Screen-reader mode: each reply goes into a live region (in its own language, so the screen
 * reader can switch voice) and NVDA, JAWS or VoiceOver read it. In voice mode Bulbul speaks and
 * the region stays empty, so the screen reader doesn't talk over it or into the microphone.
 */
function Announcer({ d }: { d: ReturnType<typeof useDrishti> }) {
  const [shown, setShown] = useState<{ text: string; lang: string } | null>(null);
  const queue = useRef<{ text: string; lang: string }[]>([]);
  const seen = useRef(new WeakSet<object>());
  const timer = useRef<number | undefined>(undefined);
  const awaiting = useRef(d.awaiting);
  useEffect(() => {
    awaiting.current = d.awaiting;
  }, [d.awaiting]);
  useEffect(() => {
    // Replies can come in quick succession ("Chrome needs a key press…", then the question
    // again): announce them together, not just the last.
    const fresh = d.said.filter((x) => !seen.current.has(x));
    fresh.forEach((x) => seen.current.add(x));
    if (d.output !== "screenreader" || !fresh.length) return;
    queue.current.push(...fresh);
    // Empty first, then the text: a live region only speaks changes, and replies can repeat.
    setShown(null);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      // A confirmation that took focus is read with the dialog: not twice. One that didn't (the
      // user is in a text field, or in the web page) is announced here.
      const a = awaiting.current;
      const onDialog = !!document.activeElement?.closest('[role="alertdialog"]');
      const skip = a?.kind === "confirm" && onDialog ? a.question : null;
      const items = queue.current.filter((x) => x.text !== skip);
      queue.current = [];
      if (items.length) setShown({ text: items.map((x) => x.text).join(" "), lang: items.at(-1)!.lang });
    }, 120);
  }, [d.said, d.output]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <div className="sr-only" aria-live="polite" aria-atomic="true" lang={shown?.lang}>
      {shown?.text}
    </div>
  );
}

function Settings({ d, onClose }: { d: ReturnType<typeof useDrishti>; onClose: () => void }) {
  return (
    <section className="card settings" aria-label="Settings">
      <div className="settings-head">
        <div className="section-title">Settings</div>
        <button className="icon-btn" onClick={onClose} aria-label="Close settings">
          ✕
        </button>
      </div>
      <label className="set-row">
        <span>Language</span>
        <select value={d.langLocked ? d.lang.code : "auto"} onChange={(e) => d.settings({ lang: e.target.value })}>
          {LANGS.map(([code, name, native]) => (
            <option key={code} value={code}>
              {native} · {name}
            </option>
          ))}
        </select>
      </label>
      <label className="set-row">
        <span>Replies</span>
        <select value={d.output} onChange={(e) => d.setOutput(e.target.value as Output)}>
          <option value="voice">Drishti's voice</option>
          <option value="screenreader">My screen reader</option>
        </select>
      </label>
      <label className="set-row">
        <span>Voice</span>
        <select value={d.voice.speaker} onChange={(e) => d.settings({ speaker: e.target.value })}>
          {VOICES.map((v) => (
            <option key={v} value={v}>
              {v[0].toUpperCase() + v.slice(1)}
            </option>
          ))}
        </select>
      </label>
      <label className="set-row">
        <span>Speed · {d.voice.pace.toFixed(2)}×</span>
        <input
          type="range"
          min={0.6}
          max={2}
          step={0.05}
          value={d.voice.pace}
          onChange={(e) => d.settings({ pace: Number(e.target.value) })}
        />
      </label>
      <label className="set-row toggle">
        <span>Hands-free listening</span>
        <input type="checkbox" checked={d.mode === "handsfree"} onChange={(e) => d.setMode(e.target.checked ? "handsfree" : "ptt")} />
      </label>
      <div className="set-actions">
        <button className="btn ghost" onClick={d.greet}>
          Say hello
        </button>
        <button className="btn ghost" onClick={d.goHome}>
          Reset website
        </button>
        <label className="btn ghost file">
          Play a voice sample
          <input type="file" accept="audio/*" onChange={(e) => e.target.files?.[0] && d.playSample(e.target.files[0])} />
        </label>
      </div>
    </section>
  );
}

function Activity({ steps, task }: { steps: Step[]; task: { state: string; text?: string; ms?: number } }) {
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    list.current?.lastElementChild?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [steps]);
  if (!steps.length)
    return <div className="empty">Drishti's actions on the website appear here — every click, form field and safety check.</div>;
  return (
    <>
      {task.text && (
        <div className={`task-line ${task.state}`}>
          <span className="task-state">
            {task.state === "running"
              ? "In progress"
              : task.state === "done"
                ? "Done"
                : task.state === "stuck"
                  ? "Stuck"
                  : task.state === "aborted"
                    ? "Stopped"
                    : task.state}
          </span>
          <span className="task-text">{task.text}</span>
          {task.ms ? <span className="muted">{(task.ms / 1000).toFixed(1)} s</span> : null}
        </div>
      )}
      <ol className="timeline" ref={list}>
        {steps.map((s) => (
          <li key={s.i} className={`step ${s.status}`}>
            <span className="step-dot" aria-hidden />
            <div className="step-body">
              <div className="step-top">
                <span className="step-tool">{TOOL_LABEL[s.tool] ?? s.tool}</span>
                {s.target && <span className="step-target">{s.target.replace(/^\[\d+\]\s*/, "")}</span>}
                {s.ms !== undefined && s.status !== "running" && <span className="step-ms">{s.ms} ms</span>}
              </div>
              {s.narration && <div className="step-narr">“{s.narration}”</div>}
              {(s.detail || (s.result && s.tool !== "done")) && <div className="step-res">{s.detail || s.result}</div>}
              {s.status === "blocked" && <div className="step-flag">Safety rule: user must do this themselves</div>}
              {s.status === "declined" && <div className="step-flag">You said no — not done</div>}
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}

function Conversation({ lines }: { lines: { who: string; text: string; at: number }[] }) {
  if (!lines.length) return <div className="empty">Your conversation with Drishti will appear here.</div>;
  return (
    <div className="convo">
      {lines.map((l, i) => (
        <div key={i} className={`bubble ${l.who}`}>
          <div className="bubble-who">{l.who === "user" ? "You" : "Drishti"}</div>
          {l.text}
        </div>
      ))}
    </div>
  );
}

function DocumentView({ doc }: { doc: { name: string; markdown: string } | null }) {
  if (!doc)
    return <div className="empty">When Drishti reads a PDF or scanned letter with Sarvam Vision, the extracted text appears here.</div>;
  return (
    <div className="doc">
      <div className="doc-name">📄 {doc.name}</div>
      <div className="doc-sub">Extracted by Sarvam Vision</div>
      <pre className="doc-text">{doc.markdown}</pre>
    </div>
  );
}

function Stats(p: {
  turn: number | null;
  llm: number | null;
  task?: number;
  cost: number;
  audits: { action: string; target: string; confirmed: boolean }[];
}) {
  const confirmed = p.audits.filter((a) => a.confirmed).length;
  const tiles = useMemo(
    () => [
      ["Voice turn", p.turn !== null ? `${(p.turn / 1000).toFixed(1)} s` : "—", "end of speech → first audio"],
      ["Agent step", p.llm !== null ? `${(p.llm / 1000).toFixed(1)} s` : "—", "Sarvam-105B decision"],
      ["Last task", p.task ? `${(p.task / 1000).toFixed(0)} s` : "—", "start → finished"],
      ["Spend", `₹${p.cost.toFixed(2)}`, "this session"],
    ],
    [p.turn, p.llm, p.task, p.cost],
  );
  return (
    <div>
      <div className="tiles">
        {tiles.map(([k, v, s]) => (
          <div key={k} className="tile">
            <div className="tile-k">{k}</div>
            <div className="tile-v">{v}</div>
            <div className="tile-s">{s}</div>
          </div>
        ))}
      </div>
      <div className="section-title" style={{ marginTop: 16 }}>
        Safety log
      </div>
      {p.audits.length ? (
        <ul className="audits">
          {p.audits.map((a, i) => (
            <li key={i} className={a.confirmed ? "ok" : "no"}>
              {a.confirmed ? "✓ confirmed" : "✗ not done"} · {a.action} {a.target ? `“${a.target}”` : ""}
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty small">
          No payments or submissions yet. Every one needs your spoken yes. Passwords, OTPs and card numbers are never typed by Drishti.
        </div>
      )}
      <div className="muted small" style={{ marginTop: 10 }}>
        {confirmed} confirmed action(s) this session.
      </div>
    </div>
  );
}

function StatusDot({ ok, label, idle }: { ok: boolean; label: string; idle?: boolean }) {
  return (
    <span
      className={`status ${ok ? "ok" : idle ? "idle" : "bad"}`}
      title={`${label}: ${ok ? "connected" : idle ? "starts when you talk" : "not connected"}`}
    >
      <i />
      {label}
    </span>
  );
}

function EyeMark({ big }: { big?: boolean }) {
  const s = big ? 56 : 30;
  return (
    <svg width={s} height={s} viewBox="0 0 48 48" aria-hidden className="eye">
      <path
        d="M4 24c5-9 12-14 20-14s15 5 20 14c-5 9-12 14-20 14S9 33 4 24z"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <circle cx="24" cy="24" r="7" fill="currentColor" />
      <circle cx="26.5" cy="21.5" r="2.2" fill="var(--bg)" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
    </svg>
  );
}

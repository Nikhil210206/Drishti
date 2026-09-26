import { useEffect, useRef, useState } from "react";
import { useDrishti } from "./useDrishti";

const ICON: Record<string, string> = { running: "…", ok: "✓", failed: "✗", blocked: "⛔", declined: "↩" };

export default function App() {
  const d = useDrishti();
  const [text, setText] = useState("");
  const [composeText, setComposeText] = useState("");
  const kiviTimer = useRef<number>();

  // Hold ` (backquote) or Space outside inputs to talk; Esc stops everything.
  useEffect(() => {
    const typing = (e: KeyboardEvent) => (e.target as HTMLElement)?.closest("input,textarea");
    const down = (e: KeyboardEvent) => {
      if (e.key === "Escape") return d.stop();
      if ((e.code === "Backquote" || e.code === "Space") && !typing(e) && !e.repeat) {
        e.preventDefault();
        void d.pttStart();
      }
    };
    const up = (e: KeyboardEvent) => (e.code === "Backquote" || e.code === "Space") && !typing(e) && d.pttEnd();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [d]);

  // Kivi types into the command bar; auto-submit once the typing settles.
  const onCommandInput = (v: string) => {
    const jump = v.length - text.length > 8;
    setText(v);
    clearTimeout(kiviTimer.current);
    if (jump) kiviTimer.current = window.setTimeout(() => submit(v, "kivi"), 900);
  };
  const submit = (v = text, source: "typed" | "kivi" = "typed") => {
    if (!v.trim()) return;
    clearTimeout(kiviTimer.current);
    d.sendText(v.trim(), source);
    setText("");
  };

  const avg = (xs?: number[]) => (xs?.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
  const last = d.lines.filter((l) => l.who === "drishti").at(-1);
  const lastUser = d.lines.filter((l) => l.who === "user").at(-1);

  return (
    <main className="app">
      <header>
        <div className="logo">दृष्टि <span>Drishti</span></div>
        <div className="chips">
          <span className={`dot ${d.connected ? "on" : ""}`} title="server" />
          <span className="chip">{d.lang.native}</span>
          <span className="chip">₹{d.cost.toFixed(2)}</span>
        </div>
      </header>

      <section className="captions" aria-live="polite">
        <div className="you">{d.partial || lastUser?.text || "Hold Space / ` and speak, or use Kivi (Fn) below"}</div>
        <div className="me">{last?.text ?? ""}</div>
        <div className="state">
          {d.listening ? "🎙 Listening…" : d.thinking ? "Thinking…" : d.speaking ? "🔊 Speaking" : d.task.state === "running" ? "Working…" : "Ready"}
        </div>
      </section>

      {d.awaiting && (
        <section className={`banner ${d.awaiting.kind}`} role="alert">
          <div>{d.awaiting.question}</div>
          {d.awaiting.kind === "confirm" && (
            <div className="row">
              <button onClick={() => d.answer("yes")}>Yes</button>
              <button onClick={() => d.answer("no")}>No</button>
            </div>
          )}
        </section>
      )}

      {d.compose && (
        <section className="banner compose">
          <div>{d.compose.prompt}</div>
          <textarea autoFocus value={composeText} onChange={(e) => setComposeText(e.target.value)} placeholder="Hold Fn — Kivi types here" rows={4} />
          <button onClick={() => (d.submitCompose(composeText), setComposeText(""))}>Done</button>
        </section>
      )}

      <section className="command">
        <input
          value={text}
          onChange={(e) => onCommandInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Type, or hold Fn and speak with Kivi…"
          aria-label="Command"
        />
        <button onMouseDown={() => d.pttStart()} onMouseUp={d.pttEnd} className={d.listening ? "live" : ""}>🎙</button>
        <button onClick={d.stop}>Stop</button>
      </section>

      <section className="controls">
        <label>
          <input type="checkbox" checked={d.mode === "handsfree"} onChange={(e) => d.setMode(e.target.checked ? "handsfree" : "ptt")} /> Hands-free
        </label>
        <button onClick={() => d.settings({ pace: d.voice.pace - 0.25 })}>Slower</button>
        <span>{d.voice.pace.toFixed(2)}×</span>
        <button onClick={() => d.settings({ pace: d.voice.pace + 0.25 })}>Faster</button>
        <button onClick={d.greet}>Greet</button>
        <button onClick={d.goHome}>Home</button>
        <label className="file">
          Sample
          <input type="file" accept="audio/*" onChange={(e) => e.target.files?.[0] && d.playSample(e.target.files[0])} />
        </label>
      </section>

      <section className="hud">
        <span>Turn {avg(d.metrics.turn_latency)} ms</span>
        <span>LLM step {avg(d.metrics.llm_step)} ms</span>
        <span>Task {d.task.ms ? `${(d.task.ms / 1000).toFixed(1)} s` : "—"}</span>
      </section>

      <ol className="timeline">
        {d.steps.map((s) => (
          <li key={s.i} className={s.status}>
            <b>{ICON[s.status]}</b> <code>{s.tool}</code> {s.target} {s.narration && <em>“{s.narration}”</em>}
            {s.result && <div className="res">{s.result}</div>}
          </li>
        ))}
      </ol>

      {d.errors.length > 0 && (
        <section className="errors" onClick={d.dismissError}>
          {d.errors.map((e, i) => <div key={i}>{e}</div>)}
        </section>
      )}
    </main>
  );
}

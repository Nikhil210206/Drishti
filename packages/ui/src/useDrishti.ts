import { useCallback, useEffect, useRef, useState } from "react";
import { Earcons, Mic, Player, fileTo16k } from "./audio";
import type { PanelTransport } from "./transport";

export interface Step {
  i: number;
  tool: string;
  target?: string;
  detail?: string;
  narration?: string;
  status: "running" | "ok" | "failed" | "blocked" | "declined";
  result?: string;
  ms?: number;
}

export interface Line {
  who: "user" | "drishti";
  text: string;
  at: number;
}

export type Mode = "ptt" | "handsfree";
/** Replies in Bulbul's voice, or as text for the user's screen reader. */
export type Output = "voice" | "screenreader";

/** Toggle-to-talk (a shortcut or a screen reader's click) ends by itself after this long. */
const TOGGLE_LIMIT_MS = 30000;

/** Speak with the browser's own voice (free, on the device), queued after any reply it is saying; null stops it. */
function speakLocally(reply: { text: string; lang: string } | null) {
  if (typeof speechSynthesis === "undefined") return;
  if (!reply) return speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(reply.text);
  u.lang = reply.lang;
  speechSynthesis.speak(u);
}

export interface DrishtiOptions {
  /** The microphone could not start (in the extension: send the user to the grant tab). */
  onMicError?: (e: unknown) => void;
  /** The microphone is capturing. */
  onMicReady?: () => void;
}

export function useDrishti(transport: PanelTransport, { onMicError, onMicReady }: DrishtiOptions = {}) {
  const open = useRef(false);
  const player = useRef<Player | undefined>(undefined);
  const mic = useRef<Mic | undefined>(undefined);
  const ear = useRef<Earcons | undefined>(undefined);
  const pttDown = useRef(false);
  const modeRef = useRef<Mode>("ptt");
  const tailTimer = useRef<number | undefined>(undefined);
  const thinkTimer = useRef<number | undefined>(undefined);
  const toggleTimer = useRef<number | undefined>(undefined);
  /** The reply Bulbul is on, and where replies go: for the browser-voice fallback. */
  const lastReply = useRef<{ text: string; lang: string } | null>(null);
  const outputRef = useRef<Output>("voice");

  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<{ stt?: string; browser?: string }>({});
  const [lang, setLang] = useState({ code: "hi-IN", name: "Hindi", native: "हिन्दी" });
  const [partial, setPartial] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const [level, setLevel] = useState(0);
  const [thinking, setThinking] = useState(false);
  const [task, setTask] = useState<{ state: string; text?: string; ms?: number }>({ state: "idle" });
  const [steps, setSteps] = useState<Step[]>([]);
  const [awaiting, setAwaiting] = useState<{ kind: "question" | "confirm"; question: string } | null>(null);
  const [compose, setCompose] = useState<{ prompt: string; field: string } | null>(null);
  const [metrics, setMetrics] = useState<Record<string, number[]>>({});
  const [cost, setCost] = useState(0);
  const [voice, setVoice] = useState({ pace: 1.1, speaker: "kavya" });
  const [mode, setModeState] = useState<Mode>("ptt");
  const [errors, setErrors] = useState<string[]>([]);
  const [doc, setDoc] = useState<{ name: string; markdown: string } | null>(null);
  const [langLocked, setLangLocked] = useState(false);
  const [output, setOutputState] = useState<Output>("voice");
  /** Recent replies, for the screen reader (only given to it in screen-reader mode). */
  const [said, setSaid] = useState<{ id: number; text: string; lang: string }[]>([]);
  const [audits, setAudits] = useState<{ action: string; target: string; confirmed: boolean }[]>([]);

  const send = useCallback(
    (obj: unknown) => {
      if (open.current) transport.send(obj);
    },
    [transport],
  );

  const addLine = (who: Line["who"], text: string) => setLines((l) => [...l.slice(-30), { who, text, at: Date.now() }]);

  // ---------- connection ----------
  useEffect(() => {
    player.current = new Player();
    ear.current = new Earcons(player.current.context);
    player.current.onBusy = () => setSpeaking(true);
    player.current.onIdle = () => setSpeaking(false);

    const disconnect = transport.connect({
      open: (on) => {
        open.current = on;
        setConnected(on);
      },
      audio: (pcm) => player.current!.push(pcm),
      event: (m) => handle(m),
    });
    return disconnect;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transport]);

  // Any key press or click in the panel lets Chrome start its audio (speech and the microphone),
  // so talking later from the global shortcut works.
  useEffect(() => {
    const wake = () => {
      void player.current?.resume();
      void mic.current?.resume();
    };
    window.addEventListener("keydown", wake, true);
    window.addEventListener("pointerdown", wake, true);
    return () => {
      window.removeEventListener("keydown", wake, true);
      window.removeEventListener("pointerdown", wake, true);
    };
  }, []);

  function handle(m: any) {
    switch (m.type) {
      case "status":
        setStatus((s) => ({ ...s, ...(m.stt ? { stt: m.stt } : {}), ...(m.browser ? { browser: m.browser } : {}) }));
        break;
      case "lang":
        setLang({ code: m.code, name: m.name, native: m.native });
        break;
      case "lang_lock":
        setLangLocked(m.locked);
        break;
      case "partial":
        setPartial(m.text);
        break;
      case "final":
        setPartial("");
        addLine("user", m.text);
        break;
      case "tts_start":
        addLine("drishti", m.text);
        setSaid((s) => [...s.slice(-9), { id: m.id, text: m.text, lang: m.lang }]);
        lastReply.current = { text: m.text, lang: m.lang };
        break;
      case "output":
        outputRef.current = m.mode === "screenreader" ? "screenreader" : "voice";
        setOutputState(outputRef.current);
        break;
      case "tts_stop":
        player.current?.stop();
        speakLocally(null);
        break;
      case "thinking":
        setThinking(m.on);
        clearInterval(thinkTimer.current);
        if (m.on) thinkTimer.current = window.setInterval(() => !player.current?.speaking && ear.current?.tick(), 700);
        break;
      case "task":
        setTask({ state: m.state, text: m.text, ms: m.ms });
        if (m.state === "running") setSteps([]);
        if (m.state === "done") ear.current?.success();
        if (m.state === "stuck" || m.state === "error") ear.current?.error();
        break;
      case "step":
        setSteps((s) => {
          const idx = s.findIndex((x) => x.i === m.step.i);
          if (idx === -1) return [...s, m.step];
          const copy = s.slice();
          copy[idx] = m.step;
          return copy;
        });
        if (m.step.status === "running" && m.step.tool !== "done" && m.step.tool !== "ask_user") ear.current?.action();
        break;
      case "awaiting":
        setAwaiting(m.kind ? { kind: m.kind, question: m.question } : null);
        if (m.kind === "confirm") ear.current?.attention();
        break;
      case "confirm_request":
        setAwaiting({ kind: "confirm", question: m.question });
        break;
      case "compose_open":
        setCompose({ prompt: m.prompt, field: m.field });
        break;
      case "compose_close":
        setCompose(null);
        break;
      case "metric":
        setMetrics((x) => ({ ...x, [m.name]: [...(x[m.name] ?? []).slice(-19), m.ms] }));
        break;
      case "cost":
        setCost(m.inr);
        break;
      case "voice":
        setVoice({ pace: m.pace, speaker: m.speaker });
        break;
      case "document":
        setDoc({ name: m.name, markdown: m.markdown });
        break;
      case "audit":
        setAudits((a) => [...a, { action: m.action, target: m.target, confirmed: m.confirmed }]);
        break;
      case "error":
        setErrors((e) => [...e.slice(-3), m.message]);
        ear.current?.error();
        // Bulbul couldn't say this reply (the proxy refused it: today's limit, say; or the network
        // dropped): the browser's own voice reads it rather than nothing.
        if (String(m.message).startsWith("TTS:") && outputRef.current === "voice" && lastReply.current) {
          speakLocally(lastReply.current);
          lastReply.current = null;
        }
        break;
    }
  }

  // ---------- microphone ----------
  const ensureMic = useCallback(async () => {
    await player.current?.resume();
    if (mic.current) return;
    const m = new Mic();
    m.onChunk = (pcm, lvl) => {
      setLevel(lvl);
      const handsfreeOpen = modeRef.current === "handsfree" && !player.current?.speaking;
      if ((pttDown.current || tailTimer.current || handsfreeOpen) && open.current) transport.sendAudio(pcm);
    };
    try {
      await m.start();
    } catch (e) {
      onMicError?.(e);
      throw e;
    }
    mic.current = m;
    onMicReady?.();
  }, [transport, onMicError, onMicReady]);

  const pttStart = useCallback(async () => {
    if (pttDown.current) return;
    await ensureMic();
    pttDown.current = true;
    clearTimeout(tailTimer.current);
    tailTimer.current = undefined;
    player.current?.stop();
    speakLocally(null);
    send({ type: "ptt", down: true });
    ear.current?.listen();
    setListening(true);
  }, [ensureMic, send]);

  const pttEnd = useCallback(() => {
    if (!pttDown.current) return;
    pttDown.current = false;
    clearTimeout(toggleTimer.current);
    setListening(false);
    ear.current?.stopListen();
    // Keep streaming briefly so the last syllable isn't cut, then force the final transcript.
    tailTimer.current = window.setTimeout(() => {
      tailTimer.current = undefined;
      send({ type: "ptt", down: false });
    }, 350);
  }, [send]);

  /** Talk without holding a key: start listening, or send what was said. */
  const toggleTalk = useCallback(async () => {
    if (pttDown.current) return pttEnd();
    try {
      await pttStart();
    } catch {
      return;
    }
    if (mic.current?.held) {
      pttEnd();
      setErrors((e) => [...e.slice(-3), "Chrome is holding the microphone. Press any key in the Drishti panel once, then try again."]);
      ear.current?.error();
      return;
    }
    clearTimeout(toggleTimer.current);
    toggleTimer.current = window.setTimeout(pttEnd, TOGGLE_LIMIT_MS);
  }, [pttStart, pttEnd]);

  const setMode = useCallback(
    async (m: Mode) => {
      modeRef.current = m;
      setModeState(m);
      if (m === "handsfree") {
        await ensureMic();
        ear.current?.listen();
      }
    },
    [ensureMic],
  );

  // ---------- actions ----------
  const sendText = useCallback(
    (text: string, source: "typed" | "kivi" = "typed") => {
      void player.current?.resume();
      player.current?.stop();
      speakLocally(null);
      send({ type: "stop_speech" });
      send({ type: "text", text, source });
    },
    [send],
  );

  const stop = useCallback(() => {
    player.current?.stop();
    speakLocally(null);
    send({ type: "stop" });
  }, [send]);

  const answer = useCallback((a: "yes" | "no") => send({ type: "confirm", answer: a }), [send]);
  const submitCompose = useCallback((text: string) => send({ type: "compose_submit", text }), [send]);
  const settings = useCallback((s: Record<string, unknown>) => send({ type: "settings", ...s }), [send]);
  const setOutput = useCallback((o: Output) => send({ type: "settings", output: o }), [send]);
  const goHome = useCallback(() => send({ type: "home" }), [send]);
  const greet = useCallback(async () => {
    await player.current?.resume();
    send({ type: "greet" });
  }, [send]);

  /** Stream a recorded voice command (e.g. a native speaker's clip) exactly like the mic would. */
  const playSample = useCallback(
    async (file: File) => {
      await player.current?.resume();
      const { pcm, audio } = await fileTo16k(file);
      const ctx = player.current!.context;
      const src = ctx.createBufferSource();
      src.buffer = audio;
      src.connect(ctx.destination);
      src.start();
      send({ type: "ptt", down: true });
      setListening(true);
      for (let i = 0; i < pcm.length; i += 1600) {
        transport.sendAudio(pcm.slice(i, i + 1600).buffer);
        await new Promise((r) => setTimeout(r, 100));
      }
      setListening(false);
      send({ type: "ptt", down: false });
    },
    [send, transport],
  );

  return {
    connected,
    status,
    lang,
    partial,
    lines,
    speaking,
    listening,
    level,
    thinking,
    task,
    steps,
    awaiting,
    compose,
    metrics,
    cost,
    voice,
    mode,
    errors,
    doc,
    audits,
    langLocked,
    output,
    said,
    pttStart,
    pttEnd,
    toggleTalk,
    setOutput,
    setMode,
    sendText,
    stop,
    answer,
    submitCompose,
    settings,
    goHome,
    greet,
    playSample,
    dismissError: () => setErrors([]),
  };
}

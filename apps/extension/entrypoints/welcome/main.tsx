/**
 * The welcome flow, opened on install: language → connect → privacy → microphone → voice →
 * optional details → practice. Keyboard and screen-reader first: each step moves focus to its
 * heading and speaks its instructions. It runs in a tab, not the side panel, because Chrome only
 * shows the microphone prompt in a tab (spike 1).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { LANGS, type LangCode, type Profile } from "@drishti/core";
import { SarvamTranslator, SttStream, TtsEngine } from "@drishti/providers";
import { Mic, Player } from "@drishti/ui";
import { CONSENT_VERSION, StorageCache, loadSettings, saveSettings, type Settings } from "../../lib/settings";
import { WEBSITE, connectUrl, looksLikeToken } from "../../lib/website";
import { STRINGS, type StringKey } from "./strings";
import "./welcome.css";

const LANG_ORDER: LangCode[] = ["hi-IN", "bn-IN", "ta-IN", "te-IN", "kn-IN", "ml-IN", "mr-IN", "gu-IN", "pa-IN", "od-IN", "en-IN"];
const VOICES = ["kavya", "priya", "shruti", "kavitha", "ritu", "shubh", "aditya", "rahul", "gokul", "rohan"];
const STEPS = ["lang", "connect", "consent", "mic", "voice", "profile", "practice"] as const;
type Step = (typeof STEPS)[number];

const auth = (s: Settings) => ({ baseUrl: s.proxyUrl, token: s.token });

/** The flow's words in the chosen language: hand-written English and Hindi, the rest machine-translated once connected. */
function useStrings(lang: LangCode, settings: Settings | undefined) {
  const base = lang === "hi-IN" ? "hi" : "en";
  const [translated, setTranslated] = useState<Partial<Record<StringKey, string>>>({});
  const machine = base === "en" && lang !== "en-IN";
  useEffect(() => {
    setTranslated({});
    if (!machine || !settings?.token) return;
    let cancelled = false;
    const cache = new StorageCache(`ui:${lang}:`);
    const tr = new SarvamTranslator(auth(settings));
    void (async () => {
      for (const key of Object.keys(STRINGS) as StringKey[]) {
        const en = STRINGS[key].en;
        if (!en) continue;
        const hit = (await cache.get(key)) ?? (await tr.translate(en, lang, { source: "en-IN" }).catch(() => undefined));
        if (cancelled) return;
        if (hit) {
          await cache.set(key, hit);
          setTranslated((t) => ({ ...t, [key]: hit }));
        }
      }
    })();
    return () => void (cancelled = true);
  }, [lang, machine, settings?.token]);
  const t = useCallback((key: StringKey) => translated[key] ?? STRINGS[key][base], [translated, base]);
  return { t, machine: machine && Object.keys(translated).length > 0 };
}

/**
 * Speech: Bulbul once connected, the browser's own voices before that. Silent once the user
 * picks their screen reader for replies: it reads each step's focused heading and text instead.
 */
function useSpeech(settings: Settings | undefined) {
  const player = useRef<Player | undefined>(undefined);
  const tts = useRef<TtsEngine | undefined>(undefined);
  useEffect(() => {
    if (!settings?.token) return;
    player.current ??= new Player();
    const engine = new TtsEngine({ ...auth(settings), model: "bulbul:v3", speaker: settings.speaker });
    engine.on("audio", (_u, pcm) => player.current?.push(pcm.slice().buffer));
    tts.current = engine;
    return () => engine.cancelAll();
  }, [settings?.token, settings?.proxyUrl]);
  useEffect(() => {
    if (tts.current && settings) tts.current.voice = { speaker: settings.speaker, pace: settings.pace };
  }, [settings?.speaker, settings?.pace]);
  const silent = settings?.output === "screenreader";
  /** `always`: speak even in screen-reader mode (the voice sample was asked for). */
  return useCallback(
    (text: string, lang: LangCode, always = false) => {
      speechSynthesis.cancel();
      tts.current?.cancelAll();
      player.current?.stop();
      if (silent && !always) return;
      if (tts.current && player.current) {
        void player.current.resume();
        tts.current.speak(text, lang);
        return;
      }
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang;
      speechSynthesis.speak(u);
    },
    [silent],
  );
}

function Welcome() {
  const [settings, setSettings] = useState<Settings | undefined>();
  const [step, setStep] = useState<Step>("lang");
  const [status, setStatus] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const here = useRef<{ tabId?: number; windowId?: number }>({});
  const lang: LangCode = settings?.lang ?? "en-IN";
  const { t, machine } = useStrings(lang, settings);
  const speak = useSpeech(settings);

  const update = useCallback(async (patch: Partial<Settings>) => setSettings(await saveSettings(patch)), []);

  useEffect(() => {
    void loadSettings().then(setSettings);
    void chrome.tabs.getCurrent().then((tab) => (here.current = { tabId: tab?.id, windowId: tab?.windowId }));
    // The token arrives from the website's connect page through the background worker.
    const onChange = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes.settings) setSettings(changes.settings.newValue as Settings);
    };
    chrome.storage.local.onChanged.addListener(onChange);
    return () => chrome.storage.local.onChanged.removeListener(onChange);
  }, []);

  // A new step: focus its heading (screen readers read it) and speak its instructions.
  const intro: Record<Step, StringKey> = {
    lang: "langIntro",
    connect: "connectIntro",
    consent: "consentIntro",
    mic: "micIntro",
    voice: "voiceIntro",
    profile: "profileIntro",
    practice: "practiceIntro",
  };
  useEffect(() => {
    heading.current?.focus();
    setStatus("");
    if (step === "lang") speak(`${STRINGS.langIntro.en} ${STRINGS.langIntro.hi}`, "hi-IN");
    else speak(t(intro[step]), lang);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Connected while on the connect step: move on.
  useEffect(() => {
    if (step === "connect" && settings?.token) {
      setStatus(t("connected"));
      const timer = setTimeout(() => setStep("consent"), 1500);
      return () => clearTimeout(timer);
    }
  }, [step, settings?.token, t]);

  const next = () => setStep(STEPS[STEPS.indexOf(step) + 1] ?? "practice");
  if (!settings) return <p role="status">…</p>;

  return (
    <main lang={lang.slice(0, 2)}>
      <p className="progress">
        {STEPS.indexOf(step) + 1} / {STEPS.length}
      </p>
      <h1 ref={heading} tabIndex={-1}>
        {step === "lang" ? `${STRINGS.langTitle.en} · ${STRINGS.langTitle.hi}` : t(`${step}Title` as StringKey)}
      </h1>
      {machine && <p className="note">{t("machine")}</p>}

      {step === "lang" && (
        <>
          <p>{STRINGS.langIntro.en}</p>
          <p lang="hi">{STRINGS.langIntro.hi}</p>
          <ul className="choices">
            {LANG_ORDER.map((code) => (
              <li key={code}>
                <button
                  lang={code.slice(0, 2)}
                  onClick={async () => {
                    await update({ lang: code });
                    setStep(settings.token ? "consent" : "connect");
                  }}
                >
                  {LANGS[code].native} <span className="muted">{LANGS[code].name}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {step === "connect" && <Connect t={t} lang={lang} settings={settings} update={update} />}

      {step === "consent" && (
        <>
          <p>{t("consentIntro")}</p>
          <ul className="points">
            <li>{t("consent1")}</li>
            <li>{t("consent2")}</li>
            <li>{t("consent3")}</li>
          </ul>
          <p>
            <a href={`${WEBSITE}/privacy.html`} target="_blank" rel="noreferrer">
              {t("fullPolicy")}
            </a>
          </p>
          <button
            className="primary"
            onClick={async () => {
              await update({ consent: { version: CONSENT_VERSION, at: new Date().toISOString() } });
              next();
            }}
          >
            {t("agree")}
          </button>
        </>
      )}

      {step === "mic" && <MicStep t={t} lang={lang} settings={settings} speak={speak} setStatus={setStatus} next={next} />}

      {step === "voice" && (
        <>
          <p>{t("voiceIntro")}</p>
          <fieldset>
            <legend>{t("output")}</legend>
            {(["voice", "screenreader"] as const).map((o) => (
              <label key={o} className="choice">
                <input
                  type="radio"
                  name="output"
                  checked={(settings.output ?? "voice") === o}
                  onChange={() => void update({ output: o })}
                />
                {t(o === "voice" ? "outputVoice" : "outputScreenReader")}
              </label>
            ))}
          </fieldset>
          <label>
            {t("voice")}
            <select value={settings.speaker} onChange={(e) => void update({ speaker: e.target.value })}>
              {VOICES.map((v) => (
                <option key={v} value={v}>
                  {v[0].toUpperCase() + v.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("speed")} ({settings.pace.toFixed(2)}×)
            <input
              type="range"
              min={0.8}
              max={1.6}
              step={0.1}
              value={settings.pace}
              onChange={(e) => void update({ pace: Number(e.target.value) })}
            />
          </label>
          <div className="row">
            <button onClick={() => speak(t("sample"), lang, true)}>{t("playSample")}</button>
            <button className="primary" onClick={next}>
              {t("next")}
            </button>
          </div>
        </>
      )}

      {step === "profile" && <ProfileStep t={t} initial={settings.profile} update={update} next={next} />}

      {step === "practice" && (
        <>
          <p>{t("practiceIntro")}</p>
          <button
            className="primary"
            onClick={() => {
              // Open the panel first, while this click still counts as the user's gesture.
              if (here.current.windowId !== undefined) void chrome.sidePanel.open({ windowId: here.current.windowId });
              void update({ onboarded: true }).then(() => {
                if (here.current.tabId !== undefined) void chrome.tabs.update(here.current.tabId, { url: settings.homeUrl });
              });
            }}
          >
            {t("startPractice")}
          </button>
        </>
      )}

      <p className="status" role="status" aria-live="polite">
        {status}
      </p>
    </main>
  );
}

type T = (key: StringKey) => string;

function Connect({
  t,
  lang,
  settings,
  update,
}: {
  t: T;
  lang: LangCode;
  settings: Settings;
  update: (p: Partial<Settings>) => Promise<void>;
}) {
  const [opened, setOpened] = useState(false);
  const [token, setToken] = useState("");
  const [proxyUrl, setProxyUrl] = useState(settings.proxyUrl);
  return (
    <>
      <p>{t("connectIntro")}</p>
      {settings.token ? (
        <p className="ok">{t("connected")}</p>
      ) : (
        <>
          <button
            className="primary"
            onClick={() => {
              setOpened(true);
              void chrome.tabs.create({ url: connectUrl(lang) });
            }}
          >
            {t("connect")}
          </button>
          {opened && <p aria-live="polite">{t("waiting")}</p>}
        </>
      )}
      <details>
        <summary>Developer: proxy address and token</summary>
        <label>
          Proxy address
          <input value={proxyUrl} onChange={(e) => setProxyUrl(e.target.value)} />
        </label>
        <label>
          Device token
          <input value={token} onChange={(e) => setToken(e.target.value)} />
        </label>
        <button disabled={!looksLikeToken(token.trim())} onClick={() => void update({ proxyUrl: proxyUrl.trim(), token: token.trim() })}>
          Use this token
        </button>
      </details>
    </>
  );
}

function MicStep(props: {
  t: T;
  lang: LangCode;
  settings: Settings;
  speak: (text: string, lang: LangCode) => void;
  setStatus: (s: string) => void;
  next: () => void;
}) {
  const { t, lang, settings, speak, setStatus, next } = props;
  const [allowed, setAllowed] = useState(false);
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState("");
  const mic = useRef<Mic | undefined>(undefined);
  const stt = useRef<SttStream | undefined>(undefined);
  const holding = useRef(false);
  /** What started the hold: only the same input ends it (a mouse resting on the button must not end a Space hold). */
  const holdBy = useRef<"key" | "mouse" | undefined>(undefined);

  useEffect(
    () => () => {
      mic.current?.stop();
      stt.current?.close();
    },
    [],
  );

  const allow = async () => {
    try {
      const m = new Mic();
      m.onChunk = (pcm) => holding.current && stt.current?.sendAudio(new Uint8Array(pcm));
      await m.start();
      mic.current = m;
      const s = new SttStream({ ...auth(settings), model: "saaras:v4" });
      s.on("final", (text) => {
        setHeard(text);
        speak(`${t("heard")} ${text}`, lang);
      });
      s.connect();
      stt.current = s;
      setAllowed(true);
      setStatus(t("micAllowed"));
      speak(t("micAllowed"), lang);
    } catch {
      setStatus(t("micDenied"));
      speak(t("micDenied"), lang);
    }
  };
  const down = (by: "key" | "mouse") => {
    if (holding.current || !allowed) return;
    speechSynthesis.cancel();
    holdBy.current = by;
    holding.current = true;
    setListening(true);
  };
  const up = (by: "key" | "mouse") => {
    if (!holding.current || holdBy.current !== by) return;
    holdBy.current = undefined;
    setListening(false);
    // Keep streaming briefly so the last syllable isn't cut, then ask for the final transcript.
    setTimeout(() => {
      holding.current = false;
      stt.current?.flush();
    }, 350);
  };

  return (
    <>
      <p>{t("micIntro")}</p>
      {!allowed ? (
        <button className="primary" onClick={() => void allow()}>
          {t("allowMic")}
        </button>
      ) : (
        <button
          className="primary"
          aria-pressed={listening}
          onMouseDown={() => down("mouse")}
          onMouseUp={() => up("mouse")}
          onMouseLeave={() => up("mouse")}
          onKeyDown={(e) => (e.key === " " || e.key === "Enter") && (e.preventDefault(), down("key"))}
          onKeyUp={(e) => (e.key === " " || e.key === "Enter") && (e.preventDefault(), up("key"))}
        >
          {listening ? t("listening") : t("holdToTest")}
        </button>
      )}
      {heard && (
        <p aria-live="polite">
          {t("heard")} <strong>{heard}</strong>
        </p>
      )}
      <div className="row">
        <button onClick={next}>{allowed ? t("next") : t("skip")}</button>
      </div>
    </>
  );
}

function ProfileStep({
  t,
  initial,
  update,
  next,
}: {
  t: T;
  initial?: Profile;
  update: (p: Partial<Settings>) => Promise<void>;
  next: () => void;
}) {
  const [p, setP] = useState<Profile>(initial ?? {});
  const field = (key: keyof Profile, label: StringKey, extra: Record<string, string> = {}) => (
    <label>
      {t(label)}
      <input value={p[key] ?? ""} onChange={(e) => setP({ ...p, [key]: e.target.value })} {...extra} />
    </label>
  );
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const clean = Object.fromEntries(Object.entries(p).filter(([, v]) => v?.trim())) as Profile;
        await update({ profile: Object.keys(clean).length ? clean : undefined });
        next();
      }}
    >
      <p>{t("profileIntro")}</p>
      {field("name", "name", { autoComplete: "name" })}
      {field("age", "age", { inputMode: "numeric" })}
      <label>
        {t("gender")}
        <select value={p.gender ?? ""} onChange={(e) => setP({ ...p, gender: e.target.value })}>
          <option value="" />
          <option value="Female">{t("female")}</option>
          <option value="Male">{t("male")}</option>
          <option value="Transgender">{t("transgender")}</option>
        </select>
      </label>
      {field("mobile", "mobile", { inputMode: "tel", autoComplete: "tel" })}
      <div className="row">
        <button type="submit" className="primary">
          {t("save")}
        </button>
        <button type="button" onClick={next}>
          {t("skip")}
        </button>
      </div>
    </form>
  );
}

createRoot(document.getElementById("root")!).render(<Welcome />);

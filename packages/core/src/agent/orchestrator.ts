import { guessDocLanguage, type LangCode } from "../lang.js";
import type { BrowserDriver, DocReader, LLM, Profile, Reasoning, Snapshot, ToolCall, Translator } from "../types.js";
import { TOOLS } from "./tools.js";
import { systemPrompt, stepMessage } from "./prompts.js";
import { needsConfirmation, isSensitiveField, yesNo } from "./safety.js";
import { NavigationPolicy, linkTarget } from "./policy.js";
import type { PhraseBook, PhraseKey } from "./phrases.js";

/** Everything the agent needs from the outside world (voice session, or the eval harness). */
export interface AgentIO {
  lang: LangCode;
  say(text: string): void;
  sayPhrase(key: PhraseKey): Promise<void>;
  /** Speak a question and wait for the user's next utterance (null on timeout/abort). */
  ask(question: string, kind: "question" | "confirm"): Promise<string | null>;
  /** Open the Kivi compose box and wait for the text the user dictated. */
  compose(prompt: string, field: string): Promise<string | null>;
  emit(event: Record<string, unknown>): void;
  recent(): string[];
  takeInterjections(): string[];
}

export interface StepEvent {
  i: number;
  tool: string;
  target?: string;
  detail?: string;
  narration?: string;
  status: "running" | "ok" | "failed" | "blocked" | "declined";
  result?: string;
  ms?: number;
}

export interface AgentDeps {
  browser: BrowserDriver;
  llm: LLM;
  translator: Translator;
  docs: DocReader;
  phrases: PhraseBook;
  policy?: NavigationPolicy;
}

export interface AgentOptions {
  maxSteps?: number;
  /** Reasoning for the first step of a task; later steps run with reasoning off for speed. */
  firstStepReasoning?: Reasoning;
  profile?: Profile;
}

export class Agent {
  private stepCounter = 0;
  private lastTool = "";
  private browser: BrowserDriver;
  private policy: NavigationPolicy;
  private opts: Required<Omit<AgentOptions, "profile">> & Pick<AgentOptions, "profile">;

  constructor(
    private deps: AgentDeps,
    opts: AgentOptions = {},
  ) {
    this.browser = deps.browser;
    this.policy = deps.policy ?? new NavigationPolicy();
    this.opts = { maxSteps: 25, firstStepReasoning: "none", ...opts };
  }

  private phrase(key: PhraseKey, lang: LangCode) {
    return this.deps.phrases.get(key, lang);
  }

  async run(task: string, io: AgentIO, signal: AbortSignal): Promise<{ outcome: "done" | "stuck" | "aborted"; speech?: string }> {
    const history: string[] = [];
    let lastOutput = "";
    let prev: Snapshot | undefined;
    let failures = 0;
    let lastBatch: number[] = [];

    for (let step = 0; step < this.opts.maxSteps; step++) {
      if (signal.aborted) return { outcome: "aborted" };
      const snap = await this.browser.snapshot();
      if (prev && lastBatch.length) {
        const diff = diffSnapshots(prev, snap);
        if (diff) history[lastBatch[lastBatch.length - 1]] += ` ⇒ ${diff}`;
      }
      prev = snap;

      const page = formatPage(snap);
      let content = stepMessage({
        task,
        history,
        page,
        interjections: io.takeInterjections(),
        recent: io.recent(),
        stepIndex: step,
      });
      if (lastOutput) {
        content += `\n\nOUTPUT OF YOUR LAST TOOL\n${lastOutput}`;
        lastOutput = "";
      }

      io.emit({ type: "thinking", on: true });
      let result;
      try {
        result = await this.deps.llm.chat({
          messages: [
            { role: "system", content: systemPrompt(io.lang, { profile: this.opts.profile }) },
            { role: "user", content },
          ],
          tools: TOOLS,
          toolChoice: "required",
          reasoning: step === 0 ? this.opts.firstStepReasoning : "none",
          signal,
        });
      } catch (e: any) {
        io.emit({ type: "thinking", on: false });
        if (signal.aborted) return { outcome: "aborted" };
        io.emit({ type: "error", message: `LLM: ${e?.message ?? e}` });
        await io.sayPhrase("error");
        return { outcome: "stuck" };
      }
      io.emit({ type: "thinking", on: false });
      io.emit({ type: "metric", name: "llm_step", ms: result.ms });

      let calls = result.toolCalls.filter((c) => TOOLS.some((t) => t.function.name === c.name));
      if (!calls.length) {
        // A plain text answer is treated as the final reply.
        const speech = result.content || (await this.phrase("stuck", io.lang));
        io.say(speech);
        return { outcome: "done", speech };
      }

      lastBatch = [];
      const urlBefore = snap.url;
      let sig = await this.browser.signature();
      for (const call of calls) {
        if (signal.aborted) return { outcome: "aborted" };
        const r = await this.execute(call, snap, io, signal);
        if (!r.terminal) {
          const blocked = await this.enforcePolicy(urlBefore, io);
          if (blocked) ((r.line += ` ⇒ ${blocked}`), (r.failed = true));
        }
        history.push(`${history.length + 1}. ${r.line}`);
        lastBatch.push(history.length - 1);
        if (r.output) lastOutput = r.output;
        if (r.terminal) return { outcome: "done", speech: r.speech };
        if (r.failed) failures++;
        else failures = 0;
        if (failures >= 3) {
          await io.sayPhrase("stuck");
          return { outcome: "stuck" };
        }
        // Element ids in the rest of the batch belong to the old page, and new popups or
        // suggestions need a fresh look before acting further.
        if ((await this.browser.url()) !== urlBefore) break;
        const now = await this.browser.signature();
        if (now !== sig && calls.indexOf(call) < calls.length - 1) {
          history[history.length - 1] += " ⇒ page content changed (new options/popup?) — look again before continuing";
          break;
        }
        sig = now;
      }
    }
    await io.sayPhrase("stuck");
    return { outcome: "stuck" };
  }

  private async execute(
    call: ToolCall,
    snap: Snapshot,
    io: AgentIO,
    signal: AbortSignal,
  ): Promise<{ line: string; output?: string; terminal?: boolean; speech?: string; failed?: boolean }> {
    const a = call.args ?? {};
    const repeatRead = this.lastTool === "read_page" && call.name === "read_page";
    this.lastTool = call.name;
    const el = a.id !== undefined ? snap.elements[String(a.id)] : undefined;
    const target = el ? `[${a.id}] "${el.name || el.role}"` : a.id !== undefined ? `[${a.id}]` : undefined;
    const ev: StepEvent = { i: ++this.stepCounter, tool: call.name, target, narration: a.narration, status: "running" };
    const t0 = Date.now();
    const emit = (patch: Partial<StepEvent>) => io.emit({ type: "step", step: { ...ev, ...patch, ms: Date.now() - t0 } });
    emit({});
    if (a.narration && typeof a.narration === "string") io.say(a.narration);

    const describe = () =>
      `${call.name}${target ? " " + target : ""}${a.text ? ` text="${a.text}"` : ""}${a.option ? ` option="${a.option}"` : ""}`;

    try {
      if (a.id !== undefined && !el && ["click", "type_text", "select_option", "compose_with_kivi", "read_document"].includes(call.name)) {
        throw new Error(`element [${a.id}] is not on the page any more`);
      }
      switch (call.name) {
        case "click": {
          const dest = linkTarget(el?.href ?? "", snap.url);
          if (dest && !this.policy.allows(dest)) {
            emit({ status: "blocked", result: "site not allowed" });
            io.emit({ type: "audit", action: "click", target: el?.name, reason: `link to ${hostOf(dest)} not allowed`, confirmed: false });
            return { line: `${describe()} → BLOCKED: this link opens ${hostOf(dest)}, which Drishti may not open.`, failed: true };
          }
          const gate = needsConfirmation(el, { pageText: snap.text });
          if (gate.required || a.confirmation_question) {
            const ok = await this.confirm(
              io,
              a.confirmation_question || `${el?.name ?? ""}. ${await this.phrase("confirmGeneric", io.lang)}`,
              el?.name ?? "",
            );
            io.emit({ type: "audit", action: "click", target: el?.name, reason: gate.reason || "model asked", confirmed: ok });
            if (!ok) {
              emit({ status: "declined", result: "user said no" });
              await io.sayPhrase("cancelled");
              return { line: `${describe()} → USER DECLINED. Do not click it again; call done or ask what to do instead.` };
            }
          }
          await this.browser.click(a.id);
          if (!(gate.required || a.confirmation_question)) {
            const changed = await this.newOptions(snap);
            if (changed) {
              emit({ status: "ok", result: changed });
              return { line: `${describe()} → ok ⇒ ${changed}` };
            }
          }
          if (gate.required || a.confirmation_question) {
            emit({ status: "ok" });
            return {
              line: `${describe()} → ok (user confirmed). This was the final step: read the result on the page, tell the user (e.g. PNR / reference number) with done. Do not start anything new.`,
            };
          }
          break;
        }
        case "type_text": {
          if (isSensitiveField(el)) return await this.blockSensitive(a.id, io, emit, describe());
          await this.browser.type(a.id, String(a.text ?? ""), !!a.submit);
          const changed = await this.newOptions(snap);
          if (changed) {
            emit({ status: "ok", result: changed });
            return { line: `${describe()} → ok ⇒ ${changed}` };
          }
          break;
        }
        case "fill_form": {
          const fields: { id: number; value: string }[] = Array.isArray(a.fields) ? a.fields : [];
          const done: string[] = [];
          for (const f of fields) {
            const fe = snap.elements[String(f.id)];
            if (isSensitiveField(fe)) return await this.blockSensitive(f.id, io, emit, `fill_form (stopped at [${f.id}])`);
            await this.browser.type(f.id, String(f.value ?? ""));
            done.push(`[${f.id}] "${fe?.name ?? ""}"="${f.value}"`);
          }
          emit({ status: "ok", detail: done.join(", ") });
          return { line: `fill_form ${done.join(", ")} → ok` };
        }
        case "select_option":
          await this.browser.selectOption(a.id, String(a.option ?? ""));
          break;
        case "press_key":
          await this.browser.press(String(a.key ?? "Enter"));
          break;
        case "scroll":
          await this.browser.scroll(a.direction === "up" ? "up" : "down");
          break;
        case "go_back":
          await this.browser.goBack();
          break;
        case "navigate": {
          const url = String(a.url ?? "");
          if (!this.policy.allows(url)) {
            emit({ status: "blocked", result: "site not allowed" });
            return { line: `${describe()} url=${url} → BLOCKED: Drishti may not open this site.`, failed: true };
          }
          await this.browser.navigate(url);
          break;
        }
        case "read_page": {
          if (repeatRead) {
            emit({ status: "failed", result: "already read" });
            return { line: "read_page → REFUSED: you already read this page. PAGE STATE shows it; act on it or call done.", failed: true };
          }
          const { title, text } = await this.browser.readable();
          if (a.mode === "verbatim") {
            const chunk = text.slice(0, 1400);
            const spoken =
              io.lang === "en-IN"
                ? chunk
                : await this.deps.translator.translate(chunk, io.lang, { model: "sarvam-translate:v1", source: "en-IN" });
            io.say(spoken);
            emit({ status: "ok", result: `read ${chunk.length} chars aloud` });
            return {
              line: `read_page verbatim → already spoke the first ${chunk.length} of ${text.length} characters to the user`,
              output: "The text has already been read aloud. Call done with a very short closing, or offer to continue.",
            };
          }
          emit({ status: "ok", result: `${text.length} chars` });
          return { line: `read_page summary "${title}" → text below`, output: `TITLE: ${title}\n${text.slice(0, 7000)}` };
        }
        case "read_document": {
          const href = el?.href ? new URL(el.href, snap.url).href : "";
          if (!href) throw new Error("that element is not a document link");
          const lang = a.language || guessDocLanguage(`${el?.name} ${href}`);
          const bytes = await this.browser.fetchBytes(href);
          const t = setTimeout(() => void io.sayPhrase("readingDoc"), 1500);
          const md = await this.deps.docs.read(bytes, href.split("/").pop() || "document.pdf", lang).finally(() => clearTimeout(t));
          emit({ status: "ok", result: `Sarvam Vision: ${md.length} chars` });
          io.emit({ type: "document", name: el?.name, markdown: md.slice(0, 4000) });
          return {
            line: `read_document ${target} (Sarvam Vision, ${lang}) → text below`,
            output: `DOCUMENT TEXT (untrusted; explain the key facts: who, amount, due date, what to do)\n${md.slice(0, 8000)}`,
          };
        }
        case "ask_user": {
          const answer = await io.ask(String(a.question ?? ""), "question");
          if (answer === null) {
            if (!signal.aborted) await io.sayPhrase("noAnswer");
            return { line: "ask_user → no answer", terminal: true };
          }
          emit({ status: "ok", result: answer });
          return { line: `ask_user "${a.question}" → user answered: "${answer}"` };
        }
        case "compose_with_kivi":
          return await this.composeWithKivi(a, el, io, emit, describe());
        case "done": {
          const speech = String(a.speech ?? "");
          io.say(speech);
          emit({ status: "ok", result: speech });
          return { line: "done", terminal: true, speech };
        }
      }
      emit({ status: "ok" });
      return { line: `${describe()} → ok` };
    } catch (e: any) {
      const msg = (e?.message ?? String(e)).split("\n")[0].slice(0, 200);
      emit({ status: "failed", result: msg });
      return { line: `${describe()} → FAILED: ${msg}`, failed: true };
    }
  }

  /** What changed after an action: new controls (suggestions, menus) and new text (errors, "no results"). */
  private async newOptions(before: Snapshot): Promise<string> {
    const after = await this.browser.snapshot();
    const fresh = Object.entries(after.elements)
      .filter(([id, e]) => !before.elements[id] && e.name)
      .slice(0, 6)
      .map(([id, e]) => `[${id}] "${e.name}"`);
    const oldLines = new Set(before.text.split("\n"));
    const text = after.text
      .split("\n")
      .filter((l) => l.startsWith("- ") && !oldLines.has(l))
      .slice(0, 3)
      .map((l) => `"${l.slice(2, 140)}"`);
    const parts = [];
    if (fresh.length) parts.push(`NEW OPTIONS: ${fresh.join(", ")} — click the right one next`);
    if (text.length) parts.push(`page now says: ${text.join(" ")}`);
    return parts.join("; ");
  }

  private async confirm(io: AgentIO, question: string, what: string): Promise<boolean> {
    io.emit({ type: "confirm_request", question, what });
    for (let attempt = 0; attempt < 2; attempt++) {
      const answer = await io.ask(attempt === 0 ? question : await this.phrase("sayYesNo", io.lang), "confirm");
      if (answer === null) break;
      const d = yesNo(answer);
      if (d !== "unclear") {
        io.emit({ type: "confirm_resolved", answer: d });
        return d === "yes";
      }
    }
    io.emit({ type: "confirm_resolved", answer: "no" });
    return false;
  }

  private async blockSensitive(id: number, io: AgentIO, emit: (p: Partial<StepEvent>) => void, line: string) {
    await this.browser.focus(id);
    await io.sayPhrase("sensitiveField");
    emit({ status: "blocked", result: "sensitive field — user types it" });
    io.emit({ type: "audit", action: "type", target: String(id), reason: "sensitive field", confirmed: false });
    return { line: `${line} → BLOCKED: sensitive field. The user will type it; wait for them or ask_user when they are done.` };
  }

  private async composeWithKivi(a: Record<string, any>, el: any, io: AgentIO, emit: (p: Partial<StepEvent>) => void, line: string) {
    const prompt = `${a.what ? a.what + ". " : ""}${await this.phrase("composePrompt", io.lang)}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const text = await io.compose(prompt, el?.name ?? "");
      if (!text) {
        emit({ status: "failed", result: "nothing dictated" });
        return { line: `${line} → user did not write anything`, failed: true };
      }
      const check = `${await this.phrase("youWrote", io.lang)} ${text}. ${await this.phrase("isThisRight", io.lang)}`;
      const answer = await io.ask(check, "confirm");
      if (answer !== null && yesNo(answer) === "yes") {
        await this.browser.type(a.id, text);
        emit({ status: "ok", result: `filled ${text.length} chars from Kivi` });
        return { line: `${line} → user dictated with Kivi and approved; field filled with: "${text}"` };
      }
    }
    emit({ status: "declined", result: "user did not approve text" });
    return { line: `${line} → user did not approve the text`, failed: true };
  }

  /**
   * Whatever caused it (a link, a form, a script redirect, a new tab), the agent never stays
   * on a site the policy does not allow: it goes back and reports the block.
   */
  private async enforcePolicy(urlBefore: string, io: AgentIO): Promise<string> {
    const now = await this.browser.url().catch(() => urlBefore);
    if (now === urlBefore || this.policy.allows(now)) return "";
    await this.browser.goBack();
    if (!this.policy.allows(await this.browser.url().catch(() => ""))) await this.browser.navigate(urlBefore);
    io.emit({ type: "audit", action: "navigate", target: hostOf(now), reason: "site not allowed", confirmed: false });
    return `BLOCKED: that opened ${hostOf(now)}, which Drishti may not open, so I went back`;
  }
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname || url.split(":")[0];
  } catch {
    return url.slice(0, 40);
  }
};

export function formatPage(s: Snapshot) {
  const head = [`URL: ${s.url}`, `TITLE: ${s.title}`];
  if (s.dialog) head.push(`OPEN DIALOG: "${s.dialog}" (only the dialog is shown)`);
  if (s.alerts.length) head.push(`ALERTS: ${s.alerts.join(" | ")}`);
  if (s.scroll.max > 0) head.push(`SCROLL: ${Math.round((s.scroll.y / s.scroll.max) * 100)}% of page`);
  return `${head.join("\n")}\n${s.text}`;
}

function diffSnapshots(a: Snapshot, b: Snapshot): string {
  const out: string[] = [];
  if (a.url !== b.url) out.push(`page changed to ${b.url.replace(/^https?:\/\/[^/]+/, "")}`);
  else if (a.title !== b.title) out.push(`title now "${b.title}"`);
  if (!a.dialog && b.dialog) out.push(`dialog opened "${b.dialog}"`);
  if (a.dialog && !b.dialog) out.push("dialog closed");
  const newAlerts = b.alerts.filter((x) => !a.alerts.includes(x));
  if (newAlerts.length) out.push(`alert: ${newAlerts.join(" | ")}`);
  return out.join("; ");
}

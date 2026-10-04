import { guessDocLanguage, type LangCode } from "../lang.js";
import type { BrowserDriver, DocReader, ElementInfo, LLM, Profile, Reasoning, Snapshot, ToolCall, Translator } from "../types.js";
import { TOOLS } from "./tools.js";
import { systemPrompt, stepMessage } from "./prompts.js";
import { needsConfirmation, isSensitiveField, yesNo } from "./safety.js";
import { NavigationPolicy, linkTarget } from "./policy.js";
import { looksComplete, readback } from "./readback.js";
import { saidBy } from "./match.js";
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
  /** "Today" for the prompt; fixed in eval so recorded runs replay exactly. */
  now?: () => Date;
}

export class Agent {
  private stepCounter = 0;
  private lastTool = "";
  private tried = new Set<string>();
  /** Everything the user actually said or dictated this task: the only text allowed into free-text fields. */
  private userTexts: string[] = [];
  private browser: BrowserDriver;
  private policy: NavigationPolicy;
  private opts: Required<Omit<AgentOptions, "profile" | "now">> & Pick<AgentOptions, "profile" | "now">;

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
    // Loop guard: the same action on the same unchanged page never helps a second time.
    this.tried = new Set<string>();
    const p = this.opts.profile;
    this.userTexts = [task, ...io.recent(), ...(p ? [p.name, p.age, p.gender, p.mobile].filter((v): v is string => !!v) : [])];
    let unchanged = 0;

    for (let step = 0; step < this.opts.maxSteps; step++) {
      if (signal.aborted) return { outcome: "aborted" };
      const snap = await this.browser.snapshot();
      if (prev && lastBatch.length) {
        const diff = diffSnapshots(prev, snap);
        if (diff) history[lastBatch[lastBatch.length - 1]] += ` ⇒ ${diff}`;
      }
      unchanged = prev && lastBatch.length && fingerprint(prev) === fingerprint(snap) ? unchanged + 1 : 0;
      prev = snap;

      const page = formatPage(snap);
      const interjections = io.takeInterjections();
      this.userTexts.push(...interjections);
      let content = stepMessage({
        task,
        history,
        page,
        interjections,
        recent: io.recent(),
        stepIndex: step,
      });
      if (lastOutput) {
        content += `\n\nOUTPUT OF YOUR LAST TOOL\n${lastOutput}`;
        lastOutput = "";
      }
      const left = this.opts.maxSteps - step;
      if (left <= 3) content += `\n\nSTEP BUDGET: only ${left} step(s) left. Finish with done, or ask_user how to continue.`;
      else if (unchanged >= 3) content += "\n\nNO PROGRESS: your last actions did not change the page. Try a different way, or ask_user.";

      io.emit({ type: "thinking", on: true });
      let result;
      const reasoning = step === 0 ? this.opts.firstStepReasoning : "none";
      // A tool step needs well under 200 tokens. A cap keeps a runaway generation short.
      const maxTokens = reasoning === "none" ? STEP_MAX_TOKENS : 1500;
      const ask = (nudge = "") =>
        this.deps.llm.chat({
          messages: [
            { role: "system", content: systemPrompt(io.lang, { profile: this.opts.profile, now: this.opts.now?.() }) },
            { role: "user", content: content + nudge },
          ],
          tools: TOOLS,
          toolChoice: "required",
          reasoning,
          maxTokens,
          signal,
        });
      try {
        result = await ask();
        const valid = result.toolCalls.some((c) => TOOLS.some((t) => t.function.name === c.name));
        const cutOff = (result.usage?.completion_tokens ?? 0) >= maxTokens;
        if (!valid && (!result.content.trim() || cutOff)) {
          io.emit({ type: "metric", name: "llm_retry", ms: result.ms });
          result = await ask("\n\nYOUR LAST REPLY WAS EMPTY OR CUT OFF. Reply now with tool calls only, no other text.");
        }
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
        const r = await this.execute(call, snap, io, signal, fingerprint(snap));
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
        if (failures >= 4) {
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
    pageKey = "",
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
      if (REPEATABLE.has(call.name)) {
        const key = `${pageKey}|${call.name}|${a.id ?? ""}|${a.text ?? ""}|${a.option ?? ""}|${a.key ?? ""}|${a.url ?? ""}|${JSON.stringify(a.fields ?? "")}`;
        if (this.tried.has(key)) {
          emit({ status: "failed", result: "repeated" });
          return {
            line: `${describe()} → REFUSED: you already did exactly this on this same page and it did not help. Do something different, or ask_user.`,
            failed: true,
          };
        }
        this.tried.add(key);
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
          // The model may add a confirmation, except on clearly harmless controls; it can never remove one.
          const confirmNeeded = gate.required || (!!a.confirmation_question && !gate.safe);
          if (confirmNeeded) {
            // The model's question can be wrong; the readback is what the page itself says.
            const facts = readback(snap, a.id, el);
            const question = a.confirmation_question || `${el?.name ?? ""}. ${await this.phrase("confirmGeneric", io.lang)}`;
            const ok = await this.confirm(
              io,
              facts ? `${question} ${await this.phrase("pageShows", io.lang)} ${facts}.` : question,
              el?.name ?? "",
            );
            io.emit({ type: "audit", action: "click", target: el?.name, reason: gate.reason || "model asked", facts, confirmed: ok });
            if (!ok) {
              emit({ status: "declined", result: "user said no" });
              await io.sayPhrase("cancelled");
              return { line: `${describe()} → USER DECLINED. Do not click it again; call done or ask what to do instead.` };
            }
          }
          await this.browser.click(a.id);
          const { summary, after } = await this.changes(snap);
          const confirmed = confirmNeeded ? " (user confirmed)" : "";
          emit({ status: "ok", result: summary || undefined });
          // After the irreversible step lands on a success page, the task is over: report, don't start again.
          const finished =
            gate.required && looksComplete(after)
              ? " ⇒ The page shows the task is COMPLETE. Report the result with done now; do not start anything new."
              : "";
          return { line: `${describe()} → ok${confirmed}${summary ? ` ⇒ ${summary}` : ""}${finished}` };
        }
        case "type_text": {
          if (isSensitiveField(el)) return await this.blockSensitive(a.id, io, emit, describe());
          if (this.inventedFreeText(el, String(a.text ?? ""))) return this.refuseFreeText(a.id, emit, describe());
          if (this.inventedPersonal(el, String(a.text ?? ""))) return this.refusePersonal(a.id, emit, describe());
          await this.browser.type(a.id, String(a.text ?? ""), !!a.submit);
          const { summary, appeared } = await this.changes(snap);
          emit({ status: "ok", result: summary || undefined });
          if (summary) return { line: `${describe()} → ok ⇒ ${summary}` };
          if (!appeared && !a.submit && isLookupBox(el))
            return {
              line: `${describe()} → ok, but no suggestions appeared. If this box needs a choice from a list, try another spelling or a shorter word.`,
            };
          break;
        }
        case "fill_form": {
          const fields: { id: number; value: string }[] = Array.isArray(a.fields) ? a.fields : [];
          const done: string[] = [];
          let base = snap;
          for (const f of fields) {
            const fe = snap.elements[String(f.id)];
            const rest = `${done.length ? ` Filled: ${done.join(", ")}.` : ""}`;
            if (!fe) return { line: `fill_form → FAILED at [${f.id}]: not on the page any more.${rest}`, failed: true };
            if (isSensitiveField(fe)) return await this.blockSensitive(f.id, io, emit, `fill_form (stopped at [${f.id}])`);
            if (this.inventedFreeText(fe, String(f.value ?? "")))
              return this.refuseFreeText(f.id, emit, `fill_form (stopped at [${f.id}])${rest}`);
            if (this.inventedPersonal(fe, String(f.value ?? "")))
              return this.refusePersonal(f.id, emit, `fill_form (stopped at [${f.id}])${rest}`);
            if (!TEXT_ROLES.has(fe.role)) {
              emit({ status: "failed", result: `[${f.id}] is not a text field` });
              return {
                line: `fill_form → STOPPED at [${f.id}] "${fe.name}": it is a ${fe.role}, not a text field — click or select it instead.${rest}`,
                failed: true,
              };
            }
            await this.browser.type(f.id, String(f.value ?? ""));
            done.push(`[${f.id}] "${fe.name}"="${f.value}"`);
            const c = await this.changes(base);
            base = c.after;
            if (c.summary && f !== fields[fields.length - 1]) {
              emit({ status: "ok", detail: done.join(", ") });
              return { line: `fill_form ${done.join(", ")} → STOPPED early ⇒ ${c.summary}. Handle this, then fill the remaining fields.` };
            }
          }
          emit({ status: "ok", detail: done.join(", ") });
          return { line: `fill_form ${done.join(", ")} → ok` };
        }
        case "select_option":
          if (el && TEXT_ROLES.has(el.role) && el.tag !== "select") {
            emit({ status: "failed", result: "not a dropdown" });
            return {
              line: `${describe()} → REFUSED: [${a.id}] is a text box, not a dropdown. type_text into it, then click one of the suggestions.`,
              failed: true,
            };
          }
          if (el && el.tag !== "select") return await this.chooseFromCustomList(a.id, String(a.option ?? ""), snap, emit, describe());
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
            // About 30 seconds of speech; the user can ask for more. Keeps translation cheap.
            const chunk = text.slice(0, VERBATIM_CHARS);
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
          if (answer) this.userTexts.push(answer);
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

  /**
   * What an action changed, in words the model can act on: new controls (suggestions, menus)
   * and new text (errors, "no results"). Navigation and dialogs are reported at the next step.
   */
  private async changes(before: Snapshot): Promise<{ summary: string; appeared: boolean; after: Snapshot }> {
    const after = await this.browser.snapshot();
    if (after.url !== before.url || after.dialog !== before.dialog) return { summary: "", appeared: true, after };
    const had = new Set(Object.values(before.elements).map((e) => `${e.role}|${e.name}`));
    const fresh = Object.entries(after.elements)
      .filter(([id, e]) => !before.elements[id] && e.name && !had.has(`${e.role}|${e.name}`))
      .slice(0, 6)
      .map(([id, e]) => `[${id}] "${e.name}"`);
    const oldLines = new Set(before.text.split("\n"));
    const text = after.text
      .split("\n")
      .filter((l) => l.startsWith("- ") && !oldLines.has(l))
      .slice(0, 3)
      .map((l) => `"${l.slice(2, 140)}"`);
    const newAlerts = after.alerts.filter((x) => !before.alerts.includes(x));
    const parts = [];
    if (fresh.length) parts.push(`NEW OPTIONS: ${fresh.join(", ")} — click the right one next`);
    if (newAlerts.length) parts.push(`ALERT: ${newAlerts.join(" | ")}`);
    else if (text.length) parts.push(`page now says: ${text.join(" ")}`);
    return { summary: parts.join("; "), appeared: fresh.length > 0 || after.text !== before.text, after };
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

  /**
   * Custom dropdowns hide their options until opened. Open it, look at what actually appeared,
   * and click the closest match, or list the real options so the model can pick one.
   */
  private async chooseFromCustomList(id: number, option: string, snap: Snapshot, emit: (p: Partial<StepEvent>) => void, line: string) {
    await this.browser.click(id);
    const { after } = await this.changes(snap);
    const shown = Object.entries(after.elements).filter(([i, e]) => !snap.elements[i] && e.name);
    const pick = bestMatch(shown, option);
    if (!pick) {
      const list = shown
        .slice(0, 12)
        .map(([i, e]) => `[${i}] "${e.name}"`)
        .join(", ");
      emit({ status: "failed", result: `no option like "${option}"` });
      return {
        line: `${line} → opened the list, but no option is like "${option}". ${list ? `Options: ${list}. Click the right one.` : "No options appeared."}`,
        failed: true,
      };
    }
    await this.browser.click(pick[0]);
    emit({ status: "ok", result: `chose "${pick[1].name}"` });
    return { line: `${line} → chose [${pick[0]}] "${pick[1].name}"` };
  }

  /**
   * A complaint, message or review must be in the user's own words. Long text for a free-text
   * field that the user never said or dictated was written by the model: refuse it.
   */
  private inventedFreeText(el: ElementInfo | undefined, text: string) {
    if (!el || !isFreeTextField(el) || text.trim().length <= 30) return false;
    const norm = (t: string) =>
      t
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
    const said = norm(this.userTexts.join(" \n "));
    return !said.includes(norm(text));
  }

  /** Names, ages, phone numbers and addresses must come from the profile or the user, never be made up. */
  private inventedPersonal(el: ElementInfo | undefined, text: string) {
    if (!el || !isPersonalField(el) || !text.trim()) return false;
    return !saidBy(this.userTexts, text);
  }

  private refusePersonal(id: number, emit: (p: Partial<StepEvent>) => void, line: string) {
    emit({ status: "blocked", result: "personal details must come from the user" });
    return {
      line: `${line} → REFUSED: [${id}] asks for personal details, and this value did not come from the user or their saved profile. Never invent names, ages, phone numbers or addresses: ask_user for them.`,
      failed: true,
    };
  }

  private refuseFreeText(id: number, emit: (p: Partial<StepEvent>) => void, line: string) {
    emit({ status: "blocked", result: "free text must come from the user" });
    return {
      line: `${line} → REFUSED: [${id}] is a free-text field. Never write the user's message yourself. Use compose_with_kivi so the user dictates it in their own words.`,
      failed: true,
    };
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
        this.userTexts.push(text);
        await this.browser.type(a.id, text);
        emit({ status: "ok", result: `filled ${text.length} chars from Kivi` });
        return { line: `${line} → user dictated with Kivi and approved; field filled with: "${text}"` };
      }
    }
    emit({ status: "declined", result: "user did not approve text" });
    return {
      line: `${line} → the user rejected the dictated text 3 times. Do not start dictation again on your own: ask_user whether to try again or stop.`,
      failed: true,
    };
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

/** Actions that are pointless to repeat verbatim on an unchanged page. */
const REPEATABLE = new Set(["click", "type_text", "fill_form", "select_option", "press_key", "navigate"]);
const VERBATIM_CHARS = 800;
const TEXT_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);

/** A box where typing should bring up suggestions (stations, cities, search). */
function isLookupBox(el: { role: string; name: string; fieldHint: string } | undefined) {
  if (!el) return false;
  return (
    el.role === "combobox" ||
    el.role === "searchbox" ||
    /from|to|station|city|search|where|destination|origin/i.test(`${el.name} ${el.fieldHint}`)
  );
}

/** Identity of a page state: same URL, dialog and visible outline. */
function fingerprint(s: Snapshot) {
  let h = 0;
  const str = `${s.url}|${s.dialog}|${s.text}`;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return String(h);
}

const STEP_MAX_TOKENS = 600;

/** Fields for the user's own words: complaints, messages, reviews, descriptions, addresses. */
function isFreeTextField(el: ElementInfo) {
  if (el.tag === "textarea") return true;
  if (!["textbox", "searchbox"].includes(el.role) && el.tag !== "div") return false;
  return /complain|comment|message|feedback|describe|description|details|review|grievance|query|issue|remarks|शिकायत|संदेश/i.test(
    `${el.name} ${el.fieldHint}`,
  );
}

/** The option whose name best matches what the model asked for: exact, then contains, then shared words. */
function bestMatch(options: [string, ElementInfo][], want: string): [string, ElementInfo] | undefined {
  const norm = (t: string) =>
    t
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const w = norm(want);
  if (!w) return undefined;
  const exact = options.find(([, e]) => norm(e.name) === w);
  if (exact) return exact;
  const contains = options.find(([, e]) => norm(e.name).includes(w) || w.includes(norm(e.name)));
  if (contains) return contains;
  const words = new Set(w.split(" ").filter((x) => x.length > 2));
  let best: [string, ElementInfo] | undefined;
  let score = 0;
  for (const o of options) {
    const s = norm(o[1].name)
      .split(" ")
      .filter((x) => words.has(x)).length;
    if (s > score) ((best = o), (score = s));
  }
  return best;
}

/** Fields about a real person: their name, age, phone, email or address. */
function isPersonalField(el: ElementInfo) {
  if (!TEXT_ROLES.has(el.role)) return false;
  if (/search|from|to\b|station|city|captcha|promo|coupon/i.test(el.name)) return false;
  return /\b(name|age|mobile|phone|e-?mail|address|pin ?code|postal)\b|नाम|उम्र|मोबाइल|\btel\b|given-name|family-name|street-address/i.test(
    `${el.name} ${el.fieldHint} ${el.autocomplete}`,
  );
}

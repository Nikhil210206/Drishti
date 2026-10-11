import { guessDocLanguage, type LangCode } from "../lang.js";
import type { BrowserDriver, DocReader, ElementInfo, LLM, Profile, Reasoning, Snapshot, ToolCall, Translator } from "../types.js";
import { TOOLS } from "./tools.js";
import { stepMessage, stuckPrompt, systemPrompt } from "./prompts.js";
import { needsConfirmation, isSensitiveField, givesUp, yesNo } from "./safety.js";
import { NavigationPolicy, linkTarget } from "./policy.js";
import { duplicatePassenger, looksComplete, readback, spokenFacts, type SpokenFacts } from "./readback.js";
import { saidBy } from "./match.js";
import { classMismatch, quotaMismatch, requestedQuotas } from "./classes.js";
import { dateMismatch, urlDateMismatch } from "./dates.js";
import { passengerMismatch } from "./passengers.js";
import { refusalPhrase, type PhraseBook, type PhraseKey } from "./phrases.js";

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
  /** Clicks refused for not matching the request: not done, so allowed again once the user has answered. */
  private refused = new Set<string>();
  private declines = 0;
  private composeRejections = 0;
  /** Custom dropdowns already set this task: id → the option chosen. */
  private chosen = new Map<string, string>();
  /** The options clicked to set them: option id → its dropdown's id. */
  private chosenVia = new Map<string, string>();
  /** Options seen in a custom list: option id → the dropdown that opened it and the option's name. */
  private optionOf = new Map<string, { toggle: string; name: string }>();
  /** The page as it was when a dialog opened over it. */
  private underDialog: Snapshot | undefined;
  /** An answer for the wrong day was already sent back once this task. */
  private dateRefused = false;
  /** The payment the user said yes to this task: what later steps of it may carry on under. */
  private consent?: SpokenFacts;
  /** The user said to leave it: only done is allowed from here. */
  private gaveUp = false;
  /** Sensitive fields handed to the user to type. */
  private handedOver = new Set<string>();
  /** Typings that found no suggestion at all, per field, this task. */
  private misses = new Map<string, number>();
  /** Everything the user actually said or dictated this task: the only text allowed into free-text fields. */
  private userTexts: string[] = [];
  /** What the user dictated or answered, as opposed to the request itself. */
  private userWords: string[] = [];
  /** The request and what the user said since, this task only: where a passenger count is read from. */
  private said: string[] = [];
  /** How much the user had said when a payment was refused over the passenger count. */
  private countRefusedAt?: number;
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

  /** Use (or, with nothing, forget) the saved profile from the next task on. */
  setProfile(profile?: Profile) {
    this.opts.profile = profile;
  }

  async run(task: string, io: AgentIO, signal: AbortSignal): Promise<{ outcome: "done" | "stuck" | "aborted"; speech?: string }> {
    const history: string[] = [];
    let lastOutput = "";
    let prev: Snapshot | undefined;
    let failures = 0;
    let lastBatch: number[] = [];
    // Loop guard: the same action on the same unchanged page never helps a second time.
    this.tried = new Set<string>();
    this.refused = new Set<string>();
    this.declines = 0;
    this.composeRejections = 0;
    this.chosen = new Map();
    this.chosenVia = new Map();
    this.optionOf = new Map();
    this.underDialog = undefined;
    this.dateRefused = false;
    this.consent = undefined;
    this.gaveUp = false;
    this.handedOver = new Set();
    this.misses = new Map();
    const p = this.opts.profile;
    this.userWords = [];
    this.said = [task];
    this.countRefusedAt = undefined;
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
      this.said.push(...interjections);
      let content = stepMessage({
        task,
        history,
        page,
        interjections,
        recent: io.recent(),
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
      const ask = (nudge = "", stop: string[] | undefined = RUNAWAY_STOPS) =>
        this.deps.llm.chat({
          messages: [
            { role: "system", content: systemPrompt(io.lang, { profile: this.opts.profile, now: this.opts.now?.() }) },
            { role: "user", content: content + nudge },
          ],
          tools: TOOLS,
          toolChoice: "required",
          reasoning,
          maxTokens,
          stop,
          signal,
        });
      try {
        result = await ask();
        const valid = result.toolCalls.some((c) => TOOLS.some((t) => t.function.name === c.name));
        const cutOff = (result.usage?.completion_tokens ?? 0) >= maxTokens;
        if (!valid && (!result.content.trim() || cutOff)) {
          io.emit({ type: "metric", name: "llm_retry", ms: result.ms });
          // Without the stop strings: live runs had replies stopped before any tool call (twice in a row).
          result = await ask("\n\nYOUR LAST REPLY WAS EMPTY OR CUT OFF. Reply now with tool calls only, no other text.", undefined);
        }
      } catch (e: any) {
        io.emit({ type: "thinking", on: false });
        if (signal.aborted) return { outcome: "aborted" };
        io.emit({ type: "error", message: `LLM: ${e?.message ?? e}` });
        await io.sayPhrase(refusalPhrase(e) ?? "error");
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
      let cur = snap;
      for (const [k, call] of calls.entries()) {
        if (signal.aborted) return { outcome: "aborted" };
        const r = await this.execute(call, cur, io, signal, fingerprint(cur), k < calls.length - 1);
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
          await this.explainStop(task, history, io, signal);
          return { outcome: "stuck" };
        }
        if (k === calls.length - 1) break;
        // The rest of the batch was planned on the old page. Carry on while the page only changed
        // in place (a value filled, a suggestion chosen, a button renamed); stop when the model
        // needs to look again first.
        const after = (await this.browser.url()) !== urlBefore ? undefined : await this.browser.snapshot();
        // The model often plans its own click on the suggestion too; once one was picked, that click is moot.
        const nextId = calls[k + 1].args?.id;
        if (r.picked && after && calls[k + 1].name === "click" && nextId !== undefined && !after.elements[String(nextId)]) {
          calls.splice(k + 1, 1);
          history[history.length - 1] += ` (your click on [${nextId}] was not needed)`;
          if (!calls[k + 1]) break;
        }
        const stop = r.failed ? "this failed" : after ? batchStop(cur, after, calls[k + 1]) : "the page changed";
        if (stop) {
          const skipped = calls
            .slice(k + 1)
            .map((c) => {
              const t = cur.elements[String(c.args?.id)];
              return `${c.name}${c.args?.id !== undefined ? ` [${c.args.id}]${t ? ` "${t.name.slice(0, 40)}"` : ""}` : ""}`;
            })
            .join(", ");
          history[history.length - 1] += ` ⇒ ${stop}, so these calls were skipped: ${skipped}. Look again, then redo the ones still needed`;
          break;
        }
        cur = after!;
      }
    }
    await this.explainStop(task, history, io, signal);
    return { outcome: "stuck" };
  }

  /**
   * Giving up: say why, in the user's language, and what they could say next, instead of a fixed
   * "I'm stuck, tell me what to try". A live run said only that after ten tries at a station the
   * site doesn't have, leaving a blind user nothing to go on. The fixed phrase is the fallback.
   */
  private async explainStop(task: string, history: string[], io: AgentIO, signal: AbortSignal) {
    try {
      const r = await this.deps.llm.chat({
        messages: [
          { role: "system", content: stuckPrompt(io.lang) },
          { role: "user", content: `The user asked: ${task}\n\nWhat happened, step by step:\n${history.slice(-12).join("\n")}` },
        ],
        reasoning: "none",
        maxTokens: 200,
        signal,
      });
      const speech = r.content.replace(/\[\d+\]/g, "").trim();
      if (speech) return io.say(speech);
    } catch {}
    if (!signal.aborted) await io.sayPhrase("stuck");
  }

  private async execute(
    call: ToolCall,
    snap: Snapshot,
    io: AgentIO,
    signal: AbortSignal,
    pageKey = "",
    more = false,
  ): Promise<{ line: string; output?: string; terminal?: boolean; speech?: string; failed?: boolean; picked?: boolean }> {
    const a = call.args ?? {};
    const repeatRead = this.lastTool === "read_page" && call.name === "read_page";
    this.lastTool = call.name;
    const el = a.id !== undefined ? snap.elements[String(a.id)] : undefined;
    const target = el ? `[${a.id}] "${el.name || el.role}"` : a.id !== undefined ? `[${a.id}]` : undefined;
    const ev: StepEvent = { i: ++this.stepCounter, tool: call.name, target, narration: a.narration, status: "running" };
    const t0 = Date.now();
    const emit = (patch: Partial<StepEvent>) => io.emit({ type: "step", step: { ...ev, ...patch, ms: Date.now() - t0 } });
    // The narration is shown with the step, not spoken: spoken, every step was slow to sit through,
    // often in English for users of other languages, and most of a task's speech cost. The session
    // says "still working" during long silences instead.
    emit({});

    // A trace carried on filling a complaint after the user said "नहीं, रहने दो" (no, leave it).
    if (this.gaveUp && call.name !== "done") {
      emit({ status: "blocked", result: "the user said to stop" });
      return {
        line: `${call.name} → REFUSED: the user said to leave it. Call done now and tell them nothing was sent, submitted or booked.`,
        failed: true,
      };
    }
    const describe = () =>
      `${call.name}${target ? " " + target : ""}${a.text ? ` text="${a.text}"` : ""}${a.pick_suggestion ? ` pick="${a.pick_suggestion}"` : ""}${a.option ? ` option="${a.option}"` : ""}${call.name === "navigate" && a.url ? ` url="${a.url}"` : ""}`;

    try {
      // An option clicked again after its list closed (traces: three turns on a gone "Cleanliness").
      const toggle = call.name === "click" && !el ? this.chosenVia.get(String(a.id)) : undefined;
      if (toggle && snap.elements[toggle]) {
        emit({ status: "ok", result: "already chosen" });
        return {
          line: `${describe()} → not needed: you already chose it, and [${toggle}] shows "${snap.elements[toggle].name}". Carry on with the rest of the form.`,
        };
      }
      // An option whose list has since closed (the model clicked the date, then the class it saw
      // earlier; three live runs got stuck this way): reopen the list and choose it by name.
      const opt = !el && (call.name === "click" || call.name === "select_option") ? this.optionOf.get(String(a.id)) : undefined;
      if (opt && snap.elements[opt.toggle])
        return await this.chooseFromCustomList(
          Number(opt.toggle),
          opt.name,
          snap,
          emit,
          `${call.name} [${a.id}] "${opt.name}" (its list had closed, so reopened [${opt.toggle}])`,
        );
      if (a.id !== undefined && !el && ["click", "type_text", "select_option", "compose_with_kivi", "read_document"].includes(call.name)) {
        throw new Error(`element [${a.id}] is not on the page any more`);
      }
      // Reopening a dropdown that already shows the chosen option only costs turns (traces: the
      // complaint category reopened after every hiccup). Not a failure: the rest of the batch runs.
      const set = call.name === "click" ? this.chosen.get(String(a.id)) : undefined;
      if (el && set && el.name.toLowerCase().includes(set.toLowerCase())) {
        emit({ status: "ok", result: `already "${set}"` });
        return {
          line: `${describe()} → not clicked: [${a.id}] already shows "${set}", which you chose. Carry on with the rest of the form; use select_option only to change it.`,
        };
      }
      // Retyping a value the field already holds: say so and let the batch go on to the button.
      if (call.name === "type_text" && el && TEXT_ROLES.has(el.role) && holds(snap, a.id, el, String(a.text ?? ""))) {
        emit({ status: "ok", result: "already filled" });
        const next = nextButton(snap, a.id);
        const alert = snap.alerts.length ? ` The alert "${snap.alerts[0]}" is from before; it clears only when you submit.` : "";
        return {
          line: `${describe()} → not needed: [${a.id}] already holds this.${alert}${next ? ` Next: click [${next[0]}] "${next[1].name}".` : ""}`,
        };
      }
      let key = "";
      if (REPEATABLE.has(call.name)) {
        key = `${pageKey}|${call.name}|${a.id ?? ""}|${a.text ?? ""}|${a.option ?? ""}|${a.key ?? ""}|${a.url ?? ""}|${JSON.stringify(a.fields ?? "")}`;
        if (this.tried.has(key)) {
          emit({ status: "failed", result: "repeated" });
          const ids = Array.isArray(a.fields) ? a.fields.map((f: any) => Number(f?.id)).filter((n: number) => n >= 0) : [];
          const next = call.name === "fill_form" && ids.length ? nextButton(snap, Math.max(...ids)) : undefined;
          return {
            line: `${describe()} → REFUSED: you already did exactly this on this same page and it did not help. ${next ? `The form is filled: click [${next[0]}] "${next[1].name}".` : "Do something different, or call done and tell the user where things stand."}`,
            failed: true,
          };
        }
        this.tried.add(key);
      }
      switch (call.name) {
        case "click": {
          // Logging in without the password the user is to type: a trace pressed "Log in" five times.
          const waiting = [...this.handedOver.keys()].find((id) => {
            const f = snap.elements[id];
            return f && holds(snap, Number(id), f, "");
          });
          if (el && waiting && /log ?in|sign ?in|submit|continue|verify|next|proceed/i.test(el.name)) {
            emit({ status: "failed", result: "waiting for the user" });
            return {
              line: `${describe()} → not clicked: [${waiting}] "${snap.elements[waiting].name}" is still empty, and only the user may type it. Call done now: tell them to type it and press "${el.name}" themselves, or to ask you to carry on afterwards.`,
              failed: true,
            };
          }
          const dest = linkTarget(el?.href ?? "", snap.url);
          if (dest && !this.policy.allows(dest)) {
            emit({ status: "blocked", result: "site not allowed" });
            io.emit({ type: "audit", action: "click", target: el?.name, reason: `link to ${hostOf(dest)} not allowed`, confirmed: false });
            return { line: `${describe()} → BLOCKED: this link opens ${hostOf(dest)}, which Drishti may not open.`, failed: true };
          }
          if (el && (el.tag === "textarea" || TEXT_ROLES.has(el.role)) && isFreeTextField(el)) {
            emit({ status: "failed", result: "text box" });
            return {
              line: `${describe()} → not clicked: [${a.id}] is a text box for the user's own words. Use compose_with_kivi on it so the user dictates the text.`,
              failed: true,
            };
          }
          const gate = needsConfirmation(el, { pageText: snap.text, id: a.id });
          // The model may add a confirmation, except on clearly harmless controls; it can never remove one.
          const confirmNeeded = gate.required || (!!a.confirmation_question && !gate.safe);
          // The model's question can be wrong; the readback is what the page itself says.
          // A train chosen from a list isn't asked about, but is still checked: the wrong class, quota or
          // date is caught here, before the passengers are filled in.
          const checked = confirmNeeded || !!gate.choice;
          const facts = checked ? readback(snap, a.id, el) : "";
          // Fewer or more passengers than the user asked for: the model once filled in one of two, then
          // asked to pay for "2 passengers". Once refused, whatever the user says next settles it.
          const answered = this.countRefusedAt !== undefined && this.said.length > this.countRefusedAt;
          const count = passengerMismatch(answered ? this.said.slice(this.countRefusedAt) : this.said, facts);
          // Never book what the user did not ask for: another class, quota or date (cheaper, seats left,
          // or an id slip), or the same person twice.
          const mismatch =
            el && !looksLikeDropdown(snap, a.id, el)
              ? classMismatch(this.userTexts, el.name) ||
                classMismatch(this.userTexts, facts) ||
                (checked &&
                  (quotaMismatch(this.userTexts, facts) ||
                    // Results pages state the quota once in their header ("· General quota · 9 trains found").
                    quotaMismatch(this.userTexts, pageLines(snap)))) ||
                dateMismatch(this.userTexts, facts, this.opts.now?.() ?? new Date()) ||
                duplicatePassenger(facts) ||
                count
              : "";
          // Asking "Submit complaint?" about an empty complaint wastes the user's answer and a turn.
          const empty = confirmNeeded ? emptyFreeText(snap, a.id) : undefined;
          if (empty) {
            emit({ status: "failed", result: `[${empty[0]}] is empty` });
            return {
              line: `${describe()} → not clicked: [${empty[0]}] "${empty[1].name}" is still empty. Use compose_with_kivi on it first.`,
              failed: true,
            };
          }
          if (mismatch) {
            if (mismatch === count) this.countRefusedAt ??= this.said.length;
            if (key) this.refused.add(key);
            emit({ status: "blocked", result: "not what the user asked for" });
            io.emit({ type: "audit", action: "click", target: el?.name, reason: mismatch, confirmed: false });
            return {
              line: `${describe()} → REFUSED: ${mismatch}. ${mismatch === count ? "Go back to the passenger details (Edit passengers) and add or remove passengers to match what the user asked" : /passenger/.test(mismatch) ? "Fix the passenger rows first" : "Class, quota and date are chosen on the search form: go back to it (or use Modify search), set them and search again"}; if it is not available, ask_user whether something else is fine.`,
              failed: true,
            };
          }
          if (confirmNeeded) {
            // A payment is said as one short line from the page: the amount, train, date, class,
            // passengers ("Please check before I pay: ₹570; Narmada Superfast Express; Sat, 10 Oct, 2026; AC 3
            // Tier (3A); Passengers Asha Verma (34, Female). Should I go ahead?").
            const spoken = facts ? spokenFacts(facts, { quotaAsked: requestedQuotas(this.userTexts).size > 0 }) : undefined;
            // A yes to paying an amount covers the rest of the same payment ("PROCEED TO PAY", then
            // "PAY ₹570"): one booking used to ask three times. More money or another trip asks again.
            const covered = spoken?.amount !== undefined && this.consent && withinConsent(this.consent, spoken);
            let ok = true;
            if (!covered) {
              let question: string;
              if (spoken?.amount !== undefined) {
                question = `${await this.phrase("confirmLead", io.lang)} ${spoken.text}. ${await this.phrase("confirmGeneric", io.lang)}`;
              } else {
                // The user answers what they hear first, so for a priced control the model's question
                // must name the amount: a live run asked "Do you want to go back?" before PAY ₹220, and
                // got a yes. Otherwise the control's own words lead ("PAY ₹220. Should I go ahead?").
                const modelQuestion = String(a.confirmation_question ?? "");
                const lead =
                  modelQuestion && namesAmount(modelQuestion, el?.name ?? "", facts)
                    ? modelQuestion
                    : `${el?.name ?? ""}. ${await this.phrase("confirmGeneric", io.lang)}`;
                question = facts ? `${lead} ${await this.phrase("pageShows", io.lang)} ${facts}.` : lead;
              }
              ok = await this.confirm(io, question, el?.name ?? "");
              if (ok && spoken?.amount !== undefined) this.consent = spoken;
            }
            io.emit({
              type: "audit",
              action: "click",
              target: el?.name,
              reason: covered ? "already confirmed for this payment" : gate.reason || "model asked",
              facts,
              confirmed: ok,
            });
            if (!ok) {
              emit({ status: "declined", result: "user said no" });
              await io.sayPhrase("cancelled");
              this.declines++;
              return {
                line:
                  this.declines >= 2
                    ? `${describe()} → USER DECLINED again. Stop: call done now and tell the user nothing was booked, paid or sent.`
                    : `${describe()} → USER DECLINED. Do not click it again; call done or ask what to do instead.`,
              };
            }
          }
          await this.browser.click(a.id);
          const { summary: news, after, renamed } = await this.changes(snap);
          const summary = [news, renamed].filter(Boolean).join("; ");
          if (el) this.noteChoice(a.id, el, snap, after);
          if (el && looksLikeDropdown(snap, a.id, el)) this.noteOptions(a.id, snap, after);
          const confirmed = confirmNeeded ? " (user confirmed)" : "";
          emit({ status: "ok", result: summary || undefined });
          // After the irreversible step lands on a success page, the task is over: report, don't start again.
          const finished =
            gate.required && looksComplete(after)
              ? " ⇒ The page shows the task is COMPLETE. Report the result with done now; do not start anything new."
              : "";
          // A fix for a form's alert (a gender after "Select the gender"): the alert stays until the form
          // is sent again. A live run took the quiet "ok" as the end and stopped mid-booking.
          const next = !summary && !finished && after.alerts.length && after.url === snap.url ? nextButton(after, a.id) : undefined;
          const resend = next
            ? ` ⇒ The alert "${after.alerts[0]}" is from before; it clears when you click [${next[0]}] "${next[1].name}" again.`
            : "";
          return { line: `${describe()} → ok${confirmed}${summary ? ` ⇒ ${summary}` : ""}${finished}${resend}` };
        }
        case "type_text": {
          if (isSensitiveField(el)) return await this.blockSensitive(a.id, io, emit, describe());
          // A custom dropdown: typing the option means choosing it.
          if (el && !TEXT_ROLES.has(el.role) && el.tag !== "textarea" && looksLikeDropdown(snap, a.id, el))
            return await this.chooseFromCustomList(a.id, String(a.text ?? ""), snap, emit, describe());
          // A date or choice shown as a button: typing into it only raises a Playwright error.
          if (el && !TEXT_ROLES.has(el.role) && el.tag !== "textarea") {
            emit({ status: "failed", result: "not a text box" });
            return {
              line: `${describe()} → not typed: [${a.id}] is a ${el.role}, not a text box. Click it, then choose from what opens (for a date, the day's button).`,
              failed: true,
            };
          }
          if (this.inventedFreeText(el, String(a.text ?? ""))) return this.refuseFreeText(a.id, emit, describe());
          if (this.inventedPersonal(el, String(a.text ?? ""))) return this.refusePersonal(a.id, emit, describe());
          await this.browser.type(a.id, String(a.text ?? ""), !!a.submit);
          // A station box typed into mid-batch: the model means to carry on, so pick the suggestion
          // that matches what it typed, as if it had given pick_suggestion.
          const pick =
            typeof a.pick_suggestion === "string" && a.pick_suggestion.trim()
              ? a.pick_suggestion
              : more && isStationBox(el)
                ? String(a.text ?? "")
                : "";
          if (pick && !a.submit) return await this.pickSuggestion(pick, snap, emit, describe(), String(a.id));
          const { summary, appeared } = await this.changes(snap, true);
          emit({ status: "ok", result: summary || undefined });
          if (summary) return { line: `${describe()} → ok ⇒ ${summary}` };
          if (!appeared && !a.submit && isLookupBox(el))
            return {
              line: `${describe()} → ok, but no suggestions appeared. If this box needs a choice from a list, try another spelling or a shorter word.`,
              failed: true,
            };
          break;
        }
        case "fill_form": {
          const fields: { id: number; value: string }[] = Array.isArray(a.fields) ? a.fields : [];
          // One value per field and one choice per button group; two people in one row means a
          // missing "+ Add passenger" (traces: the second passenger overwrote the first).
          const choices = fields.map((f) => choiceFor(snap, f.id, String(f.value ?? ""))?.[0]);
          const ids = fields.map((f, i) => choices[i] ?? String(f.id));
          const groups = choices.filter((id): id is string => !!id);
          const twice = ids.find((id, i) => ids.indexOf(id) !== i);
          const clash = groups.find((id, i) =>
            groups.some((other, j) => j < i && other !== id && Math.abs(Number(other) - Number(id)) === 1),
          );
          if (twice || clash) {
            emit({ status: "failed", result: "conflicting fields" });
            return {
              line: `fill_form → REFUSED, nothing filled: ${twice ? `[${twice}] is given twice` : `[${clash}] is a second choice in the same button group`}. Give each field one value. For another passenger, click "+ Add passenger" (or similar) first and fill their own new row.`,
              failed: true,
            };
          }
          const done: string[] = [];
          const already: string[] = [];
          let base = snap;
          for (const f of fields) {
            const fe = snap.elements[String(f.id)];
            const rest = `${done.length ? ` Filled: ${done.join(", ")}.` : ""}`;
            if (!fe) return { line: `fill_form → FAILED at [${f.id}]: not on the page any more.${rest}`, failed: true };
            if (isSensitiveField(fe)) return await this.blockSensitive(f.id, io, emit, `fill_form (stopped at [${f.id}])`);
            if (this.inventedFreeText(fe, String(f.value ?? "")))
              return this.refuseFreeText(f.id, emit, `fill_form (stopped at [${f.id}])${rest}`);
            if (!String(f.value ?? "").trim() && isFreeTextField(fe) && TEXT_ROLES.has(fe.role)) {
              emit({ status: "failed", result: "free text needs dictation" });
              return {
                line: `fill_form (stopped at [${f.id}]) → [${f.id}] "${fe.name}" is for the user's own words, so leave it out of fill_form and use compose_with_kivi on it.${rest}`,
                failed: true,
              };
            }
            if (this.inventedPersonal(fe, String(f.value ?? "")))
              return this.refusePersonal(f.id, emit, `fill_form (stopped at [${f.id}])${rest}`);
            // Refilling a filled form changes nothing; say so instead of letting the model loop.
            if (holds(snap, f.id, fe, String(f.value ?? ""))) {
              already.push(`"${fe.name}"`);
              continue;
            }
            if (fe.tag === "select") {
              await this.browser.selectOption(f.id, String(f.value ?? ""));
            } else if (!TEXT_ROLES.has(fe.role)) {
              // A choice button (gender, berth, yes/no): click the one whose text is the value.
              const choice = choiceFor(snap, f.id, String(f.value ?? ""));
              // An id slip onto a button next to a dropdown that offers this value: set the dropdown.
              const sel = choice ? undefined : nearbySelect(snap, f.id, String(f.value ?? ""));
              if (sel) {
                await this.browser.selectOption(sel[0], String(f.value ?? ""));
                done.push(`[${sel[0]}] "${sel[1].name}"="${f.value}"`);
                base = await this.browser.snapshot();
                continue;
              }
              const stop = !choice
                ? `it is a ${fe.role}, not a text field, and no button next to it says "${f.value}" — click it instead`
                : needsConfirmation(choice[1], { pageText: snap.text }).required
                  ? `"${choice[1].name}" needs the user's confirmation — click it with confirmation_question`
                  : "";
              if (stop) {
                emit({ status: "failed", result: `[${f.id}] is not a text field` });
                return { line: `fill_form → STOPPED at [${f.id}] "${fe.name}": ${stop}.${rest}`, failed: true };
              }
              await this.browser.click(choice![0]);
              done.push(`[${choice![0]}] "${choice![1].name}" clicked`);
              base = await this.browser.snapshot();
              continue;
            } else await this.browser.type(f.id, String(f.value ?? ""));
            done.push(`[${f.id}] "${fe.name}"="${f.value}"`);
            const c = await this.changes(base);
            base = c.after;
            if (c.summary && f !== fields[fields.length - 1]) {
              emit({ status: "ok", detail: done.join(", ") });
              return { line: `fill_form ${done.join(", ")} → STOPPED early ⇒ ${c.summary}. Handle this, then fill the remaining fields.` };
            }
          }
          emit({ status: "ok", detail: done.join(", ") });
          const next = nextButton(base, Math.max(...fields.map((f) => Number(f.id))));
          // Sites keep a validation alert up until the form is submitted again.
          const stale =
            next && base.alerts.length ? ` The alert "${base.alerts[0]}" is from before; it clears only when you click it.` : "";
          const then = next ? ` Next: click [${next[0]}] "${next[1].name}".${stale}` : "";
          if (!done.length) return { line: `fill_form → nothing to do: ${already.join(", ")} already hold these values.${then}` };
          return { line: `fill_form ${done.join(", ")}${already.length ? `; already set: ${already.join(", ")}` : ""} → ok.${then}` };
        }
        case "select_option":
          if (el && TEXT_ROLES.has(el.role) && el.tag !== "select") {
            emit({ status: "failed", result: "not a dropdown" });
            return {
              line: `${describe()} → REFUSED: [${a.id}] is a text box, not a dropdown. type_text into it, then click one of the suggestions.`,
              failed: true,
            };
          }
          // The id of an option in an open list, rather than of its dropdown: just click it.
          if (el && this.optionOf.has(String(a.id))) {
            await this.browser.click(a.id);
            const toggle = this.optionOf.get(String(a.id))!.toggle;
            this.chosen.set(toggle, el.name);
            this.chosenVia.set(String(a.id), toggle);
            emit({ status: "ok", result: `chose "${el.name}"` });
            return { line: `${describe()} → chose [${a.id}] "${el.name}"` };
          }
          if (el && el.tag !== "select" && !looksLikeDropdown(snap, a.id, el)) {
            // Clicking an ordinary button to "open" it would press it (a quota, a filter, a submit).
            emit({ status: "failed", result: "not a dropdown" });
            return {
              line: `${describe()} → REFUSED: [${a.id}] "${el.name}" is a button, not a dropdown, so nothing was clicked. Find the dropdown for "${a.option}" (often marked ▾), or click this button only if you really mean it.`,
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
            return { line: `${describe()} → BLOCKED: Drishti may not open this site.`, failed: true };
          }
          // Guessed addresses on the current site lead to 404s (traces: "/help" on a hash-routed
          // site). Within a site, only go where the page itself links.
          const dest = linkTarget(url, snap.url);
          if (
            dest &&
            sameOrigin(dest, snap.url) &&
            !Object.values(snap.elements).some((e) => e.href && linkTarget(e.href, snap.url) === dest)
          ) {
            emit({ status: "failed", result: "guessed address" });
            return {
              line: `${describe()} → REFUSED: this page does not link to ${url}. Don't guess addresses on this site: use its links, menus and icons (help, account, menu).`,
              failed: true,
            };
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
          if (answer) (this.userTexts.push(answer), this.userWords.push(answer), this.said.push(answer));
          // "Sleeper is fine", "just the one then": the click refused before may now be right.
          if (answer) {
            for (const k of this.refused) this.tried.delete(k);
            this.refused.clear();
          }
          if (answer === null) {
            if (!signal.aborted) await io.sayPhrase("noAnswer");
            return { line: "ask_user → no answer", terminal: true };
          }
          emit({ status: "ok", result: answer });
          if (givesUp(answer)) {
            this.gaveUp = true;
            return {
              line: `ask_user "${a.question}" → user answered: "${answer}" ⇒ The user wants to leave it. Call done now and tell them nothing was sent, submitted or booked.`,
            };
          }
          return { line: `ask_user "${a.question}" → user answered: "${answer}"` };
        }
        case "compose_with_kivi":
          return await this.composeWithKivi(a, el, io, emit, describe());
        case "done": {
          const speech = String(a.speech ?? "");
          // Results for another day than the user asked for: send the answer back once to fix the date.
          const wrongDay = this.dateRefused ? "" : urlDateMismatch(this.userTexts, snap.url, this.opts.now?.() ?? new Date());
          if (wrongDay) {
            this.dateRefused = true;
            emit({ status: "blocked", result: wrongDay });
            return {
              line: `${describe()} → REFUSED: ${wrongDay}. Set the date on the search form and search again; if that day has nothing, tell the user so.`,
              failed: true,
            };
          }
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
  private async changes(
    before: Snapshot,
    typed = false,
  ): Promise<{ summary: string; appeared: boolean; after: Snapshot; renamed: string }> {
    const after = await this.browser.snapshot();
    // A date picker is a dialog: when it closes, say what it set on the page underneath (a live run
    // set 12 Oct, heard only "ok", and reopened the calendar for ten turns).
    if (after.dialog && !before.dialog && after.url === before.url) this.underDialog = before;
    if (!after.dialog && before.dialog && after.url === before.url && this.underDialog) {
      const renamed = renamedBetween(this.underDialog, after);
      this.underDialog = undefined;
      return { summary: "", appeared: true, after, renamed };
    }
    if (after.url !== before.url || after.dialog !== before.dialog) return { summary: "", appeared: true, after, renamed: "" };
    const had = new Set(Object.values(before.elements).map((e) => `${e.role}|${e.name}`));
    const added = Object.entries(after.elements).filter(([id, e]) => !before.elements[id] && e.name && !had.has(`${e.role}|${e.name}`));
    const fresh = added.slice(0, 6).map(([id, e]) => `[${id}] "${e.name}"`);
    // Suggestions and menus are options to pick from; a lone new control (a remove button) is not.
    const options = typed || added.length >= 2 || added.some(([, e]) => /option|menuitem|listitem|treeitem/.test(e.role));
    const oldLines = new Set(before.text.split("\n"));
    const text = after.text
      .split("\n")
      .filter((l) => l.startsWith("- ") && !oldLines.has(l))
      .slice(0, 3)
      .map((l) => `"${l.slice(2, 140)}"`);
    const newAlerts = after.alerts.filter((x) => !before.alerts.includes(x));
    const parts = [];
    if (fresh.length)
      parts.push(options ? `NEW OPTIONS: ${fresh.join(", ")} — click the right one next` : `new on the page: ${fresh.join(", ")}`);
    if (newAlerts.length) parts.push(`ALERT: ${newAlerts.join(" | ")}`);
    else if (text.length) parts.push(`page now says: ${text.join(" ")}`);
    const renamed = renamedBetween(before, after);
    return { summary: parts.join("; "), appeared: fresh.length > 0 || after.text !== before.text, after, renamed };
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

  /** Remember the options a dropdown showed, so a click on one after the list closes can be redone. */
  private noteOptions(toggle: number, before: Snapshot, after: Snapshot) {
    for (const [i, e] of Object.entries(after.elements))
      if (!before.elements[i] && e.name && !TEXT_ROLES.has(e.role)) this.optionOf.set(i, { toggle: String(toggle), name: e.name });
  }

  /** A clicked option that closed its list and now shows on its dropdown: remember the choice. */
  private noteChoice(id: number, el: ElementInfo, before: Snapshot, after: Snapshot) {
    const name = el.name.trim().toLowerCase();
    if (!name || after.elements[String(id)]) return;
    const toggle = Object.entries(after.elements).find(
      ([i, e]) => before.elements[i] && e.name !== before.elements[i].name && e.name.toLowerCase().includes(name),
    );
    if (!toggle) return;
    this.chosen.set(toggle[0], el.name.trim());
    this.chosenVia.set(String(id), toggle[0]);
  }

  /**
   * Custom dropdowns hide their options until opened. Open it, look at what actually appeared,
   * and click the closest match, or list the real options so the model can pick one.
   */
  private async chooseFromCustomList(id: number, option: string, snap: Snapshot, emit: (p: Partial<StepEvent>) => void, line: string) {
    await this.browser.click(id);
    const { after } = await this.changes(snap);
    this.noteOptions(id, snap, after);
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
    this.chosen.set(String(id), pick[1].name);
    this.chosenVia.set(pick[0], String(id));
    emit({ status: "ok", result: `chose "${pick[1].name}"` });
    return { line: `${line} → chose [${pick[0]}] "${pick[1].name}"` };
  }

  /**
   * Autocomplete in one call: after typing, wait for suggestions and click the one closest to
   * what the model asked for, so the rest of a form can follow in the same turn.
   */
  private async pickSuggestion(want: string, snap: Snapshot, emit: (p: Partial<StepEvent>) => void, line: string, field: string) {
    let shown: [string, ElementInfo][] = [];
    for (let wait = 0; wait < 3 && !shown.length; wait++) {
      if (wait) await new Promise((r) => setTimeout(r, 300 * wait));
      const after = await this.browser.snapshot();
      shown = Object.entries(after.elements).filter(([i, e]) => !snap.elements[i] && e.name && !TEXT_ROLES.has(e.role));
    }
    const pick = bestMatch(shown, want);
    if (!pick) {
      const list = shown
        .slice(0, 8)
        .map(([i, e]) => `[${i}] "${e.name}"`)
        .join(", ");
      emit({ status: "failed", result: `no suggestion like "${want}"` });
      // Nothing at all, twice for the same box: the site doesn't know the place. A live run tried
      // spellings of "Erode" for ten turns on a site without it, then gave up without saying why.
      const misses = list ? 0 : (this.misses.get(field) ?? 0) + 1;
      this.misses.set(field, misses);
      const hint = list
        ? `no suggestion is like "${want}". Suggestions: ${list}. Click the right one`
        : misses >= 2
          ? `no suggestions appeared again. This site most likely has no "${want}". Stop trying other spellings: ask_user, telling them in their language that the site doesn't list it, and offer to use another place they name`
          : "no suggestions appeared. Try once more with a shorter word or the station code";
      return { line: `${line} → typed, but ${hint}.`, failed: true };
    }
    await this.browser.click(pick[0]);
    const others = shown
      .filter(([i]) => i !== pick[0])
      .slice(0, 3)
      .map(([i, e]) => `[${i}] "${e.name}"`);
    emit({ status: "ok", result: `chose "${pick[1].name}"` });
    return {
      line: `${line} → chose suggestion "${pick[1].name}"${others.length ? ` (others offered: ${others.join(", ")})` : ""}`,
      picked: true,
    };
  }

  /**
   * A complaint, message or review must be in the user's own words. Long text for a free-text
   * field that the user never said or dictated was written by the model: refuse it. Words lifted
   * from the request into a long-form box (a textarea) must be the message itself, not the request
   * restated: a live trace filed "complaint about food quality" as the complaint.
   */
  private inventedFreeText(el: ElementInfo | undefined, text: string) {
    if (!el || !isFreeTextField(el) || !text.trim()) return false;
    const norm = (t: string) =>
      t
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
    if (norm(this.userWords.join(" \n ")).includes(norm(text))) return false;
    const said = norm(this.userTexts.join(" \n ")).includes(norm(text));
    if (el.tag === "textarea" || (el.tag === "div" && TEXT_ROLES.has(el.role)))
      return !said || text.trim().length <= 30 || REQUEST_WORDS.test(text);
    return text.trim().length > 30 && !said;
  }

  /** Names, ages, phone numbers and addresses must come from the profile or the user, never be made up. */
  private inventedPersonal(el: ElementInfo | undefined, text: string) {
    if (!el || !isPersonalField(el) || !text.trim()) return false;
    return !saidBy(this.userTexts, text);
  }

  private refusePersonal(id: number, emit: (p: Partial<StepEvent>) => void, line: string) {
    emit({ status: "blocked", result: "personal details must come from the user" });
    return {
      line: `${line} → REFUSED: [${id}] asks for personal details, and this value did not come from the user or their saved profile. Never invent names, ages, phone numbers, addresses or numbers like a PNR: ask_user for them, or leave an optional field empty.`,
      failed: true,
    };
  }

  private refuseFreeText(id: number, emit: (p: Partial<StepEvent>) => void, line: string) {
    emit({ status: "blocked", result: "free text must come from the user" });
    return {
      line: `${line} → REFUSED: [${id}] is a free-text field. Never write the user's message yourself, not even by restating their request. Use compose_with_kivi so the user dictates it in their own words.`,
      failed: true,
    };
  }

  private async blockSensitive(id: number, io: AgentIO, emit: (p: Partial<StepEvent>) => void, line: string) {
    this.handedOver.add(String(id));
    await this.browser.focus(id);
    await io.sayPhrase("sensitiveField");
    emit({ status: "blocked", result: "sensitive field — user types it" });
    io.emit({ type: "audit", action: "type", target: String(id), reason: "sensitive field", confirmed: false });
    // A trace asked "please type your password" eight times instead of handing over: hand over once.
    return {
      line: `${line} → BLOCKED: sensitive field, and the user has been told to type it themselves (the box is focused). Do the rest of the form, then call done: say what is left for them to type, and that they can ask you to carry on afterwards. Don't ask_user for it.`,
    };
  }

  private async composeWithKivi(a: Record<string, any>, el: any, io: AgentIO, emit: (p: Partial<StepEvent>) => void, line: string) {
    if (this.composeRejections >= 2) {
      emit({ status: "failed", result: "dictation rejected twice" });
      return {
        line: `${line} → REFUSED: the user already rejected the dictated text twice. Call done and tell them nothing was sent; they can start again whenever they like.`,
        failed: true,
      };
    }
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
        this.userWords.push(text);
        await this.browser.type(a.id, text);
        emit({ status: "ok", result: `filled ${text.length} chars from Kivi` });
        return { line: `${line} → user dictated with Kivi and approved; field filled with: "${text}"` };
      }
    }
    this.composeRejections++;
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

/**
 * A later step of a payment the user already agreed to: no more money, and the same trip wherever
 * both steps show it (train, date, class, quota).
 */
function withinConsent(consent: SpokenFacts, now: SpokenFacts): boolean {
  if (consent.amount === undefined || now.amount === undefined || now.amount > consent.amount) return false;
  return (["train", "date", "cls", "quota"] as const).every((k) => !consent[k] || !now[k] || consent[k] === now[k]);
}

/** Rupee amounts in a text ("PAY ₹1,240" → "1240"). */
const amounts = (text: string) => [...text.matchAll(/₹\s?(\d[\d,]*)/g)].map((m) => m[1].replace(/,/g, ""));
/** Indian-script digits as ASCII: every Indic block's zero sits at …6 (०, ০, ੦, ૦, ୦, ௦, ౦, ೦, ൦). */
const asciiDigits = (s: string) => s.replace(/[०-९০-৯੦-੯૦-૯୦-୯௦-௯౦-౯೦-೯൦-൯]/g, (d) => String((d.charCodeAt(0) - 6) & 0xf));

/**
 * Whether a confirmation question names the amount a priced control is about: the control's own
 * (PAY ₹220), else the page readback's. True when neither shows one.
 */
export function namesAmount(question: string, control: string, facts: string): boolean {
  const want = amounts(control).length ? amounts(control) : amounts(facts);
  if (!want.length) return true;
  const q = asciiDigits(question).replace(/(\d)[,\s](?=\d)/g, "$1");
  return want.some((n) => new RegExp(`(^|\\D)${n}(\\D|$)`).test(q));
}

const sameOrigin = (a: string, b: string) => {
  try {
    const o = new URL(a).origin;
    return o !== "null" && o === new URL(b).origin;
  } catch {
    return false;
  }
};

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

/**
 * Why the rest of a batch must wait for a fresh look, or "" to carry on. Ids are stable across
 * re-renders, so later calls stay valid unless new controls appeared (suggestions, a calendar,
 * a new passenger row) or their target is gone.
 */
export function batchStop(before: Snapshot, after: Snapshot, next: ToolCall): string {
  if (after.url !== before.url) return "the page changed";
  if (after.dialog !== before.dialog) return after.dialog ? "a dialog opened" : "the dialog closed";
  if (after.alerts.some((x) => !before.alerts.includes(x))) return "an alert appeared";
  const added = Object.keys(after.elements).filter((id) => !before.elements[id]).length;
  const removed = Object.keys(before.elements).filter((id) => !after.elements[id]).length;
  if (added > removed) return "new options appeared";
  // New text in place ("No stations found", "Enter a valid mobile number") needs reading first.
  const lines = new Set(before.text.split("\n"));
  if (after.text.split("\n").some((l) => l.startsWith("- ") && !lines.has(l))) return "the page shows new text";
  const a = next.args ?? {};
  const targets = [a.id, ...(Array.isArray(a.fields) ? a.fields.map((f: any) => f?.id) : [])].filter((x) => x !== undefined && x !== null);
  if (targets.some((id) => !after.elements[String(id)])) return "its target is no longer on the page";
  return "";
}

/** Actions that are pointless to repeat verbatim on an unchanged page. */
const REPEATABLE = new Set(["click", "type_text", "fill_form", "select_option", "press_key", "navigate"]);
const VERBATIM_CHARS = 800;
const TEXT_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);

/** A custom (non-<select>) dropdown: a combobox, a "▾" toggle, "Select …", or a control with an expanded/collapsed state. */
function looksLikeDropdown(snap: Snapshot, id: number | string, el: ElementInfo) {
  if (["combobox", "listbox"].includes(el.role)) return true;
  if (/[▾▼⌄⏷]|^\s*(select|choose)\b/i.test(el.name)) return true;
  const line = snap.text.split("\n").find((l) => l.includes(`[${id}] `)) ?? "";
  return /\b(collapsed|expanded)\b/.test(line);
}

/** A box where typing should bring up suggestions (stations, cities, search). */
function isLookupBox(el: { role: string; name: string; fieldHint: string } | undefined) {
  if (!el) return false;
  return (
    el.role === "combobox" ||
    el.role === "searchbox" ||
    /from|to|station|city|search|where|destination|origin/i.test(`${el.name} ${el.fieldHint}`)
  );
}

/** A from/to station or city box, where the typed name is also the suggestion to choose. */
function isStationBox(el: ElementInfo | undefined) {
  return (
    !!el &&
    TEXT_ROLES.has(el.role) &&
    el.role !== "searchbox" &&
    /\b(from|to|station|city|destination|origin|source)\b/i.test(`${el.name} ${el.fieldHint}`)
  );
}

/** The page's text lines (not its controls), as one string. */
function pageLines(s: Snapshot) {
  return s.text
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .join(" ");
}

/** Identity of a page state: same URL, dialog and visible outline. */
function fingerprint(s: Snapshot) {
  let h = 0;
  const str = `${s.url}|${s.dialog}|${s.text}`;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return String(h);
}

const STEP_MAX_TOKENS = 600;
// Sometimes the model writes its tool call as text and then pads with blank lines up to the token
// cap (3–4 s and ₹0.04 wasted each time). Blank lines never occur inside a tool call, so stop there.
const RUNAWAY_STOPS = ["\n \n", "\n  \n", "\n    \n", "\n\n\n"];

// "Complaint" and its kin in the 11 languages: text that names them describes the request, not the message.
const REQUEST_WORDS = /complain|grievance|feedback|शिकायत|तक्रार|புகார்|ఫిర్యాదు|ದೂರು|പരാതി|অভিযোগ|ફરિયાદ|ਸ਼ਿਕਾਇਤ|ଅଭିଯୋଗ/i;

/** Fields for the user's own words: complaints, messages, reviews, descriptions, addresses. */
function isFreeTextField(el: ElementInfo) {
  if (el.tag === "textarea") return true;
  if (!["textbox", "searchbox"].includes(el.role) && el.tag !== "div") return false;
  return /complain|comment|message|feedback|describe|description|details|review|grievance|query|issue|remarks|शिकायत|संदेश/i.test(
    `${el.name} ${el.fieldHint}`,
  );
}

/** Controls that now say something else (a dropdown showing the chosen option, a date button). */
function renamedBetween(before: Snapshot, after: Snapshot) {
  return Object.entries(after.elements)
    .filter(([id, e]) => before.elements[id] && e.name && e.name !== before.elements[id].name)
    .slice(0, 3)
    .map(([id, e]) => `[${id}] now says "${e.name.slice(0, 60)}"`)
    .join(", ");
}

/** An empty box for the user's own words just above a submit button, unless it says it's optional. */
function emptyFreeText(snap: Snapshot, buttonId: number) {
  return Object.entries(snap.elements).find(
    ([i, e]) =>
      e.tag === "textarea" &&
      isFreeTextField(e) &&
      Number(i) < buttonId &&
      buttonId - Number(i) <= 8 &&
      !/optional/i.test(`${e.name} ${e.fieldHint}`) &&
      holds(snap, Number(i), e, ""),
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

/**
 * The choice button meant by a fill_form entry: the element itself when its text is the value,
 * else a nearby button (the same group, ids within a few) whose text is exactly the value.
 */
function choiceFor(snap: Snapshot, id: number, value: string): [string, ElementInfo] | undefined {
  const norm = (t: string) =>
    t
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const v = norm(value);
  if (!v) return undefined;
  const self = snap.elements[String(id)];
  if (self && norm(self.name) === v) return [String(id), self];
  return Object.entries(snap.elements).find(([i, e]) => Math.abs(Number(i) - id) <= 6 && !TEXT_ROLES.has(e.role) && norm(e.name) === v);
}

/** The field already shows this value: the text in it, the selected option, or a selected choice button. */
function holds(snap: Snapshot, id: number, el: ElementInfo, value: string) {
  const line = snap.text.split("\n").find((l) => l.startsWith(`[${id}] `)) ?? "";
  const v = value.trim().toLowerCase();
  if (el.tag === "select") return line.toLowerCase().includes(`selected="${v}"`);
  if (TEXT_ROLES.has(el.role)) return line.includes(`value="${value.trim()}"`) || (!v && line.includes('value=""'));
  const choice = choiceFor(snap, id, value);
  if (!choice) return false;
  const chosen = snap.text.split("\n").find((l) => l.startsWith(`[${choice[0]}] `)) ?? "";
  return /\b(looks-selected|checked|selected|pressed)\b/.test(chosen.replace(/selected="[^"]*"/, ""));
}

/** A dropdown within a few ids whose options include the value. */
function nearbySelect(snap: Snapshot, id: number, value: string): [string, ElementInfo] | undefined {
  const v = value.trim().toLowerCase();
  if (!v) return undefined;
  return Object.entries(snap.elements).find(([i, e]) => {
    if (e.tag !== "select" || Math.abs(Number(i) - id) > 3) return false;
    const line = snap.text.split("\n").find((l) => l.startsWith(`[${i}] `)) ?? "";
    const opts = line.match(/options=\[(.*)\]/)?.[1] ?? "";
    return opts.split(" | ").some((o) => o.trim().toLowerCase() === v);
  });
}

/** The form's continue/next/submit button after its last field, to suggest as the next step. */
function nextButton(snap: Snapshot, afterId: number): [string, ElementInfo] | undefined {
  return Object.entries(snap.elements).find(
    ([i, e]) => Number(i) > afterId && !TEXT_ROLES.has(e.role) && /^\s*(continue|next|proceed|submit|save|search)\b/i.test(e.name),
  );
}

/** Fields about a real person: their name, age, phone, email or address. */
function isPersonalField(el: ElementInfo) {
  if (!TEXT_ROLES.has(el.role)) return false;
  if (/search|from|to\b|station|city|captcha|promo|coupon/i.test(el.name)) return false;
  return /\b(name|age|mobile|phone|e-?mail|address|pin ?code|postal|pnr|booking id|order id|ticket (no|number))\b|नाम|उम्र|मोबाइल|\btel\b|given-name|family-name|street-address/i.test(
    `${el.name} ${el.fieldHint} ${el.autocomplete}`,
  );
}

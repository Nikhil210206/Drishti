import { pageDates, readbackPassengers, shownClasses, type AgentIO, type LangCode, type PhraseBook, type PhraseKey } from "@drishti/core";
import type { Task } from "./tasks.js";
import type { Trace } from "./tracing.js";

const FALLBACK_ANSWER: Partial<Record<LangCode, string>> = {
  "hi-IN": "आप खुद तय कर लीजिए, जो पहला विकल्प है वही",
  "en-IN": "You decide, the first option is fine",
};

/**
 * A scripted user: typed command, canned answers, and "haan" at confirmations unless told
 * otherwise. Like a careful real user, it says no when what the page says (the readback after
 * "The page says:") contradicts the booking it asked for: another class, date or quota.
 */
export class ScriptedIO implements AgentIO {
  said: string[] = [];
  events: Record<string, any>[] = [];
  questions: string[] = [];
  confirmations: string[] = [];
  private answers: string[];
  private confirms: string[];

  /** Confirmations refused because the page contradicted the task. */
  objections: string[] = [];

  constructor(
    public lang: LangCode,
    private task: Task,
    private phrases: PhraseBook,
    private trace: Trace,
    private today = "",
  ) {
    this.answers = [...(task.answers ?? [])];
    this.confirms = [...(task.confirms ?? [])];
  }

  say(t: string) {
    this.said.push(t);
    this.trace.write("say", { text: t });
  }

  async sayPhrase(k: PhraseKey) {
    this.say(await this.phrases.get(k, this.lang));
  }

  async ask(q: string, kind: "question" | "confirm") {
    this.said.push(q);
    let answer: string;
    let objection = "";
    if (kind === "confirm") {
      this.confirmations.push(q);
      objection = await this.contradiction(q);
      if (objection) this.objections.push(objection);
      answer = objection ? "no" : (this.confirms.shift() ?? this.task.confirm_default ?? "haan");
    } else {
      this.questions.push(q);
      answer = this.answers.shift() ?? FALLBACK_ANSWER[this.lang] ?? FALLBACK_ANSWER["en-IN"]!;
    }
    this.trace.write("ask", { kind, question: q, answer, ...(objection ? { objection } : {}) });
    return answer;
  }

  /** What in the page's own readback contradicts the expected booking, or "". */
  private async contradiction(question: string): Promise<string> {
    const want = this.task.expect.booking;
    if (!want) return "";
    // The page's readback: after "The page says:", or a payment's whole short line after "Please check before I pay:".
    let facts = "";
    for (const key of ["pageShows", "confirmLead"] as const) {
      const marker = await this.phrases.get(key, this.lang);
      const at = question.lastIndexOf(marker);
      if (at >= 0) facts = question.slice(at + marker.length);
    }
    if (!facts) return "";
    const options = (k: string) =>
      String(want[k] ?? "")
        .split("|")
        .filter(Boolean);
    const classes = [...shownClasses(facts)];
    if (want.cls && classes.length === 1 && !options("cls").includes(classes[0])) return `class ${classes[0]}, want ${want.cls}`;
    const dates = [...new Set(pageDates(facts))];
    const days = options("date").map((d) => (/^[+-]\d+$/.test(d) ? addDays(this.today, Number(d)) : d));
    if (want.date && this.today && dates.length === 1 && !days.includes(dates[0])) return `date ${dates[0]}, want ${days.join("|")}`;
    const people = readbackPassengers(facts).length;
    if (want.passengers && people && people !== Number(want.passengers)) return `${people} passenger(s), want ${want.passengers}`;
    if (options("quota").includes("TQ") && /\bGeneral\b/.test(facts) && !/\bTatkal\b/i.test(facts)) return "General quota, want Tatkal";
    return "";
  }

  async compose(prompt: string, field: string) {
    this.trace.write("compose", { prompt, field, text: this.task.compose ?? null });
    return this.task.compose ?? null;
  }

  emit(e: Record<string, any>) {
    this.events.push(e);
    this.trace.write("event", e);
  }

  recent() {
    return [`User: ${this.task.command}`];
  }

  takeInterjections() {
    return [];
  }
}

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

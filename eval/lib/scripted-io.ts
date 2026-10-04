import type { AgentIO, LangCode, PhraseBook, PhraseKey } from "@drishti/core";
import type { Task } from "./tasks.js";
import type { Trace } from "./tracing.js";

const FALLBACK_ANSWER: Partial<Record<LangCode, string>> = {
  "hi-IN": "आप खुद तय कर लीजिए, जो पहला विकल्प है वही",
  "en-IN": "You decide, the first option is fine",
};

/** A scripted user: typed command, canned answers, and "haan" at confirmations unless told otherwise. */
export class ScriptedIO implements AgentIO {
  said: string[] = [];
  events: Record<string, any>[] = [];
  questions: string[] = [];
  confirmations: string[] = [];
  private answers: string[];
  private confirms: string[];

  constructor(
    public lang: LangCode,
    private task: Task,
    private phrases: PhraseBook,
    private trace: Trace,
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
    if (kind === "confirm") {
      this.confirmations.push(q);
      answer = this.confirms.shift() ?? this.task.confirm_default ?? "haan";
    } else {
      this.questions.push(q);
      answer = this.answers.shift() ?? FALLBACK_ANSWER[this.lang] ?? FALLBACK_ANSWER["en-IN"]!;
    }
    this.trace.write("ask", { kind, question: q, answer });
    return answer;
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

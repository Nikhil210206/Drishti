/**
 * Run traces: one JSONL file per task with every snapshot the agent saw, every LLM request and
 * reply, every browser action and every agent event. Open them in eval/viewer/index.html.
 */
import fs from "node:fs";
import path from "node:path";
import { isSensitiveField, type BrowserDriver, type LLM, type Snapshot } from "@drishti/core";

export class Trace {
  private fd: number;
  private t0 = Date.now();
  /** Safety violations noticed while tracing (e.g. typing into a password field). */
  violations: string[] = [];

  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.fd = fs.openSync(file, "w");
  }

  write(type: string, data: Record<string, unknown>) {
    fs.writeSync(this.fd, JSON.stringify({ t: Date.now() - this.t0, type, ...data }) + "\n");
  }

  close() {
    fs.closeSync(this.fd);
  }

  llm(inner: LLM): LLM {
    let n = 0;
    return {
      chat: async (opts) => {
        const i = ++n;
        this.write("llm_request", { i, reasoning: opts.reasoning, toolChoice: opts.toolChoice, messages: opts.messages });
        try {
          const r = await inner.chat(opts);
          this.write("llm_response", { i, ms: r.ms, content: r.content, toolCalls: r.toolCalls, usage: r.usage, raw: r.raw });
          return r;
        } catch (e: any) {
          this.write("llm_error", { i, error: String(e?.message ?? e) });
          throw e;
        }
      },
    };
  }

  driver(inner: BrowserDriver): BrowserDriver {
    let last: Snapshot | undefined;
    const act = async <T>(method: string, args: unknown[], run: () => Promise<T>): Promise<T> => {
      const t = Date.now();
      try {
        const r = await run();
        this.write("action", { method, args, ms: Date.now() - t });
        return r;
      } catch (e: any) {
        this.write("action", { method, args, ms: Date.now() - t, error: String(e?.message ?? e).split("\n")[0] });
        throw e;
      }
    };
    const checkSensitive = (id: string | number) => {
      const el = last?.elements[String(id)];
      if (isSensitiveField(el)) this.violations.push(`typed into sensitive field [${id}] "${el?.name}"`);
    };
    return {
      snapshot: async () => {
        const s = await inner.snapshot();
        last = s;
        this.write("snapshot", {
          url: s.url,
          title: s.title,
          dialog: s.dialog,
          alerts: s.alerts,
          text: s.text,
          elements: Object.keys(s.elements).length,
        });
        return s;
      },
      signature: () => inner.signature(),
      url: () => inner.url(),
      click: (id) => act("click", [id], () => inner.click(id)),
      type: (id, text, submit) => {
        checkSensitive(id);
        return act("type", [id, text, submit], () => inner.type(id, text, submit));
      },
      selectOption: (id, option) => act("selectOption", [id, option], () => inner.selectOption(id, option)),
      press: (key) => act("press", [key], () => inner.press(key)),
      scroll: (d) => act("scroll", [d], () => inner.scroll(d)),
      goBack: () => act("goBack", [], () => inner.goBack()),
      navigate: (url) => act("navigate", [url], () => inner.navigate(url)),
      focus: (id) => act("focus", [id], () => inner.focus(id)),
      readable: () => act("readable", [], () => inner.readable()),
      fetchBytes: (url) => act("fetchBytes", [url], () => inner.fetchBytes(url)),
    };
  }
}

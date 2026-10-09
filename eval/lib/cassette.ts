/**
 * Cassettes: record every paid call of a live eval run (LLM, translation, documents) and replay
 * it later at zero cost. CI replays; `--live` records.
 *
 * LLM replies replay in order. Each entry keeps a hash of the request it answered, so a replay
 * whose prompts changed is reported as "drift" (the run still completes, using the recorded
 * replies). Translations and documents replay by content hash.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ChatOptions, ChatResult, DocReader, LLM, TranslateOptions, Translator } from "@drishti/core";
import { costMeter } from "@drishti/providers";

export type CassetteMode = "record" | "replay";

interface CassetteFile {
  version: 1;
  task: string;
  recordedAt: string;
  model: string;
  llm: { hash: string; response: ChatResult }[];
  translate: Record<string, string>;
  docs: Record<string, string>;
}

/** The content hash cassettes key translations and documents by (eval/top-up-phrases.ts uses it too). */
export const sha = (v: unknown) =>
  crypto
    .createHash("sha1")
    .update(typeof v === "string" ? v : JSON.stringify(v))
    .digest("hex")
    .slice(0, 16);

/** The part of a request that should be identical between a recording and its replay. */
const requestHash = (o: ChatOptions) =>
  sha({ messages: o.messages, tools: o.tools?.map((t) => t.function.name), toolChoice: o.toolChoice, reasoning: o.reasoning });

export class Cassette {
  private data: CassetteFile;
  private next = 0;
  drift = 0;
  /** Replay asked for more LLM replies than were recorded. */
  exhausted = false;
  readonly missing: string[] = [];

  constructor(
    private file: string,
    readonly mode: CassetteMode,
    task: string,
    model: string,
  ) {
    if (mode === "replay") {
      if (!fs.existsSync(file)) throw new Error(`No cassette for ${task}. Record it with --live.`);
      this.data = JSON.parse(fs.readFileSync(file, "utf8"));
    } else {
      this.data = { version: 1, task, recordedAt: new Date().toISOString(), model, llm: [], translate: {}, docs: {} };
    }
  }

  get recordedModel() {
    return this.data.model;
  }

  save() {
    if (this.mode !== "record") return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 1) + "\n");
  }

  llm(inner: LLM): LLM {
    return {
      chat: async (opts) => {
        const hash = requestHash(opts);
        if (this.mode === "record") {
          const response = await inner.chat(opts);
          this.data.llm.push({ hash, response });
          return response;
        }
        const entry = this.data.llm[this.next++];
        if (!entry) {
          this.exhausted = true;
          throw new Error("cassette exhausted: the agent asked for more LLM replies than were recorded");
        }
        if (entry.hash !== hash) this.drift++;
        // Count the recorded spend, so replayed reports show what the run cost live.
        if (entry.response.usage) costMeter.addLlm(entry.response.usage);
        return structuredClone(entry.response);
      },
    };
  }

  translator(inner: Translator): Translator {
    return {
      translate: async (text: string, target: string, opts?: TranslateOptions) => {
        const key = sha({ text, target, opts });
        if (this.mode === "record") return (this.data.translate[key] = await inner.translate(text, target, opts));
        const hit = this.data.translate[key];
        if (hit === undefined) {
          this.missing.push(`translate→${target}: ${text.slice(0, 40)}`);
          return text; // offline fallback: untranslated
        }
        costMeter.addTranslate(text.length);
        return hit;
      },
    };
  }

  docs(inner: DocReader): DocReader {
    return {
      read: async (bytes, fileName, language) => {
        const key = sha(`${crypto.createHash("sha1").update(bytes).digest("hex")}|${language}`);
        if (this.mode === "record") return (this.data.docs[key] = await inner.read(bytes, fileName, language));
        const hit = this.data.docs[key];
        if (hit === undefined) throw new Error(`cassette has no document for ${fileName}`);
        return hit;
      },
    };
  }
}

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { SarvamAIClient } from "sarvamai";
import type { DocReader } from "@drishti/core";
import { requireKey, type SarvamAuth } from "./key.js";
import { costMeter } from "./cost.js";

/**
 * Read a document (PDF / PNG / JPG) with Sarvam Vision (Doc AI "digitise") and return Markdown.
 * Results are kept in memory only, keyed by content hash: documents are bills and letters
 * with personal details, so nothing is written to disk beyond the upload's temp file.
 */
export class SarvamDocReader implements DocReader {
  private results = new Map<string, string>();
  private inflight = new Map<string, Promise<string>>();

  constructor(
    private auth: SarvamAuth,
    private maxCached = 20,
  ) {}

  read(bytes: Uint8Array, fileName: string, language = "en-IN"): Promise<string> {
    const hash = crypto.createHash("sha1").update(bytes).digest("hex");
    const hit = this.results.get(hash);
    if (hit !== undefined) return Promise.resolve(hit);
    const existing = this.inflight.get(hash);
    if (existing) return existing;
    const job = runJob(this.auth, bytes, fileName, language)
      .then((md) => {
        this.results.set(hash, md);
        if (this.results.size > this.maxCached) this.results.delete(this.results.keys().next().value!);
        return md;
      })
      .finally(() => this.inflight.delete(hash));
    this.inflight.set(hash, job);
    return job;
  }
}

async function runJob(auth: SarvamAuth, bytes: Uint8Array, fileName: string, language: string): Promise<string> {
  requireKey(auth);
  const client = new SarvamAIClient({ apiSubscriptionKey: auth.apiKey });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drishti-doc-"));
  const tmp = path.join(dir, path.basename(fileName) || "document.pdf");
  fs.writeFileSync(tmp, bytes);
  try {
    const job = await client.docAi.digitise({
      file: [fs.createReadStream(tmp)],
      language,
      output_format: "md",
    });
    const deadline = Date.now() + 120_000;
    let status = job.status;
    while (!/^(completed|partially_completed)$/i.test(status)) {
      if (/^(failed|rejected)$/i.test(status)) throw new Error(`Sarvam Vision job ${status}`);
      if (Date.now() > deadline) throw new Error("Sarvam Vision job timed out");
      await new Promise((r) => setTimeout(r, 1500));
      const s = await client.docAi.getStatus(job.job_id);
      status = s.status;
      if (/completed/i.test(status) && (s.usage as any)?.pages) costMeter.addDoc((s.usage as any).pages);
    }
    const dl = await client.docAi.getDownloadUrl(job.job_id);
    const res = await fetch(dl.url, { method: dl.method || "GET", headers: dl.headers });
    if (!res.ok) throw new Error(`Vision download HTTP ${res.status}`);
    return extractMarkdown(Buffer.from(await res.arrayBuffer()));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function extractMarkdown(buf: Buffer): string {
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    const files = unzipSync(new Uint8Array(buf));
    const names = Object.keys(files).sort();
    const md = names.filter((n) => /\.(md|markdown)$/i.test(n));
    const pick = md.length ? md : names.filter((n) => /\.(html?|txt|json)$/i.test(n));
    return pick.map((n) => strFromU8(files[n])).join("\n\n");
  }
  return buf.toString("utf8");
}

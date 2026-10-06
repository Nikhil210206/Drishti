import { unzipSync, strFromU8 } from "fflate";
import type { DocReader } from "@drishti/core";
import { apiUrl, authHeaders, limitError, requireKey, type SarvamAuth } from "./key.js";
import { costMeter } from "./cost.js";

/**
 * Read a document (PDF / PNG / JPG) with Sarvam Vision (Doc AI "digitise") and return Markdown.
 * Plain REST, so it runs in the extension through the proxy as well as in Node.
 *
 * Results are kept in memory only, keyed by content hash: documents are bills and letters with
 * personal details, so nothing is ever written to disk.
 */
export class SarvamDocReader implements DocReader {
  private results = new Map<string, string>();
  private inflight = new Map<string, Promise<string>>();

  constructor(
    private auth: SarvamAuth,
    private maxCached = 20,
  ) {}

  async read(bytes: Uint8Array, fileName: string, language = "en-IN"): Promise<string> {
    const hash = await sha1(bytes);
    const hit = this.results.get(hash);
    if (hit !== undefined) return hit;
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

async function sha1(bytes: Uint8Array) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes as Uint8Array<ArrayBuffer>));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

const MIME: Record<string, string> = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" };

async function call(auth: SarvamAuth, path: string, init: RequestInit = {}) {
  const res = await fetch(apiUrl(auth, path), {
    ...init,
    headers: { ...authHeaders(auth), ...(init.headers as Record<string, string> | undefined) },
  });
  const limit = await limitError(res);
  if (limit) throw limit;
  if (!res.ok) throw new Error(`Sarvam Vision HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<any>;
}

async function runJob(auth: SarvamAuth, bytes: Uint8Array, fileName: string, language: string): Promise<string> {
  requireKey(auth);
  const name = fileName.split(/[\\/]/).pop() || "document.pdf";
  const type = MIME[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/pdf";
  const form = new FormData();
  form.append("file", new Blob([bytes as Uint8Array<ArrayBuffer>], { type }), name);
  form.append("language", language);
  form.append("output_format", "md");
  const job = await call(auth, "/doc-ai/v1/job/digitise", { method: "POST", body: form });

  const deadline = Date.now() + 120_000;
  let status: string = job.status ?? "";
  while (!/^(completed|partially_completed)$/i.test(status)) {
    if (/^(failed|rejected)$/i.test(status)) throw new Error(`Sarvam Vision job ${status}`);
    if (Date.now() > deadline) throw new Error("Sarvam Vision job timed out");
    await new Promise((r) => setTimeout(r, 1500));
    const s = await call(auth, `/doc-ai/v1/job/${encodeURIComponent(job.job_id)}/status`);
    status = s.status ?? "";
    if (/completed/i.test(status) && s.usage?.pages) costMeter.addDoc(s.usage.pages);
  }

  // The result sits in Sarvam's storage behind a signed URL: no credential needed to fetch it.
  const dl = await call(auth, `/doc-ai/v1/job/${encodeURIComponent(job.job_id)}/download-url`);
  const res = await fetch(dl.url, { method: dl.method || "GET", headers: dl.headers ?? undefined });
  if (!res.ok) throw new Error(`Vision download HTTP ${res.status}`);
  return extractMarkdown(new Uint8Array(await res.arrayBuffer()));
}

function extractMarkdown(buf: Uint8Array): string {
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    const files = unzipSync(buf);
    const names = Object.keys(files).sort();
    const md = names.filter((n) => /\.(md|markdown)$/i.test(n));
    const pick = md.length ? md : names.filter((n) => /\.(html?|txt|json)$/i.test(n));
    return pick.map((n) => strFromU8(files[n])).join("\n\n");
  }
  return new TextDecoder().decode(buf);
}

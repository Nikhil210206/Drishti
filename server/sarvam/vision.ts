import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { SarvamAIClient } from "sarvamai";
import { CACHE_DIR, config, requireApiKey } from "../config.js";
import { costMeter } from "./cost.js";

const CACHE = path.join(CACHE_DIR, "vision");
fs.mkdirSync(CACHE, { recursive: true });

const inflight = new Map<string, Promise<string>>();

/**
 * Read a document (PDF / PNG / JPG) with Sarvam Vision (Doc AI "digitise") and return Markdown.
 * Jobs are asynchronous, so results are cached by content hash and can be started early
 * (speculative prefetch) the moment a document link shows up on screen.
 */
export function readDocument(bytes: Buffer, fileName: string, language = "en-IN"): Promise<string> {
  const hash = crypto.createHash("sha1").update(bytes).digest("hex");
  const cached = path.join(CACHE, `${hash}.md`);
  if (fs.existsSync(cached)) return Promise.resolve(fs.readFileSync(cached, "utf8"));
  const existing = inflight.get(hash);
  if (existing) return existing;
  const job = runJob(bytes, fileName, language)
    .then((md) => {
      fs.writeFileSync(cached, md);
      return md;
    })
    .finally(() => inflight.delete(hash));
  inflight.set(hash, job);
  return job;
}

async function runJob(bytes: Buffer, fileName: string, language: string): Promise<string> {
  requireApiKey();
  const client = new SarvamAIClient({ apiSubscriptionKey: config.apiKey });
  const tmp = path.join(CACHE, `upload-${Date.now()}-${path.basename(fileName)}`);
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
    fs.rmSync(tmp, { force: true });
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

/** Pick the Doc AI language hint from the script used in a link label or file name. */
export function guessDocLanguage(label: string): string {
  const table: [RegExp, string][] = [
    [/[ঀ-৿]|bengali|bangla|\bbn\b/i, "bn-IN"],
    [/[஀-௿]|tamil|\bta\b/i, "ta-IN"],
    [/[ఀ-౿]|telugu|\bte\b/i, "te-IN"],
    [/[ಀ-೿]|kannada|\bkn\b/i, "kn-IN"],
    [/[ഀ-ൿ]|malayalam|\bml\b/i, "ml-IN"],
    [/marathi|\bmr\b/i, "mr-IN"],
    [/[ऀ-ॿ]|hindi|\bhi\b/i, "hi-IN"],
  ];
  for (const [re, code] of table) if (re.test(label)) return code;
  return "en-IN";
}

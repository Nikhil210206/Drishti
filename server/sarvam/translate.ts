import { config, requireApiKey } from "../config.js";
import { costMeter } from "./cost.js";

/**
 * Sarvam text translation. `mayura:v1` covers the 11 spoken languages and supports a
 * colloquial register; `sarvam-translate:v1` covers all 22 and longer inputs.
 */
export async function translate(
  text: string,
  target: string,
  opts: { source?: string; model?: "mayura:v1" | "sarvam-translate:v1"; mode?: string } = {},
): Promise<string> {
  requireApiKey();
  if (!text.trim() || target === opts.source) return text;
  const model = opts.model ?? "mayura:v1";
  const limit = model === "mayura:v1" ? 950 : 1900;
  const parts = splitText(text, limit);
  const out: string[] = [];
  for (const part of parts) {
    const body: Record<string, unknown> = {
      input: part,
      source_language_code: opts.source ?? "auto",
      target_language_code: target,
      model,
    };
    if (model === "mayura:v1") body.mode = opts.mode ?? "modern-colloquial";
    const res = await fetch("https://api.sarvam.ai/translate", {
      method: "POST",
      headers: { "api-subscription-key": config.apiKey, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Translate HTTP ${res.status}: ${await res.text()}`);
    const data: any = await res.json();
    costMeter.addTranslate(part.length);
    out.push(data.translated_text ?? "");
  }
  return out.join(" ");
}

function splitText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const sentences = text.split(/(?<=[.!?।\n])\s+/);
  const parts: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if ((cur + " " + s).length > limit && cur) {
      parts.push(cur);
      cur = "";
    }
    cur = cur ? `${cur} ${s}` : s.slice(0, limit);
  }
  if (cur) parts.push(cur);
  return parts;
}

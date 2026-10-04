import type { ChatOptions, ChatResult, LLM, ToolCall } from "@drishti/core";
import { requireKey, type SarvamAuth } from "./key.js";
import { costMeter } from "./cost.js";

const URL = "https://api.sarvam.ai/v1/chat/completions";

export class SarvamLLM implements LLM {
  constructor(private cfg: SarvamAuth & { model: string }) {}

  chat(opts: ChatOptions): Promise<ChatResult> {
    return chat(this.cfg, opts);
  }
}

async function chat(cfg: SarvamAuth & { model: string }, opts: ChatOptions): Promise<ChatResult> {
  requireKey(cfg);
  const body: Record<string, any> = {
    model: cfg.model,
    messages: opts.messages,
    max_tokens: opts.maxTokens ?? 1500,
    temperature: opts.temperature ?? 0.2,
    // null switches thinking off, which is what keeps agent steps fast.
    reasoning_effort: !opts.reasoning || opts.reasoning === "none" ? null : opts.reasoning,
  };
  if (opts.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = opts.toolChoice ?? "auto";
  }
  if (opts.json) body.response_format = { type: "json_object" };
  if (opts.stop?.length) body.stop = opts.stop;

  const t0 = Date.now();
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(URL, {
        method: "POST",
        headers: { "api-subscription-key": cfg.apiKey, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`LLM HTTP ${res.status}: ${await res.text()}`);
        await sleep(600 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${await res.text()}`);
      const data: any = await res.json();
      const msg = data.choices?.[0]?.message ?? {};
      if (data.usage) costMeter.addLlm(data.usage);
      const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc: any, i: number) => ({
        id: tc.id ?? `call_${i}`,
        name: tc.function?.name,
        args: parseArgs(tc.function?.arguments),
      }));
      const content: string = msg.content ?? "";
      const recovered = !toolCalls.length && content ? recoverToolCalls(content) : [];
      toolCalls.push(...recovered);
      const clean = stripThink(content);
      return {
        content: /"name"\s*:/.test(clean) ? "" : clean,
        toolCalls,
        ms: Date.now() - t0,
        usage: data.usage,
        ...(recovered.length ? { raw: content.slice(0, 4000) } : {}),
      };
    } catch (e: any) {
      if (e?.name === "AbortError") throw e;
      lastErr = e;
      if (attempt < 3) await sleep(600 * 2 ** attempt);
    }
  }
  throw lastErr;
}

export function parseArgs(raw: unknown): Record<string, any> {
  if (raw && typeof raw === "object") return raw as Record<string, any>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {}
    }
    return {};
  }
}

/** Some responses put a tool call in the text body instead of `tool_calls`; recover it. */
export function recoverToolCalls(content: string): ToolCall[] {
  const text = stripThink(content)
    .replace(/```(?:json)?/g, "")
    .trim();
  const candidates = [text.match(/\[[\s\S]*\]/)?.[0], text.match(/\{[\s\S]*\}/)?.[0], `[${text}]`];
  for (const c of candidates) {
    if (!c || !/"name"\s*:/.test(c)) continue;
    try {
      const obj = JSON.parse(c);
      const list = (Array.isArray(obj) ? obj : [obj]).filter((o) => typeof o?.name === "string");
      if (list.length)
        return list.map((o, i) => ({ id: `rec_${i}`, name: o.name, args: parseArgs(o.arguments ?? o.args ?? o.parameters) }));
    } catch {}
  }
  return [];
}

export function stripThink(s: string) {
  return s.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

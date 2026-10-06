import type { ChatOptions, ChatResult, LLM, ToolCall } from "@drishti/core";
import { LimitError, apiUrl, authHeaders, limitError, requireKey, type SarvamAuth } from "./key.js";
import { costMeter } from "./cost.js";

export class SarvamLLM implements LLM {
  constructor(private cfg: SarvamAuth & { model: string }) {}

  chat(opts: ChatOptions): Promise<ChatResult> {
    return chat(this.cfg, opts);
  }
}

const ATTEMPT_MS = 45_000;

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
      const res = await fetch(apiUrl(cfg, "/v1/chat/completions"), {
        method: "POST",
        headers: { ...authHeaders(cfg), "content-type": "application/json" },
        body: JSON.stringify(body),
        // A live run once hung 15 minutes on one request: give each attempt a deadline, then retry.
        signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(ATTEMPT_MS)]) : AbortSignal.timeout(ATTEMPT_MS),
      });
      // The proxy's own refusals: wait out "busy", stop at once on the daily quota.
      const limit = await limitError(res);
      if (limit) {
        if (limit.code !== "busy" && limit.code !== "slow_down") throw limit;
        lastErr = limit;
        await sleep(Math.max(1, limit.retryAfterS) * 1000);
        continue;
      }
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
        // Keep what the model wrote whenever tool calls came from text or came out empty: the trace
        // then shows why (a Punjabi task twice wrote a tool call as text that could not be parsed).
        ...(recovered.length
          ? { raw: content.slice(0, 4000) }
          : !toolCalls.length
            ? { raw: JSON.stringify({ finish: data.choices?.[0]?.finish_reason, ...msg }).slice(0, 4000) }
            : {}),
      };
    } catch (e: any) {
      if (opts.signal?.aborted || (e instanceof LimitError && e.code !== "busy" && e.code !== "slow_down")) throw e;
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
  // Several calls written one after another ({..}\n{..}), or a list cut short: take each complete
  // top-level object that parses.
  const list = topLevelObjects(text)
    .map((c) => {
      try {
        return JSON.parse(c);
      } catch {
        return undefined;
      }
    })
    .filter((o) => typeof o?.name === "string");
  return list.map((o, i) => ({ id: `rec_${i}`, name: o.name, args: parseArgs(o.arguments ?? o.args ?? o.parameters) }));
}

/** The balanced {...} spans at the outermost level of the text (or of a [...] list), skipping braces in strings. */
function topLevelObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0) out.push(text.slice(start, i + 1));
    }
  }
  return out;
}

export function stripThink(s: string) {
  return s.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

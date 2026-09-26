import { config, requireApiKey } from "../config.js";
import { costMeter } from "./cost.js";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, any> };
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  ms: number;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

type Reasoning = "low" | "medium" | "high" | "none";

const URL = "https://api.sarvam.ai/v1/chat/completions";

export async function chat(opts: {
  messages: ChatMessage[];
  tools?: ToolDef[];
  toolChoice?: "auto" | "required" | "none";
  reasoning?: Reasoning;
  maxTokens?: number;
  temperature?: number;
  json?: boolean;
  signal?: AbortSignal;
}): Promise<ChatResult> {
  requireApiKey();
  const body: Record<string, any> = {
    model: config.llmModel,
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

  const t0 = Date.now();
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(URL, {
        method: "POST",
        headers: { "api-subscription-key": config.apiKey, "content-type": "application/json" },
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
      if (data.usage) costMeter.addLlm(data.usage.prompt_tokens ?? 0, data.usage.completion_tokens ?? 0);
      const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc: any, i: number) => ({
        id: tc.id ?? `call_${i}`,
        name: tc.function?.name,
        args: parseArgs(tc.function?.arguments),
      }));
      const content: string = msg.content ?? "";
      if (!toolCalls.length && content) toolCalls.push(...recoverToolCalls(content));
      return { content: stripThink(content), toolCalls, ms: Date.now() - t0, usage: data.usage };
    } catch (e: any) {
      if (e?.name === "AbortError") throw e;
      lastErr = e;
      if (attempt < 3) await sleep(600 * 2 ** attempt);
    }
  }
  throw lastErr;
}

function parseArgs(raw: unknown): Record<string, any> {
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
function recoverToolCalls(content: string): ToolCall[] {
  const text = stripThink(content).replace(/```(?:json)?/g, "");
  const m = text.match(/\{[\s\S]*"name"\s*:\s*"[a-z_]+"[\s\S]*\}/);
  if (!m) return [];
  try {
    const obj = JSON.parse(m[0]);
    const list = Array.isArray(obj) ? obj : [obj];
    return list
      .filter((o) => typeof o?.name === "string")
      .map((o, i) => ({ id: `rec_${i}`, name: o.name, args: parseArgs(o.arguments ?? o.args ?? o.parameters) }));
  } catch {
    return [];
  }
}

function stripThink(s: string) {
  return s.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

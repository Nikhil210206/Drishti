// Rough ₹ spend tracker from the published Sarvam price list (Oct 2026).
const PRICE = {
  llmIn: 29.28 / 1e6,
  // Prompt tokens served from the provider's prefix cache (the system prompt and tools, mostly).
  llmCachedIn: 10.98 / 1e6,
  llmOut: 73.2 / 1e6,
  sttPerSec: 30 / 3600,
  ttsPerChar: 30 / 10000,
  translatePerChar: 20 / 10000,
  docPerPage: 0.5,
};

export interface LlmUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number | null } | null;
}

type Listener = (inr: number) => void;

class CostMeter {
  total = 0;
  private listeners = new Set<Listener>();
  private add(inr: number) {
    this.total += inr;
    for (const l of this.listeners) l(this.total);
  }
  onChange(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  /** Pass the API's `usage` object: cached prompt tokens are billed at the lower rate. */
  addLlm(usage: LlmUsage) {
    const inTok = usage.prompt_tokens ?? 0;
    const cached = Math.min(usage.prompt_tokens_details?.cached_tokens ?? 0, inTok);
    this.add((inTok - cached) * PRICE.llmIn + cached * PRICE.llmCachedIn + (usage.completion_tokens ?? 0) * PRICE.llmOut);
  }
  addStt(seconds: number) {
    this.add(seconds * PRICE.sttPerSec);
  }
  addTts(chars: number) {
    this.add(chars * PRICE.ttsPerChar);
  }
  addTranslate(chars: number) {
    this.add(chars * PRICE.translatePerChar);
  }
  addDoc(pages: number) {
    this.add(pages * PRICE.docPerPage);
  }
}

export const costMeter = new CostMeter();

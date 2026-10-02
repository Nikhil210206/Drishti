// Rough ₹ spend tracker from the published Sarvam price list (Sep 2026).
const PRICE = {
  llmIn: 29.28 / 1e6,
  llmOut: 73.2 / 1e6,
  sttPerSec: 30 / 3600,
  ttsPerChar: 30 / 10000,
  translatePerChar: 20 / 10000,
  docPerPage: 0.5,
};

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
  addLlm(inTok: number, outTok: number) {
    this.add(inTok * PRICE.llmIn + outTok * PRICE.llmOut);
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

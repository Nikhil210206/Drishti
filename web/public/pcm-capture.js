// AudioWorklet: downsample mic audio to 16 kHz mono PCM16 and post 100 ms chunks.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.buf = new Int16Array(1600);
    this.n = 0;
    this.pos = 0;
  }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    let level = 0;
    for (let i = 0; i < ch.length; i++) level = Math.max(level, Math.abs(ch[i]));
    // Simple decimation with averaging over each output sample's input window.
    while (this.pos < ch.length) {
      const start = Math.floor(this.pos);
      const end = Math.min(ch.length, Math.floor(this.pos + this.ratio));
      let sum = 0, cnt = 0;
      for (let i = start; i < Math.max(end, start + 1); i++) (sum += ch[i]), cnt++;
      const s = Math.max(-1, Math.min(1, sum / cnt));
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.buf.length) {
        this.port.postMessage({ pcm: this.buf.buffer, level }, [this.buf.buffer]);
        this.buf = new Int16Array(1600);
        this.n = 0;
      }
      this.pos += this.ratio;
    }
    this.pos -= ch.length;
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);

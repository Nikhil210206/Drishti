/** Mic capture (16 kHz PCM16 chunks), streamed speech playback (24 kHz PCM16) and earcons. */

export class Mic {
  private ctx?: AudioContext;
  private stream?: MediaStream;
  private node?: AudioWorkletNode;
  onChunk: (pcm: ArrayBuffer, level: number) => void = () => {};

  async start() {
    if (this.ctx) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule("/pcm-capture.js");
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "pcm-capture");
    this.node.port.onmessage = (e) => this.onChunk(e.data.pcm, e.data.level);
    src.connect(this.node);
    // Chrome may hold a new AudioContext until the page gets a key press or click.
    await this.ctx.resume().catch(() => {});
  }

  /** Chrome is holding the microphone's audio until the panel gets a key press or click. */
  get held() {
    return this.ctx?.state === "suspended";
  }

  resume() {
    return this.ctx?.resume();
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.ctx = undefined;
  }
}

export class Player {
  private ctx = new AudioContext({ sampleRate: 24000 });
  private nextTime = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private endTimer?: number;
  onIdle: () => void = () => {};
  onBusy: () => void = () => {};
  private busy = false;

  get context() {
    return this.ctx;
  }

  resume() {
    return this.ctx.resume();
  }

  push(pcm: ArrayBuffer) {
    const int = new Int16Array(pcm);
    if (!int.length) return;
    const buf = this.ctx.createBuffer(1, int.length, 24000);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < int.length; i++) ch[i] = int[i] / 0x8000;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    const now = this.ctx.currentTime;
    if (this.nextTime < now + 0.02) this.nextTime = now + 0.04;
    src.start(this.nextTime);
    this.nextTime += buf.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
    this.setBusy(true);
    this.scheduleIdle();
  }

  private scheduleIdle() {
    clearTimeout(this.endTimer);
    const ms = Math.max(0, (this.nextTime - this.ctx.currentTime) * 1000) + 350;
    this.endTimer = window.setTimeout(() => this.setBusy(false), ms);
  }

  private setBusy(b: boolean) {
    if (b === this.busy) return;
    this.busy = b;
    b ? this.onBusy() : this.onIdle();
  }

  get speaking() {
    return this.busy;
  }

  stop() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {}
    }
    this.sources.clear();
    this.nextTime = 0;
    clearTimeout(this.endTimer);
    this.setBusy(false);
  }
}

/** Short non-speech sounds so a blind user always knows what state Drishti is in. */
export class Earcons {
  constructor(private ctx: AudioContext) {}
  private tone(freq: number, start: number, dur: number, gain = 0.08, type: OscillatorType = "sine") {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    const t = this.ctx.currentTime + start;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.ctx.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
  listen() {
    this.tone(660, 0, 0.09);
    this.tone(880, 0.08, 0.12);
  }
  stopListen() {
    this.tone(880, 0, 0.08);
    this.tone(660, 0.07, 0.1);
  }
  tick() {
    this.tone(1200, 0, 0.03, 0.025, "triangle");
  }
  action() {
    this.tone(520, 0, 0.05, 0.05, "square");
  }
  success() {
    [523, 659, 784].forEach((f, i) => this.tone(f, i * 0.08, 0.18, 0.07));
  }
  error() {
    this.tone(220, 0, 0.25, 0.09, "sawtooth");
  }
  attention() {
    this.tone(988, 0, 0.12, 0.08);
    this.tone(988, 0.18, 0.12, 0.08);
  }
}

/** Decode any audio file and resample it to 16 kHz mono PCM16 (for the "play sample" montage). */
export async function fileTo16k(file: File): Promise<{ pcm: Int16Array; audio: AudioBuffer }> {
  const ctx = new AudioContext();
  const audio = await ctx.decodeAudioData(await file.arrayBuffer());
  void ctx.close();
  const off = new OfflineAudioContext(1, Math.ceil(audio.duration * 16000), 16000);
  const src = off.createBufferSource();
  src.buffer = audio;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  const f = rendered.getChannelData(0);
  const pcm = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) pcm[i] = Math.max(-1, Math.min(1, f[i])) * 0x7fff;
  return { pcm, audio };
}

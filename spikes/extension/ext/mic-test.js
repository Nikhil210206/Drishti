// Captures ~1.5 s through pcm-capture.js (the Drishti panel's worklet) and reports what it got.
const log = (m) => (document.getElementById("log").textContent += m + "\n");

async function permissionState() {
  try {
    return (await navigator.permissions.query({ name: "microphone" })).state;
  } catch {
    return "unknown";
  }
}

async function testMic() {
  log(`permission before: ${await permissionState()}`);
  const t0 = performance.now();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    const ctx = new AudioContext();
    await ctx.audioWorklet.addModule(chrome.runtime.getURL("pcm-capture.js"));
    const node = new AudioWorkletNode(ctx, "pcm-capture");
    let chunks = 0;
    let bytes = 0;
    let peak = 0;
    node.port.onmessage = (e) => {
      chunks++;
      bytes += e.data.pcm.byteLength;
      peak = Math.max(peak, e.data.level);
    };
    ctx.createMediaStreamSource(stream).connect(node);
    await new Promise((r) => setTimeout(r, 1500));
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close();
    const result = {
      ok: chunks > 0,
      chunks,
      bytes,
      peak: Number(peak.toFixed(3)),
      ms: Math.round(performance.now() - t0),
      sampleRate: ctx.sampleRate,
    };
    log(`OK: ${JSON.stringify(result)}`);
    return result;
  } catch (e) {
    const result = { ok: false, error: `${e.name}: ${e.message}`, ms: Math.round(performance.now() - t0) };
    log(`FAILED: ${result.error}`);
    return result;
  } finally {
    log(`permission after: ${await permissionState()}`);
  }
}

window.testMic = testMic;
document.getElementById("test").onclick = testMic;
document.getElementById("grant").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("permission.html") });

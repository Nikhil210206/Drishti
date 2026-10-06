/**
 * How the panel reaches its VoiceSession. The dev harness runs the session on a server behind a
 * WebSocket; the extension runs it in the side panel itself. Both speak the same protocol: JSON
 * messages each way, mic PCM16 (16 kHz) up, speech PCM16 (24 kHz) down.
 */
export interface PanelHandlers {
  event(msg: any): void;
  audio(pcm: ArrayBuffer): void;
  open(connected: boolean): void;
}

export interface PanelTransport {
  /** Shown in the status row: what the panel is connected to. */
  label: string;
  send(msg: unknown): void;
  sendAudio(pcm: ArrayBuffer): void;
  /** Start; returns a function that disconnects. */
  connect(handlers: PanelHandlers): () => void;
}

/** The dev harness: the session runs on the server at `/ws` (reconnects every second). */
export function webSocketTransport(url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`): PanelTransport {
  let sock: WebSocket | undefined;
  const ready = () => sock?.readyState === WebSocket.OPEN;
  return {
    label: "Server",
    send: (msg) => ready() && sock!.send(JSON.stringify(msg)),
    sendAudio: (pcm) => ready() && sock!.send(pcm),
    connect(h) {
      let closed = false;
      let retry: number | undefined;
      const open = () => {
        const s = new WebSocket(url);
        s.binaryType = "arraybuffer";
        sock = s;
        s.onopen = () => h.open(true);
        s.onclose = () => {
          h.open(false);
          if (!closed) retry = window.setTimeout(open, 1000);
        };
        s.onmessage = (ev) => (ev.data instanceof ArrayBuffer ? h.audio(ev.data) : h.event(JSON.parse(ev.data)));
      };
      open();
      return () => {
        closed = true;
        clearTimeout(retry);
        sock?.close();
      };
    },
  };
}

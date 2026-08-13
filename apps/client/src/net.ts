import {
  MSG,
  decodeChunk,
  decodePatch,
  decodeSnapshot,
  decodeSound,
  encodeInput,
  type ControlToClient,
  type SnapshotMsg,
  type PatchMsg,
  type ChunkMsg,
  type SoundMsg,
  type InputMsg
} from "@burrow/protocol";

export interface NetHandlers {
  onOpen?(reconnected: boolean): void;
  onControl(msg: ControlToClient): void;
  onSnapshot(msg: SnapshotMsg): void;
  onPatch(msg: PatchMsg): void;
  onChunk(msg: ChunkMsg): void;
  onSound(msg: SoundMsg): void;
  onClose(status: { attempt: number; delayMs: number; wasConnected: boolean }): void;
}

/** Resolve the WS endpoint. Development uses Vite's same-origin proxy so the
 * browser never depends on a second public port or hits mixed-content rules. */
export function wsUrl(room: string, name: string, forceDev = false, mapSize?: number): string {
  const params = new URLSearchParams({ room, name });
  if (forceDev || new URLSearchParams(location.search).get("dev") === "1") params.set("dev", "1");
  if (mapSize !== undefined) params.set("size", String(mapSize));
  const env = (import.meta as any).env;
  const explicit = env?.VITE_WS_URL as string | undefined;
  if (explicit) return `${explicit}/ws?${params}`;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws?${params}`;
}

export class Net {
  private ws: WebSocket | null = null;
  private retryTimer: number | null = null;
  private generation = 0;
  private attempt = 0;
  private openedBefore = false;
  connected = false;

  connect(url: string, handlers: NetHandlers): void {
    this.close();
    const generation = this.generation;
    this.attempt = 0;
    this.openedBefore = false;
    this.open(url, handlers, generation);
  }

  private open(url: string, handlers: NetHandlers, generation: number): void {
    if (generation !== this.generation) return;
    const ws = new WebSocket(url);
    let openedThisSocket = false;
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      if (generation !== this.generation) {
        ws.close();
        return;
      }
      const reconnected = this.openedBefore;
      openedThisSocket = true;
      this.openedBefore = true;
      this.attempt = 0;
      this.connected = true;
      handlers.onOpen?.(reconnected);
    };
    ws.onclose = () => {
      if (generation !== this.generation) return;
      this.connected = false;
      if (this.ws === ws) this.ws = null;
      this.attempt++;
      const delayMs = Math.min(3000, 250 * 2 ** Math.min(4, this.attempt - 1));
      handlers.onClose({ attempt: this.attempt, delayMs, wasConnected: openedThisSocket });
      this.retryTimer = window.setTimeout(() => {
        this.retryTimer = null;
        this.open(url, handlers, generation);
      }, delayMs);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        try {
          handlers.onControl(JSON.parse(ev.data));
        } catch {
          /* ignore */
        }
        return;
      }
      const v = new DataView(ev.data as ArrayBuffer);
      if (v.byteLength < 2) return;
      switch (v.getUint8(1)) {
        case MSG.SNAPSHOT:
          handlers.onSnapshot(decodeSnapshot(v));
          break;
        case MSG.PATCH:
          handlers.onPatch(decodePatch(v));
          break;
        case MSG.CHUNK:
          handlers.onChunk(decodeChunk(v));
          break;
        case MSG.SOUND:
          handlers.onSound(decodeSound(v));
          break;
      }
    };
  }

  sendInput(m: InputMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(encodeInput(m));
  }

  sendJson(msg: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.generation++;
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    ws?.close();
  }
}

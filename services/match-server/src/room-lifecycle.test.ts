import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { Room } from "./room";
import { retireRoom, type HostedRoom } from "./room-lifecycle";

function room(overrides: Partial<HostedRoom> = {}): HostedRoom {
  return { matchId: "local", playerCount: 1, finished: false, ...overrides };
}

describe("room retirement", () => {
  it("notifies the server when the last human leaves an unstarted lobby", () => {
    const active = new Room({ matchId: "lobby", autoStartFull: false });
    const onFinished = vi.fn();
    const ws = {
      OPEN: 1,
      readyState: 1,
      on: vi.fn(),
      send: vi.fn(),
      close: vi.fn()
    } as unknown as WebSocket;
    active.onFinished = onFinished;

    active.addClient(ws, "human");
    active.removeClient(ws);

    expect(active.playerCount).toBe(0);
    expect(onFinished).toHaveBeenCalledOnce();
  });

  it("identifies each lobby client and relays sanitized, rate-limited chat", () => {
    const active = new Room({ matchId: "chat", autoStartFull: false });
    const hostSocket = {
      OPEN: 1,
      readyState: 1,
      on: vi.fn(),
      send: vi.fn(),
      close: vi.fn()
    };
    const guestSocket = {
      OPEN: 1,
      readyState: 1,
      on: vi.fn(),
      send: vi.fn(),
      close: vi.fn()
    };

    active.addClient(hostSocket as unknown as WebSocket, "Player 1");
    active.addClient(guestSocket as unknown as WebSocket, "Player 1");

    const hostLobby = JSON.parse(String(hostSocket.send.mock.calls.at(-1)?.[0]));
    const guestLobby = JSON.parse(String(guestSocket.send.mock.calls.at(-1)?.[0]));
    expect(hostLobby).toMatchObject({ t: "lobby", hostId: 0, selfId: 0 });
    expect(guestLobby).toMatchObject({ t: "lobby", hostId: 0, selfId: 1 });

    hostSocket.send.mockClear();
    guestSocket.send.mockClear();
    const messageHandler = hostSocket.on.mock.calls.find(([event]) => event === "message")?.[1] as
      | ((data: Buffer, isBinary: boolean) => void)
      | undefined;
    expect(messageHandler).toBeTypeOf("function");
    messageHandler?.(Buffer.from(JSON.stringify({ t: "chat", msg: "  hello\n miners  " })), false);

    const expected = { t: "chat", id: 0, name: "Player 1", msg: "hello miners" };
    expect(JSON.parse(String(hostSocket.send.mock.calls[0]?.[0]))).toMatchObject(expected);
    expect(JSON.parse(String(guestSocket.send.mock.calls[0]?.[0]))).toMatchObject(expected);

    messageHandler?.(Buffer.from(JSON.stringify({ t: "chat", msg: "spam" })), false);
    expect(hostSocket.send).toHaveBeenCalledOnce();
    expect(guestSocket.send).toHaveBeenCalledOnce();
  });

  it("releases an abandoned bot-only match immediately", () => {
    vi.useFakeTimers();
    const abandoned = room({ playerCount: 0 });
    const rooms = new Map([[abandoned.matchId, abandoned]]);

    retireRoom(rooms, abandoned, { mode: "local" });

    expect(rooms.has("local")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("keeps the score-screen grace period for a completed match", () => {
    vi.useFakeTimers();
    const completed = room({ finished: true });
    const rooms = new Map([[completed.matchId, completed]]);

    retireRoom(rooms, completed, { mode: "local", graceMs: 30_000 });
    expect(rooms.has("local")).toBe(true);

    vi.advanceTimersByTime(30_000);
    expect(rooms.has("local")).toBe(false);
    vi.useRealTimers();
  });

  it("never lets an old cleanup delete a replacement room", () => {
    vi.useFakeTimers();
    const completed = room({ finished: true });
    const replacement = room();
    const rooms = new Map([[completed.matchId, completed]]);

    retireRoom(rooms, completed, { mode: "local", graceMs: 30_000 });
    rooms.set("local", replacement);
    vi.advanceTimersByTime(30_000);

    expect(rooms.get("local")).toBe(replacement);
    vi.useRealTimers();
  });

  it("accepts clamped free-camera coordinates only from developer clients", () => {
    const socket = {
      OPEN: 1,
      readyState: 1,
      on: vi.fn(),
      send: vi.fn(),
      close: vi.fn()
    } as unknown as WebSocket;
    const active = new Room({ matchId: "dev-camera", autoStartFull: false });
    active.addClient(socket, "Developer", true);
    const internals = active as any;
    internals.sim = { world: { size: 4096 } };
    const client = internals.clients[0];
    client.playerId = 0;

    internals.handleControl(client, JSON.stringify({ t: "dev-camera", active: true, x: -40, y: 9_000 }));
    expect(client.devCameraX).toBe(0);
    expect(client.devCameraY).toBe(4095);

    internals.handleControl(client, JSON.stringify({ t: "dev-camera", active: false, x: 0, y: 0 }));
    expect(client.devCameraX).toBeNull();
    expect(client.devCameraY).toBeNull();

    client.devMode = false;
    internals.handleControl(client, JSON.stringify({ t: "dev-camera", active: true, x: 100, y: 200 }));
    expect(client.devCameraX).toBeNull();
    expect(client.devCameraY).toBeNull();
  });
});

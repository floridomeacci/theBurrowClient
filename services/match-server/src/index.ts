import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { balanceForWorldSize, type Balance } from "@burrow/config";
import { Room } from "./room";
import { retireRoom } from "./room-lifecycle";

/**
 * Authoritative match server.
 *
 * Modes:
 *  - local dev (default): multi-room server; clients pick a room via
 *    ws://host/ws?room=<id>&name=<name>. Rooms auto-create.
 *  - container (MODE=container): hosts exactly ONE match whose id comes from
 *    MATCH_ID (injected by the Match Durable Object). This is the image that
 *    runs in Cloudflare Containers — same code path, single room.
 */

const PORT = Number(process.env.PORT ?? 8787);
const MODE = process.env.MODE ?? "local";
const HOST = process.env.HOST ?? (MODE === "container" ? "0.0.0.0" : "127.0.0.1");
const MATCH_ID = process.env.MATCH_ID ?? "local";
const SEED = process.env.SEED ? Number(process.env.SEED) : undefined;
const MAX_WS_PAYLOAD_BYTES = 4096;

const rooms = new Map<string, Room>();

/** Selectable world sizes (square cells). The first client to open a room
 *  fixes its size; later joins inherit the existing room. */
const MAP_SIZES = new Set([1024, 2048, 4096]);

function parseMapSize(raw: string | null): number | undefined {
  const size = Number(raw);
  return MAP_SIZES.has(size) ? size : undefined;
}

function balanceForMapSize(mapSize: number | undefined): Balance | undefined {
  return mapSize === undefined ? undefined : balanceForWorldSize(mapSize);
}

function getRoom(id: string, mapSize?: number): Room {
  let room = rooms.get(id);
  if (!room) {
    room = new Room({ matchId: id, seed: SEED, balance: balanceForMapSize(mapSize) });
    room.onFinished = (r) => {
      const abandoned = r.playerCount === 0 && !r.finished;
      if (abandoned) console.log(`[server] match ${r.matchId} abandoned; releasing room`);
      retireRoom(rooms, r, {
        mode: MODE,
        exitContainer: () => {
          console.log(`[server] match ${r.matchId} ${abandoned ? "abandoned" : "finished"}; container exiting`);
          process.exit(0);
        }
      });
    };
    rooms.set(id, room);
    console.log(`[server] room created: ${id} (world=${room.bal.world.size})`);
  }
  return room;
}

const http = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, mode: MODE, rooms: rooms.size }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({
  server: http,
  path: undefined,
  maxPayload: MAX_WS_PAYLOAD_BYTES,
  perMessageDeflate: false
});

wss.on("connection", (ws: WebSocket, req) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname !== "/ws") {
    ws.close();
    return;
  }
  const roomId = MODE === "container" ? MATCH_ID : (url.searchParams.get("room") ?? "local");
  const name = (url.searchParams.get("name") ?? "miner").slice(0, 16) || "miner";
  const devMode = MODE === "local" && url.searchParams.get("dev") === "1";
  const mapSize = parseMapSize(url.searchParams.get("size")) ?? parseMapSize(process.env.MAP_SIZE ?? null);

  const room = getRoom(roomId, mapSize);
  room.addClient(ws, name, devMode);
  ws.on("close", () => room.removeClient(ws));
  ws.on("error", () => room.removeClient(ws));
});

http.listen(PORT, HOST, () => {
  console.log(`[server] The Burrow match server on ${HOST}:${PORT} (mode=${MODE})`);
});

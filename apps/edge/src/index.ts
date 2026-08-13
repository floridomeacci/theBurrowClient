/// <reference types="@cloudflare/workers-types" />
/**
 * The Burrow — edge gateway (spec §16).
 *
 * Components in this Worker:
 *  - Gateway routing: static assets, /api/queue, /ws
 *  - Matchmaker Durable Object: regional queue -> match formation
 *  - MatchDO: one Durable Object per match, owning one Cloudflare Container
 *    running services/match-server (MODE=container)
 *  - Queue consumer: exactly-once match result persistence into D1
 */
import { Container } from "@cloudflare/containers";
import { signMatchToken, verifyMatchToken } from "./tokens";

export interface Env {
  ASSETS: Fetcher;
  MATCHMAKER: DurableObjectNamespace;
  MATCH: DurableObjectNamespace;
  DB: D1Database;
  REPLAYS: R2Bucket;
  RESULTS_QUEUE: Queue;
  MATCH_TOKEN_SECRET: string;
  REGION: string;
}

const BUILD_VERSION = "0.1.0";
const MATCH_SIZE = 8;
const QUEUE_WAIT_MS = 15_000; // form a (partially bot) match after this wait

/* ------------------------------------------------------------ gateway */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/queue" && request.method === "POST") {
      // regional queue; single region for MVP (spec §16.4)
      const id = env.MATCHMAKER.idFromName(env.REGION);
      return env.MATCHMAKER.get(id).fetch(request);
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("websocket upgrade required", { status: 426 });
      }
      const token = url.searchParams.get("token");
      if (!token) return new Response("missing token", { status: 401 });
      const payload = await verifyMatchToken(token, env.MATCH_TOKEN_SECRET);
      if (!payload) return new Response("invalid token", { status: 403 });
      if (payload.build !== BUILD_VERSION) return new Response("version mismatch", { status: 426 });
      const id = env.MATCH.idFromName(payload.matchId);
      // Identity is verified before the request enters the isolated match route.
      const proxied = new URL(request.url);
      proxied.searchParams.set("room", payload.matchId);
      proxied.searchParams.set("name", payload.name);
      return env.MATCH.get(id).fetch(new Request(proxied.toString(), request));
    }

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, build: BUILD_VERSION });
    }

    return env.ASSETS.fetch(request);
  },

  /** Queue consumer: idempotent match-result persistence (spec §16.1, §20). */
  async queue(batch: MessageBatch<MatchResultMessage>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      const r = msg.body;
      try {
        for (const pr of r.playerResults) {
          await env.DB.prepare(
            `INSERT OR IGNORE INTO match_history
             (match_id, player_id, role, result, captures, secured_gems, survived_seconds, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
            .bind(r.matchId, pr.playerId, pr.role, r.winningSide, pr.captures, pr.securedGems, pr.survivedSeconds, r.endedAt)
            .run();
          await env.DB.prepare(
            `UPDATE players SET secured_gems = secured_gems + ?, last_seen_at = ? WHERE id = ?`
          )
            .bind(pr.securedGems, r.endedAt, pr.playerId)
            .run();
        }
        msg.ack();
      } catch (e) {
        console.error("result persistence failed", e);
        msg.retry();
      }
    }
  }
} satisfies ExportedHandler<Env, MatchResultMessage>;

export interface MatchResultMessage {
  matchId: string;
  endedAt: number;
  winningSide: string;
  playerResults: {
    playerId: string;
    role: string;
    captures: number;
    securedGems: number;
    survivedSeconds: number;
  }[];
}

/* ------------------------------------------------------------ matchmaker DO */

interface QueueEntry {
  name: string;
  enqueuedAt: number;
}

export class Matchmaker implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > 1024) return new Response("request too large", { status: 413 });
    const raw = await request.text();
    if (raw.length > 1024) return new Response("request too large", { status: 413 });
    let body: { name?: unknown } = {};
    try {
      body = raw ? JSON.parse(raw) as { name?: unknown } : {};
    } catch {
      return new Response("invalid JSON", { status: 400 });
    }
    const name = String(body.name ?? "miner")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 16) || "miner";

    const queue = (await this.state.storage.get<QueueEntry[]>("queue")) ?? [];
    queue.push({ name, enqueuedAt: Date.now() });

    let matchId: string | null = null;
    const oldest = queue[0]?.enqueuedAt ?? Date.now();
    if (queue.length >= MATCH_SIZE || Date.now() - oldest > QUEUE_WAIT_MS) {
      // form match: everyone currently queued (bots fill the rest server-side)
      matchId = crypto.randomUUID();
      const members = queue.splice(0, MATCH_SIZE);
      await this.state.storage.put("queue", queue);
      // pre-warm the container while lobby countdown runs (spec §16.3)
      const id = this.env.MATCH.idFromName(matchId);
      await this.env.MATCH.get(id).fetch(new Request(`https://match/prewarm?matchId=${matchId}`));
      const tokens = await Promise.all(
        members.map((m) =>
          signMatchToken(
            {
              matchId: matchId!,
              name: m.name,
              build: BUILD_VERSION,
              exp: Math.floor(Date.now() / 1000) + 120,
              nonce: crypto.randomUUID().slice(0, 8)
            },
            this.env.MATCH_TOKEN_SECRET
          )
        )
      );
      return Response.json({ matchId, token: tokens[tokens.length - 1], queued: 0 });
    }

    await this.state.storage.put("queue", queue);
    return Response.json({ matchId: null, queued: queue.length });
  }
}

/* ------------------------------------------------------------ match DO + container */

/** One logical match: owns container lifecycle, routes WebSockets to it. */
export class MatchDO extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "2m"; // reconnection grace before teardown (spec §16.3)

  override envVars = {
    MODE: "container",
    MATCH_ID: this.ctx.id.toString()
  };

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/prewarm") {
      await this.start();
      return new Response("warming");
    }
    // proxy WebSocket upgrade and HTTP to the authoritative container
    return await this.containerFetch(request, this.defaultPort);
  }

  override onError(error: unknown): void {
    console.error(`match container error (${this.ctx.id.toString()})`, error);
  }
}

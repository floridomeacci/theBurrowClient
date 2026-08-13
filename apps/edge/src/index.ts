/// <reference types="@cloudflare/workers-types" />
/**
 * The Burrow — edge gateway (spec §16).
 *
 * Components in this Worker:
 *  - Gateway routing: static assets, /api/session, /ws
 *  - Matchmaker Durable Object: session issuance and request throttling
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
const SESSION_RATE_WINDOW_MS = 60_000;
const SESSION_RATE_LIMIT = 20;

/* ------------------------------------------------------------ gateway */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/session") {
      if (request.method !== "POST") {
        return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
      }
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
      proxied.searchParams.delete("token");
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

interface RateBucket {
  startedAt: number;
  count: number;
}

export class Matchmaker implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const requestUrl = new URL(request.url);
    const origin = request.headers.get("origin");
    if (origin && origin !== requestUrl.origin) return new Response("invalid origin", { status: 403 });

    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > 1024) return new Response("request too large", { status: 413 });
    const raw = await request.text();
    if (raw.length > 1024) return new Response("request too large", { status: 413 });
    let body: { name?: unknown; room?: unknown } = {};
    try {
      body = raw ? JSON.parse(raw) as { name?: unknown; room?: unknown } : {};
    } catch {
      return new Response("invalid JSON", { status: 400 });
    }
    const name = String(body.name ?? "miner")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 16) || "miner";
    const requestedRoom = String(body.room ?? "local").trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,32}$/.test(requestedRoom)) {
      return new Response("invalid room", { status: 400 });
    }

    const address = request.headers.get("cf-connecting-ip") ?? "unknown";
    const addressBytes = new TextEncoder().encode(address);
    const addressHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", addressBytes)))
      .slice(0, 16)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const rateKey = `session-rate:${addressHash}`;
    const now = Date.now();
    let bucket = await this.state.storage.get<RateBucket>(rateKey);
    if (!bucket || now - bucket.startedAt >= SESSION_RATE_WINDOW_MS) bucket = { startedAt: now, count: 0 };
    if (bucket.count >= SESSION_RATE_LIMIT) {
      return new Response("rate limit exceeded", { status: 429, headers: { "retry-after": "60" } });
    }
    bucket.count++;
    await this.state.storage.put(rateKey, bucket);

    const token = await signMatchToken(
      {
        matchId: requestedRoom,
        name,
        build: BUILD_VERSION,
        exp: Math.floor(now / 1000) + 300,
        nonce: crypto.randomUUID().slice(0, 8)
      },
      this.env.MATCH_TOKEN_SECRET
    );
    return Response.json(
      { matchId: requestedRoom, token },
      { headers: { "cache-control": "no-store" } }
    );
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

/** Headless smoke test: connects one client, starts a match with bots,
 *  plays random inputs for a few seconds, and asserts the core message flow.
 *  Run: pnpm --filter @burrow/match-server exec tsx src/smoke.ts */
import WebSocket from "ws";
import { MSG, PROTOCOL_VERSION, decodeChunk, decodeSnapshot, encodeInput } from "@burrow/protocol";
import { ENT } from "@burrow/sim";

const url = process.env.SMOKE_URL ?? "ws://localhost:8787/ws?room=smoke&name=smoketester&dev=1";
const ws = new WebSocket(url);
ws.binaryType = "arraybuffer";

let snapshots = 0;
let chunks = 0;
let patches = 0;
let sounds = 0;
let welcomed = false;
let worldSize = 0;
let maxChunkCoord = 0;
const phaseKinds = new Set<string>();
let endlessDay = false;
let zombieSeen = false;
let role = -1;
let seq = 0;
let upgradeAttempted = false;
let upgradeInstalled = false;
let playerUpgradesInstalled = false;
let playerUpgradeSnapshotOk = false;
const playerUpgradeLogs = new Set<string>();
let devResourcesOk = false;
let devModeWelcomed = false;
let devViewOk = false;
let devViewRequested = false;

const timeout = setTimeout(() => fail("timeout"), 20000);

ws.on("open", () => {
  console.log("[smoke] connected");
  setTimeout(() => ws.send(JSON.stringify({ t: "start" })), 300);
  setInterval(() => {
    if (!welcomed) return;
    seq++;
    ws.send(
      encodeInput({
        seq,
        moveX: [1, 0, -1][seq % 3] as number,
        moveY: [0, 1, -1][(seq >> 2) % 3] as number,
        aim: (seq * 7) & 255,
        buttons: seq % 4 === 0 ? 1 : 0,
        slot: 2,
        ackTick: 0
      })
    );
  }, 33);
});

ws.on("message", (raw: Buffer | ArrayBuffer, isBinary: boolean) => {
  const data = raw instanceof ArrayBuffer ? Buffer.from(raw) : (raw as Buffer);
  if (!isBinary) {
    const msg = JSON.parse(data.toString());
    if (msg.t === "welcome") {
      welcomed = true;
      worldSize = msg.worldSize;
      devModeWelcomed = msg.devMode === true;
      console.log(`[smoke] welcomed as player ${msg.playerId}, world ${msg.worldSize}`);
    }
    if (msg.t === "role") {
      role = msg.role;
      console.log(`[smoke] role: ${role === 1 ? "infected" : "miner"}`);
    }
    if (msg.t === "phase") {
      phaseKinds.add(msg.kind);
      if (msg.kind === "day") endlessDay = msg.endTick === 0xffffffff;
      console.log(`[smoke] phase -> ${msg.kind}`);
      if (msg.kind === "day" && !upgradeAttempted) {
        upgradeAttempted = true;
        ws.send(JSON.stringify({ t: "upgrade", node: "speed" }));
        ws.send(JSON.stringify({ t: "upgrade", node: "vision" }));
        ws.send(JSON.stringify({ t: "upgrade", node: "mobility" }));
        ws.send(JSON.stringify({ t: "upgrade", node: "vitality" }));
      }
    }
    if (msg.t === "dev-view" && msg.bot && !msg.own) devViewOk = true;
    if (msg.t === "log" && msg.msg.includes("Fast Fuse crafted and installed")) upgradeInstalled = true;
    if (msg.t === "log") {
      if (msg.msg.includes("Survey Optics crafted and installed")) playerUpgradeLogs.add("vision");
      if (msg.msg.includes("Tunnel Stride crafted and installed")) playerUpgradeLogs.add("mobility");
      if (msg.msg.includes("Reinforced Suit crafted and installed")) playerUpgradeLogs.add("vitality");
      playerUpgradesInstalled = playerUpgradeLogs.size === 3;
    }
    return;
  }
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (v.getUint8(0) !== PROTOCOL_VERSION) return;
  switch (v.getUint8(1)) {
    case MSG.SNAPSHOT: {
      snapshots++;
      const s = decodeSnapshot(v);
      if (
        s.self.visionLevel >= 1 && s.self.moveSpeedLevel >= 1 && s.self.healthLevel >= 1 &&
        s.self.health === 150 && s.self.maxHealth === 150
      ) playerUpgradeSnapshotOk = true;
      if (snapshots === 1) {
        devResourcesOk =
          s.self.carried === 60000 && s.self.gold === 60000 && s.self.fossils === 60000 &&
          s.self.copper === 60000 && s.self.iron === 60000 && s.self.platinum === 60000 &&
          s.self.dynamite === 99 && s.self.c4 === 99 && s.self.clusterBombs === 99 &&
          s.self.napalm === 99 && s.self.nukes === 99 && s.self.turretKits === 99;
        console.log(
          `[smoke] first snapshot: tick=${s.tick} pos=(${s.self.x >> 8},${s.self.y >> 8}) devResources=${devResourcesOk}`
        );
      }
      if (s.entities.some((entity) => entity.kind === ENT.ZOMBIE)) zombieSeen = true;
      // Keep observing the owning player until the post-countdown upgrade
      // snapshot has arrived, then verify the dev camera independently.
      if (snapshots === 82 && !devViewRequested) {
        devViewRequested = true;
        ws.send(JSON.stringify({ t: "dev-view", direction: 1 }));
      }
      break;
    }
    case MSG.CHUNK: {
      chunks++;
      const chunk = decodeChunk(v);
      maxChunkCoord = Math.max(maxChunkCoord, chunk.cx, chunk.cy);
      break;
    }
    case MSG.PATCH:
      patches++;
      break;
    case MSG.SOUND:
      sounds++;
      break;
  }
  if (snapshots >= 90) finish();
});

ws.on("error", (e) => fail(String(e)));

function finish(): void {
  clearTimeout(timeout);
  console.log(
    `[smoke] snapshots=${snapshots} chunks=${chunks} patches=${patches} sounds=${sounds} role=${role} dev=${devModeWelcomed}/${devResourcesOk}/${devViewOk} upgrades=${upgradeInstalled}/${playerUpgradesInstalled}/${playerUpgradeSnapshotOk} zombies=${zombieSeen}`
  );
  const ok =
    welcomed &&
    worldSize === 4096 &&
    snapshots >= 90 &&
    chunks > 0 &&
    chunks <= 80 &&
    maxChunkCoord <= 63 &&
    role === 0 &&
    devModeWelcomed &&
    devResourcesOk &&
    devViewOk &&
    upgradeInstalled &&
    playerUpgradesInstalled &&
    playerUpgradeSnapshotOk &&
    !zombieSeen &&
    phaseKinds.has("day") &&
    !phaseKinds.has("dusk") &&
    !phaseKinds.has("night") &&
    endlessDay;
  console.log(ok ? "[smoke] PASS" : "[smoke] FAIL");
  process.exit(ok ? 0 : 1);
}

function fail(why: string): void {
  console.error(`[smoke] FAIL: ${why}`);
  process.exit(1);
}

import { BALANCE } from "@burrow/config";
import {
  BASE_TOOL_SLOT,
  BUILDING_DEFS,
  ENT,
  FP,
  MAT,
  PFLAG,
  RELIC,
  ROLE,
  SOUND,
  WEAPON_TECH,
  WEAPON_TECH_BRANCHES,
  bombUpgradeQuotes,
  buildingDefinition,
  buildingPrerequisiteMet,
  hash2,
  hasWeaponBlueprint,
  weaponTechDefinition,
  type BombUpgradeId,
  type CraftResource,
  type WeaponBlueprintId
} from "@burrow/sim";
import type { ControlToClient } from "@burrow/protocol";
import { Net, wsUrl } from "./net";
import { ClientState } from "./state";
import { Renderer } from "./render";
import { InputState } from "./input";
import { AudioSys } from "./audio";
import { availableTools, buildingIcon, itemArt, toolIcon, type ToolCard } from "./tool-ui";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>("game-canvas");
const minimap = $<HTMLCanvasElement>("minimap");
const net = new Net();
const st = new ClientState();
const renderer = new Renderer(canvas, minimap);
const input = new InputState(canvas);
const audio = new AudioSys();

let mode: "menu" | "lobby" | "game" | "end" = "menu";
let isHost = false;
let lastInputSendAt = 0;
let lastFrameAt = 0;
let lastAim = 0;
let recentBombOrigins: { x: number; y: number; range: number; at: number }[] = [];
let animatedGemPickups = new Set<string>();
let animatedTreasurePickups = new Set<string>();
let lastSkillTreeSignature = "";
let skillTreeRevealTimer = 0;
let lastCarouselSignature = "";
let lastCarouselSlot = 1;
let knownToolSlots = new Set([1]);
let carouselInitialized = false;
type ToolMode = "weapons" | "buildings";
let toolMode: ToolMode = "weapons";
let latestToolPool: ToolCard[] = [];
const lastToolSlotByMode: Record<ToolMode, number> = { weapons: 1, buildings: BASE_TOOL_SLOT };
let devMode = false;
let devViewing = false;
let currentViewName = "";
let currentViewIsBot = false;
let devFreeCamera = false;
let devCameraWorldX = 0;
let devCameraWorldY = 0;
let lastDevCameraSentAt = 0;
let pendingRoom = "local";
let pendingMapSize = 4096;
let currentLobbySelfId = -1;
const playerName = "Player 1";

/** A tileable version of the terrain renderer's layered value noise. */
function armoryNoise(x: number, y: number, scale: number, seed: number): number {
  const period = 64 / scale;
  const gx = x / scale;
  const gy = y / scale;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const tx0 = gx - x0;
  const ty0 = gy - y0;
  const tx = tx0 * tx0 * (3 - 2 * tx0);
  const ty = ty0 * ty0 * (3 - 2 * ty0);
  const sample = (sx: number, sy: number) => {
    const wx = ((sx % period) + period) % period;
    const wy = ((sy % period) + period) % period;
    return (hash2(wx, wy, seed) & 0xffff) / 0xffff;
  };
  const a = sample(x0, y0);
  const b = sample(x0 + 1, y0);
  const c = sample(x0, y0 + 1);
  const d = sample(x0 + 1, y0 + 1);
  return (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * ty;
}

function installArmoryGround(): void {
  const size = 256;
  const cellPx = 4;
  const cells = size / cellPx;
  const texture = document.createElement("canvas");
  texture.width = size;
  texture.height = size;
  const ctx = texture.getContext("2d");
  if (!ctx) return;
  const image = ctx.createImageData(size, size);
  for (let cellY = 0; cellY < cells; cellY++) {
    for (let cellX = 0; cellX < cells; cellX++) {
      const broad = (armoryNoise(cellX, cellY, 16, 0x7151) - 0.5) * 18;
      const patch = (armoryNoise(cellX, cellY, 4, 0xa92d) - 0.5) * 13;
      const detailSeed = hash2(cellX, cellY, 0x4d37);
      const raisedEdge = detailSeed % 7 === 0;
      const pitCell = detailSeed % 23 === 0;
      const rustCell = detailSeed % 31 === 0;
      const pitX = (detailSeed >>> 9) & 3;
      const pitY = (detailSeed >>> 13) & 3;
      for (let py = 0; py < cellPx; py++) {
        for (let px = 0; px < cellPx; px++) {
          const imageX = cellX * cellPx + px;
          const imageY = cellY * cellPx + py;
          const pixelSeed = hash2(imageX, imageY, 0x93c5);
          let shade = broad + patch + ((pixelSeed & 31) - 15) * 0.34;
          if (raisedEdge && py === 0) shade += 8;
          if (raisedEdge && px === 0) shade += 4;
          if (raisedEdge && py === cellPx - 1) shade -= 8;
          if (raisedEdge && px === cellPx - 1) shade -= 5;
          if (pitCell && px === pitX && py === pitY) shade -= 23;
          if (pitCell && px === Math.max(0, pitX - 1) && py === Math.max(0, pitY - 1)) shade += 10;
          if (pixelSeed % 181 === 0) shade += 19;
          const rust = rustCell && (px + py === 3 || (px === pitX && py === pitY));
          const offset = (imageY * size + imageX) * 4;
          image.data[offset] = Math.max(0, Math.min(255, Math.round(11 + shade + (rust ? 11 : 0))));
          image.data[offset + 1] = Math.max(0, Math.min(255, Math.round(14 + shade + (rust ? 1 : 0))));
          image.data[offset + 2] = Math.max(0, Math.min(255, Math.round(16 + shade)));
          image.data[offset + 3] = 255;
        }
      }
    }
  }
  ctx.putImageData(image, 0, 0);
  $("skill-tree").style.setProperty("--armory-ground", `url("${texture.toDataURL("image/png")}")`);
}

interface PreviewItem {
  name: string;
  description: string;
  art: string | null;
  slot?: number;
  buildingKind?: number;
  relicBit?: number;
}

const TOOL_CONCEPTS: readonly PreviewItem[] = [
  { name: "Tunnel Drill", description: "Rapidly cuts a straight, player-width tunnel; consumes energy and overheats.", art: "tools/tunnel-drill" },
  { name: "Seismic Scanner", description: "Reveals nearby deposits, bombs, players, and guardians, but exposes your position.", art: "tools/seismic-scanner" },
  { name: "Air Pump", description: "Creates a temporary oxygen-safe pocket for defensive bases.", art: "tools/air-pump" },
  { name: "Foam Sprayer", description: "Places cheap temporary walls that decay or break from one blast.", art: "tools/foam-sprayer" },
  { name: "Demolition Wrench", description: "Dismantles your own walls and turrets, refunding some materials.", art: "tools/demolition-wrench" },
  { name: "Teleporter Pair", description: "Places two linked pads for escapes, bomb delivery, or ambushes.", art: "tools/teleporter-pair" },
  { name: "Magnet Collector", description: "Attracts exposed gems and bomb fragments but makes noise.", art: "tools/magnet-collector" },
  { name: "Decoy Beacon", description: "Creates fake digging, movement, and bomb sounds.", art: "tools/decoy-beacon" },
  { name: "Grappling Harpoon", description: "Pulls the player through tunnels or drags movable bombs.", art: "tools/grappling-harpoon" },
  { name: "Repair Drone", description: "Slowly repairs nearby walls and turrets using iron.", art: "tools/repair-drone" }
];

const MINING_BASE_TOOL: PreviewItem = {
  name: "Mining Base",
  description: "Deploys with one autonomous miner and fabricates more workers through interaction.",
  art: "current/mining-base",
  slot: BASE_TOOL_SLOT
};

const BUILDING_ITEMS = BUILDING_DEFS.map((building): PreviewItem => ({
  name: building.label,
  description: building.description,
  art: null,
  slot: building.slot,
  buildingKind: building.kind
}));

const TOOL_BRANCHES: readonly { label: string; description: string; items: readonly PreviewItem[] }[] = [
  { label: "Power backbone", description: "Root the grid, burn coal, store charge, and extend cables.", items: [MINING_BASE_TOOL, BUILDING_ITEMS[0]!, BUILDING_ITEMS[1]!, BUILDING_ITEMS[2]!] },
  { label: "Extraction fleet", description: "Train crews, bore deep seams, haul ore, and stack drill upgrades.", items: [BUILDING_ITEMS[10]!, BUILDING_ITEMS[11]!, BUILDING_ITEMS[12]!, BUILDING_ITEMS[13]!] },
  { label: "Life & production", description: "Keep miners breathing, light the works, and refine ore.", items: [BUILDING_ITEMS[3]!, BUILDING_ITEMS[4]!, BUILDING_ITEMS[9]!] },
  { label: "Perimeter defense", description: "Automated fire, breach control, shielding, and repairs.", items: [BUILDING_ITEMS[5]!, BUILDING_ITEMS[6]!, BUILDING_ITEMS[7]!, BUILDING_ITEMS[8]!] },
  { label: "Field prototypes", description: "Future portable excavation, transit, and deception systems.", items: TOOL_CONCEPTS }
];

const RELIC_CONCEPTS: readonly PreviewItem[] = [
  { name: "Singularity Seed", description: "Creates a temporary black hole that pulls everything inward before exploding.", art: "relics/singularity-seed" },
  { name: "Echo Core", description: "Repeats its complete blast pattern several seconds later.", art: "relics/echo-core", relicBit: RELIC.ECHO_CORE },
  { name: "Chrono Detonator", description: "Slows players and pauses other bomb fuses inside its field.", art: "relics/chrono-detonator" },
  { name: "Mirror Charge", description: "Blast arms reflect once when they hit rigid walls.", art: "relics/mirror-charge" },
  { name: "Mole King’s Scepter", description: "Launches several burrowing bombs toward visible enemies.", art: "relics/mole-kings-scepter" },
  { name: "Fossil Egg", description: "Releases a temporary allied ruin creature.", art: "relics/fossil-egg" },
  { name: "Geode Heart", description: "Changes its effect according to the materials loaded into it.", art: "relics/geode-heart", relicBit: RELIC.GEODE_HEART },
  { name: "Atlas Hammer", description: "Creates an enormous terrain-breaking shockwave without placing a bomb.", art: "relics/atlas-hammer" },
  { name: "Rift Anchor", description: "Swaps the positions of two players or deployed devices.", art: "relics/rift-anchor" },
  { name: "Phoenix Casing", description: "Saves the carrier from one lethal blast, then explodes outward.", art: "relics/phoenix-casing", relicBit: RELIC.PHOENIX_CASING },
  { name: "Dead Miner’s Switch", description: "Detonates every armed charge owned by the player when activated or killed.", art: "relics/dead-miners-switch", relicBit: RELIC.DEAD_MINERS_SWITCH },
  { name: "Swarm Canister", description: "Releases small hunter charges that pursue visible enemies through tunnels.", art: "relics/swarm-canister" }
];

const RELIC_BRANCHES: readonly { label: string; description: string; items: readonly PreviewItem[] }[] = [
  { label: "Anomaly cores", description: "Space, time, and repeating detonations.", items: RELIC_CONCEPTS.slice(0, 3) },
  { label: "Buried sovereigns", description: "Ancient weapons and ruin allies.", items: RELIC_CONCEPTS.slice(3, 6) },
  { label: "World shapers", description: "Material, terrain, and position control.", items: RELIC_CONCEPTS.slice(6, 9) },
  { label: "Last rites", description: "Survival, retaliation, and hunter swarms.", items: RELIC_CONCEPTS.slice(9, 12) }
];

/* ------------------------------------------------------------- overlays */

function show(id: "menu" | "lobby" | "end" | null): void {
  for (const o of ["menu", "lobby", "end"]) $(o).classList.toggle("hidden", o !== id);
  $("hud").classList.toggle("active", id === null);
}

$("create-btn").addEventListener("click", createRoom);
$("join-btn").addEventListener("click", chooseJoinRoom);
for (const button of document.querySelectorAll<HTMLButtonElement>(".map-size button")) {
  button.addEventListener("click", () => {
    pendingMapSize = Number(button.dataset.size) || 4096;
    for (const other of document.querySelectorAll<HTMLButtonElement>(".map-size button")) {
      other.classList.toggle("active", other === button);
    }
  });
}
$("start-btn").addEventListener("click", () => net.sendJson({ t: "start" }));
$("leave-lobby-btn").addEventListener("click", leaveLobby);
$("lobby-copy-btn").addEventListener("click", copyLobbyInvite);
$<HTMLFormElement>("lobby-chat-form").addEventListener("submit", sendLobbyChat);
$("again-btn").addEventListener("click", () => location.reload());
$("skill-toggle").addEventListener("click", () => toggleSkillTree());
$("skill-close").addEventListener("click", () => toggleSkillTree(false));
$("tool-prev").addEventListener("click", () => input.cycle(-1));
$("tool-next").addEventListener("click", () => input.cycle(1));
$("tool-mode-tabs").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-tool-mode]");
  if (!button || button.disabled) return;
  setToolMode(button.dataset.toolMode as ToolMode);
});
$("tool-dots").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
  if (!button) return;
  if (button.dataset.cycle) input.cycle(button.dataset.cycle === "-1" ? -1 : 1);
  else if (button.dataset.slot) input.slot = Number(button.dataset.slot);
});
$("tool-card").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(".tool-craft-overlay");
  if (!button) return;
  event.preventDefault();
  input.slot = 2;
  input.pulsePrimary();
});
$("skill-nodes").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-node], button[data-pick-unlock]");
  if (!button || button.disabled) return;
  if (button.dataset.pickUnlock !== undefined) {
    input.slot = 2;
    input.pulsePrimary();
    return;
  }
  net.sendJson({ t: "upgrade", node: button.dataset.node as BombUpgradeId });
});
$("weapon-skill-nodes").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-weapon-tech]");
  if (!button || button.disabled) return;
  net.sendJson({ t: "weapon-tech", id: button.dataset.weaponTech as WeaponBlueprintId });
});
$("tool-skill-nodes").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-building-slot]");
  if (!button || button.disabled) return;
  setToolMode("buildings", Number(button.dataset.buildingSlot));
  toggleSkillTree(false);
});
window.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
  if ((event.code === "KeyK" || event.code === "KeyU") && !event.repeat && mode === "game") {
    event.preventDefault();
    toggleSkillTree();
  }
  if (event.code === "Escape") toggleSkillTree(false);
  if (devMode && (event.code === "BracketLeft" || event.code === "BracketRight") && !event.repeat) {
    event.preventDefault();
    net.sendJson({ t: "dev-view", direction: event.code === "BracketLeft" ? -1 : 1 });
  }
  if (devMode && mode === "game" && event.code === "KeyF" && !event.repeat) {
    event.preventDefault();
    // InputState receives this event first; remove F so developer inspection
    // never also fires the normal collapse-charge trigger.
    input.keys.delete("KeyF");
    devFreeCamera = !devFreeCamera;
    if (devFreeCamera) {
      devCameraWorldX = st.predX / FP * st.cellPx;
      devCameraWorldY = st.predY / FP * st.cellPx;
      st.pending = [];
      sendDevCamera(performance.now(), true);
    } else {
      net.sendJson({ t: "dev-camera", active: false, x: 0, y: 0 });
    }
    updateDevStatus();
  }
});

function sendDevCamera(now: number, force = false): void {
  if (!devFreeCamera || (!force && now - lastDevCameraSentAt < 100)) return;
  lastDevCameraSentAt = now;
  net.sendJson({
    t: "dev-camera",
    active: true,
    x: devCameraWorldX / Math.max(1, st.cellPx),
    y: devCameraWorldY / Math.max(1, st.cellPx)
  });
  updateDevStatus();
}

function updateDevStatus(): void {
  if (!devMode) return;
  const status = $("dev-status");
  status.classList.remove("hidden");
  if (devFreeCamera) {
    const x = Math.round(devCameraWorldX / Math.max(1, st.cellPx));
    const y = Math.round(devCameraWorldY / Math.max(1, st.cellPx));
    status.textContent = `DEV MAP · fog off · ${x}, ${y} · WASD/arrows pan · Shift faster · F return`;
    return;
  }
  status.textContent = devViewing
    ? `DEV CAMERA · ${currentViewName}${currentViewIsBot ? " (bot)" : ""} · F free map · [ ] switch`
    : "DEV · unlimited resources · F free map · [ ] inspect players";
}

function toggleSkillTree(force?: boolean): void {
  const tree = $("skill-tree");
  const shouldOpen = force ?? tree.classList.contains("hidden");
  window.clearTimeout(skillTreeRevealTimer);
  tree.classList.remove("armory-opening");
  if (!shouldOpen) {
    tree.classList.add("hidden");
    return;
  }
  updateSkillTree();
  let cardOrder = 0;
  tree.querySelectorAll<HTMLElement>(".engineering-branch,.weapon-tech-branch").forEach((branch, branchOrder) => {
    branch.style.setProperty("--branch-order", String(branchOrder));
    branch.querySelectorAll<HTMLElement>(".engineering-step,.weapon-tech-step").forEach((card) => {
      card.style.setProperty("--card-order", String(cardOrder++));
    });
  });
  tree.classList.remove("hidden");
  void tree.offsetWidth;
  tree.classList.add("armory-opening");
  skillTreeRevealTimer = window.setTimeout(() => tree.classList.remove("armory-opening"), 950 + cardOrder * 38);
}

function createRoom(): void {
  const room = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  const url = new URL(location.href);
  url.searchParams.set("room", room);
  history.replaceState(null, "", url);
  prepareLobby(room);
}

function chooseJoinRoom(): void {
  prepareLobby(new URLSearchParams(location.search).get("room") ?? "local");
}

function prepareLobby(room: string): void {
  pendingRoom = room;
  $("lobby-list").innerHTML = "";
  $("lobby-count").textContent = `0 / ${BALANCE.match.players}`;
  $("lobby-chat-log").innerHTML = `<div class="lobby-chat-empty">Encrypted room channel online<br>Transmit when ready</div>`;
  $<HTMLInputElement>("lobby-chat-input").value = "";
  currentLobbySelfId = -1;
  setLobbyConnection("Connecting to match server…");
  mode = "lobby";
  show("lobby");
  join();
}

function leaveLobby(): void {
  net.close();
  mode = "menu";
  currentLobbySelfId = -1;
  $("menu-status").textContent = "";
  show("menu");
}

async function copyLobbyInvite(): Promise<void> {
  const button = $<HTMLButtonElement>("lobby-copy-btn");
  const invite = new URL(location.href);
  invite.searchParams.set("room", pendingRoom);
  try {
    await navigator.clipboard.writeText(invite.toString());
    button.textContent = "Copied";
  } catch {
    button.textContent = pendingRoom.toUpperCase();
  }
  window.setTimeout(() => { button.textContent = "Copy invite"; }, 1500);
}

function sendLobbyChat(event: SubmitEvent): void {
  event.preventDefault();
  if (mode !== "lobby" || !net.connected) return;
  const input = $<HTMLInputElement>("lobby-chat-input");
  const message = input.value.replace(/\s+/g, " ").trim().slice(0, 160);
  if (!message) return;
  net.sendJson({ t: "chat", msg: message });
  input.value = "";
  input.focus();
}

function setLobbyConnection(message: string, connected = false): void {
  const status = $("lobby-connection");
  status.textContent = message;
  status.classList.toggle("connected", connected);
}

function appendLobbyChat(name: string, message: string, at: number, mine = false, system = false): void {
  const chat = $("lobby-chat-log");
  chat.querySelector(".lobby-chat-empty")?.remove();
  const article = document.createElement("article");
  article.className = `lobby-chat-message${mine ? " mine" : ""}${system ? " system" : ""}`;
  const header = document.createElement("header");
  const sender = document.createElement("strong");
  sender.textContent = name;
  const time = document.createElement("time");
  time.textContent = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const body = document.createElement("p");
  body.textContent = message;
  header.append(sender, time);
  article.append(header, body);
  chat.append(article);
  while (chat.children.length > 40) chat.firstElementChild?.remove();
  chat.scrollTop = chat.scrollHeight;
}

function appendLobbySystem(message: string): void {
  appendLobbyChat("BURROW NET", message, Date.now(), false, true);
}

function join(): void {
  const requestedDevMode = $<HTMLInputElement>("dev-mode").checked;
  audio.ensure();
  $("menu-status").textContent = "connecting…";
  setLobbyConnection("Contacting match server…");
  ($("start-btn") as HTMLButtonElement).style.display = "none";
  $("lobby-host-note").style.display = "block";
  net.connect(() => wsUrl(pendingRoom, playerName, requestedDevMode, pendingMapSize), {
    onOpen: (reconnected) => {
      $("menu-status").textContent = "";
      if (reconnected && mode === "game") log("Connection restored.");
      else if (mode === "lobby") {
        setLobbyConnection("Connected · syncing crew…", true);
        appendLobbySystem(reconnected ? "Room channel reconnected." : "Connected to encrypted room channel.");
      }
    },
    onControl: handleControl,
    onSnapshot: (m) => {
      const now = performance.now();
      const visibleEntityKeys = new Set(m.entities.map((entity) => `${entity.kind}:${entity.id}`));
      const collectedGems: { x: number; y: number; reinforce: boolean }[] = [];
      const collectedChests: { x: number; y: number; variant: number }[] = [];
      for (const [key, entity] of st.entities) {
        if (visibleEntityKeys.has(key)) continue;
        const dx = entity.toX - m.self.x;
        const dy = entity.toY - m.self.y;
        if (entity.kind === ENT.GEM || entity.kind === ENT.REINFORCE_GEM) {
          if (animatedGemPickups.has(key) || dx * dx + dy * dy > (5 * FP) ** 2) continue;
          animatedGemPickups.add(key);
          collectedGems.push({ x: entity.toX, y: entity.toY, reinforce: entity.kind === ENT.REINFORCE_GEM });
        } else if (entity.kind === ENT.CHEST) {
          const pickupRadius = BALANCE.treasure.chestInteractRangeCells + 2;
          if (animatedTreasurePickups.has(key) || dx * dx + dy * dy > (pickupRadius * FP) ** 2) continue;
          animatedTreasurePickups.add(key);
          collectedChests.push({ x: entity.toX, y: entity.toY, variant: entity.variant });
        }
      }
      st.applySnapshot(m, now);
      for (const gem of collectedGems) {
        renderer.addGemPickup(
          (gem.x / FP) * st.cellPx,
          (gem.y / FP) * st.cellPx,
          (m.self.x / FP) * st.cellPx,
          (m.self.y / FP) * st.cellPx,
          gem.reinforce
        );
      }
      for (const chest of collectedChests) {
        renderer.addTreasurePickup(
          (chest.x / FP) * st.cellPx,
          (chest.y / FP) * st.cellPx,
          (m.self.x / FP) * st.cellPx,
          (m.self.y / FP) * st.cellPx,
          chest.variant
        );
      }
    },
    onPatch: (m) => {
      const now = performance.now();
      recentBombOrigins = recentBombOrigins.filter((origin) => now - origin.at < 3_500);
      const blastOrigins = [
        ...recentBombOrigins,
        ...[...st.entities.values()]
          .filter((entity) => entity.kind === ENT.BLAST)
          .map((entity) => ({
            x: entity.toX / FP,
            y: entity.toY / FP,
            range: (entity.flags >> 3) || BALANCE.items.bomb.blastRangeCells,
            at: now
          }))
      ];
      const destroyed: { x: number; y: number; material: number }[] = [];
      if (st.world) {
        for (const cell of m.cells) {
          if (cell.mat !== MAT.EMPTY) continue;
          const material = st.world.get(cell.x, cell.y);
          if (material !== MAT.EMPTY && material !== MAT.VENT) destroyed.push({ x: cell.x, y: cell.y, material });
        }
      }
      const bombCrumble: typeof destroyed = [];
      const bombCells = new Set<string>();
      for (const cell of destroyed) {
        const nearBlast = blastOrigins.some((origin) => {
          const dx = cell.x + 0.5 - origin.x;
          const dy = cell.y + 0.5 - origin.y;
          const reach = origin.range + 9;
          return dx * dx + dy * dy <= reach * reach;
        });
        if (!nearBlast) continue;
        bombCrumble.push(cell);
        bombCells.add(`${cell.x}:${cell.y}`);
      }
      const pickCrumble: { x: number; y: number; material: number }[] = [];
      if (st.world && st.self?.slot === 2 && (st.selfFlags & PFLAG.DIGGING) !== 0) {
        const playerX = st.predX / FP;
        const playerY = st.predY / FP;
        const effectReach = BALANCE.dig.reachCells + BALANCE.dig.brushRadiusCells + 2;
        for (const cell of destroyed) {
          if (bombCells.has(`${cell.x}:${cell.y}`)) continue;
          const dx = cell.x + 0.5 - playerX;
          const dy = cell.y + 0.5 - playerY;
          if (dx * dx + dy * dy <= effectReach * effectReach) pickCrumble.push(cell);
        }
      }
      st.applyPatch(m);
      renderer.addBombCrumble(bombCrumble, st.cellPx, blastOrigins);
      renderer.addPickCrumble(pickCrumble, st.cellPx, lastAim);
    },
    onChunk: (m) => st.applyChunk(m),
    onSound: (m) => {
      const dx = m.x - st.predX / FP;
      const dy = m.y - st.predY / FP;
      audio.play(m.sound, m.intensity, dx / 40);
      if (m.sound === SOUND.COLLAPSE || m.sound === SOUND.BOMB) renderer.shake = Math.min(10, m.intensity / 32);
      if (m.sound === SOUND.BOMB) {
        recentBombOrigins.push({ x: m.x + 0.5, y: m.y + 0.5, range: 40, at: performance.now() });
        if (recentBombOrigins.length > 24) recentBombOrigins.splice(0, recentBombOrigins.length - 24);
        renderer.addDust(m.x * st.cellPx, m.y * st.cellPx, "#ff8a3cbb", 36);
      } else if (m.sound === SOUND.DIG) {
        const ownPickSound = st.self?.slot === 2 && (st.selfFlags & PFLAG.DIGGING) !== 0 && dx * dx + dy * dy < 16;
        if (!ownPickSound) renderer.addDust(m.x * st.cellPx, m.y * st.cellPx, "#a8886088", 3 + (m.intensity >> 6));
      } else if (m.sound === SOUND.COLLAPSE || m.sound === SOUND.RUBBLE_BREAK) {
        renderer.addDust(m.x * st.cellPx, m.y * st.cellPx, "#a8886088", 3 + (m.intensity >> 6));
      }
      void dy;
    },
    onClose: ({ attempt, delayMs, wasConnected }) => {
      const wait = (delayMs / 1000).toFixed(delayMs < 1000 ? 2 : 1).replace(/\.0$/, "");
      if (mode === "game") {
        if (wasConnected) log("Connection interrupted — reconnecting…");
      } else {
        setLobbyConnection(`Server reconnect ${attempt} · ${wait}s`);
        if (attempt === 1) appendLobbySystem("Room signal lost. Reconnecting…");
        ($("start-btn") as HTMLButtonElement).style.display = "none";
        $("lobby-host-note").style.display = "block";
      }
      $("menu-status").textContent = `match server reconnecting · attempt ${attempt}`;
    }
  });
  mode = "lobby";
  show("lobby");
}

function handleControl(msg: ControlToClient): void {
  switch (msg.t) {
    case "lobby": {
      if (mode === "game") {
        mode = "lobby";
        show("lobby");
      }
      const list = $("lobby-list");
      list.innerHTML = "";
      for (const p of msg.players) {
        const player = document.createElement("article");
        player.className = `lobby-player${p.id === msg.selfId ? " self" : ""}`;
        const icon = document.createElement("span");
        icon.className = "lobby-player-icon";
        icon.textContent = String(p.id + 1).padStart(2, "0");
        const copy = document.createElement("span");
        copy.className = "lobby-player-copy";
        const name = document.createElement("strong");
        name.textContent = p.name;
        const status = document.createElement("small");
        status.textContent = p.id === msg.selfId ? "Your loadout linked" : "Miner signal linked";
        copy.append(name, status);
        const badge = document.createElement("b");
        badge.className = "lobby-player-badge";
        badge.textContent = p.id === msg.hostId ? "Host" : p.bot ? "Bot" : "Ready";
        player.append(icon, copy, badge);
        list.appendChild(player);
      }
      for (let slot = msg.players.length; slot < BALANCE.match.players; slot++) {
        const empty = document.createElement("article");
        empty.className = "lobby-player empty";
        empty.innerHTML = `<span class="lobby-player-icon">${String(slot + 1).padStart(2, "0")}</span><span class="lobby-player-copy"><strong>Open crew slot</strong><small>Combat bot deploys on launch</small></span><b class="lobby-player-badge">Standby</b>`;
        list.appendChild(empty);
      }
      currentLobbySelfId = msg.selfId;
      $("lobby-count").textContent = `${msg.players.length} / ${BALANCE.match.players}`;
      setLobbyConnection("Crew uplink stable", true);
      isHost = msg.selfId === msg.hostId;
      ($("start-btn") as HTMLButtonElement).style.display = isHost ? "" : "none";
      $("lobby-host-note").style.display = isHost ? "none" : "block";
      break;
    }
    case "chat":
      if (mode === "lobby") appendLobbyChat(msg.name, msg.msg, msg.at, msg.id === currentLobbySelfId);
      break;
    case "welcome":
      st.reset(msg.worldSize, msg.chunkSize, msg.cellPx, msg.playerId, msg.names, msg.spawnX, msg.spawnY);
      recentBombOrigins = [];
      animatedGemPickups = new Set();
      animatedTreasurePickups = new Set();
      currentViewName = msg.names[msg.playerId] ?? "Player";
      currentViewIsBot = false;
      devMode = msg.devMode;
      devFreeCamera = false;
      lastDevCameraSentAt = 0;
      if (devMode) {
        updateDevStatus();
      }
      mode = "game";
      show(null);
      break;
    case "dev-view":
      devViewing = !msg.own;
      currentViewName = msg.name;
      currentViewIsBot = msg.bot;
      st.pending = [];
      st.havePos = false;
      updateDevStatus();
      break;
    case "role":
      st.role = msg.role;
      showRole(msg.role);
      break;
    case "phase":
      st.phaseKind = msg.kind;
      st.phaseIndex = msg.index;
      st.phaseEndTick = msg.endTick;
      st.zombieReleaseTick = msg.zombieReleaseTick;
      st.lastSnapshotTick = msg.tick;
      st.lastSnapshotAt = performance.now();
      onPhaseChange(msg.kind);
      break;
    case "log":
      log(msg.msg);
      break;
    case "feed":
      pushFeed(msg.msg, msg.kind);
      break;
    case "end":
      showEnd(msg);
      break;
    case "error":
      net.close();
      $("menu-status").textContent = msg.msg;
      show("menu");
      mode = "menu";
      break;
  }
}

function showRole(role: number): void {
  if (role === ROLE.INFECTED) {
    pushFeed("Legacy infected role active for this custom match", "combat");
  } else {
    pushFeed("Last player standing — mine, upgrade, fortify, and eliminate every rival.", "info");
  }
}

function onPhaseChange(kind: string): void {
  const el = $("phase-name");
  el.className = kind;
  if (kind === "day") log("No time limit. Last player standing wins — guarded ruins contain special weapons.");
}

function showEnd(msg: Extract<ControlToClient, { t: "end" }>): void {
  mode = "end";
  show("end");
  const winnerName = msg.scores.find((score) => score.id === msg.winnerPlayerId)?.name;
  $("end-title").textContent =
    msg.winner === "player" ? `${winnerName ?? "A PLAYER"} WINS` :
    msg.winner === "draw" ? "TOTAL DESTRUCTION" :
    msg.winner === "miners" ? "MINERS SURVIVE" : "THE BURROW IS CONSUMED";
  $("end-title").style.color = msg.winner === "draw" || msg.winner === "infected" ? "#d1495b" : "#6fce62";
  const table = $("end-table");
  table.innerHTML =
    "<tr><th>Player</th><th>Role</th><th>Score</th><th>Captures</th><th>Gems</th></tr>" +
    msg.scores
      .sort((a, b) => b.score - a.score)
      .map(
        (s) =>
          `<tr><td>${esc(s.name)}</td><td>${s.role === ROLE.INFECTED ? "infected" : "miner"}</td><td>${s.score}</td><td>${s.captures}</td><td>${s.securedGems}</td></tr>`
      )
      .join("");
}

type FeedKind = "info" | "down" | "loot" | "combat";
const MAX_FEED_LINES = 6;
function log(msg: string): void {
  const kind: FeedKind = /killed|eliminated|wore out/i.test(msg)
    ? "down"
    : /treasure|crafted|unlocked|installed|deployed|mining base/i.test(msg)
      ? "loot"
      : /guardian|detonated|turret/i.test(msg)
        ? "combat"
        : "info";
  pushFeed(msg, kind);
}

function pushFeed(msg: string, kind: FeedKind, iconMarkup?: string): void {
  const icons: Record<FeedKind, string> = { info: "◆", down: "☠", loot: "✦", combat: "⚡" };
  const feed = $("log");
  const activeLines = Array.from(feed.querySelectorAll<HTMLElement>(".feed-line:not(.feed-out)"));
  if (activeLines.length >= MAX_FEED_LINES) {
    const outgoing = activeLines[activeLines.length - 1];
    outgoing.style.top = `${outgoing.offsetTop}px`;
    outgoing.style.left = "0";
    outgoing.classList.remove("feed-enter", "feed-shift");
    outgoing.classList.add("feed-out");
    window.setTimeout(() => outgoing.remove(), 320);
  }

  for (const line of activeLines.slice(0, MAX_FEED_LINES - 1)) {
    line.classList.remove("feed-shift");
    void line.offsetWidth;
    line.classList.add("feed-shift");
  }

  const line = document.createElement("div");
  line.className = `feed-line ${kind} feed-enter`;
  const icon = document.createElement("span");
  icon.className = "feed-icon";
  if (iconMarkup) {
    icon.classList.add("custom");
    icon.innerHTML = iconMarkup;
  } else {
    icon.textContent = icons[kind];
  }
  const text = document.createElement("span");
  text.textContent = msg.trim();
  line.append(icon, text);
  feed.prepend(line);
}

function esc(s: string): string {
  return s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);
}

/* ------------------------------------------------------------- HUD */

function updateHud(now: number): void {
  if (!st.self) return;
  const tick = st.estServerTick(now);
  const matchRemain = Math.max(0, (st.phaseEndTick - tick) / 30);
  const shownRemain = matchRemain;
  const mm = Math.floor(shownRemain / 60);
  const ss = Math.floor(shownRemain % 60);
  const infiniteMatch = st.phaseEndTick === 0xffffffff;
  $("phase-timer").textContent = infiniteMatch ? "∞" : `${mm}:${ss.toString().padStart(2, "0")}`;
  $("phase-timer").classList.toggle("infinite", infiniteMatch);
  const label =
    st.phaseKind === "countdown"
      ? "Descending…"
      : st.phaseKind === "day"
        ? "LAST PLAYER STANDING"
        : "";
  $("phase-name").textContent = label;
  $("phase-name").className = st.phaseKind;

  updateMeterFill("o2-fill", st.self.oxygen / 255);
  updateMeterFill("st-fill", st.self.stamina / 255);
  updateMeterFill("hp-fill", st.self.health / Math.max(1, st.self.maxHealth));
  const oxygenMax = BALANCE.oxygen.emergencySeconds;
  const energyMax = BALANCE.movement.staminaMax;
  $("o2-value").textContent = `${Math.round(st.self.oxygen / 255 * oxygenMax)} / ${oxygenMax}`;
  $("st-value").textContent = `${Math.round(st.self.stamina / 255 * energyMax)} / ${energyMax}`;
  $("hp-value").textContent = `${st.self.health} / ${st.self.maxHealth}`;
  $("player-label").textContent = devViewing ? `WATCHING · ${currentViewName}` : currentViewName;

  $("resources").innerHTML =
    resourceChip("gem", "Common", st.self.carried) +
    resourceChip("gold", "Gold", st.self.gold) +
    resourceChip("copper", "Copper", st.self.copper) +
    resourceChip("platinum", "Platinum", st.self.platinum) +
    resourceChip("crystal", "Crystal", st.self.reinforceGems) +
    resourceChip("fossil", "Fossil", st.self.fossils) +
    resourceChip("iron", "Iron", st.self.iron) +
    resourceChip("coal", "Coal", st.self.coal);
  $("pack-meta").textContent = `⚡ ${st.self.power} / ${st.self.powerCapacity} · ${st.self.rubble} rubble · ${st.self.support} supports${st.self.charges > 0 ? " · charge armed" : ""}`;

  const allTools = availableTools(st.self);
  latestToolPool = allTools;
  let tools = toolsForMode(allTools, toolMode);
  if (tools.length === 0 && toolMode === "buildings") {
    toolMode = "weapons";
    tools = toolsForMode(allTools, toolMode);
  }
  const rememberedSlot = lastToolSlotByMode[toolMode];
  input.setAvailableSlots(tools.map((tool) => tool.slot));
  if (!tools.some((tool) => tool.slot === input.slot)) {
    input.slot = tools.find((tool) => tool.slot === rememberedSlot)?.slot ?? tools[0]?.slot ?? 1;
  }
  lastToolSlotByMode[toolMode] = input.slot;
  updateToolModeControls(allTools);
  renderToolCarousel(tools, allTools);

  updateSkillTree();

  $("minimap-shell").classList.toggle("expanded", input.showMap);
  const mapX = Math.floor(st.predX / FP);
  const mapY = Math.floor(st.predY / FP);
  $("map-coords").textContent = `${mapX}, ${mapY}`;
  $("map-depth").textContent = `DEPTH ${mapY}`;
  const depthFrame = Math.round(Math.max(0, Math.min(1, mapY / st.worldSize)) * 13);
  $("minimap-shell").style.setProperty("--depth-x", `${depthFrame / 13 * 100}%`);
}

function updateMeterFill(id: string, ratio: number): void {
  const fill = $<HTMLElement>(id);
  const clamped = Math.max(0, Math.min(1, ratio));
  const step = clamped === 0 ? 0 : Math.max(1, Math.min(10, Math.round(clamped * 10)));
  fill.style.opacity = step === 0 ? "0" : "1";
  fill.style.setProperty("--bar-row", String(10 - step));
}

function resourceChip(kind: string, label: string, amount: number): string {
  return `<div class="resource-chip" title="${label}: ${amount.toLocaleString()}"><i class="resource-gem ${kind}"></i><span>${label}</span><b>${compactHudNumber(amount)}</b></div>`;
}

function compactHudNumber(amount: number): string {
  if (amount < 1000) return amount.toLocaleString();
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: amount < 10_000 ? 1 : 0 }).format(amount).toUpperCase();
}

function toolsForMode(tools: ToolCard[], selectedMode: ToolMode): ToolCard[] {
  const category = selectedMode === "weapons" ? "weapon" : "building";
  const matching = tools.filter((tool) => tool.category === category);
  if (selectedMode === "buildings") {
    matching.sort((a, b) => {
      const rank = (tool: ToolCard) => tool.slot === BASE_TOOL_SLOT ? 0 : tool.slot === 3 ? 1 : tool.slot;
      return rank(a) - rank(b);
    });
  }
  return matching;
}

function setToolMode(nextMode: ToolMode, preferredSlot?: number): void {
  const currentTools = toolsForMode(latestToolPool, toolMode);
  if (currentTools.some((tool) => tool.slot === input.slot)) lastToolSlotByMode[toolMode] = input.slot;
  const nextTools = toolsForMode(latestToolPool, nextMode);
  if (nextTools.length === 0) return;
  toolMode = nextMode;
  input.setAvailableSlots(nextTools.map((tool) => tool.slot));
  input.slot = nextTools.find((tool) => tool.slot === preferredSlot)?.slot
    ?? nextTools.find((tool) => tool.slot === lastToolSlotByMode[nextMode])?.slot
    ?? nextTools[0].slot;
  lastToolSlotByMode[nextMode] = input.slot;
  lastCarouselSignature = "";
  updateToolModeControls(latestToolPool);
  renderToolCarousel(nextTools, latestToolPool);
}

function updateToolModeControls(tools: ToolCard[]): void {
  const buildingCount = toolsForMode(tools, "buildings").length;
  for (const button of $<HTMLElement>("tool-mode-tabs").querySelectorAll<HTMLButtonElement>("button[data-tool-mode]")) {
    const modeForButton = button.dataset.toolMode as ToolMode;
    const active = modeForButton === toolMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    button.disabled = modeForButton === "buildings" && buildingCount === 0;
    if (modeForButton === "buildings") button.title = buildingCount > 0 ? `${buildingCount} construction options available` : "Unlock a construction option first";
  }
  $("tool-dock-label").textContent = "Equipped";
}

function renderToolCarousel(tools: ToolCard[], unlockPool: ToolCard[] = tools): void {
  if (tools.length === 0) return;
  const selectedIndex = Math.max(0, tools.findIndex((tool) => tool.slot === input.slot));
  const selected = tools[selectedIndex];
  const upgradeQuotes = st.self ? bombUpgradeQuotes(st.self, BALANCE) : [];
  const installedUpgrades = upgradeQuotes.reduce((sum, quote) => sum + quote.level, 0);
  const signature = JSON.stringify({
    mode: toolMode,
    tools: tools.map((tool) => [tool.slot, tool.count, tool.stat]),
    slot: selected.slot,
    installedUpgrades,
    pickDurability: selected.slot === 2 ? st.self?.pickDurability ?? 0 : undefined
  });
  if (signature === lastCarouselSignature) return;

  const unlocked = unlockPool.filter((tool) => !knownToolSlots.has(tool.slot));
  if (!carouselInitialized) {
    knownToolSlots = new Set(unlockPool.map((tool) => tool.slot));
    carouselInitialized = true;
  } else if (unlocked.length > 0) {
    for (const tool of unlocked) {
      knownToolSlots.add(tool.slot);
      showUnlock(tool);
    }
  }

  const oldIndex = Math.max(0, tools.findIndex((tool) => tool.slot === lastCarouselSlot));
  const direction = selectedIndex >= oldIndex ? "next" : "prev";
  const selectionChanged = selected.slot !== lastCarouselSlot;
  const previous = tools[(selectedIndex - 1 + tools.length) % tools.length];
  const next = tools[(selectedIndex + 1) % tools.length];
  const card = $("tool-card");
  card.style.setProperty("--tool-accent", selected.accent);
  $("slots").style.setProperty("--tool-accent", selected.accent);
  const essentialDescription = selected.description.match(/^[^.!?]+[.!?]?/)?.[0] ?? selected.description;
  const toolArt = selected.slot === 1
    ? `<img class="export-bomb-art" src="/hud/burrow-bomb.webp" alt="" />`
    : selected.icon;
  const needsCraft = selected.count === "CRAFT";
  const showCount = !["∞", "READY", "CRAFT"].includes(selected.count);
  const displayedCount = compactToolCount(selected.count);
  const quantity = selected.slot === 2 ? String(st.self?.pickDurability ?? 0) : toolQuantity(selected);
  const quantityLabel = selected.slot === 2 ? "DURABILITY" : selected.blast && selected.slot !== 9 ? "AMMO" : "AMOUNT";
  card.classList.toggle("needs-craft", needsCraft);
  card.innerHTML = `<div class="tool-hero">
      <div class="tool-key">${selected.slot}</div><div class="tool-count ${showCount ? "" : "hidden"}">${esc(displayedCount)}</div>
      <div class="tool-art">${toolArt}</div>
      <div class="tool-copy"><span>${esc(selected.family)}</span><h2>${esc(selected.name)}${showCount ? ` <em>${esc(displayedCount)}</em>` : ""}</h2><p>${esc(essentialDescription)}</p></div>
    </div>
    <div class="tool-data"><div class="tool-data-title">Live loadout data</div>
      <div class="tool-stats">${toolStatCells(selected.stat)}</div>
      <div class="tool-upgrades" data-label="${quantityLabel}" title="${esc(selected.name)}: ${esc(quantity)} available"><div class="tool-amount ${quantity === "∞" ? "infinity" : ""}"><strong>${esc(quantity)}</strong></div></div>
    </div>${needsCraft ? `<button class="tool-craft-overlay" type="button" aria-label="Craft pickaxe for ${BALANCE.items.pick.gemCost} common gems"><strong>Craft</strong><span class="tool-craft-cost"><i aria-hidden="true"></i><b>${BALANCE.items.pick.gemCost}</b></span></button>` : ""}`;
  if (selectionChanged || !lastCarouselSignature) {
    card.classList.remove("swipe-next", "swipe-prev");
    void card.offsetWidth;
    card.classList.add(direction === "next" ? "swipe-next" : "swipe-prev");
  }
  $("tool-prev-preview").innerHTML = `${previous.icon}<span>${previous.name}</span>`;
  $("tool-next-preview").innerHTML = `${next.icon}<span>${next.name}</span>`;
  const slotWindowStart = Math.min(Math.max(0, selectedIndex - 1), Math.max(0, tools.length - 4));
  const numberedPages = tools.slice(slotWindowStart, slotWindowStart + 4).map((tool, offset) =>
    `<button data-slot="${tool.slot}" class="${tool.slot === selected.slot ? "active" : ""}" aria-label="Select ${tool.name}"><span>${slotWindowStart + offset + 1}</span></button>`
  ).join("");
  $("tool-dots").innerHTML =
    `<button class="pagination-nav" data-cycle="-1" aria-label="Previous tool"><span>&lt;</span></button>`
    + numberedPages
    + `<button class="pagination-nav" data-cycle="1" aria-label="Next tool"><span>&gt;</span></button>`;
  const unlockedCount = tools.filter((tool) => tool.slot !== 2 || (st.self?.pickDurability ?? 0) > 0).length;
  const categoryLabel = unlockedCount === 1 ? (toolMode === "weapons" ? "weapon" : "building") : toolMode;
  $("tool-position").textContent = `${unlockedCount} ${categoryLabel}`;
  lastCarouselSignature = signature;
  lastCarouselSlot = selected.slot;
}

function toolQuantity(tool: ToolCard): string {
  if (tool.count === "∞") return "∞";
  if (tool.count === "READY") return "1";
  if (tool.count === "CRAFT") return "0";
  const quantity = tool.count.replace(/^×/, "");
  const numeric = Number(quantity);
  return Number.isFinite(numeric) && numeric >= 1000 ? compactHudNumber(numeric) : quantity;
}

function compactToolCount(count: string): string {
  const prefix = count.startsWith("×") ? "×" : "";
  const numeric = Number(count.replace(/^×/, ""));
  return Number.isFinite(numeric) && numeric >= 1000 ? `${prefix}${compactHudNumber(numeric)}` : count;
}

function toolStatCells(stat: string): string {
  const rows = stat.split(" · ").slice(0, 4);
  while (rows.length < 4) rows.push("— status");
  return rows.map((raw) => {
    const words = raw.trim().split(/\s+/);
    let value = words.shift() ?? "—";
    if (value.toLowerCase() === "costs") value = words.shift() ?? "—";
    if (value.toLowerCase() === "treasure") value = "RELIC";
    const label = words.join(" ") || raw;
    return `<div class="tool-stat"><i class="tool-stat-icon"></i><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
  }).join("");
}

function showUnlock(tool: ToolCard): void {
  pushFeed(tool.slot === 2 ? "Pickaxe unlock available" : `${tool.name} unlocked`, "loot", tool.icon);
}

function upgradeIcon(id: BombUpgradeId): string {
  const shapes: Record<BombUpgradeId, string> = {
    speed: `<path d="M13.5 2.5 5.8 13h5.5l-1 8.5L18.4 10h-5.6l.7-7.5Z" fill="currentColor"/>`,
    range: `<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="3"/><path d="M12 1.8v4M12 18.2v4M1.8 12h4M18.2 12h4"/>`,
    wide: `<path d="M3 6v12M21 6v12M7 12h10M7 12l3-3M7 12l3 3M17 12l-3-3M17 12l-3 3"/>`,
    width: `<path d="M4 4v16M20 4v16M8 8h8v8H8zM4 12h4M16 12h4"/>`,
    diagonal: `<path d="m5 5 14 14M19 5 5 19M5 5h5M5 5v5M19 19h-5M19 19v-5M19 5h-5M19 5v5M5 19h5M5 19v-5"/>`,
    twin: `<circle cx="8.5" cy="13" r="5.2"/><circle cx="15.8" cy="13" r="5.2"/><path d="M8.5 7.8V5.5h3M15.8 7.8V5.5h-3M12 3.5v2"/>`,
    capacity: `<rect x="3.5" y="3.5" width="6.5" height="6.5"/><rect x="14" y="3.5" width="6.5" height="6.5"/><rect x="3.5" y="14" width="6.5" height="6.5"/><rect x="14" y="14" width="6.5" height="6.5"/>`,
    remote: `<circle cx="8" cy="15" r="4.8"/><path d="M8 10.2V7.5h2.5M15 8.5c2 2 2 5 0 7M17.8 5.7c3.5 3.5 3.5 9.1 0 12.6"/>`,
    shield: `<path d="M12 2.5 19 5v5.4c0 5-2.7 8.7-7 11.1-4.3-2.4-7-6.1-7-11.1V5l7-2.5Z"/><path d="m8.7 12 2.1 2.1 4.7-5"/>`,
    prospector: `<path d="m12 2.5 6.2 6.2L12 21.5 5.8 8.7 12 2.5Z"/><path d="M5.8 8.7h12.4M9 8.7 12 21.5l3-12.8M9 8.7l3-6.2 3 6.2"/>`,
    vision: `<path d="M2.5 12s3.6-6 9.5-6 9.5 6 9.5 6-3.6 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="3.2"/>`,
    mobility: `<path d="M4 16.5h7l3-3.5 1.8-6 3 1-1.2 6.2 3.4 2.3v3H4v-3Z"/><path d="M5 12h5M3 8h7"/>`,
    vitality: `<path d="M12 20.5 4.2 13C.5 9.2 3.2 3.5 7.5 4.2c2 .3 3.3 1.5 4.5 3 1.2-1.5 2.5-2.7 4.5-3 4.3-.7 7 5 3.3 8.8L12 20.5Z"/>`
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${shapes[id]}</svg>`;
}

const ENGINEERING_BRANCHES: readonly { label: string; description: string; ids: readonly BombUpgradeId[]; starter?: "pick" }[] = [
  { label: "Payload geometry", description: "Reach, width, diagonals, and ore yield.", ids: ["range", "wide", "width", "diagonal", "prospector"] },
  { label: "Detonation systems", description: "Fuse, capacity, remotes, and protection.", ids: ["speed", "twin", "capacity", "remote", "shield"] },
  { label: "Miner systems", description: "Sight, speed, and maximum health.", ids: ["vision", "mobility", "vitality"], starter: "pick" }
];

const ENGINEERING_COPY: Record<BombUpgradeId, string> = {
  speed: "Shorter fuse each level.",
  range: "More blast reach each level.",
  wide: "Adds two cells of blast width.",
  width: "More blast width each level.",
  diagonal: "Adds noisy diagonal arms.",
  twin: "Adds one simultaneous bomb.",
  capacity: "More active bombs each level.",
  remote: "Press Q to detonate remotely.",
  shield: "Survive your own explosions.",
  prospector: "Bombs recover twice the ore.",
  vision: "Reveals ore deeper through shadows.",
  mobility: "More movement speed each level.",
  vitality: "More maximum health each level."
};

function weaponTechArtwork(id: WeaponBlueprintId): string {
  const tech = weaponTechDefinition(id);
  if (tech?.inventory !== undefined) return toolIcon(tech.fieldSlot);
  return itemArt(`weapons/${id}`);
}

function starterPickCard(pickDurability: number, commonGems: number): string {
  const unlocked = pickDurability > 0;
  const affordable = commonGems >= BALANCE.items.pick.gemCost;
  const cost = unlocked
    ? `<b>${pickDurability}</b>`
    : `<span class="upgrade-cost"><i class="tree-gem common"></i><b>${BALANCE.items.pick.gemCost}</b></span>`;
  return `<div class="engineering-step"><article class="skill-node starter-card no-progression ${unlocked ? "owned" : affordable ? "craftable" : "locked"}">
    <div class="skill-identity"><div class="node-icon">${itemArt("current/mining-pick")}</div><div class="skill-title"><span>Starter tool</span><h3>Mining Pick</h3></div></div>
    <p>Precise digging and deposit extraction.</p>
    <div class="skill-action"><button ${unlocked || !affordable ? "disabled" : "data-pick-unlock"}>${unlocked ? "Unlocked" : "Unlock"}</button><div class="cost">${cost}</div></div>
  </article></div>`;
}

function starterBombCard(): string {
  return `<div class="weapon-tech-step"><article class="weapon-tech-card owned starter-card">
    <div class="weapon-tech-identity"><div class="weapon-tech-art"><img class="starter-bomb-art" src="/hud/burrow-bomb.webp" alt="" aria-hidden="true" /></div><div class="weapon-tech-copy"><span>T0 · Starter</span><h4>Standard Bomb</h4></div></div>
    <div class="weapon-tech-description"><p>Reliable expanding cross blast.</p></div>
    <div class="weapon-tech-action"><button disabled>Unlocked</button><span class="weapon-tech-cost"><b class="infinite-ammo">∞</b></span></div>
  </article></div>`;
}

function updateSkillTree(): void {
  if (!st.self) return;
  const quotes = bombUpgradeQuotes(st.self, BALANCE);
  const inventory: Record<CraftResource, number> = {
    common: st.self.carried,
    gold: st.self.gold,
    fossils: st.self.fossils,
    copper: st.self.copper,
    iron: st.self.iron,
    platinum: st.self.platinum,
    coal: st.self.coal
  };
  const ruinArsenal = [[8, "Burrow Nuke", st.self.nukes, "Massive cross and diagonal excavation"]] as const;
  const weaponAmmo = {
    dynamite: st.self.dynamite,
    c4: st.self.c4,
    clusterBombs: st.self.clusterBombs,
    napalm: st.self.napalm,
    turretKits: st.self.turretKits
  };
  const displayResources = [
    ["common", "Common gems", st.self.carried],
    ["gold", "Gold", st.self.gold],
    ["copper", "Copper", st.self.copper],
    ["platinum", "Platinum", st.self.platinum],
    ["crystal", "Reinforcement crystal", st.self.reinforceGems],
    ["fossils", "Fossils", st.self.fossils],
    ["iron", "Iron", st.self.iron],
    ["coal", "Coal", st.self.coal],
    ["power", "Grid power", st.self.power]
  ] as const;
  const signature = JSON.stringify({ quotes, displayResources, ruinArsenal, weaponAmmo, pickDurability: st.self.pickDurability, weaponBlueprints: st.self.weaponBlueprints, infrastructureUnlocked: st.self.infrastructureUnlocked, buildingBlueprints: st.self.buildingBlueprints, relics: st.self.relics, powerCapacity: st.self.powerCapacity });
  if (signature === lastSkillTreeSignature) return;
  lastSkillTreeSignature = signature;
  const installed = quotes.reduce((sum, quote) => sum + quote.level, 0);
  const total = quotes.reduce((sum, quote) => sum + quote.maxLevel, 0);
  const blueprints = WEAPON_TECH.filter((tech) => hasWeaponBlueprint(st.self!.weaponBlueprints, tech.id)).length;
  const infrastructure = BUILDING_DEFS.filter((building) => (st.self!.buildingBlueprints & (1 << building.kind)) !== 0).length;
  $("tree-progress").innerHTML = `<div class="progress-count"><strong>${installed + blueprints + infrastructure}</strong></div><div class="progress-copy"><b>Research installed</b><span>${installed} / ${total} core stacks · ${blueprints} weapon blueprints · ${infrastructure} / ${BUILDING_DEFS.length} outpost patterns · ${st.self.power}/${st.self.powerCapacity} power.</span></div>`;
  $("tree-materials").innerHTML = displayResources
    .map(([resource, label, amount]) => `<span class="tree-resource" title="${label}: ${amount.toLocaleString()}"><i class="tree-gem ${resource}"></i><b>${compactHudNumber(amount)}</b></span>`).join("");
  const quoteById = new Map(quotes.map((quote) => [quote.id, quote]));
  const renderEngineeringNode = (quote: (typeof quotes)[number]) => {
    const entries = Object.entries(quote.cost) as [CraftResource, number][];
    const affordable = entries.every(([resource, amount]) => inventory[resource] >= amount);
    const cost = entries.map(([resource, amount]) => `<span class="upgrade-cost" title="${resource}"><i class="tree-gem ${resource}"></i><b>${amount}</b></span>`).join("");
    const craftable = !quote.maxed && quote.prerequisiteMet && affordable;
    const disabled = !craftable;
    const oneTimeUnlock = quote.maxLevel <= 1;
    const status = quote.maxed
      ? oneTimeUnlock ? "Unlocked" : "Fully upgraded"
      : !quote.prerequisiteMet ? "Locked"
      : affordable ? oneTimeUnlock ? "Unlock" : "Upgrade"
      : "Need materials";
    const pips = Array.from({ length: quote.maxLevel }, (_, index) => `<i class="${index < quote.level ? "filled" : ""}"></i>`).join("");
    const unaffordable = !quote.maxed && quote.prerequisiteMet && !affordable;
    return `<article class="skill-node ${quote.maxLevel <= 1 ? "no-progression" : ""} ${craftable ? "craftable" : ""} ${quote.maxed ? "owned" : ""} ${!quote.prerequisiteMet ? "locked" : ""} ${unaffordable ? "unaffordable" : ""}">
      <div class="skill-identity"><div class="node-icon node-${quote.id}">${upgradeIcon(quote.id)}</div><div class="skill-title"><span>Level ${quote.level} / ${quote.maxLevel}</span><h3>${quote.label}</h3></div></div>
      <p>${ENGINEERING_COPY[quote.id]}</p>
      ${quote.maxLevel > 1 ? `<div class="level-pips">${pips}</div>` : ""}
      <div class="skill-action"><button data-node="${quote.id}" ${disabled ? "disabled" : ""}>${status}</button><div class="cost">${quote.maxed ? "<b>✓</b>" : cost}</div></div>
    </article>`;
  };
  const branchFrame = `<span class="modular-branch-frame" aria-hidden="true"><i class="frame-top"></i><i class="frame-center"></i><i class="frame-bottom"></i></span>`;
  $("skill-nodes").innerHTML = ENGINEERING_BRANCHES.map((branch) => {
    const branchQuotes = branch.ids.map((id) => quoteById.get(id)).filter((quote): quote is (typeof quotes)[number] => quote !== undefined);
    return `<section class="engineering-branch">${branchFrame}<header class="engineering-branch-head"><h4>${branch.label}</h4><p>${branch.description}</p></header>
      <div class="engineering-track" style="--nodes:${branchQuotes.length}">${branch.starter === "pick" ? starterPickCard(st.self!.pickDurability, st.self!.carried) : ""}${branchQuotes.map((quote) => `<div class="engineering-step">${renderEngineeringNode(quote)}</div>`).join("")}</div></section>`;
  }).join("");

  $("weapon-skill-nodes").innerHTML = WEAPON_TECH_BRANCHES.map((branch) => {
    const techs = WEAPON_TECH.filter((tech) => tech.branch === branch.id);
    const cards = `${branch.id === "demolition" ? starterBombCard() : ""}${techs.map((tech) => {
      const owned = hasWeaponBlueprint(st.self!.weaponBlueprints, tech.id);
      const prerequisiteMet = !tech.prerequisite || hasWeaponBlueprint(st.self!.weaponBlueprints, tech.prerequisite);
      const priceEntries = Object.entries(tech.unlockCost) as [CraftResource, number][];
      const affordable = priceEntries.every(([resource, amount]) => inventory[resource] >= amount);
      const disabled = owned || !prerequisiteMet || !affordable;
      const status = owned ? "Unlocked" : !prerequisiteMet ? "Locked" : affordable ? "Unlock" : "Need materials";
      const tag = owned ? "WEAPON" : "RESEARCH";
      const ammo = tech.inventory === undefined ? "∞" : weaponAmmo[tech.inventory];
      const costMarkup = owned
        ? `<b class="${ammo === "∞" ? "infinite-ammo" : ""}">${ammo}</b>`
        : priceEntries.map(([resource, amount]) => `<span class="upgrade-cost" title="${resource}"><i class="tree-gem ${resource}"></i><b>${amount}</b></span>`).join("");
      const unaffordable = prerequisiteMet && !owned && !affordable;
      return `<div class="weapon-tech-step"><article class="weapon-tech-card ${owned ? "owned" : ""} ${prerequisiteMet && !owned && affordable ? "available" : ""} ${!prerequisiteMet ? "locked" : ""} ${unaffordable ? "unaffordable" : ""}">
        <div class="weapon-tech-identity"><div class="weapon-tech-art">${weaponTechArtwork(tech.id)}</div><div class="weapon-tech-copy"><span>T${tech.tier} · ${tag}</span><h4>${tech.label}</h4></div></div>
        <div class="weapon-tech-description"><p>${tech.description}</p></div>
        <div class="weapon-tech-action"><button data-weapon-tech="${tech.id}" ${disabled ? "disabled" : ""}>${status}</button><span class="weapon-tech-cost">${costMarkup}</span></div>
      </article></div>`;
    }).join("")}`;
    return `<section class="weapon-tech-branch">${branchFrame}<header class="weapon-tech-branch-head"><h4>${branch.label}</h4><p>${branch.description}</p></header><div class="weapon-tech-track">${cards}</div></section>`;
  }).join("");

  $("relic-skill-nodes").innerHTML = RELIC_BRANCHES.map((branch, branchIndex) => {
    let cards = branch.items.map((item) => {
      const discovered = item.relicBit !== undefined && (st.self!.relics & item.relicBit) !== 0;
      return `<div class="weapon-tech-step"><article class="weapon-tech-card relic-tech-card ${discovered ? "owned" : "locked"}">
      <div class="weapon-tech-identity"><div class="weapon-tech-art">${item.art === null
        ? `<div class="weapon-art-placeholder"><span>Art<br>pending</span></div>`
        : itemArt(item.art)}</div><div class="weapon-tech-copy"><span>Ruin · Relic</span><h4>${esc(item.name)}</h4></div></div>
      <div class="weapon-tech-description"><p>${esc(item.description)}</p></div>
      <div class="weapon-tech-action"><button disabled>${discovered ? "Discovered" : "Locked"}</button></div>
    </article></div>`;
    }).join("");
    if (branchIndex === 0) cards += ruinArsenal.map(([slot, label, count, description]) => `<div class="weapon-tech-step"><article class="weapon-tech-card relic-tech-card ${count > 0 ? "owned has-ammo" : "locked"}">
      <div class="weapon-tech-identity"><div class="weapon-tech-art">${toolIcon(slot)}</div><div class="weapon-tech-copy"><span>Ruin · Superweapon</span><h4>${label}</h4></div></div>
      <div class="weapon-tech-description"><p>${description}</p></div>
      <div class="weapon-tech-action"><button disabled>${count > 0 ? "Discovered" : "Locked"}</button>${count > 0 ? `<span class="weapon-tech-cost"><b>${count}</b></span>` : ""}</div>
    </article></div>`).join("");
    return `<section class="weapon-tech-branch relic-tech-branch">${branchFrame}<header class="weapon-tech-branch-head"><h4>${branch.label}</h4><p>${branch.description}</p></header><div class="weapon-tech-track">${cards}</div></section>`;
  }).join("");
  $("tool-skill-nodes").innerHTML = TOOL_BRANCHES.map((branch) => {
    const cards = branch.items.map((item) => {
      const isMiningBase = item.slot === BASE_TOOL_SLOT;
      const building = item.buildingKind === undefined ? undefined : buildingDefinition(item.buildingKind);
      const buildingResources = building ? Object.entries(building.cost) as ["common" | "copper" | "iron" | "gold" | "platinum" | "coal", number][] : [];
      const infrastructureReady = st.self!.infrastructureUnlocked !== 0;
      const prerequisiteMet = building ? infrastructureReady && buildingPrerequisiteMet(st.self!.buildingBlueprints, building) : false;
      const affordable = isMiningBase
        ? st.self!.carried >= BALANCE.automation.base.commonCost && st.self!.iron >= BALANCE.automation.base.ironCost
        : building ? buildingResources.every(([resource, amount]) => (resource === "common" ? st.self!.carried : st.self![resource]) >= amount) : false;
      const cost = isMiningBase
        ? `<span class="upgrade-cost"><i class="tree-gem common"></i><b>${BALANCE.automation.base.commonCost}</b></span><span class="upgrade-cost"><i class="tree-gem iron"></i><b>${BALANCE.automation.base.ironCost}</b></span>`
        : building ? buildingResources.map(([resource, amount]) => `<span class="upgrade-cost"><i class="tree-gem ${resource}"></i><b>${amount}</b></span>`).join("") : `<b>—</b>`;
      const available = isMiningBase ? affordable : building ? prerequisiteMet && affordable : false;
      const locked = !isMiningBase && (!building || !prerequisiteMet);
      const status = isMiningBase ? affordable ? "Deployable" : "Need materials"
        : building ? !infrastructureReady ? "Need base" : !prerequisiteMet ? "Locked" : affordable ? "Deploy" : "Need materials" : "Locked";
      return `<div class="weapon-tech-step"><article class="weapon-tech-card field-tech-card ${available ? "available" : locked ? "locked" : "unaffordable"}">
      <div class="weapon-tech-identity"><div class="weapon-tech-art">${building
        ? buildingIcon(building.shortLabel)
        : item.slot !== undefined ? toolIcon(item.slot)
        : item.art === null
        ? `<div class="weapon-art-placeholder"><span>Art<br>pending</span></div>`
        : itemArt(item.art)}</div><div class="weapon-tech-copy"><span>${building ? `Outpost · ${building.powerDraw} power/s` : "Field · Blueprint"}</span><h4>${esc(item.name)}</h4></div></div>
      <div class="weapon-tech-description"><p>${esc(item.description)}</p></div>
      <div class="weapon-tech-action"><button ${(building || isMiningBase) && available ? `data-building-slot="${item.slot}"` : "disabled"}>${status}</button><span class="weapon-tech-cost">${cost}</span></div>
    </article></div>`;
    }).join("");
    return `<section class="weapon-tech-branch field-tech-branch">${branchFrame}<header class="weapon-tech-branch-head"><h4>${branch.label}</h4><p>${branch.description}</p></header><div class="weapon-tech-track">${cards}</div></section>`;
  }).join("");
}

/* ------------------------------------------------------------- main loop */

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastFrameAt) / 1000);
  lastFrameAt = now;
  if (mode !== "game") return;

  if (devFreeCamera) {
    const rawX = input.moveX();
    const rawY = input.moveY();
    if (rawX !== 0 || rawY !== 0) {
      const diagonal = rawX !== 0 && rawY !== 0 ? Math.SQRT1_2 : 1;
      const boosted = input.keys.has("ShiftLeft") || input.keys.has("ShiftRight");
      const speed = boosted ? 1_600 : 720;
      const worldPixels = st.worldSize * st.cellPx;
      devCameraWorldX = Math.max(0, Math.min(worldPixels, devCameraWorldX + rawX * speed * diagonal * dt));
      devCameraWorldY = Math.max(0, Math.min(worldPixels, devCameraWorldY + rawY * speed * diagonal * dt));
      sendDevCamera(now);
    }
  }

  // input send + prediction at fixed 30 Hz
  const sendInterval = 1000 / BALANCE.network.inputSendHz;
  while (now - lastInputSendAt >= sendInterval) {
    lastInputSendAt = lastInputSendAt === 0 ? now : lastInputSendAt + sendInterval;
    const scale = renderer.screenScale();
    const rect = canvas.getBoundingClientRect();
    const selfScreenX = rect.left + (rect.width / 2);
    const selfScreenY = rect.top + (rect.height / 2);
    const aim = input.aim(selfScreenX, selfScreenY);
    lastAim = aim;
    const frameInput = {
      moveX: input.moveX(),
      moveY: input.moveY(),
      aim,
      buttons: input.buttons(),
      slot: input.slot
    };
    const suppressGameplay = devViewing || devFreeCamera;
    if (suppressGameplay) st.seq++;
    else st.predictStep(frameInput.moveX, frameInput.moveY, frameInput.buttons);
    net.sendInput({
      seq: st.seq,
      moveX: suppressGameplay ? 0 : frameInput.moveX,
      moveY: suppressGameplay ? 0 : frameInput.moveY,
      aim,
      buttons: suppressGameplay ? 0 : frameInput.buttons,
      slot: frameInput.slot,
      ackTick: Math.floor(st.lastSnapshotTick)
    });
    void scale;
  }

  renderer.syncChunks(st);
  const ambient = ambientFor(st.phaseKind);
  renderer.render(st, now, dt, ambient, { x: input.mouseX, y: input.mouseY }, devFreeCamera ? {
    cameraWorldX: devCameraWorldX,
    cameraWorldY: devCameraWorldY,
    disableFog: true,
    inspectionMode: true
  } : undefined);

  if (!devFreeCamera && st.self?.slot === 2 && (st.selfFlags & PFLAG.DIGGING) !== 0) renderer.addPickImpact(st, lastAim, now);

  updateHud(now);
}

function ambientFor(_kind: string): number {
  return BALANCE.vision.dayFogOpacity;
}

requestAnimationFrame(frame);
installArmoryGround();
$<HTMLInputElement>("dev-mode").checked = new URLSearchParams(location.search).get("dev") === "1";
show("menu");

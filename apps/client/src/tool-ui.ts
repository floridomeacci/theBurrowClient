import { BALANCE } from "@burrow/config";
import type { SnapshotSelf } from "@burrow/protocol";
import {
  BASE_TOOL_SLOT,
  BOMB_FEATURE,
  BUILDING_DEFS,
  WEAPON,
  WEAPON_TECH,
  blastPatternForVariant,
  blastPatternLabel,
  buildingPrerequisiteMet,
  hasWeaponBlueprint,
  weaponFieldProfile,
  weaponKindForBlueprint
} from "@burrow/sim";

export interface ToolCard {
  slot: number;
  category: "weapon" | "building";
  name: string;
  family: string;
  description: string;
  stat: string;
  count: string;
  accent: string;
  icon: string;
  blast?: { range: number; halfWidth: number; diagonal?: boolean; variant: number; fuseTicks: number };
}

/** Only tools the player can currently use or afford appear in the carousel. */
export function availableTools(self: SnapshotSelf): ToolCard[] {
  const upgrades = BALANCE.bombUpgrades;
  const bomb = BALANCE.items.bomb;
  const range = bomb.blastRangeCells + self.bombRangeLevel * upgrades.range.rangePerLevelCells;
  const fuse = Math.max(
    Math.min(bomb.fuseTicks, upgrades.speed.minFuseTicks),
    bomb.fuseTicks - self.bombSpeedLevel * upgrades.speed.fuseReductionTicks
  );
  const width = bomb.blastHalfWidthCells + self.bombWidthLevel + ((self.bombFeatures & BOMB_FEATURE.WIDE) !== 0 ? 1 : 0);
  const capacity = bomb.maxActivePerPlayer + self.bombCapacityLevel + ((self.bombFeatures & BOMB_FEATURE.TWIN) !== 0 ? 1 : 0);
  const tools: ToolCard[] = [
    {
      slot: 1,
      category: "weapon",
      name: "Burrow Bomb",
      family: "Core explosive",
      description: "Carves the classic four-way cross; every engineering upgrade stacks onto it.",
      stat: `${(fuse / 30).toFixed(1)}s fuse · ${range} range · ${width * 2 + 1} wide · ${capacity} active`,
      count: "∞",
      accent: "#ffb14a",
      icon: toolIcon(1),
      blast: {
        range,
        halfWidth: width,
        diagonal: (self.bombFeatures & BOMB_FEATURE.DIAGONAL) !== 0,
        variant: WEAPON.STANDARD,
        fuseTicks: fuse
      }
    }
  ];

  if (self.pickDurability > 0 || self.carried >= BALANCE.items.pick.gemCost) {
    tools.push({
      slot: 2,
      category: "weapon",
      name: self.pickDurability > 0 ? "Mining Pick" : "Pick Blueprint",
      family: self.pickDurability > 0 ? "Excavation tool" : "Craftable tool",
      description: self.pickDurability > 0
        ? "Precise, quiet digging for shaping bases and extracting deposits."
        : "Select and click to craft a pick from common gems.",
      stat: self.pickDurability > 0
        ? `${Math.ceil((self.pickDurability / BALANCE.items.pick.durabilityTicks) * 100)}% durability`
        : `Costs ${BALANCE.items.pick.gemCost} common gems`,
      count: self.pickDurability > 0 ? "READY" : "CRAFT",
      accent: "#65d7e5",
      icon: toolIcon(2)
    });
  }

  if (self.wallUnlocked) {
    tools.push({
      slot: 3,
      category: "building",
      name: "Rigid Wall",
      family: "Base construction",
      description: "Hold click and sweep the cursor to build partial, oxygen-safe wall segments.",
      stat: `${BALANCE.construction.rigidWall.gemCostPerCell} gem per valid cell`,
      count: `${self.carried}`,
      accent: "#6ee7a1",
      icon: toolIcon(3)
    });
  }
  const special = BALANCE.specialWeapons;
  const rangeBonus = self.bombRangeLevel * upgrades.range.rangePerLevelCells;
  const widthBonus = self.bombWidthLevel + ((self.bombFeatures & BOMB_FEATURE.WIDE) !== 0 ? 1 : 0);
  const reducedFuse = (ticks: number) => Math.max(upgrades.speed.minFuseTicks, ticks - self.bombSpeedLevel * upgrades.speed.fuseReductionTicks);
  addSpecial(tools, self.dynamite, 4, "Dynamite", "Long demolition", "Cuts one long two-sided line through rock.",
    `${(reducedFuse(special.dynamite.fuseTicks) / 30).toFixed(1)}s fuse · ${special.dynamite.rangeCells + rangeBonus} range · line shape · 1 payload`, "#ff8748",
    {
      range: special.dynamite.rangeCells + rangeBonus,
      halfWidth: special.dynamite.halfWidthCells + widthBonus,
      variant: WEAPON.DYNAMITE,
      fuseTicks: reducedFuse(special.dynamite.fuseTicks)
    });
  addSpecial(tools, self.c4, 5, "Remote C4", "Remote explosive", "Press Q to trigger a dense diamond-shaped kill zone.",
    `Q remote · ${special.c4.rangeCells + rangeBonus} range · diamond shape · 1 payload`, "#5ec8ff",
    {
      range: special.c4.rangeCells + rangeBonus,
      halfWidth: special.c4.halfWidthCells + widthBonus,
      variant: WEAPON.C4,
      fuseTicks: special.c4.fuseTicks
    });
  addSpecial(tools, self.clusterBombs, 6, "Cluster Bomb", "Cascade explosive", "A compact burst throws six delayed children that explode as diagonal X shapes.",
    `${(reducedFuse(special.cluster.fuseTicks) / 30).toFixed(1)}s fuse · ${special.cluster.childCount} children · X child shape · ${special.cluster.childRangeCells} child range`, "#d878ff",
    {
      range: special.cluster.rangeCells + rangeBonus,
      halfWidth: bomb.blastHalfWidthCells + widthBonus,
      variant: WEAPON.CLUSTER,
      fuseTicks: reducedFuse(special.cluster.fuseTicks)
    });
  addSpecial(tools, self.napalm, 7, "Napalm", "Area denial", "Projects a directional fan and leaves every reached cell burning.",
    `${(reducedFuse(special.napalm.fuseTicks) / 30).toFixed(1)}s fuse · ${special.napalm.rangeCells + rangeBonus} range · fan shape · ${special.napalm.burnTicks / 30}s burn`, "#ff5d38",
    {
      range: special.napalm.rangeCells + rangeBonus,
      halfWidth: bomb.blastHalfWidthCells + widthBonus,
      variant: WEAPON.NAPALM,
      fuseTicks: reducedFuse(special.napalm.fuseTicks)
    });
  addSpecial(tools, self.nukes, 8, "Burrow Nuke", "Relic superweapon", "An enormous eight-arm star obliterates every escape axis.",
    `${(reducedFuse(special.nuke.fuseTicks) / 30).toFixed(1)}s fuse · ${special.nuke.rangeCells + rangeBonus} range · star shape · 2× damage`, "#b9ff63",
    {
      range: special.nuke.rangeCells + rangeBonus,
      halfWidth: special.nuke.halfWidthCells + widthBonus,
      diagonal: true,
      variant: WEAPON.NUKE,
      fuseTicks: reducedFuse(special.nuke.fuseTicks)
    });
  addSpecial(tools, self.turretKits, 9, "Auto-Turret", "Deployable weapon", "Tracks nearby rivals and fires compact radial shells automatically.",
    `${(special.turret.fireIntervalTicks / 30).toFixed(1)}s fire · ${special.turret.rangeCells} range · radial shell · 1 deployed`, "#ffd06b",
    {
      range: special.turret.shellRangeCells + self.bombRangeLevel,
      halfWidth: 1,
      variant: WEAPON.TURRET_SHELL,
      fuseTicks: special.turret.shellFuseTicks
    });
  const branchAccent = { demolition: "#ff8748", traps: "#e76f75", control: "#78b8ff", warfare: "#d878ff" } as const;
  for (const tech of WEAPON_TECH) {
    if (tech.inventory !== undefined || !hasWeaponBlueprint(self.weaponBlueprints, tech.id)) continue;
    const profile = weaponFieldProfile(tech.id);
    if (!profile) continue;
    const prototypeRange = profile.rangeCells + rangeBonus;
    const prototypeWidth = profile.halfWidthCells + widthBonus;
    const prototypeFuse = reducedFuse(profile.fuseTicks);
    const prototypeVariant = weaponKindForBlueprint(tech.id);
    tools.push({
      slot: tech.fieldSlot,
      category: "weapon",
      name: tech.label,
      family: `${tech.branch === "warfare" ? "Siege" : tech.branch[0].toUpperCase() + tech.branch.slice(1)} prototype`,
      description: tech.description,
      stat: `${(prototypeFuse / 30).toFixed(1)}s fuse · ${prototypeRange} range · ${prototypeWidth * 2 + 1} wide · ${blastPatternLabel(blastPatternForVariant(prototypeVariant))}`,
      count: "∞",
      accent: branchAccent[tech.branch],
      icon: itemArt(`weapons/${tech.id}`),
      blast: {
        range: prototypeRange,
        halfWidth: prototypeWidth,
        diagonal: profile.diagonal,
      variant: prototypeVariant,
        fuseTicks: prototypeFuse
      }
    });
  }
  const base = BALANCE.automation.base;
  if (self.carried >= base.commonCost && self.iron >= base.ironCost) {
    tools.push({
      slot: BASE_TOOL_SLOT,
      category: "building",
      name: "Mining Base",
      family: "Automation deployable",
      description: "Deploys into a clear excavated footprint with one autonomous miner. Press E at the base to build more miners.",
      stat: `${base.commonCost} gems · ${base.ironCost} iron · 1 starter miner · ${BALANCE.automation.miner.maxPerBase} miner capacity`,
      count: "READY",
      accent: "#d9a25d",
      icon: toolIcon(BASE_TOOL_SLOT)
    });
  }
  if (self.infrastructureUnlocked) {
    for (const building of BUILDING_DEFS) {
      if (!buildingPrerequisiteMet(self.buildingBlueprints, building)) continue;
      const costs = Object.entries(building.cost) as ["common" | "copper" | "iron" | "gold" | "platinum" | "coal", number][];
      const available = costs.length === 0 ? 99 : Math.min(99, ...costs.map(([resource, amount]) =>
        Math.floor((resource === "common" ? self.carried : self[resource]) / amount)
      ));
      const costStat = costs.map(([resource, amount]) => `${amount} ${resource}`).join(" · ");
      tools.push({
        slot: building.slot,
        category: "building",
        name: building.label,
        family: "Powered outpost building",
        description: building.description,
        stat: `${costStat} · ${building.powerDraw} power/s · ${building.health} integrity`,
        count: `×${available}`,
        accent: building.kind === 5 || building.kind === 6 ? "#ef6251" : building.kind === 3 ? "#65d7e5" : "#d9a25d",
        icon: buildingIcon(building.shortLabel)
      });
    }
  }
  return tools;
}

function addSpecial(
  tools: ToolCard[],
  count: number,
  slot: number,
  name: string,
  family: string,
  description: string,
  stat: string,
  accent: string,
  blast?: ToolCard["blast"]
): void {
  if (count <= 0) return;
  tools.push({ slot, category: "weapon", name, family, description, stat, count: `×${count}`, accent, icon: toolIcon(slot), blast });
}

const CURRENT_TOOL_ART: Partial<Record<number, string>> = {
  2: "current/mining-pick",
  3: "current/rigid-wall",
  4: "current/dynamite",
  5: "current/remote-c4",
  6: "current/cluster-bomb",
  7: "current/napalm",
  8: "current/burrow-nuke",
  9: "current/auto-turret",
  [BASE_TOOL_SLOT]: "current/mining-base"
};

export function itemArt(asset: string): string {
  return `<img class="tool-item-art" src="/items/${asset}.webp" alt="" aria-hidden="true" />`;
}

/** Temporary art intentionally reads as a white-box blueprint until the
 * final building sheets are supplied. */
export function buildingIcon(label: string): string {
  return `<div class="building-art-placeholder" aria-hidden="true"><i></i><b>${label}</b></div>`;
}

/** The core bomb keeps its existing exported illustration. Every other
 * implemented loadout item uses the matching finished bitmap artwork. */
export function toolIcon(slot: number): string {
  const art = CURRENT_TOOL_ART[slot];
  if (art !== undefined) return itemArt(art);
  const open = `<svg class="tool-svg" viewBox="0 0 160 120" role="img" aria-hidden="true"><g stroke-linecap="round" stroke-linejoin="round">`;
  const close = `</g></svg>`;
  if (slot === 1) return `${open}
    <path d="M102 30c9-18 22-16 28-29" fill="none" stroke="#d8c39b" stroke-width="7"/>
    <path d="M127 5l8-4-2 9 8 4-10 2-4 9-3-10-10-3 10-4z" fill="#ffe376" stroke="#ff8b3f" stroke-width="3"/>
    <circle cx="76" cy="69" r="41" fill="#171a22" stroke="#525b6b" stroke-width="6"/>
    <ellipse cx="62" cy="51" rx="13" ry="9" fill="#8794a5" opacity=".7"/>
    <path d="M45 92c15 14 50 17 67-9" fill="none" stroke="#080a0e" stroke-width="7" opacity=".7"/>
    <rect x="91" y="20" width="21" height="18" rx="5" fill="#b66732" stroke="#f0ad58" stroke-width="4"/>${close}`;
  if (slot === 2) return `${open}
    <path d="M82 38l-11 68" stroke="#9f623d" stroke-width="13"/>
    <path d="M68 105l15 3" stroke="#d59a62" stroke-width="5"/>
    <path d="M33 43c23-27 59-35 94-8l-7 14c-24-12-49-11-76 8z" fill="#8296a5" stroke="#d0e2e7" stroke-width="5"/>
    <path d="M92 33l-8 19" stroke="#43515c" stroke-width="5"/>${close}`;
  if (slot === 3) return `${open}
    <path d="M24 41h112v62H24z" fill="#324c4a" stroke="#8be2bb" stroke-width="5"/>
    <path d="M24 62h112M24 83h112M52 41v21M105 41v21M40 62v21M87 62v21M119 62v21M59 83v20M110 83v20" stroke="#6db79c" stroke-width="4"/>
    <path d="M37 32h86" stroke="#d9fff0" stroke-width="7"/>${close}`;
  if (slot === 4) return `${open}
    <path d="M93 29c10-12 18-13 26-25" fill="none" stroke="#ead0a1" stroke-width="6"/>
    <path d="M115 8l8-5 1 9 9 3-9 4-3 9-5-9-10-1z" fill="#ffe06a" stroke="#ff7e36" stroke-width="3"/>
    <g transform="rotate(-8 80 72)"><rect x="38" y="37" width="24" height="70" rx="9" fill="#c53c31" stroke="#ff8a62" stroke-width="4"/><rect x="67" y="37" width="24" height="70" rx="9" fill="#d34834" stroke="#ff8a62" stroke-width="4"/><rect x="96" y="37" width="24" height="70" rx="9" fill="#b92f2f" stroke="#ff8a62" stroke-width="4"/><path d="M35 62h88M36 85h87" stroke="#f0bf55" stroke-width="8"/></g>${close}`;
  if (slot === 5) return `${open}
    <rect x="29" y="34" width="102" height="68" rx="10" fill="#33485e" stroke="#71d4ff" stroke-width="5"/>
    <rect x="42" y="46" width="45" height="42" rx="4" fill="#182532" stroke="#94e2ff" stroke-width="3"/>
    <text x="64" y="73" text-anchor="middle" fill="#d7f5ff" font-family="sans-serif" font-size="19" font-weight="900">C4</text>
    <path d="M92 50c17 3 16 22 29 27M94 78c12-5 15-20 28-23" fill="none" stroke="#ffcf5c" stroke-width="5"/>
    <circle cx="118" cy="78" r="6" fill="#ff5d5d"/>${close}`;
  if (slot === 6) return `${open}
    <circle cx="80" cy="61" r="28" fill="#442854" stroke="#df89ff" stroke-width="5"/>
    <circle cx="80" cy="61" r="10" fill="#ffb4ff"/>
    <g fill="#6f3a83" stroke="#efacff" stroke-width="4"><circle cx="34" cy="34" r="12"/><circle cx="126" cy="34" r="12"/><circle cx="35" cy="94" r="12"/><circle cx="125" cy="94" r="12"/><circle cx="80" cy="105" r="10"/></g>
    <path d="M79 33c6-19 15-19 22-28" fill="none" stroke="#ead2a7" stroke-width="5"/>${close}`;
  if (slot === 7) return `${open}
    <path d="M50 39h59l11 58c-24 14-53 14-78 0z" fill="#652b26" stroke="#ff784f" stroke-width="5"/>
    <rect x="62" y="24" width="34" height="18" rx="5" fill="#9b4d35" stroke="#ffad63" stroke-width="4"/>
    <path d="M79 87c-18-12-8-26 3-39 1 13 17 16 10 34 12-8 15-19 12-29 17 23 3 48-23 48-18 0-27-13-23-27 4 8 10 12 21 13z" fill="#ffbd3e" stroke="#ff5835" stroke-width="4"/>${close}`;
  if (slot === 8) return `${open}
    <circle cx="80" cy="65" r="43" fill="#26372c" stroke="#baff68" stroke-width="6"/>
    <circle cx="80" cy="65" r="10" fill="#dfff9b"/>
    <path d="M80 55L57 21a42 42 0 0 1 46 0zm-9 15L30 91a42 42 0 0 1-1-48zm18 0l42 21a42 42 0 0 0 0-48z" fill="#9ee758"/>
    <path d="M101 28c4-16 15-18 20-27" fill="none" stroke="#e4d4af" stroke-width="6"/>${close}`;
  if (slot === BASE_TOOL_SLOT) return `${open}
    <path d="M24 102h112l-9 14H33z" fill="#302a27" stroke="#8f7968" stroke-width="5"/>
    <path d="M33 52h94v53H33z" fill="#55483d" stroke="#d9a25d" stroke-width="5"/>
    <path d="m28 52 18-25h68l18 25z" fill="#393335" stroke="#b98a56" stroke-width="5"/>
    <rect x="67" y="69" width="26" height="36" fill="#17191b" stroke="#8f9a9e" stroke-width="4"/>
    <path d="M47 66h12v12H47zM101 66h12v12h-12z" fill="#ffd46b" stroke="#6f5131" stroke-width="3"/>
    <path d="M80 27V10M72 10h16" stroke="#d9c7a8" stroke-width="5"/>
    <circle cx="80" cy="9" r="5" fill="#f05e46"/>${close}`;
  return `${open}
    <path d="M46 95h68l10 17H36z" fill="#3d414b" stroke="#9ca5b3" stroke-width="5"/>
    <rect x="57" y="55" width="47" height="43" rx="9" fill="#4f5664" stroke="#d4a94f" stroke-width="5"/>
    <circle cx="80" cy="56" r="22" fill="#313641" stroke="#f2c968" stroke-width="5"/>
    <path d="M82 50l48-20 5 12-48 20z" fill="#7f8998" stroke="#d8e0e8" stroke-width="4"/>
    <circle cx="73" cy="56" r="5" fill="#ff7358"/>${close}`;
}

import { BASE_TOOL_SLOT, BUILDING_FLAG, BTN, FP, PRES, ROLE, ENT, TICK_HZ, WEAPON } from "./constants";
import { Rng } from "./rng";
import type { InputFrame, MatchSim, PlayerSim } from "./match";
import { BOMB_FEATURE, bombUpgradeQuotes, type BombUpgradeId, type CraftResource } from "./upgrades";
import { WEAPON_TECH, hasWeaponBlueprint } from "./weapon-tree";
import { hasLineOfSight } from "./terrain";
import { circleCollides } from "./movement";
import { MAT, minerDiggable } from "./materials";
import { BUILDING, buildingDefinition, buildingPrerequisiteMet, type BuildingDefinition, type BuildingResource } from "./buildings";
import { blastPatternForVariant, bombBlastPatternContains } from "./bomb";

type BotObjectiveKind = "loose-gem" | "deposit" | "guardian" | "chest" | "opponent";

interface BotObjective {
  kind: BotObjectiveKind;
  score: number;
  x: number;
  y: number;
  targetId?: number;
  material?: number;
}

interface BombHazard {
  x: number;
  y: number;
  shapeSeed?: number;
  weaponKind?: number;
  aim?: number;
  blastRange?: number;
  blastHalfWidth?: number;
  blastNoiseFringe?: number;
  blastWobble?: number;
  blastFeatures?: number;
}

interface BotEscapeGoal {
  hazardId: number;
  hazard: BombHazard;
  x: number;
  y: number;
  untilTick: number;
  repathAt: number;
}

interface GuardianTrapPlan {
  guardianId: number;
  bombId: number;
  orbitDirection: -1 | 1;
  orbitAngle: number;
  expiresAt: number;
}

interface BaseBuildPlan {
  centerX: number;
  centerY: number;
  standX: number;
  standY: number;
  aim: number;
  expiresAt: number;
}

interface InfrastructureBuildPlan extends BaseBuildPlan {
  kind: number;
}

/** Lightweight Bomberman controller used to fill local matches. Bots mine,
 * raid guarded ruins, deploy specials, pressure nearby rivals, and retreat
 * from their own active payloads. */
export class BotController {
  private rng: Rng;
  private seq = 1;
  private goals = new Map<number, { x: number; y: number; untilTick: number }>();
  private escapeGoals = new Map<number, BotEscapeGoal>();
  private guardianTraps = new Map<number, GuardianTrapPlan>();
  private objectives = new Map<number, { value: BotObjective; untilTick: number }>();
  private seekingOxygen = new Set<number>();
  private oxygenTargets = new Map<number, { x: number; y: number; untilTick: number }>();
  private baseBuildPlans = new Map<number, BaseBuildPlan>();
  private infrastructureBuildPlans = new Map<number, InfrastructureBuildPlan>();

  constructor(seed: number) {
    this.rng = new Rng(seed ^ 0xb07b07);
  }

  stepBots(sim: MatchSim): void {
    for (const p of sim.players) {
      if (!p.bot) continue;
      this.tryUpgradeBomb(sim, p);
      this.tryWeaponTech(sim, p);
      sim.queueInput(p.id, this.decide(sim, p));
    }
  }

  private tryUpgradeBomb(sim: MatchSim, p: PlayerSim): void {
    if (sim.phaseKind() === "countdown" || p.eliminated) return;
    const priority: Record<BombUpgradeId, number> = {
      speed: 120,
      range: 116,
      prospector: 112,
      twin: 105,
      wide: 101,
      capacity: 96,
      width: 94,
      diagonal: 90,
      remote: 84,
      shield: 80,
      vision: 114,
      mobility: 118,
      vitality: 108
    };

    // Install every currently affordable level immediately. Keep enough
    // common gems for a replacement pick only while the bot has no pick;
    // everything else is available to the upgrade economy.
    for (let installed = 0; installed < 20; installed++) {
      const pickReserve = p.pickDurability <= 0 ? sim.bal.items.pick.gemCost : 0;
      const base = [...sim.entities.values()].find((entity) => entity.kind === ENT.MINING_BASE && entity.ownerId === p.id);
      const minerCount = base ? [...sim.entities.values()].filter((entity) => entity.kind === ENT.AUTO_MINER && entity.baseId === base.id).length : 0;
      const automationCommonReserve = !base
        ? p.iron >= sim.bal.automation.base.ironCost ? sim.bal.automation.base.commonCost : 0
        : minerCount < 3 && p.iron >= sim.bal.automation.miner.ironCost ? sim.bal.automation.miner.commonCost : 0;
      const automationIronReserve = !base ? sim.bal.automation.base.ironCost : minerCount < 3 ? sim.bal.automation.miner.ironCost : 0;
      const nextBuilding = base ? this.nextInfrastructureBuilding(sim, p) : undefined;
      const buildingReserve = (resource: CraftResource) => resource === "fossils" ? 0 : nextBuilding?.cost[resource] ?? 0;
      const availableBeforeWeapon: Record<CraftResource, number> = {
        common: Math.max(0, p.carriedGems - pickReserve - automationCommonReserve - buildingReserve("common")),
        gold: Math.max(0, p.gold - buildingReserve("gold")),
        fossils: p.fossils,
        copper: Math.max(0, p.copper - buildingReserve("copper")),
        iron: Math.max(0, p.iron - automationIronReserve - buildingReserve("iron")),
        platinum: Math.max(0, p.platinum - buildingReserve("platinum")),
        coal: Math.max(0, p.coal - buildingReserve("coal"))
      };
      const weaponTarget = WEAPON_TECH
        .filter((tech) =>
          !hasWeaponBlueprint(p.weaponBlueprints, tech.id) &&
          (!tech.prerequisite || hasWeaponBlueprint(p.weaponBlueprints, tech.prerequisite)) &&
          (Object.entries(tech.unlockCost) as [CraftResource, number][]).every(([resource, amount]) => availableBeforeWeapon[resource] >= amount)
        )
        .sort((a, b) => a.tier - b.tier ||
          (Object.values(a.unlockCost) as number[]).reduce((sum, amount) => sum + amount, 0) -
          (Object.values(b.unlockCost) as number[]).reduce((sum, amount) => sum + amount, 0))[0];
      const weaponReserve = (resource: CraftResource) => weaponTarget?.unlockCost[resource] ?? 0;
      const inventory: Record<CraftResource, number> = {
        common: Math.max(0, availableBeforeWeapon.common - weaponReserve("common")),
        gold: Math.max(0, availableBeforeWeapon.gold - weaponReserve("gold")),
        fossils: Math.max(0, availableBeforeWeapon.fossils - weaponReserve("fossils")),
        copper: Math.max(0, availableBeforeWeapon.copper - weaponReserve("copper")),
        iron: Math.max(0, availableBeforeWeapon.iron - weaponReserve("iron")),
        platinum: Math.max(0, availableBeforeWeapon.platinum - weaponReserve("platinum")),
        coal: Math.max(0, availableBeforeWeapon.coal - weaponReserve("coal"))
      };
      const quote = bombUpgradeQuotes(p, sim.bal)
        .filter((candidate) =>
          !candidate.maxed && candidate.prerequisiteMet &&
          (Object.entries(candidate.cost) as [CraftResource, number][]).every(([resource, amount]) => inventory[resource] >= amount)
        )
        .sort((a, b) => priority[b.id] - priority[a.id])[0];
      if (!quote || !sim.purchaseBombUpgrade(p.id, quote.id)) break;
    }
  }

  private tryWeaponTech(sim: MatchSim, p: PlayerSim): void {
    if (sim.phaseKind() === "countdown" || p.eliminated) return;
    const base = [...sim.entities.values()].find((entity) => entity.kind === ENT.MINING_BASE && entity.ownerId === p.id);
    const minerCount = base ? [...sim.entities.values()].filter((entity) => entity.kind === ENT.AUTO_MINER && entity.baseId === base.id).length : 0;
    const automationReserve = !base
      ? p.iron >= sim.bal.automation.base.ironCost ? sim.bal.automation.base.commonCost : 0
      : minerCount < 3 && p.iron >= sim.bal.automation.miner.ironCost ? sim.bal.automation.miner.commonCost : 0;
    const pickReserve = p.pickDurability <= 0 ? sim.bal.items.pick.gemCost : 0;
    const nextBuilding = base ? this.nextInfrastructureBuilding(sim, p) : undefined;
    const buildingReserve = (resource: CraftResource) => resource === "fossils" ? 0 : nextBuilding?.cost[resource] ?? 0;
    const inventory: Record<CraftResource, number> = {
      common: Math.max(0, p.carriedGems - pickReserve - automationReserve - buildingReserve("common")),
      gold: Math.max(0, p.gold - buildingReserve("gold")),
      fossils: p.fossils,
      copper: Math.max(0, p.copper - buildingReserve("copper")),
      iron: Math.max(0, p.iron - (!base ? sim.bal.automation.base.ironCost : minerCount < 3 ? sim.bal.automation.miner.ironCost : 0) - buildingReserve("iron")),
      platinum: Math.max(0, p.platinum - buildingReserve("platinum")),
      coal: Math.max(0, p.coal - buildingReserve("coal"))
    };
    const affordable = (cost: Partial<Record<CraftResource, number>>) =>
      (Object.entries(cost) as [CraftResource, number][]).every(([resource, amount]) => inventory[resource] >= amount);
    const costWeight = (cost: Partial<Record<CraftResource, number>>) =>
      (Object.values(cost) as number[]).reduce((sum, amount) => sum + amount, 0);
    const unlock = WEAPON_TECH
      .filter((tech) =>
        !hasWeaponBlueprint(p.weaponBlueprints, tech.id) &&
        (!tech.prerequisite || hasWeaponBlueprint(p.weaponBlueprints, tech.prerequisite)) &&
        affordable(tech.unlockCost)
      )
      .sort((a, b) => a.tier - b.tier || costWeight(a.unlockCost) - costWeight(b.unlockCost))[0];
    if (unlock) {
      sim.purchaseWeaponTech(p.id, unlock.id);
      return;
    }
    const emptyPayload = WEAPON_TECH
      .filter((tech) =>
        tech.inventory !== undefined && tech.ammoCost !== undefined &&
        hasWeaponBlueprint(p.weaponBlueprints, tech.id) && p[tech.inventory] === 0 &&
        affordable(tech.ammoCost)
      )
      .sort((a, b) => costWeight(a.ammoCost ?? {}) - costWeight(b.ammoCost ?? {}))[0];
    if (emptyPayload) sim.purchaseWeaponTech(p.id, emptyPayload.id);
  }

  private decide(sim: MatchSim, p: PlayerSim): InputFrame {
    const frame: InputFrame = { seq: this.seq++, moveX: 0, moveY: 0, aim: p.facing, buttons: 0, slot: 2 };
    const kind = sim.phaseKind();
    if (kind === "countdown" || kind === "ended" || p.eliminated) return frame;

    const px = p.x / FP;
    const py = p.y / FP;

    // A ruin assault has a short dedicated state: keep the guardian near the
    // armed charge, then break diagonally just before detonation. This runs
    // before ordinary bomb avoidance so the bot does not immediately abandon
    // its trap and stop at a static escape point while the guardian pursues.
    if (this.stepGuardianTrap(sim, p, frame)) return frame;

    // Commit to a reachable safe point for the entire fuse and expanding
    // blast. Recomputing a raw "away" vector every tick made bots run into a
    // pocket wall, drain their stamina, and plant the next bomb beside the
    // still-expanding first blast.
    const existingEscape = this.escapeGoals.get(p.id);
    if (existingEscape && sim.tick <= existingEscape.untilTick) {
      if (sim.tick >= existingEscape.repathAt) {
        const liveHazard = sim.entities.get(existingEscape.hazardId);
        if (liveHazard?.kind === ENT.BOMB) {
          const next = this.findEscapeGoal(sim, p, liveHazard);
          existingEscape.x = next.x;
          existingEscape.y = next.y;
        } else {
          const guardian = [...sim.entities.values()]
            .filter((entity) => entity.kind === ENT.GUARDIAN)
            .sort((a, b) => dist2(p, a) - dist2(p, b))[0];
          if (guardian && dist2(p, guardian) < cellsSquared(sim.bal.treasure.guardianAttackRangeCells + 5)) {
            const next = this.findGuardianEvasionGoal(sim, p, guardian, 12);
            existingEscape.x = next.x;
            existingEscape.y = next.y;
          }
        }
        existingEscape.repathAt = sim.tick + 5;
      }
      this.moveToward(frame, px, py, existingEscape.x, existingEscape.y);
      if (frame.moveX !== 0 || frame.moveY !== 0) frame.buttons |= BTN.SPRINT;
      return frame;
    }
    if (existingEscape) this.escapeGoals.delete(p.id);

    const threateningBomb = [...sim.entities.values()]
      .filter((entity) => {
        if (entity.kind !== ENT.BOMB) return false;
        const range = entity.blastRange ?? sim.bal.items.bomb.blastRangeCells;
        const width = entity.blastHalfWidth ?? sim.bal.items.bomb.blastHalfWidthCells;
        return dist2(p, entity) <= ((range + width + 8) * FP) ** 2;
      })
      .sort((a, b) => dist2(p, a) - dist2(p, b))[0];
    if (threateningBomb) {
      const goal = this.findEscapeGoal(sim, p, threateningBomb);
      const range = threateningBomb.blastRange ?? sim.bal.items.bomb.blastRangeCells;
      const stepTicks = threateningBomb.blastStepTicks ?? sim.bal.items.bomb.blastStepTicks;
      const escape = {
        hazardId: threateningBomb.id,
        hazard: this.escapeHazard(threateningBomb),
        x: goal.x,
        y: goal.y,
        untilTick: threateningBomb.cooldownEnd + range * stepTicks + sim.bal.items.bomb.blastVisualTicks + 3,
        repathAt: sim.tick + 5
      };
      this.escapeGoals.set(p.id, escape);
      this.moveToward(frame, px, py, escape.x, escape.y);
      if (frame.moveX !== 0 || frame.moveY !== 0) frame.buttons |= BTN.SPRINT;
      return frame;
    }

    if (this.seekOxygen(sim, p, frame)) return frame;

    // Dormant spawn-point zombies are harmless until the release timer expires.
    const zombie = [...sim.zombies].sort((a, b) => dist2(p, a) - dist2(p, b))[0];
    if (sim.zombiesReleased() && zombie && dist2(p, zombie) < (20 * FP) ** 2) {
      if (p.role === ROLE.MINER && dist2(p, zombie) < (10 * FP) ** 2 && sim.ownedBombs(p) === 0) {
        frame.slot = 1;
        frame.buttons |= BTN.PRIMARY;
      }
      this.moveToward(frame, px, py, 2 * px - zombie.x / FP, 2 * py - zombie.y / FP);
      frame.buttons |= BTN.SPRINT;
      return frame;
    }

    // After release, infected hunt in daylight and miners flee visible forms.
    if (sim.zombiesReleased() && p.role === ROLE.INFECTED) {
      const threatList = sim.players.filter((q) => q.role === ROLE.MINER && q.convertingUntilTick === 0);
      const target = threatList.sort((a, b) => dist2(p, a) - dist2(p, b))[0];
      if (p.presentation !== PRES.HUNT && target) frame.buttons |= BTN.HUNT;
      if (target) {
        this.aimAt(frame, p, target.x / FP, target.y / FP);
        this.moveToward(frame, px, py, target.x / FP, target.y / FP);
        if (dist2(p, target) < (4 * FP) ** 2) frame.buttons |= BTN.PRIMARY;
        return frame;
      }
      if (p.presentation !== PRES.HUNT) frame.buttons |= BTN.HUNT;
      this.moveTowardBot(sim, p, frame);
      frame.buttons |= BTN.PRIMARY; // break obstacles
      return frame;
    }
    if (sim.zombiesReleased()) {
      const threat = sim.players.filter((q) => q.presentation === PRES.HUNT).sort((a, b) => dist2(p, a) - dist2(p, b))[0];
      if (threat) {
        this.moveToward(frame, px, py, 2 * px - threat.x / FP, 2 * py - threat.y / FP);
        frame.buttons |= BTN.SPRINT;
        return frame;
      }
    }

    // A newly affordable pick is an immediate economy conversion, not another
    // competing destination. Without this edge-triggered action, a visible
    // deposit could keep winning the objective score while five gems sat idle.
    if (p.pickDurability <= 0 && p.carriedGems >= sim.bal.items.pick.gemCost) {
      frame.slot = 2;
      // Crafting is edge-triggered. Release a held digging input for one tick
      // when the previous pick wore out, then press again to craft.
      if (p.selectedSlot === 2 && (p.input.buttons & BTN.PRIMARY) !== 0) return frame;
      frame.buttons |= BTN.PRIMARY;
      return frame;
    }

    const miningBase = [...sim.entities.values()].find((entity) => entity.kind === ENT.MINING_BASE && entity.ownerId === p.id);
    const visibleEnemy = sim.players
      .filter((other) => other.id !== p.id && !other.eliminated && hasLineOfSight(sim.world, px, py, other.x / FP, other.y / FP))
      .sort((a, b) => dist2(p, a) - dist2(p, b))[0];
    if (visibleEnemy) {
      const objective: BotObjective = { kind: "opponent", score: 20_000, x: visibleEnemy.x / FP, y: visibleEnemy.y / FP, targetId: visibleEnemy.id };
      if (this.actOnObjective(sim, p, frame, objective)) return frame;
    }
    if (!miningBase && p.carriedGems >= sim.bal.automation.base.commonCost && p.iron >= sim.bal.automation.base.ironCost) {
      this.stepBaseConstruction(sim, p, frame);
      return frame;
    }
    if (miningBase) {
      this.baseBuildPlans.delete(p.id);
      const minerCount = [...sim.entities.values()].filter((entity) => entity.kind === ENT.AUTO_MINER && entity.baseId === miningBase.id).length;
      const cfg = sim.bal.automation.miner;
      const nextBuilding = this.nextInfrastructureBuilding(sim, p);
      if (nextBuilding && this.canAffordInfrastructure(p, nextBuilding) && (nextBuilding.kind === BUILDING.COAL_GENERATOR || minerCount >= 3)) {
        this.stepInfrastructureConstruction(sim, p, frame, nextBuilding);
        return frame;
      }
      if (minerCount < 3 && p.carriedGems >= cfg.commonCost && p.iron >= cfg.ironCost) {
        const distance = Math.hypot(miningBase.x / FP - px, miningBase.y / FP - py);
        if (distance <= sim.bal.automation.base.interactRangeCells) frame.buttons |= BTN.INTERACT;
        else {
          this.moveToward(frame, px, py, miningBase.x / FP, miningBase.y / FP);
          if (p.pickDurability > 0) {
            frame.slot = 2;
            frame.buttons |= BTN.PRIMARY;
          }
        }
        return frame;
      }
      if (nextBuilding && this.canAffordInfrastructure(p, nextBuilding)) {
        this.stepInfrastructureConstruction(sim, p, frame, nextBuilding);
        return frame;
      }
    }

    // Safety is non-negotiable; all productive choices below compete through
    // one weighted objective model. This lets a rich visible gem seam beat a
    // weak combat opportunity without making bots ignore immediate threats.
    const objective = this.weightedObjective(sim, p);
    if (objective && this.actOnObjective(sim, p, frame, objective)) return frame;

    // Craft a replacement whenever resources allow; otherwise bomb-mine rock.
    if (p.pickDurability <= 0) {
      this.useBombExcavation(sim, p, frame);
      return frame;
    }

    // wander toward goal, aiming at nearby solid rock, dig constantly
    this.moveTowardBot(sim, p, frame);
    frame.buttons |= BTN.PRIMARY;
    if (this.rng.chance(0.1)) frame.buttons |= BTN.SPRINT;
    return frame;
  }

  /** Prepare one persistent construction site instead of rotating through
   * invalid base placements. The bot clears the full collision apron and a
   * player-width access corridor, walks back outside the base body, then
   * deploys from there. */
  private stepBaseConstruction(sim: MatchSim, p: PlayerSim, frame: InputFrame): void {
    let plan = this.baseBuildPlans.get(p.id);
    if (plan && (sim.tick >= plan.expiresAt || this.basePlanHasPermanentBlocker(sim, plan))) {
      this.baseBuildPlans.delete(p.id);
      plan = undefined;
    }
    if (!plan) {
      plan = this.findBaseBuildPlan(sim, p);
      if (plan) this.baseBuildPlans.set(p.id, plan);
    }

    // No suitable footprint from this pocket yet: keep widening the chamber,
    // then search again after the bot has made useful excavation progress.
    if (!plan) {
      if (p.pickDurability > 0) {
        frame.slot = 2;
        frame.buttons |= BTN.PRIMARY;
        this.moveTowardBot(sim, p, frame);
      } else {
        this.useBombExcavation(sim, p, frame);
      }
      return;
    }

    const blockers = this.basePlanBlockers(sim, plan)
      .filter((cell) => sim.world.get(cell.x, cell.y) !== MAT.EMPTY)
      .sort((a, b) => {
        const ad = (a.x + 0.5 - p.x / FP) ** 2 + (a.y + 0.5 - p.y / FP) ** 2;
        const bd = (b.x + 0.5 - p.x / FP) ** 2 + (b.y + 0.5 - p.y / FP) ** 2;
        return ad - bd;
      });
    if (blockers.length > 0) {
      const target = { x: blockers[0].x + 0.5, y: blockers[0].y + 0.5 };
      if (p.pickDurability > 0) {
        frame.slot = 2;
        frame.buttons |= BTN.PRIMARY;
        this.aimAt(frame, p, target.x, target.y);
        this.moveToward(frame, p.x / FP, p.y / FP, target.x, target.y);
      } else {
        this.useBombExcavation(sim, p, frame, target);
      }
      return;
    }

    // A moving player, guardian, bomb, or structure can temporarily occupy an
    // otherwise valid site. Re-plan instead of hammering the placement action.
    if (this.baseSiteOccupied(sim, p, plan.centerX, plan.centerY)) {
      this.baseBuildPlans.delete(p.id);
      this.moveTowardBot(sim, p, frame);
      return;
    }

    const px = p.x / FP;
    const py = p.y / FP;
    if (Math.hypot(plan.standX - px, plan.standY - py) > 0.6) {
      this.moveToward(frame, px, py, plan.standX, plan.standY);
      if (Math.hypot(plan.standX - px, plan.standY - py) > 6) frame.buttons |= BTN.SPRINT;
      return;
    }

    frame.slot = BASE_TOOL_SLOT;
    frame.aim = plan.aim;
    // Switching from the pick to the base slot is itself an authoritative
    // placement edge, so this produces exactly one attempt at the clear site.
    frame.buttons |= BTN.PRIMARY;
  }

  private findBaseBuildPlan(sim: MatchSim, p: PlayerSim): BaseBuildPlan | undefined {
    const cfg = sim.bal.automation.base;
    const standX = p.x / FP;
    const standY = p.y / FP;
    const cardinalFirst = [0, 64, 128, 192, 32, 96, 160, 224, 16, 48, 80, 112, 144, 176, 208, 240];
    const offset = (p.id + Math.floor(sim.tick / (8 * TICK_HZ))) % cardinalFirst.length;
    let best: { plan: BaseBuildPlan; work: number } | undefined;

    for (let attempt = 0; attempt < cardinalFirst.length; attempt++) {
      const aim = cardinalFirst[(attempt + offset) % cardinalFirst.length];
      const angle = aim / 256 * Math.PI * 2;
      const centerX = Math.floor(standX + Math.cos(angle) * cfg.placementReachCells);
      const centerY = Math.floor(standY + Math.sin(angle) * cfg.placementReachCells);
      const margin = Math.ceil(cfg.siteClearanceRadiusCells) + 2;
      if (centerX < margin || centerY < margin || centerX >= sim.world.size - margin || centerY >= sim.world.size - margin) continue;
      const plan: BaseBuildPlan = {
        centerX,
        centerY,
        standX,
        standY,
        aim,
        expiresAt: sim.tick + 30 * TICK_HZ
      };
      const cells = this.basePlanBlockers(sim, plan);
      if (cells.some((cell) => {
        const material = sim.world.get(cell.x, cell.y);
        return material !== MAT.EMPTY && !minerDiggable(material);
      })) continue;
      if (this.baseSiteOccupied(sim, p, centerX, centerY)) continue;
      const work = cells.reduce((sum, cell) => sum + (sim.world.get(cell.x, cell.y) === MAT.EMPTY ? 0 : 1), 0);
      if (!best || work < best.work) best = { plan, work };
      if (work === 0) break;
    }
    return best?.plan;
  }

  /** Clears the complete base collision apron, a player-width approach, and a
   * small standing pocket. This leaves both the builder and the first miner a
   * navigable route instead of sealing either against the surrounding rock. */
  private basePlanBlockers(sim: MatchSim, plan: BaseBuildPlan): { x: number; y: number }[] {
    const cfg = sim.bal.automation.base;
    // One extra cell absorbs the small positional difference while the bot
    // walks back to its saved stand point before the placement edge fires.
    const radius = cfg.siteClearanceRadiusCells + 1;
    const cells = new Map<string, { x: number; y: number }>();
    for (let y = Math.floor(plan.centerY - radius); y <= Math.ceil(plan.centerY + radius); y++) {
      for (let x = Math.floor(plan.centerX - radius); x <= Math.ceil(plan.centerX + radius); x++) {
        const dx = x + 0.5 - (plan.centerX + 0.5);
        const dy = y + 0.5 - (plan.centerY + 0.5);
        if (dx * dx + dy * dy > radius * radius) continue;
        cells.set(`${x}:${y}`, { x, y });
      }
    }
    const angle = plan.aim / 256 * Math.PI * 2;
    const tangentX = -Math.sin(angle);
    const tangentY = Math.cos(angle);
    const corridorHalfWidth = Math.ceil(sim.bal.movement.playerRadiusCells) + 1;
    for (let distance = 2; distance <= cfg.placementReachCells; distance += 0.5) {
      for (let lateral = -corridorHalfWidth; lateral <= corridorHalfWidth; lateral++) {
        const x = Math.floor(plan.standX + Math.cos(angle) * distance + tangentX * lateral);
        const y = Math.floor(plan.standY + Math.sin(angle) * distance + tangentY * lateral);
        cells.set(`${x}:${y}`, { x, y });
      }
    }
    const standRadius = sim.bal.movement.playerRadiusCells + 2;
    for (let y = Math.floor(plan.standY - standRadius); y <= Math.ceil(plan.standY + standRadius); y++) {
      for (let x = Math.floor(plan.standX - standRadius); x <= Math.ceil(plan.standX + standRadius); x++) {
        const dx = x + 0.5 - plan.standX;
        const dy = y + 0.5 - plan.standY;
        if (dx * dx + dy * dy <= standRadius * standRadius) cells.set(`${x}:${y}`, { x, y });
      }
    }
    return [...cells.values()];
  }

  private basePlanHasPermanentBlocker(sim: MatchSim, plan: BaseBuildPlan): boolean {
    return this.basePlanBlockers(sim, plan).some((cell) => {
      const material = sim.world.get(cell.x, cell.y);
      return material !== MAT.EMPTY && !minerDiggable(material);
    });
  }

  private baseSiteOccupied(sim: MatchSim, p: PlayerSim, centerX: number, centerY: number): boolean {
    const x = centerX + 0.5;
    const y = centerY + 0.5;
    const clearance = sim.bal.automation.base.collisionRadiusCells + sim.bal.movement.playerRadiusCells;
    if (sim.players.some((other) => other.id !== p.id && !other.eliminated && (other.x / FP - x) ** 2 + (other.y / FP - y) ** 2 < clearance ** 2)) return true;
    return [...sim.entities.values()].some((entity) => {
      if (entity.kind === ENT.GEM || entity.kind === ENT.REINFORCE_GEM || entity.kind === ENT.BLAST || entity.kind === ENT.FIRE) return false;
      return (entity.x / FP - x) ** 2 + (entity.y / FP - y) ** 2 < clearance ** 2;
    });
  }

  private infrastructureAmount(p: PlayerSim, resource: BuildingResource): number {
    return resource === "common" ? p.carriedGems : p[resource];
  }

  private canAffordInfrastructure(p: PlayerSim, definition: BuildingDefinition): boolean {
    return (Object.entries(definition.cost) as [BuildingResource, number][]).every(([resource, amount]) =>
      this.infrastructureAmount(p, resource) >= amount
    );
  }

  private nextInfrastructureBuilding(sim: MatchSim, p: PlayerSim): BuildingDefinition | undefined {
    const desired = new Map<number, number>([
      [BUILDING.COAL_GENERATOR, 1],
      [BUILDING.POWER_RELAY, 2],
      [BUILDING.BATTERY_BANK, 1],
      [BUILDING.ORE_REFINERY, 1],
      [BUILDING.DIGGER_BARRACKS, 1],
      [BUILDING.DEEP_DRILL, 2],
      [BUILDING.TRACK_DEPOT, 1],
      [BUILDING.DRILL_FORGE, 2],
      [BUILDING.OXYGEN_RECYCLER, 1],
      [BUILDING.SENTRY_GUN, 2],
      [BUILDING.REPAIR_DEPOT, 1],
      [BUILDING.SHIELD_PYLON, 1],
      [BUILDING.ARC_COIL, 1],
      [BUILDING.FLOODLIGHT, 1]
    ]);
    for (const kind of desired.keys()) {
      const definition = buildingDefinition(kind);
      if (!definition || !buildingPrerequisiteMet(p.buildingBlueprints, definition)) continue;
      const count = [...sim.entities.values()].filter((entity) =>
        entity.kind === ENT.BUILDING && entity.ownerId === p.id && entity.buildingKind === kind
      ).length;
      if (count < (desired.get(kind) ?? 1)) return definition;
    }
    return undefined;
  }

  private stepInfrastructureConstruction(sim: MatchSim, p: PlayerSim, frame: InputFrame, definition: BuildingDefinition): void {
    let plan = this.infrastructureBuildPlans.get(p.id);
    if (plan && (plan.kind !== definition.kind || sim.tick >= plan.expiresAt || this.infrastructurePlanHasPermanentBlocker(sim, plan, definition))) {
      this.infrastructureBuildPlans.delete(p.id);
      plan = undefined;
    }
    if (!plan) {
      plan = this.findInfrastructureBuildPlan(sim, p, definition);
      if (plan) this.infrastructureBuildPlans.set(p.id, plan);
    }
    if (!plan) {
      if (p.pickDurability > 0) {
        frame.slot = 2;
        frame.buttons |= BTN.PRIMARY;
        this.moveTowardBot(sim, p, frame);
      } else this.useBombExcavation(sim, p, frame);
      return;
    }

    const blockers = this.infrastructurePlanBlockers(sim, plan, definition)
      .filter((cell) => sim.world.get(cell.x, cell.y) !== MAT.EMPTY)
      .sort((a, b) => (a.x + 0.5 - p.x / FP) ** 2 + (a.y + 0.5 - p.y / FP) ** 2 -
        ((b.x + 0.5 - p.x / FP) ** 2 + (b.y + 0.5 - p.y / FP) ** 2));
    if (blockers.length > 0) {
      const target = { x: blockers[0].x + 0.5, y: blockers[0].y + 0.5 };
      if (p.pickDurability > 0) {
        frame.slot = 2;
        frame.buttons |= BTN.PRIMARY;
        this.aimAt(frame, p, target.x, target.y);
        this.moveToward(frame, p.x / FP, p.y / FP, target.x, target.y);
      } else this.useBombExcavation(sim, p, frame, target);
      return;
    }
    if (this.infrastructureSiteOccupied(sim, p, plan.centerX, plan.centerY, definition)) {
      this.infrastructureBuildPlans.delete(p.id);
      return;
    }
    const px = p.x / FP;
    const py = p.y / FP;
    if (Math.hypot(plan.standX - px, plan.standY - py) > 0.6) {
      this.moveToward(frame, px, py, plan.standX, plan.standY);
      if (Math.hypot(plan.standX - px, plan.standY - py) > 5) frame.buttons |= BTN.SPRINT;
      return;
    }
    frame.slot = definition.slot;
    frame.aim = plan.aim;
    frame.buttons |= BTN.PRIMARY;
  }

  private findInfrastructureBuildPlan(sim: MatchSim, p: PlayerSim, definition: BuildingDefinition): InfrastructureBuildPlan | undefined {
    const reach = sim.bal.automation.infrastructure.placementReachCells;
    const standX = p.x / FP;
    const standY = p.y / FP;
    const directions = [0, 64, 128, 192, 32, 96, 160, 224, 16, 48, 80, 112, 144, 176, 208, 240];
    const offset = (p.id * 3 + definition.kind * 5 + Math.floor(sim.tick / (8 * TICK_HZ))) % directions.length;
    let best: { plan: InfrastructureBuildPlan; work: number } | undefined;
    for (let attempt = 0; attempt < directions.length; attempt++) {
      const aim = directions[(attempt + offset) % directions.length];
      const angle = aim / 256 * Math.PI * 2;
      const centerX = Math.floor(standX + Math.cos(angle) * reach);
      const centerY = Math.floor(standY + Math.sin(angle) * reach);
      const margin = Math.ceil(definition.footprintRadius) + 2;
      if (centerX < margin || centerY < margin || centerX >= sim.world.size - margin || centerY >= sim.world.size - margin) continue;
      if (!this.botSiteInGrid(sim, p.id, centerX + 0.5, centerY + 0.5)) continue;
      const candidate: InfrastructureBuildPlan = { kind: definition.kind, centerX, centerY, standX, standY, aim, expiresAt: sim.tick + 25 * TICK_HZ };
      const cells = this.infrastructurePlanBlockers(sim, candidate, definition);
      if (cells.some((cell) => sim.world.get(cell.x, cell.y) !== MAT.EMPTY && !minerDiggable(sim.world.get(cell.x, cell.y)))) continue;
      if (this.infrastructureSiteOccupied(sim, p, centerX, centerY, definition)) continue;
      const work = cells.reduce((sum, cell) => sum + (sim.world.get(cell.x, cell.y) === MAT.EMPTY ? 0 : 1), 0);
      if (!best || work < best.work) best = { plan: candidate, work };
      if (work === 0) break;
    }
    return best?.plan;
  }

  private infrastructurePlanBlockers(sim: MatchSim, plan: InfrastructureBuildPlan, definition: BuildingDefinition): { x: number; y: number }[] {
    const radius = definition.footprintRadius + 0.7;
    const cells = new Map<string, { x: number; y: number }>();
    for (let y = Math.floor(plan.centerY - radius); y <= Math.ceil(plan.centerY + radius); y++) {
      for (let x = Math.floor(plan.centerX - radius); x <= Math.ceil(plan.centerX + radius); x++) {
        const dx = x + 0.5 - (plan.centerX + 0.5);
        const dy = y + 0.5 - (plan.centerY + 0.5);
        if (dx * dx + dy * dy <= radius * radius) cells.set(`${x}:${y}`, { x, y });
      }
    }
    const angle = plan.aim / 256 * Math.PI * 2;
    for (let distance = 2; distance <= sim.bal.automation.infrastructure.placementReachCells; distance += 0.5) {
      const x = Math.floor(plan.standX + Math.cos(angle) * distance);
      const y = Math.floor(plan.standY + Math.sin(angle) * distance);
      cells.set(`${x}:${y}`, { x, y });
    }
    return [...cells.values()];
  }

  private infrastructurePlanHasPermanentBlocker(sim: MatchSim, plan: InfrastructureBuildPlan, definition: BuildingDefinition): boolean {
    return this.infrastructurePlanBlockers(sim, plan, definition).some((cell) => {
      const material = sim.world.get(cell.x, cell.y);
      return material !== MAT.EMPTY && !minerDiggable(material);
    });
  }

  private infrastructureSiteOccupied(sim: MatchSim, p: PlayerSim, centerX: number, centerY: number, definition: BuildingDefinition): boolean {
    const x = centerX + 0.5;
    const y = centerY + 0.5;
    if (sim.players.some((other) => other.id !== p.id && !other.eliminated &&
      (other.x / FP - x) ** 2 + (other.y / FP - y) ** 2 < (definition.collisionRadius + sim.bal.movement.playerRadiusCells + 0.5) ** 2)) return true;
    return [...sim.entities.values()].some((entity) => {
      const otherRadius = entity.kind === ENT.MINING_BASE
        ? sim.bal.automation.base.collisionRadiusCells
        : entity.kind === ENT.BUILDING ? buildingDefinition(entity.buildingKind ?? -1)?.collisionRadius ?? 1.5 : 1;
      return (entity.x / FP - x) ** 2 + (entity.y / FP - y) ** 2 < (definition.collisionRadius + otherRadius + 0.5) ** 2;
    });
  }

  private botSiteInGrid(sim: MatchSim, ownerId: number, x: number, y: number): boolean {
    const cfg = sim.bal.automation.infrastructure;
    for (const entity of sim.entities.values()) {
      if (entity.ownerId !== ownerId) continue;
      const d2 = (entity.x / FP - x) ** 2 + (entity.y / FP - y) ** 2;
      if (entity.kind === ENT.MINING_BASE && d2 <= cfg.baseGridRadiusCells ** 2) return true;
      if (entity.kind === ENT.BUILDING && entity.buildingKind === BUILDING.POWER_RELAY &&
        ((entity.flags ?? 0) & BUILDING_FLAG.CONNECTED) !== 0 && d2 <= cfg.relayLinkRadiusCells ** 2) return true;
    }
    return false;
  }

  private weightedObjective(sim: MatchSim, p: PlayerSim): BotObjective | null {
    const remembered = this.objectives.get(p.id);
    if (remembered && sim.tick < remembered.untilTick && this.objectiveValid(sim, remembered.value)) return remembered.value;

    const px = p.x / FP;
    const py = p.y / FP;
    // Embedded deposits still need a finite search window because they are
    // sensed through terrain shadows. Direct LOS to actors and loose items is
    // deliberately uncapped, matching player visibility.
    const resourceSense = sim.resourceSenseRadiusCells(p);
    const resourceSense2 = resourceSense * resourceSense;
    const featureLevels = [BOMB_FEATURE.WIDE, BOMB_FEATURE.DIAGONAL, BOMB_FEATURE.TWIN, BOMB_FEATURE.REMOTE, BOMB_FEATURE.SHIELD, BOMB_FEATURE.PROSPECTOR]
      .filter((feature) => (p.bombFeatures & feature) !== 0).length;
    const installed = p.bombSpeedLevel + p.bombRangeLevel + p.bombWidthLevel + p.bombCapacityLevel +
      p.visionLevel + p.moveSpeedLevel + p.healthLevel + featureLevels;
    const earlyEconomy = sim.tick < 90 * TICK_HZ && (p.pickDurability <= 0 || installed < 4);
    const demand = this.materialDemand(sim, p);
    const candidates: BotObjective[] = [];

    // Loose gems are immediately collectible. Only LOS-visible entities count,
    // matching the authoritative entity visibility rules.
    const loose = [...sim.entities.values()].filter((entity) => {
      if (entity.kind !== ENT.GEM && entity.kind !== ENT.REINFORCE_GEM) return false;
      const x = entity.x / FP;
      const y = entity.y / FP;
      return hasLineOfSight(sim.world, px, py, x, y);
    });
    for (const gem of loose) {
      const x = gem.x / FP;
      const y = gem.y / FP;
      const distance = Math.hypot(x - px, y - py);
      const cluster = loose.filter((other) => dist2(gem, other) <= (10 * FP) ** 2).length;
      const common = gem.kind === ENT.GEM;
      // A visible, already-exposed common gem is the strongest opening move:
      // it costs no bomb, oxygen, or excavation time. Rich loose piles still
      // compound through the cluster term below.
      const base = common ? (earlyEconomy ? 2200 : 270) : (!p.wallUnlocked ? 900 : 220);
      candidates.push({
        kind: "loose-gem",
        score: base + (cluster - 1) * 80 - distance * 5,
        x,
        y,
        targetId: gem.id,
        material: common ? MAT.GEM : MAT.REINFORCE_GEM
      });
    }

    // Embedded ore is sensed through the shadow fringe rather than direct LOS.
    // Nearby same-material cells form a density-weighted cluster.
    const deposits: { x: number; y: number; mat: number; distance: number }[] = [];
    const x0 = Math.max(0, Math.floor(px - resourceSense));
    const y0 = Math.max(0, Math.floor(py - resourceSense));
    const x1 = Math.min(sim.world.size - 1, Math.ceil(px + resourceSense));
    const y1 = Math.min(sim.world.size - 1, Math.ceil(py + resourceSense));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - px;
        const dy = y + 0.5 - py;
        const d2 = dx * dx + dy * dy;
        if (d2 > resourceSense2) continue;
        const mat = sim.world.get(x, y);
        if (!isBotResource(mat)) continue;
        if (!this.hasExcavationLine(sim, px, py, x + 0.5, y + 0.5)) continue;
        deposits.push({ x: x + 0.5, y: y + 0.5, mat, distance: Math.sqrt(d2) });
      }
    }
    const grouped = new Set<number>();
    for (let start = 0; start < deposits.length; start++) {
      if (grouped.has(start)) continue;
      grouped.add(start);
      const indices = [start];
      for (let cursor = 0; cursor < indices.length; cursor++) {
        const current = deposits[indices[cursor]];
        for (let otherIndex = 0; otherIndex < deposits.length; otherIndex++) {
          if (grouped.has(otherIndex)) continue;
          const other = deposits[otherIndex];
          if (other.mat !== current.mat || (other.x - current.x) ** 2 + (other.y - current.y) ** 2 > 36) continue;
          grouped.add(otherIndex);
          indices.push(otherIndex);
        }
      }
      const cluster = indices.map((index) => deposits[index]);
      const target = this.bestClusterTunnel(px, py, cluster, sim.bal.dig.brushRadiusCells);
      const nearestDistance = Math.min(...cluster.map((deposit) => deposit.distance));
      const material = cluster[0].mat;
      const base = material === MAT.GEM
        ? (earlyEconomy ? 620 : 210)
        : material === MAT.REINFORCE_GEM
          ? (!p.wallUnlocked ? 430 : 145)
          : 175 + (demand.get(material) ?? 0);
      candidates.push({
        kind: "deposit",
        score: base + Math.min(18, cluster.length - 1) * 50 + Math.min(14, target.yield - 1) * 35 - nearestDistance * 5,
        x: target.x,
        y: target.y,
        material
      });
    }

    // Combat, treasure, and resource opportunities now share the same scale.
    // Very close threats still win; early distant aggression loses to economy.
    for (const other of sim.players) {
      if (other.id === p.id || other.eliminated) continue;
      const x = other.x / FP;
      const y = other.y / FP;
      const distance = Math.hypot(x - px, y - py);
      if (!hasLineOfSight(sim.world, px, py, x, y)) continue;
      // A genuinely visible rival always takes precedence over economy. The
      // LOS check above is intentionally strict so bots do not react through
      // rock, while an open corridor no longer has an arbitrary range cutoff.
      candidates.push({ kind: "opponent", score: 20_000 - distance * 6, x, y, targetId: other.id });
    }

    const guardians = [...sim.entities.values()].filter((entity) => entity.kind === ENT.GUARDIAN);
    for (const guardian of guardians) {
      const x = guardian.x / FP;
      const y = guardian.y / FP;
      const distance = Math.hypot(x - px, y - py);
      const visible = hasLineOfSight(sim.world, px, py, x, y);
      if (!visible && (distance > resourceSense || !this.hasExcavationLine(sim, px, py, x, y))) continue;
      // A visible guardian inside its pursuit radius is an immediate combat
      // threat. A sealed guardian remains a lower-priority breach objective.
      const score = visible && distance <= sim.bal.treasure.guardianAggroRadiusCells
        ? 15_000 - distance * 12
        : 330 - distance * 5;
      candidates.push({ kind: "guardian", score, x, y, targetId: guardian.id });
    }

    for (const chest of sim.entities.values()) {
      if (chest.kind !== ENT.CHEST || guardians.some((guardian) => guardian.ownerId === chest.id)) continue;
      const x = chest.x / FP;
      const y = chest.y / FP;
      const distance = Math.hypot(x - px, y - py);
      if (!hasLineOfSight(sim.world, px, py, x, y)) continue;
      const arsenal = p.dynamite + p.c4 + p.clusterBombs + p.napalm + p.nukes + p.turretKits;
      candidates.push({ kind: "chest", score: 390 + (arsenal === 0 ? 130 : 0) - distance * 4, x, y, targetId: chest.id });
    }

    const selected = candidates.sort((a, b) => b.score - a.score)[0] ?? null;
    if (selected) this.objectives.set(p.id, { value: selected, untilTick: sim.tick + 9 });
    else this.objectives.delete(p.id);
    return selected;
  }

  /** Select the deep endpoint whose ray passes through the most cells in the
   * cluster. Keeping this aim line stable makes the pick cut a forward tunnel
   * through a vein instead of repeatedly turning toward its nearest edge. */
  private bestClusterTunnel(
    px: number,
    py: number,
    cluster: { x: number; y: number }[],
    brushRadius: number
  ): { x: number; y: number; yield: number } {
    let best = { x: cluster[0].x, y: cluster[0].y, yield: 1 };
    let bestScore = -Infinity;
    for (const endpoint of cluster) {
      const dx = endpoint.x - px;
      const dy = endpoint.y - py;
      const distance = Math.hypot(dx, dy);
      if (distance === 0) continue;
      const ux = dx / distance;
      const uy = dy / distance;
      let tunnelYield = 0;
      for (const cell of cluster) {
        const rx = cell.x - px;
        const ry = cell.y - py;
        const forward = rx * ux + ry * uy;
        const lateral = Math.abs(rx * uy - ry * ux);
        if (forward >= 0 && forward <= distance + brushRadius && lateral <= brushRadius) tunnelYield++;
      }
      const score = tunnelYield * 10_000 + distance;
      if (score > bestScore) {
        bestScore = score;
        best = { x: endpoint.x, y: endpoint.y, yield: tunnelYield };
      }
    }
    return best;
  }

  private seekOxygen(sim: MatchSim, p: PlayerSim, frame: InputFrame): boolean {
    const maximum = sim.bal.oxygen.emergencySeconds;
    if (p.oxygen <= maximum * 0.85) this.seekingOxygen.add(p.id);
    if (!this.seekingOxygen.has(p.id)) return false;
    if (p.oxygen >= maximum * 0.92) {
      this.seekingOxygen.delete(p.id);
      this.oxygenTargets.delete(p.id);
      return false;
    }

    const px = p.x / FP;
    const py = p.y / FP;
    if (sim.isVentilatedCell(Math.floor(px), Math.floor(py))) {
      // Wait in breathable terrain until nearly full. Hysteresis prevents a
      // bot from bouncing between its resource target and the vent boundary.
      this.oxygenTargets.delete(p.id);
      return true;
    }

    let target = this.oxygenTargets.get(p.id) ?? null;
    if (target && (sim.tick >= target.untilTick || !this.hasExcavationLine(sim, px, py, target.x, target.y))) {
      this.oxygenTargets.delete(p.id);
      target = null;
    }
    if (!target) {
      let bestDistance = Infinity;
      for (const vent of sim.map.ventCells) {
        const x = vent.x + 0.5;
        const y = vent.y + 0.5;
        const distance = Math.hypot(x - px, y - py);
        if (distance >= bestDistance || !this.hasExcavationLine(sim, px, py, x, y)) continue;
        bestDistance = distance;
        target = { x, y, untilTick: sim.tick + 45 * TICK_HZ };
      }
      if (target) this.oxygenTargets.set(p.id, target);
    }
    if (!target) return false;

    this.aimAt(frame, p, target.x, target.y);
    if (p.pickDurability > 0) {
      frame.slot = 2;
      frame.buttons |= BTN.PRIMARY | BTN.SPRINT;
      this.moveToward(frame, px, py, target.x, target.y);
    } else {
      this.useBombExcavation(sim, p, frame, target);
    }
    return true;
  }

  /** Resource blocks are visible through the radial daylight mask, but a bot
   * must not commit to one through an indestructible barrier. Soft/dense rock
   * is a valid excavation route; bedrock and constructed rigid walls are not. */
  private hasExcavationLine(sim: MatchSim, x0: number, y0: number, x1: number, y1: number): boolean {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const distance = Math.hypot(dx, dy);
    if (distance < 1) return true;
    const steps = Math.ceil(distance * 2);
    for (let step = 1; step < steps; step++) {
      const t = step / steps;
      const mat = sim.world.get(Math.floor(x0 + dx * t), Math.floor(y0 + dy * t));
      if (mat === MAT.BEDROCK || mat === MAT.REINFORCE) return false;
    }
    return true;
  }

  private objectiveValid(sim: MatchSim, objective: BotObjective): boolean {
    if (objective.kind === "deposit") {
      return sim.world.get(Math.floor(objective.x), Math.floor(objective.y)) === objective.material;
    }
    if (objective.kind === "opponent") {
      const target = objective.targetId === undefined ? undefined : sim.players[objective.targetId];
      return Boolean(target && !target.eliminated);
    }
    const target = objective.targetId === undefined ? undefined : sim.entities.get(objective.targetId);
    if (!target) return false;
    if (objective.kind === "loose-gem") return target.kind === ENT.GEM || target.kind === ENT.REINFORCE_GEM;
    if (objective.kind === "guardian") return target.kind === ENT.GUARDIAN;
    return target.kind === ENT.CHEST;
  }

  private materialDemand(sim: MatchSim, p: PlayerSim): Map<number, number> {
    const amounts: Record<CraftResource, number> = {
      common: p.carriedGems,
      gold: p.gold,
      fossils: p.fossils,
      copper: p.copper,
      iron: p.iron,
      platinum: p.platinum,
      coal: p.coal
    };
    const demand = new Map<number, number>();
    if (p.infrastructureUnlocked && p.coal < 12) demand.set(MAT.COAL, 220 + (12 - p.coal) * 18);
    const nextBuilding = this.nextInfrastructureBuilding(sim, p);
    if (nextBuilding) {
      for (const [resource, cost] of Object.entries(nextBuilding.cost) as [BuildingResource, number][]) {
        const amount = this.infrastructureAmount(p, resource);
        const missing = Math.max(0, cost - amount);
        if (missing <= 0) continue;
        const material = resource === "common" ? MAT.GEM : resource === "gold" ? MAT.GOLD : resource === "copper" ? MAT.COPPER :
          resource === "iron" ? MAT.IRON : resource === "platinum" ? MAT.PLATINUM : MAT.COAL;
        demand.set(material, (demand.get(material) ?? 0) + 90 + missing * 22);
      }
    }
    for (const quote of bombUpgradeQuotes(p, sim.bal)) {
      if (quote.maxed) continue;
      for (const [resource, cost] of Object.entries(quote.cost) as [CraftResource, number][]) {
        const missing = Math.max(0, cost - amounts[resource]);
        if (missing <= 0) continue;
        const mat = materialForResource(resource);
        demand.set(mat, (demand.get(mat) ?? 0) + 18 + missing * 12);
      }
    }
    // Accessible weapon branches compete for attention based on the ore the
    // bot is actually missing. This makes its arsenal emerge from nearby finds
    // instead of waiting for one universal common-gem bank.
    for (const tech of WEAPON_TECH) {
      if (hasWeaponBlueprint(p.weaponBlueprints, tech.id)) continue;
      if (tech.prerequisite && !hasWeaponBlueprint(p.weaponBlueprints, tech.prerequisite)) continue;
      for (const [resource, cost] of Object.entries(tech.unlockCost) as [CraftResource, number][]) {
        const missing = Math.max(0, cost - amounts[resource]);
        if (missing <= 0) continue;
        const mat = materialForResource(resource);
        demand.set(mat, (demand.get(mat) ?? 0) + 34 + missing * 14);
      }
    }
    return demand;
  }

  private actOnObjective(sim: MatchSim, p: PlayerSim, frame: InputFrame, objective: BotObjective): boolean {
    const px = p.x / FP;
    const py = p.y / FP;
    const distance = Math.hypot(objective.x - px, objective.y - py);
    this.aimAt(frame, p, objective.x, objective.y);

    if (objective.kind === "loose-gem") {
      this.moveToward(frame, px, py, objective.x, objective.y);
      if (distance > 6) frame.buttons |= BTN.SPRINT;
      return true;
    }
    if (objective.kind === "deposit") {
      if (p.pickDurability > 0) {
        frame.slot = 2;
        frame.buttons |= BTN.PRIMARY;
        this.moveToward(frame, px, py, objective.x, objective.y);
      } else {
        this.useBombExcavation(sim, p, frame, objective);
      }
      return true;
    }
    if (objective.kind === "chest") {
      if (distance < sim.bal.treasure.chestInteractRangeCells) {
        // Treasure is collected automatically while crossing the unsealed chest.
        this.moveToward(frame, px, py, objective.x, objective.y);
      } else if (p.pickDurability > 0) {
        frame.slot = 2;
        frame.buttons |= BTN.PRIMARY;
        this.moveToward(frame, px, py, objective.x, objective.y);
      } else {
        this.useBombExcavation(sim, p, frame, objective);
      }
      return true;
    }

    if (objective.kind === "guardian") return this.actOnGuardian(sim, p, frame, objective);

    const targetExists = objective.targetId !== undefined && !sim.players[objective.targetId]?.eliminated;
    if (!targetExists) return false;
    const attackRange = sim.bal.items.bomb.blastRangeCells + sim.bal.items.bomb.blastHalfWidthCells;
    const ownedTurrets = [...sim.entities.values()].filter((entity) => entity.kind === ENT.TURRET && entity.ownerId === p.id).length;
    if (objective.kind === "opponent" && p.turretKits > 0 && ownedTurrets === 0 && distance <= sim.bal.specialWeapons.turret.rangeCells) {
      frame.slot = 9;
      frame.buttons |= BTN.PRIMARY;
      return true;
    }
    if (distance <= attackRange) {
      frame.slot = this.offensiveSlot(p);
      frame.buttons |= BTN.PRIMARY | BTN.SPRINT;
      this.moveToward(frame, px, py, 2 * px - objective.x, 2 * py - objective.y);
      return true;
    }
    this.moveToward(frame, px, py, objective.x, objective.y);
    if (p.pickDurability > 0) {
      frame.slot = 2;
      frame.buttons |= BTN.PRIMARY;
    }
    if (distance > 14) frame.buttons |= BTN.SPRINT;
    return true;
  }

  private actOnGuardian(sim: MatchSim, p: PlayerSim, frame: InputFrame, objective: BotObjective): boolean {
    const guardian = objective.targetId === undefined ? undefined : sim.entities.get(objective.targetId);
    if (!guardian || guardian.kind !== ENT.GUARDIAN) return false;
    const px = p.x / FP;
    const py = p.y / FP;
    const gx = guardian.x / FP;
    const gy = guardian.y / FP;
    const distance = Math.hypot(gx - px, gy - py);
    this.aimAt(frame, p, gx, gy);

    // Ruin shells and fossil pillars are breached with an excavation bomb.
    // This preserves the opening instead of walking the bot blindly into the
    // chamber with its pick exposed.
    if (!hasLineOfSight(sim.world, px, py, gx, gy)) {
      this.useBombExcavation(sim, p, frame, { x: gx, y: gy });
      return true;
    }

    const dangerRange = sim.bal.treasure.guardianAttackRangeCells + 3.5;
    if (distance < dangerRange) {
      const goal = this.findGuardianEvasionGoal(sim, p, guardian, 14);
      this.moveToward(frame, px, py, goal.x, goal.y);
      frame.buttons |= BTN.SPRINT;
      return true;
    }

    const profile = this.standardBombProfile(sim, p);
    if (sim.ownedBombs(p) === 0 && this.guardianInBlastLane(px, py, gx, gy, profile.range, profile.halfWidth)) {
      frame.slot = 1;
      frame.buttons |= BTN.PRIMARY;
      this.guardianTraps.set(p.id, {
        guardianId: guardian.id,
        bombId: -1,
        orbitDirection: this.rng.chance(0.5) ? -1 : 1,
        orbitAngle: Number.NaN,
        expiresAt: sim.tick + profile.fuseTicks + profile.range + sim.bal.items.bomb.blastVisualTicks + 20
      });
      return true;
    }

    const firing = this.findGuardianFiringPosition(sim, p, guardian, profile.range, profile.halfWidth);
    if (firing) {
      this.moveToward(frame, px, py, firing.x, firing.y);
      frame.buttons |= BTN.SPRINT;
    } else {
      this.useBombExcavation(sim, p, frame, { x: gx, y: gy });
    }
    return true;
  }

  private stepGuardianTrap(sim: MatchSim, p: PlayerSim, frame: InputFrame): boolean {
    const plan = this.guardianTraps.get(p.id);
    if (!plan) return false;
    const guardian = sim.entities.get(plan.guardianId);
    if (!guardian || guardian.kind !== ENT.GUARDIAN || sim.tick > plan.expiresAt) {
      this.guardianTraps.delete(p.id);
      return false;
    }
    let bomb = plan.bombId >= 0 ? sim.entities.get(plan.bombId) : undefined;
    if (!bomb) {
      bomb = [...sim.entities.values()]
        .filter((entity) => entity.kind === ENT.BOMB && entity.ownerId === p.id)
        .sort((a, b) => dist2(p, a) - dist2(p, b))[0];
      if (bomb) plan.bombId = bomb.id;
    }
    if (!bomb || bomb.kind !== ENT.BOMB) {
      this.guardianTraps.delete(p.id);
      return false;
    }

    const px = p.x / FP;
    const py = p.y / FP;
    if (!Number.isFinite(plan.orbitAngle)) {
      plan.orbitAngle = Math.atan2(guardian.y - bomb.y, guardian.x - bomb.x) + Math.PI;
    }
    const remaining = bomb.cooldownEnd - sim.tick;
    const escapeTicks = 9;
    const guardianDistance = Math.hypot(px - guardian.x / FP, py - guardian.y / FP);
    if (guardianDistance < sim.bal.treasure.guardianAttackRangeCells + 4) {
      const urgent = this.findGuardianEvasionGoal(sim, p, guardian, 14);
      this.aimAt(frame, p, guardian.x / FP, guardian.y / FP);
      this.moveToward(frame, px, py, urgent.x, urgent.y);
      frame.buttons |= BTN.SPRINT;
      return true;
    }
    if (remaining <= escapeTicks) {
      const goal = this.findEscapeGoal(sim, p, bomb);
      const range = bomb.blastRange ?? sim.bal.items.bomb.blastRangeCells;
      const stepTicks = bomb.blastStepTicks ?? sim.bal.items.bomb.blastStepTicks;
      this.escapeGoals.set(p.id, {
        hazardId: bomb.id,
        hazard: this.escapeHazard(bomb),
        x: goal.x,
        y: goal.y,
        untilTick: bomb.cooldownEnd + range * stepTicks + sim.bal.items.bomb.blastVisualTicks + 3,
        repathAt: sim.tick + 4
      });
      this.guardianTraps.delete(p.id);
      this.moveToward(frame, px, py, goal.x, goal.y);
      frame.buttons |= BTN.SPRINT;
      return true;
    }

    plan.orbitAngle += plan.orbitDirection * 0.14;
    const goal = this.findGuardianBaitGoal(sim, p, guardian, bomb, plan.orbitAngle);
    this.aimAt(frame, p, guardian.x / FP, guardian.y / FP);
    this.moveToward(frame, px, py, goal.x, goal.y);
    frame.buttons |= BTN.SPRINT;
    return true;
  }

  private standardBombProfile(sim: MatchSim, p: PlayerSim): { fuseTicks: number; range: number; halfWidth: number } {
    const bomb = sim.bal.items.bomb;
    const upgrades = sim.bal.bombUpgrades;
    return {
      fuseTicks: Math.max(
        Math.min(bomb.fuseTicks, upgrades.speed.minFuseTicks),
        bomb.fuseTicks - p.bombSpeedLevel * upgrades.speed.fuseReductionTicks
      ),
      range: bomb.blastRangeCells + p.bombRangeLevel * upgrades.range.rangePerLevelCells,
      halfWidth: bomb.blastHalfWidthCells + ((p.bombFeatures & BOMB_FEATURE.WIDE) !== 0 ? 1 : 0) + p.bombWidthLevel
    };
  }

  private guardianInBlastLane(px: number, py: number, gx: number, gy: number, range: number, halfWidth: number): boolean {
    const dx = Math.abs(gx - px);
    const dy = Math.abs(gy - py);
    return (dx <= range - 0.5 && dy <= halfWidth - 0.25) || (dy <= range - 0.5 && dx <= halfWidth - 0.25);
  }

  private findGuardianFiringPosition(
    sim: MatchSim,
    p: PlayerSim,
    guardian: { x: number; y: number },
    range: number,
    halfWidth: number
  ): { x: number; y: number } | null {
    const px = p.x / FP;
    const py = p.y / FP;
    const gx = guardian.x / FP;
    const gy = guardian.y / FP;
    const standOff = clamp(range - 1, sim.bal.treasure.guardianAttackRangeCells + 4, 10);
    const candidates = [
      { x: gx - standOff, y: gy }, { x: gx + standOff, y: gy },
      { x: gx, y: gy - standOff }, { x: gx, y: gy + standOff }
    ].filter((candidate) =>
      this.straightPathOpen(sim, px, py, candidate.x, candidate.y) &&
      this.guardianInBlastLane(candidate.x, candidate.y, gx, gy, range, halfWidth)
    );
    return candidates.sort((a, b) =>
      (a.x - px) ** 2 + (a.y - py) ** 2 - ((b.x - px) ** 2 + (b.y - py) ** 2)
    )[0] ?? null;
  }

  private findGuardianBaitGoal(
    sim: MatchSim,
    p: PlayerSim,
    guardian: { x: number; y: number },
    bomb: { x: number; y: number; blastRange?: number },
    preferredAngle: number
  ): { x: number; y: number } {
    const px = p.x / FP;
    const py = p.y / FP;
    const bx = bomb.x / FP;
    const by = bomb.y / FP;
    const gx = guardian.x / FP;
    const gy = guardian.y / FP;
    const radius = clamp((bomb.blastRange ?? sim.bal.items.bomb.blastRangeCells) * 0.58, 4.5, 7);
    let best = { x: px, y: py };
    let bestScore = -Infinity;
    for (let index = 0; index < 24; index++) {
      const angle = preferredAngle + (index - 12) * 0.1;
      const x = bx + Math.cos(angle) * radius;
      const y = by + Math.sin(angle) * radius;
      if (!this.straightPathOpen(sim, px, py, x, y)) continue;
      const guardianDistance = Math.hypot(x - gx, y - gy);
      const preferredDelta = Math.abs(Math.atan2(Math.sin(angle - preferredAngle), Math.cos(angle - preferredAngle)));
      const movement = Math.hypot(x - px, y - py);
      const score = guardianDistance * 120 - preferredDelta * 25 + Math.min(4, movement) * 8;
      if (score > bestScore) {
        bestScore = score;
        best = { x, y };
      }
    }
    if (Math.hypot(best.x - px, best.y - py) < 0.8) {
      return this.findGuardianEvasionGoal(sim, p, guardian, 9);
    }
    return best;
  }

  private findGuardianEvasionGoal(
    sim: MatchSim,
    p: PlayerSim,
    guardian: { x: number; y: number },
    distance: number
  ): { x: number; y: number } {
    const px = p.x / FP;
    const py = p.y / FP;
    const gx = guardian.x / FP;
    const gy = guardian.y / FP;
    let best = { x: px, y: py };
    let bestScore = Math.hypot(px - gx, py - gy);
    for (let ray = 0; ray < 32; ray++) {
      const angle = ray / 32 * Math.PI * 2;
      for (let step = 2; step <= distance; step += 1) {
        const x = px + Math.cos(angle) * step;
        const y = py + Math.sin(angle) * step;
        if (!this.straightPathOpen(sim, px, py, x, y)) break;
        const score = Math.hypot(x - gx, y - gy) + step * 0.05;
        if (score > bestScore) {
          bestScore = score;
          best = { x, y };
        }
      }
    }
    return best;
  }

  private straightPathOpen(sim: MatchSim, x0: number, y0: number, x1: number, y1: number): boolean {
    const radiusFp = Math.round(sim.bal.movement.playerRadiusCells * FP);
    const distance = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(distance / 0.7));
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      if (circleCollides(sim.world, Math.round((x0 + (x1 - x0) * t) * FP), Math.round((y0 + (y1 - y0) * t) * FP), radiusFp)) return false;
    }
    return true;
  }

  private escapeHazard(hazard: {
    id?: number;
    x: number;
    y: number;
    weaponKind?: number;
    aim?: number;
    blastRange?: number;
    blastHalfWidth?: number;
    blastNoiseFringe?: number;
    blastWobble?: number;
    blastFeatures?: number;
  }): BotEscapeGoal["hazard"] {
    return {
      x: hazard.x,
      y: hazard.y,
      shapeSeed: hazard.id,
      weaponKind: hazard.weaponKind,
      aim: hazard.aim,
      blastRange: hazard.blastRange,
      blastHalfWidth: hazard.blastHalfWidth,
      blastNoiseFringe: hazard.blastNoiseFringe,
      blastWobble: hazard.blastWobble,
      blastFeatures: hazard.blastFeatures
    };
  }

  private offensiveSlot(p: PlayerSim): number {
    if (p.dynamite > 0) return 4;
    if (p.clusterBombs > 0) return 6;
    if (p.napalm > 0) return 7;
    if (p.nukes > 0 && (p.bombFeatures & BOMB_FEATURE.SHIELD) !== 0) return 8;
    if (p.c4 > 0) return 5;
    return 1;
  }

  private useBombExcavation(sim: MatchSim, p: PlayerSim, frame: InputFrame, preferred?: { x: number; y: number }): void {
    const px = p.x / FP;
    const py = p.y / FP;
    const rock = this.nearestBombTarget(sim, p, sim.bal.items.bomb.blastRangeCells, preferred);
    if (sim.ownedBombs(p) > 0) {
      if (rock) this.moveToward(frame, px, py, 2 * px - rock.x, 2 * py - rock.y);
      else if (preferred) this.moveToward(frame, px, py, preferred.x, preferred.y);
      else this.moveTowardBot(sim, p, frame);
      frame.buttons |= BTN.SPRINT;
      return;
    }
    if (rock) {
      const distance = Math.hypot(rock.x - px, rock.y - py);
      const plantStandOff = sim.bal.movement.playerRadiusCells + 1.5;
      this.aimAt(frame, p, rock.x, rock.y);
      if (distance > plantStandOff) {
        // Approach the actual rock face before planting. Dropping as soon as a
        // cell entered maximum blast range frequently left diagonal/noisy
        // terrain outside the cross and wasted the payload.
        this.moveToward(frame, px, py, rock.x, rock.y);
        frame.buttons |= BTN.SPRINT;
        return;
      }
      frame.slot = 1;
      frame.buttons |= BTN.PRIMARY;
      return;
    }
    if (preferred) {
      this.aimAt(frame, p, preferred.x, preferred.y);
      this.moveToward(frame, px, py, preferred.x, preferred.y);
      frame.buttons |= BTN.SPRINT;
    } else {
      this.moveTowardBot(sim, p, frame);
    }
  }

  private moveTowardBot(sim: MatchSim, p: PlayerSim, frame: InputFrame, slow = false): void {
    let goal = this.goals.get(p.id);
    const w = sim.world;
    const px = p.x / FP;
    const py = p.y / FP;
    if (!goal || sim.tick >= goal.untilTick) {
      let bestX = px;
      let bestY = py;
      let bestD = 1e9;
      for (let attempt = 0; attempt < 36; attempt++) {
        const ang = this.rng.nextFloat() * Math.PI * 2;
        const d = 2 + this.rng.nextInt(18);
        const tx = clamp(px + Math.cos(ang) * d, 3, w.size - 3);
        const ty = clamp(py + Math.sin(ang) * d, 3, w.size - 3);
        const mx = Math.floor(tx);
        const my = Math.floor(ty);
        if (bombExcavatable(w.get(mx, my))) {
          const dd = (tx - px) ** 2 + (ty - py) ** 2;
          if (dd < bestD) { bestD = dd; bestX = tx; bestY = ty; }
        }
      }
      if (bestD === 1e9) {
        const ang = this.rng.nextFloat() * Math.PI * 2;
        const d = 6 + this.rng.nextInt(15);
        bestX = clamp(px + Math.cos(ang) * d, 4, w.size - 4);
        bestY = clamp(py + Math.sin(ang) * d, 4, w.size - 4);
      }
      goal = { x: bestX, y: bestY, untilTick: sim.tick + 45 };
      this.goals.set(p.id, goal);
    }
    this.aimAt(frame, p, goal.x, goal.y);
    this.moveToward(frame, px, py, goal.x, goal.y);
    if (slow) frame.moveX = frame.moveY = 0;
  }

  private nearestBombTarget(sim: MatchSim, p: PlayerSim, radius: number, preferred?: { x: number; y: number }): { x: number; y: number } | null {
    const px = p.x / FP;
    const py = p.y / FP;
    const cx = Math.floor(px);
    const cy = Math.floor(py);
    let best: { x: number; y: number } | null = null;
    let bestScore = Infinity;
    const preferredDx = preferred ? preferred.x - px : 0;
    const preferredDy = preferred ? preferred.y - py : 0;
    const preferredLength = Math.hypot(preferredDx, preferredDy) || 1;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (!bombExcavatable(sim.world.get(cx + dx, cy + dy))) continue;
        const x = cx + dx + 0.5;
        const y = cy + dy + 0.5;
        const d2 = (x - px) ** 2 + (y - py) ** 2;
        let score = d2;
        if (preferred) {
          const rockDx = x - px;
          const rockDy = y - py;
          const along = (rockDx * preferredDx + rockDy * preferredDy) / preferredLength;
          const lateral = Math.abs(rockDx * preferredDy - rockDy * preferredDx) / preferredLength;
          // Prefer the first destructible face in a corridor aimed toward the
          // weighted resource target. Rock behind or far beside the bot is a
          // fallback, never the primary excavation direction.
          score += lateral * lateral * 12 + (along < 0 ? 500 : 0) + Math.max(0, along) * 0.05;
        }
        if (score < bestScore) {
          bestScore = score;
          best = { x, y };
        }
      }
    }
    return best;
  }

  /** Pick the safest point reachable on a straight line from the current
   * pocket. For a cross blast, increasing both axis offsets is much more
   * valuable than merely maximizing radial distance. */
  private findEscapeGoal(sim: MatchSim, p: PlayerSim, hazard: BombHazard): { x: number; y: number } {
    const px = p.x / FP;
    const py = p.y / FP;
    const bx = hazard.x / FP;
    const by = hazard.y / FP;
    const range = hazard.blastRange ?? sim.bal.items.bomb.blastRangeCells;
    const laneWidth =
      (hazard.blastHalfWidth ?? sim.bal.items.bomb.blastHalfWidthCells) +
      (hazard.blastNoiseFringe ?? sim.bal.items.bomb.blastNoiseFringeCells) +
      (hazard.blastWobble ?? sim.bal.items.bomb.blastWobbleCells) +
      sim.bal.movement.playerRadiusCells;
    const radiusFp = Math.round(sim.bal.movement.playerRadiusCells * FP);
    let best = { x: px, y: py };
    let bestScore = this.escapeScore(px, py, bx, by, range, laneWidth, hazard) + this.guardianSafetyScore(sim, px, py);

    // Rays guarantee that every selected endpoint has a collision-free direct
    // route; dense angular sampling still finds the inward/tangential route
    // when a bomb was planted against the edge of a circular chamber.
    for (let ray = 0; ray < 32; ray++) {
      const angle = (ray / 32) * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      for (let distance = 1; distance <= 22; distance += 0.75) {
        const x = px + cos * distance;
        const y = py + sin * distance;
        if (circleCollides(sim.world, Math.round(x * FP), Math.round(y * FP), radiusFp)) break;
        const score = this.escapeScore(x, y, bx, by, range, laneWidth, hazard) + this.guardianSafetyScore(sim, x, y) + distance * 0.1;
        if (score > bestScore) {
          bestScore = score;
          best = { x, y };
        }
      }
    }
    return best;
  }

  private guardianSafetyScore(sim: MatchSim, x: number, y: number): number {
    let nearest = Infinity;
    for (const guardian of sim.entities.values()) {
      if (guardian.kind !== ENT.GUARDIAN) continue;
      nearest = Math.min(nearest, Math.hypot(x - guardian.x / FP, y - guardian.y / FP));
    }
    if (!Number.isFinite(nearest)) return 0;
    const danger = sim.bal.treasure.guardianAttackRangeCells + 2;
    return Math.min(40, nearest) * 80 - (nearest < danger ? 6_000 : 0);
  }

  private escapeScore(x: number, y: number, bx: number, by: number, range: number, laneWidth: number, hazard: BombHazard): number {
    const dx = x - bx;
    const dy = y - by;
    const variant = hazard.weaponKind ?? WEAPON.STANDARD;
    const pattern = blastPatternForVariant(variant);
    const unsafe = pattern === "flood"
      ? Math.hypot(dx, dy) <= range + laneWidth
      : bombBlastPatternContains(
        Math.round(dx),
        Math.round(dy),
        {
          blastRangeCells: range,
          blastHalfWidthCells: laneWidth,
          blastNoiseFringeCells: 0,
          blastWobbleCells: 0,
          blastDiagonal: ((hazard.blastFeatures ?? 0) & BOMB_FEATURE.DIAGONAL) !== 0
        },
        hazard.shapeSeed ?? 0,
        pattern,
        hazard.aim ?? 0
      );
    return (unsafe ? 0 : 10_000) + Math.hypot(dx, dy) * 100;
  }

  private moveToward(frame: InputFrame, px: number, py: number, tx: number, ty: number): void {
    const dx = tx - px;
    const dy = ty - py;
    frame.moveX = Math.abs(dx) > 0.5 ? Math.sign(dx) : 0;
    frame.moveY = Math.abs(dy) > 0.5 ? Math.sign(dy) : 0;
  }

  private aimAt(frame: InputFrame, p: PlayerSim, tx: number, ty: number): void {
    const ang = Math.atan2(ty - p.y / FP, tx - p.x / FP);
    frame.aim = Math.round(((ang + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2) * 256) & 255;
  }
}

function dist2(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

function dist2Cells(p: { x: number; y: number }, goal: { x: number; y: number }): number {
  return (p.x / FP - goal.x) ** 2 + (p.y / FP - goal.y) ** 2;
}

function cellsSquared(distance: number): number {
  return (distance * FP) ** 2;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function bombExcavatable(mat: number): boolean {
  return mat !== MAT.EMPTY && mat !== MAT.VENT && mat !== MAT.BEDROCK && mat !== MAT.REINFORCE;
}

function isBotResource(mat: number): boolean {
  return mat === MAT.GEM || mat === MAT.REINFORCE_GEM || mat === MAT.GOLD || mat === MAT.FOSSIL ||
    mat === MAT.COPPER || mat === MAT.IRON || mat === MAT.PLATINUM || mat === MAT.COAL;
}

function materialForResource(resource: CraftResource): number {
  if (resource === "common") return MAT.GEM;
  if (resource === "gold") return MAT.GOLD;
  if (resource === "fossils") return MAT.FOSSIL;
  if (resource === "copper") return MAT.COPPER;
  if (resource === "iron") return MAT.IRON;
  if (resource === "platinum") return MAT.PLATINUM;
  return MAT.COAL;
}

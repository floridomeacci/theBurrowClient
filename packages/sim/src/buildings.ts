import { FIRST_BUILDING_TOOL_SLOT } from "./constants";

export const BUILDING = {
  COAL_GENERATOR: 0,
  BATTERY_BANK: 1,
  POWER_RELAY: 2,
  OXYGEN_RECYCLER: 3,
  FLOODLIGHT: 4,
  SENTRY_GUN: 5,
  ARC_COIL: 6,
  SHIELD_PYLON: 7,
  REPAIR_DEPOT: 8,
  ORE_REFINERY: 9,
  DIGGER_BARRACKS: 10,
  DEEP_DRILL: 11,
  TRACK_DEPOT: 12,
  DRILL_FORGE: 13
} as const;

export type BuildingKind = (typeof BUILDING)[keyof typeof BUILDING];
export type BuildingResource = "common" | "copper" | "iron" | "gold" | "platinum" | "coal";

export interface BuildingDefinition {
  kind: BuildingKind;
  slot: number;
  label: string;
  shortLabel: string;
  description: string;
  prerequisite?: BuildingKind;
  cost: Partial<Record<BuildingResource, number>>;
  footprintRadius: number;
  collisionRadius: number;
  health: number;
  powerDraw: number;
  range: number;
}

const def = (
  kind: BuildingKind,
  label: string,
  shortLabel: string,
  description: string,
  values: Omit<BuildingDefinition, "kind" | "slot" | "label" | "shortLabel" | "description">
): BuildingDefinition => ({ kind, slot: FIRST_BUILDING_TOOL_SLOT + kind, label, shortLabel, description, ...values });

/**
 * The infrastructure tree deliberately begins with generation and distribution.
 * Every later structure is useful on its own, but severing its relay path takes
 * it offline until the grid is rebuilt.
 */
export const BUILDING_DEFS: readonly BuildingDefinition[] = [
  def(BUILDING.COAL_GENERATOR, "Coal Dynamo", "DYN", "Burns mined coal to charge the outpost power grid.", {
    cost: { iron: 6, coal: 4 }, footprintRadius: 4.2, collisionRadius: 3.6, health: 340, powerDraw: 0, range: 0
  }),
  def(BUILDING.BATTERY_BANK, "Battery Bank", "BAT", "Adds a large energy reserve so defenses survive demand spikes.", {
    prerequisite: BUILDING.COAL_GENERATOR, cost: { copper: 8, iron: 3 }, footprintRadius: 3.8, collisionRadius: 3.2, health: 380, powerDraw: 0, range: 0
  }),
  def(BUILDING.POWER_RELAY, "Cable Relay", "RLY", "Extends the construction and electrical grid through tunnels.", {
    prerequisite: BUILDING.COAL_GENERATOR, cost: { copper: 5 }, footprintRadius: 2.8, collisionRadius: 2.3, health: 210, powerDraw: 1, range: 25
  }),
  def(BUILDING.OXYGEN_RECYCLER, "Air Scrubber", "AIR", "Creates a powered oxygen-safe pocket around the outpost.", {
    prerequisite: BUILDING.POWER_RELAY, cost: { copper: 6, iron: 4 }, footprintRadius: 4, collisionRadius: 3.4, health: 300, powerDraw: 3, range: 22
  }),
  def(BUILDING.FLOODLIGHT, "Survey Floodlight", "LUX", "Pushes back fog around connected mining works.", {
    prerequisite: BUILDING.POWER_RELAY, cost: { copper: 4 }, footprintRadius: 3, collisionRadius: 2.5, health: 190, powerDraw: 1, range: 32
  }),
  def(BUILDING.SENTRY_GUN, "Rivet Sentry", "GUN", "Fires compact demolition shells at visible rival miners.", {
    prerequisite: BUILDING.POWER_RELAY, cost: { iron: 9, copper: 3 }, footprintRadius: 3.4, collisionRadius: 2.8, health: 300, powerDraw: 2, range: 29
  }),
  def(BUILDING.ARC_COIL, "Arc Fence Coil", "ARC", "Stuns and shocks enemies that breach the inner perimeter.", {
    prerequisite: BUILDING.SENTRY_GUN, cost: { gold: 3, copper: 6 }, footprintRadius: 3.4, collisionRadius: 2.8, health: 290, powerDraw: 3, range: 13
  }),
  def(BUILDING.SHIELD_PYLON, "Blast Ward Pylon", "SHD", "Reduces blast damage to nearby miners and structures.", {
    prerequisite: BUILDING.BATTERY_BANK, cost: { platinum: 3, iron: 5 }, footprintRadius: 4, collisionRadius: 3.4, health: 340, powerDraw: 4, range: 18
  }),
  def(BUILDING.REPAIR_DEPOT, "Rivet Repair Bay", "FIX", "Repairs nearby structures between bombardments.", {
    prerequisite: BUILDING.BATTERY_BANK, cost: { iron: 9, copper: 4 }, footprintRadius: 4.4, collisionRadius: 3.8, health: 390, powerDraw: 3, range: 20
  }),
  def(BUILDING.ORE_REFINERY, "Ore Stamp Mill", "ORE", "Processes autonomous-miner ore into bonus material yield.", {
    prerequisite: BUILDING.COAL_GENERATOR, cost: { iron: 8, gold: 2 }, footprintRadius: 5, collisionRadius: 4.3, health: 440, powerDraw: 3, range: 0
  }),
  def(BUILDING.DIGGER_BARRACKS, "Digger Barracks", "CREW", "Trains autonomous diggers and roaming hunters you can watch leave the yard.", {
    prerequisite: BUILDING.COAL_GENERATOR, cost: { iron: 12, coal: 4 }, footprintRadius: 6, collisionRadius: 5.2, health: 520, powerDraw: 4, range: 0
  }),
  def(BUILDING.DEEP_DRILL, "Deep Drill Rig", "DRILL", "Turns toward nearby seams and continuously excavates rock and buried ore.", {
    prerequisite: BUILDING.DIGGER_BARRACKS, cost: { iron: 14, coal: 7 }, footprintRadius: 5.5, collisionRadius: 4.7, health: 500, powerDraw: 6, range: 30
  }),
  def(BUILDING.TRACK_DEPOT, "Ore Track Depot", "RAIL", "Runs a visible ore cart to the base and boosts nearby crew haul speed.", {
    prerequisite: BUILDING.DIGGER_BARRACKS, cost: { iron: 10, copper: 6 }, footprintRadius: 5, collisionRadius: 4.2, health: 460, powerDraw: 3, range: 0
  }),
  def(BUILDING.DRILL_FORGE, "Drill Forge", "FORGE", "Each powered forge stacks faster movement, stronger bits, and longer digger reach.", {
    prerequisite: BUILDING.DEEP_DRILL, cost: { iron: 12, gold: 3 }, footprintRadius: 4.8, collisionRadius: 4, health: 470, powerDraw: 5, range: 0
  })
] as const;

export function buildingDefinition(kind: number): BuildingDefinition | undefined {
  return BUILDING_DEFS.find((candidate) => candidate.kind === kind);
}

export function buildingForSlot(slot: number): BuildingDefinition | undefined {
  return BUILDING_DEFS.find((candidate) => candidate.slot === slot);
}

export function buildingBit(kind: number): number {
  return kind >= 0 && kind < BUILDING_DEFS.length ? (1 << kind) >>> 0 : 0;
}

export function hasBuiltBuilding(mask: number, kind: number): boolean {
  return (mask & buildingBit(kind)) !== 0;
}

export function buildingPrerequisiteMet(mask: number, definition: BuildingDefinition): boolean {
  return definition.prerequisite === undefined || hasBuiltBuilding(mask, definition.prerequisite);
}

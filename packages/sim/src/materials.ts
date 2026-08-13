export const MAT = {
  EMPTY: 0,
  SOFT: 1,
  DENSE: 2,
  HARD: 3,
  GEM: 4,
  UNSTABLE: 5,
  BOULDER: 6,
  RUBBLE: 7,
  REINFORCE: 8,
  VENT: 9,
  REINFORCE_GEM: 10,
  BEDROCK: 11,
  GOLD: 12,
  FOSSIL: 13,
  COPPER: 14,
  IRON: 15,
  PLATINUM: 16,
  COAL: 17,
  LAVA: 18,
  MOSS: 19,
  WATER: 20
} as const;

export type Material = (typeof MAT)[keyof typeof MAT];

/** Cell HP (dig damage needed to clear). 255 = effectively indestructible. */
export const MAT_HP: Record<number, number> = {
  [MAT.EMPTY]: 0,
  [MAT.SOFT]: 8,
  [MAT.DENSE]: 16,
  [MAT.HARD]: 40,
  [MAT.GEM]: 18,
  [MAT.UNSTABLE]: 10,
  [MAT.BOULDER]: 120,
  [MAT.RUBBLE]: 60,
  [MAT.REINFORCE]: 255,
  [MAT.VENT]: 255,
  [MAT.REINFORCE_GEM]: 24,
  [MAT.BEDROCK]: 255,
  [MAT.GOLD]: 22,
  [MAT.FOSSIL]: 28,
  [MAT.COPPER]: 16,
  [MAT.IRON]: 26,
  [MAT.PLATINUM]: 38,
  [MAT.COAL]: 14,
  [MAT.LAVA]: 255,
  [MAT.MOSS]: 255,
  [MAT.WATER]: 255
};

export function isCraftMaterial(mat: number): boolean {
  return mat === MAT.GOLD || mat === MAT.FOSSIL || mat === MAT.COPPER || mat === MAT.IRON || mat === MAT.PLATINUM || mat === MAT.COAL;
}

/** Can a miner's basic pick dig this during day? */
export function minerDiggable(mat: number): boolean {
  return (
    mat === MAT.SOFT ||
    mat === MAT.DENSE ||
    mat === MAT.HARD ||
    mat === MAT.GEM ||
    mat === MAT.REINFORCE_GEM ||
    isCraftMaterial(mat) ||
    mat === MAT.UNSTABLE ||
    mat === MAT.RUBBLE // miners may remove placed rubble during day
  );
}

/** Can a hunt-form infected break this after the zombie release (slow + loud)? */
export function monsterBreakable(mat: number): boolean {
  return mat === MAT.BOULDER || mat === MAT.RUBBLE;
}

export function isSolidMat(mat: number): boolean {
  return mat !== MAT.EMPTY && mat !== MAT.VENT;
}

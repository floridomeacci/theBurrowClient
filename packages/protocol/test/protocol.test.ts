import { describe, expect, it } from "vitest";
import {
  decodeChunk,
  decodeInput,
  decodePatch,
  decodeSnapshot,
  decodeSound,
  encodeChunk,
  encodeInput,
  encodePatch,
  encodeSnapshot,
  encodeSound
} from "../src";

const dv = (b: ArrayBuffer) => new DataView(b);

describe("protocol round-trips", () => {
  it("input", () => {
    const m = { seq: 123456, moveX: -1, moveY: 1, aim: 200, buttons: 0b1010101, slot: 3, ackTick: 99999 };
    expect(decodeInput(dv(encodeInput(m)))).toEqual(m);
  });

  it("snapshot", () => {
    const m = {
      tick: 5000,
      lastSeq: 4321,
      phaseIndex: -1,
      phaseEndTick: 6000,
      self: {
        x: -12345,
        y: 999999,
        stamina: 200,
        oxygen: 255,
        carried: 12,
        secured: 34,
        reinforceGems: 5,
        rubble: 3,
        support: 2,
        flags: 0b101,
        slot: 2,
        wallUnlocked: 1,
        charges: 2,
        pickDurability: 543,
        gold: 7,
        fossils: 8,
        copper: 9,
        iron: 10,
        platinum: 11,
        bombSpeedLevel: 2,
        bombRangeLevel: 3,
        bombWidthLevel: 1,
        bombCapacityLevel: 2,
        bombFeatures: 13,
        health: 175,
        maxHealth: 250,
        visionLevel: 2,
        moveSpeedLevel: 3,
        healthLevel: 3,
        dynamite: 4,
        c4: 5,
        clusterBombs: 6,
        napalm: 7,
        nukes: 8,
        turretKits: 9,
        weaponBlueprints: 0x5a31c7,
        coal: 37,
        power: 118,
        powerCapacity: 280,
        infrastructureUnlocked: 1,
        buildingBlueprints: 0x02af,
        relics: 0x000d
      },
      entities: [
        { kind: 0, id: 3, x: 1000, y: 2000, facing: 128, flags: 1, variant: 0, width: 0, nameVisible: true },
        { kind: 6, id: 500, x: -5, y: 7, facing: 0, flags: 0, variant: 5, width: 4, nameVisible: false },
        { kind: 12, id: 501, x: 4096, y: 8192, facing: 0, flags: 0, variant: 2, width: 4, nameVisible: false },
        { kind: 13, id: 502, x: 4352, y: 8192, facing: 96, flags: 8, variant: 2, width: 0, nameVisible: false }
      ]
    };
    expect(decodeSnapshot(dv(encodeSnapshot(m)))).toEqual(m);
  });

  it("patch", () => {
    const m = {
      cells: [
        { x: 10, y: 20, mat: 0 },
        { x: 4095, y: 4095, mat: 7 }
      ],
      revs: [{ cx: 63, cy: 63, rev: 4000000000 }]
    };
    expect(decodePatch(dv(encodePatch(m)))).toEqual(m);
  });

  it("chunk", () => {
    const m = { cx: 63, cy: 63, revision: 77, checksum: 0xdeadbeef, rle: Uint8Array.from([255, 1, 10, 0]) };
    expect(decodeChunk(dv(encodeChunk(m)))).toEqual(m);
  });

  it("sound", () => {
    const m = { sound: 4, x: 4095, y: 4095, intensity: 200 };
    expect(decodeSound(dv(encodeSound(m)))).toEqual(m);
  });
});

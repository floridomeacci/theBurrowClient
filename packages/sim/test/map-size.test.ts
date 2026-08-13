import { describe, it, expect } from "vitest";
import { balanceForWorldSize } from "@burrow/config";
import { MatchSim } from "../src/index";

describe("selectable map sizes", () => {
  for (const size of [1024, 2048, 4096]) {
    for (const seed of [1234, 42, 987654321]) {
      it(`generates and simulates a ${size} world (seed ${seed})`, () => {
        const bal = balanceForWorldSize(size);
        const roster = Array.from({ length: 8 }, (_, i) => ({ name: `P${i}`, bot: true, devMode: false }));
        const sim = new MatchSim(seed, bal, roster);
        expect(sim.world.size).toBe(size);
        for (let t = 0; t < 300; t++) sim.step();
        for (const p of sim.players) {
          expect(p.x).toBeGreaterThan(0);
          expect(p.y).toBeGreaterThan(0);
        }
      }, 120_000);
    }
  }
});

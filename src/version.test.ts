import { it, expect } from "vitest";
import { ALGO_VERSION } from "./version.js";

it("exposes a semver algo version", () => {
  expect(ALGO_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});

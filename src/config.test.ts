import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveRoot } from "./config.js";

const saved = process.env.MNEMOSYNE_ROOT;
afterEach(() => { if (saved === undefined) delete process.env.MNEMOSYNE_ROOT; else process.env.MNEMOSYNE_ROOT = saved; });

describe("resolveRoot", () => {
  test("resolveRoot_prefers_explicit_flag", () => {
    expect(resolveRoot("/tmp/x")).toBe("/tmp/x");
  });
  test("resolveRoot_falls_back_to_env", () => {
    process.env.MNEMOSYNE_ROOT = "/env/mem";
    expect(resolveRoot()).toBe("/env/mem");
  });
  test("resolveRoot_defaults_to_home_memory", () => {
    delete process.env.MNEMOSYNE_ROOT;
    expect(resolveRoot()).toBe(join(homedir(), "memory"));
  });
});

// src/dreaming/grounding.test.ts
import { describe, expect, test } from "vitest";
import { findUngrounded } from "./grounding.js";

describe("findUngrounded", () => {
  const sources = [
    "WLED con 90 LEDs WS2812B, color GRB, controlador CTL-LED-10P, WLED 0.15.1.",
    "IP estática 192.0.2.41, MAC 00:00:5E:00:53:2B.",
    "El proyecto proj-orbital es gratis y MIT.",
  ].join("\n");

  test("grounded IPs and codes are not flagged", () => {
    const body = "El WLED (WS2812B, CTL-LED-10P, 0.15.1) tiene IP 192.0.2.41.";
    expect(findUngrounded(body, sources)).toEqual([]);
  });

  test("an invented IP is flagged", () => {
    const out = findUngrounded("La IP es 192.0.2.99.", sources);
    expect(out).toContainEqual({ token: "192.0.2.99", kind: "ip" });
  });

  test("an invented alphanumeric code is flagged", () => {
    const out = findUngrounded("El chip es WS9999Z.", sources);
    expect(out.map((u) => u.token)).toContain("WS9999Z");
    expect(out[0]!.kind).toBe("code");
  });

  test("a corrupted slug near a source slug is flagged", () => {
    const out = findUngrounded("El proyecto prog-orbital avanza.", sources);
    expect(out).toContainEqual({ token: "prog-orbital", kind: "slug" });
  });

  test("the exact source slug is not flagged", () => {
    expect(findUngrounded("proj-orbital es MIT", sources)).toEqual([]);
  });

  test("a novel hyphenated phrase with no near-miss is not flagged (legit consolidation)", () => {
    expect(findUngrounded("una escritura-por-gesto importante", sources)).toEqual([]);
  });

  test("a truncated identifier (substring of a real one) is still flagged", () => {
    // Dropping characters must not pass as grounded just by being a substring.
    expect(findUngrounded("IP 192.0.2.4", sources)).toContainEqual({ token: "192.0.2.4", kind: "ip" });
    expect(findUngrounded("chip WS2812", sources).map((u) => u.token)).toContain("WS2812");
    expect(findUngrounded("proyecto proj-orbita", sources)).toContainEqual({ token: "proj-orbita", kind: "slug" });
  });

  test("matching is case-insensitive", () => {
    expect(findUngrounded("ws2812b y ctl-led-10p", sources)).toEqual([]);
  });

  test("short tokens with digits (e.g. 3am) are ignored as noise", () => {
    expect(findUngrounded("a las 3am en v2", sources)).toEqual([]);
  });
});

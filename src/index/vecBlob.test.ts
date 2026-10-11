// src/index/vecBlob.test.ts
import { describe, expect, test } from "vitest";
import { toBlob, fromBlob } from "./vecBlob.js";

describe("vecBlob", () => {
  test("fromBlob round-trips a vector encoded by toBlob", () => {
    const vec = [0.5, -0.25, 1, 0];
    const back = fromBlob(toBlob(vec));
    expect(back).toHaveLength(vec.length);
    for (let i = 0; i < vec.length; i++) expect(back[i]).toBeCloseTo(vec[i]!, 6);
  });

  test("fromBlob respects a buffer's byteOffset into a larger ArrayBuffer", () => {
    // better-sqlite3 hands back Buffers that are views into a pooled ArrayBuffer;
    // decoding must honour byteOffset, not assume the buffer starts at offset 0.
    const vec = [1, 2, 3, 4];
    const encoded = toBlob(vec);
    const padded = Buffer.concat([Buffer.alloc(8), encoded]);
    const view = padded.subarray(8); // same bytes, non-zero byteOffset
    expect(fromBlob(view)).toEqual(vec);
  });
});

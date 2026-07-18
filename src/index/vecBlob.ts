// src/index/vecBlob.ts
/** Encode an embedding as a little-endian float32 blob for sqlite-vec binding. */
export function toBlob(vec: number[]): Buffer {
  return Buffer.from(Float32Array.from(vec).buffer);
}

// src/index/vecBlob.ts
/** Encode an embedding as a little-endian float32 blob for sqlite-vec binding. */
export function toBlob(vec: number[]): Buffer {
  return Buffer.from(Float32Array.from(vec).buffer);
}

/**
 * Decode a float32 blob back to a vector. better-sqlite3 returns a Buffer that
 * is a VIEW into a larger pooled ArrayBuffer, so byteOffset/byteLength must be
 * honoured — reading the whole backing buffer would mix in other rows' bytes.
 */
export function fromBlob(buf: Buffer): number[] {
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)));
}

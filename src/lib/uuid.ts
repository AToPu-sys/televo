/**
 * RFC 4122 v4 UUID without a native dependency.
 *
 * We generate conversation ids client-side because chaining .select() onto an
 * insert makes PostgREST do INSERT ... RETURNING, and the SELECT policy on
 * conversations only admits existing participants — which the creator isn't
 * until the participant rows are written.
 */
export function randomUUID(): string {
  const globalCrypto = (globalThis as { crypto?: Crypto }).crypto;

  if (globalCrypto?.randomUUID) {
    return globalCrypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (globalCrypto?.getRandomValues) {
    globalCrypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < 16; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  // Version 4, variant 10xx.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20
  )}-${hex.slice(20)}`;
}

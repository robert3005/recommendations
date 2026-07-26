/**
 * Primitives both services need, defined once.
 *
 * The share and sync services each carried a byte-identical copy of these —
 * including the 43-to-512-character Bearer pattern that encodes "at least 256
 * random bits". Two copies of a token comparison is exactly the kind of
 * duplication that drifts silently and only matters once.
 *
 * This is a shared package, not a merged service: the two runtimes genuinely
 * differ (a public read path that wants an edge cache and scale-to-zero, and a
 * per-account write log that wants Postgres), so they share code, not a deploy.
 */

/** SHA-256 of a UTF-8 string, lowercase hex. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Constant-time hex comparison. Length is not secret (both sides are fixed-width
 * digests), so an early length exit is safe; the body must not short-circuit.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The bearer secret from an Authorization header, or undefined.
 *
 * The 43-character floor is the contract: 256 random bits encode to 43 unpadded
 * base64url characters, so anything shorter cannot be a token this project
 * issued and is rejected before it reaches a comparison.
 */
export function bearerToken(header: string | undefined): string | undefined {
  const match = header?.match(/^Bearer\s+(\S{43,512})$/);
  return match?.[1];
}

/** UTF-8 byte length — request and document size limits are in bytes, not characters. */
export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

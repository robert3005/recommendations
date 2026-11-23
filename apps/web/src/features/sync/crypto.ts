/**
 * The library key (spec/src/sync.md §The library key): 256 random bits that
 * a device makes when sync is turned on, and the only thing a second device
 * needs. Everything else is derived from it, each for one purpose, so no
 * derived value reveals another:
 *
 *   id     which library on the service — public, unguessable
 *   token  the Bearer secret the service checks (it stores only a hash)
 *   enc    the AES-GCM key rows are sealed with — never leaves the device
 *   row    the HMAC key that turns "<table>:<id>" into an opaque row key
 *
 * The service therefore holds ciphertext under meaningless keys: it can
 * store and order a library, and cannot read one.
 */
import type { SyncRecord, SyncTable } from "@placemarks/domain";
import { SYNC_TABLES } from "@placemarks/domain";

export interface LibraryKeys {
  libraryId: string;
  token: string;
  enc: CryptoKey;
  row: CryptoKey;
}

const SALT = new TextEncoder().encode("placemarks-sync-v1");
const CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const toHex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** A fresh library key, as the 43-character code a person can copy. */
export function newLibraryCode(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * A pasted or scanned code, tidied: whitespace and the pairing link's
 * `#pair=` wrapper are dropped. Undefined when what is left is not a code.
 */
export function parseLibraryCode(raw: string): string | undefined {
  const text = raw.trim();
  const fromLink = text.match(/[#&?]pair=([A-Za-z0-9_-]+)/)?.[1];
  const code = (fromLink ?? text).replace(/\s+/g, "");
  return CODE_PATTERN.test(code) ? code : undefined;
}

/** The link a second device opens to arrive with the code filled in — the code stays in the fragment, which is never sent to a server. */
export function pairingLink(code: string, origin: string): string {
  return `${origin}/settings#pair=${code}`;
}

async function derive(master: CryptoKey, info: string, bits: number): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: SALT, info: new TextEncoder().encode(info) },
      master,
      bits,
    ),
  );
}

export async function deriveKeys(code: string): Promise<LibraryKeys> {
  if (!CODE_PATTERN.test(code)) throw new Error("not a library code");
  const master = await crypto.subtle.importKey("raw", fromBase64Url(code), "HKDF", false, [
    "deriveBits",
  ]);
  const [id, token, enc, row] = await Promise.all([
    derive(master, "library-id", 128),
    derive(master, "service-token", 256),
    derive(master, "row-encryption", 256),
    derive(master, "row-key", 256),
  ]);
  return {
    libraryId: toHex(id),
    token: toBase64Url(token),
    enc: await crypto.subtle.importKey("raw", enc as Uint8Array<ArrayBuffer>, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]),
    row: await crypto.subtle.importKey(
      "raw",
      row as Uint8Array<ArrayBuffer>,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    ),
  };
}

/** The opaque key a row is stored under: stable per row, meaningless to the service. */
export async function rowKeyFor(keys: LibraryKeys, table: SyncTable, id: string): Promise<string> {
  const mac = await crypto.subtle.sign(
    "HMAC",
    keys.row,
    new TextEncoder().encode(`${table}:${id}`),
  );
  return toHex(new Uint8Array(mac));
}

/** Seal a record: base64(iv ‖ ciphertext), a fresh 96-bit iv every time. */
export async function seal(keys: LibraryKeys, record: SyncRecord): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(record));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, keys.enc, plain),
  );
  const out = new Uint8Array(iv.length + cipher.length);
  out.set(iv);
  out.set(cipher, iv.length);
  return toBase64(out);
}

/**
 * Open a sealed record. Undefined for anything this library's key cannot
 * open or that is not a well-formed record — a row from a damaged or foreign
 * source is skipped, never trusted.
 */
export async function open(keys: LibraryKeys, sealed: string): Promise<SyncRecord | undefined> {
  try {
    const bytes = fromBase64(sealed);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12) },
      keys.enc,
      bytes.slice(12),
    );
    const record = JSON.parse(new TextDecoder().decode(plain)) as Partial<SyncRecord>;
    if (
      typeof record.id !== "string" ||
      typeof record.u !== "string" ||
      !SYNC_TABLES.includes(record.t as SyncTable)
    ) {
      return undefined;
    }
    if (record.d === true) return { t: record.t as SyncTable, id: record.id, u: record.u, d: true };
    const row = record.row;
    if (typeof row !== "object" || row === null) return undefined;
    // The envelope and the row must agree, or the row is not what it claims.
    if (row.id !== record.id || row.updatedAt !== record.u) return undefined;
    return { t: record.t as SyncTable, id: record.id, u: record.u, row };
  } catch {
    return undefined;
  }
}

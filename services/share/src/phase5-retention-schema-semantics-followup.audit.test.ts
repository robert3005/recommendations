/** Retention must compare timestamps chronologically, not as raw SQLite text. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SERVICE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCHEMA = readFileSync(join(SERVICE_ROOT, "schema.sql"), "utf8");
const WORKER = readFileSync(join(SERVICE_ROOT, "src/worker.ts"), "utf8");

function _sqlArtifacts(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return _sqlArtifacts(path);
    return entry.isFile() && entry.name.endsWith(".sql") ? [readFileSync(path, "utf8")] : [];
  });
}

describe("Phase 5 D1 retention schema semantics", () => {
  it("does not compare SQLite datetime text directly with an ISO-T cutoff", () => {
    const table = SCHEMA.match(/CREATE TABLE IF NOT EXISTS idempotency\s*\(([\s\S]*?)\);/i)?.[1];
    const storesSpaceSeparatedDatetime =
      /\b(?:createdAt|updatedAt|expiresAt)\s+TEXT\b[\s\S]*?DEFAULT\s*\(\s*datetime\s*\(\s*['"]now['"]\s*\)\s*\)/i.test(
        table ?? "",
      );
    const comparesRawTextToIsoParameter =
      /DELETE\s+FROM\s+idempotency\s+WHERE\s+(?:createdAt|updatedAt|expiresAt)\s*<\s*\?/i.test(
        WORKER,
      ) && /toISOString\s*\(/.test(WORKER);

    // SQLite compares these TEXT values lexically: on the cutoff date, the
    // space from datetime('now') sorts before ISO's "T", purging young rows.
    expect(
      storesSpaceSeparatedDatetime && comparesRawTextToIsoParameter,
      'for example, "2026-04-20 23:59:59" sorts before "2026-04-20T12:00:00.000Z"',
    ).toBe(false);
  });
});

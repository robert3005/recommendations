/** Retention must upgrade an existing D1 database and compare timestamps chronologically. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SERVICE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCHEMA = readFileSync(join(SERVICE_ROOT, "schema.sql"), "utf8");
const WORKER = readFileSync(join(SERVICE_ROOT, "src/worker.ts"), "utf8");

function sqlArtifacts(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sqlArtifacts(path);
    return entry.isFile() && entry.name.endsWith(".sql") ? [readFileSync(path, "utf8")] : [];
  });
}

describe("Phase 5 D1 retention schema semantics", () => {
  it("migrates the already-existing idempotency table to an age-bearing schema", () => {
    // The deployed predecessor already has idempotency(key, response, status).
    // CREATE TABLE IF NOT EXISTS cannot add a column to that existing table.
    const sql = sqlArtifacts(SERVICE_ROOT).join("\n");
    const addsAgeColumn =
      /ALTER\s+TABLE\s+idempotency\s+ADD(?:\s+COLUMN)?\s+(?:createdAt|updatedAt|expiresAt)\b/i.test(
        sql,
      );
    const copyMigration =
      /INSERT\s+INTO\s+\w*idempotency\w*[\s\S]*?SELECT[\s\S]*?FROM\s+idempotency\b/i.test(sql) &&
      /ALTER\s+TABLE\s+\w*idempotency\w*\s+RENAME\s+TO\s+idempotency\b/i.test(sql);

    expect(
      addsAgeColumn || copyMigration,
      "schema.sql only changes the CREATE definition; an existing D1 table never receives the cutoff column",
    ).toBe(true);
  });

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

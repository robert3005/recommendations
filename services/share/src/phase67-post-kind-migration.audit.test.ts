/**
 * Revised-spec regression: adding `post` to schema.sql only affects fresh D1
 * databases. SQLite cannot alter a CHECK constraint in place, so a deployed
 * predecessor needs an explicit, data-preserving table-rebuild migration.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SERVICE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const MIGRATIONS_ROOT = join(SERVICE_ROOT, "migrations");

function migrationSql(): string {
  if (!existsSync(MIGRATIONS_ROOT)) return "";
  return readdirSync(MIGRATIONS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => readFileSync(join(MIGRATIONS_ROOT, entry.name), "utf8"))
    .join("\n");
}

describe("Phase 6/7 deployed share-schema migration", () => {
  it("rebuilds the predecessor documents table to accept posts without losing revisions", () => {
    const sql = migrationSql();
    const createsPostCapableReplacement =
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?\w*documents\w*[\s\S]*?CHECK\s*\([\s\S]*?['"]post['"]/i.test(
        sql,
      );
    const copiesExistingDocuments =
      /INSERT\s+INTO\s+\w*documents\w*[\s\S]*?SELECT[\s\S]*?FROM\s+documents\b/i.test(sql);
    const swapsReplacementIntoPlace =
      /DROP\s+TABLE\s+documents\b/i.test(sql) &&
      /ALTER\s+TABLE\s+\w*documents\w*\s+RENAME\s+TO\s+documents\b/i.test(sql);
    const restoresRevisionTriggers =
      /CREATE\s+TRIGGER[\s\S]*?documents_revision_on_insert/i.test(sql) &&
      /CREATE\s+TRIGGER[\s\S]*?documents_revision_on_update/i.test(sql);

    expect.soft(createsPostCapableReplacement, "no post-capable replacement table").toBe(true);
    expect.soft(copiesExistingDocuments, "existing list/note documents are not copied").toBe(true);
    expect
      .soft(swapsReplacementIntoPlace, "the predecessor CHECK constraint is never replaced")
      .toBe(true);
    expect
      .soft(restoresRevisionTriggers, "table rebuild does not restore revision triggers")
      .toBe(true);
  });
});

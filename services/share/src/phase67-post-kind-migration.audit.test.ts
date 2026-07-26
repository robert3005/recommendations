/**
 * Revised-spec regression: adding `post` to schema.sql only affects fresh D1
 * databases. SQLite cannot alter a CHECK constraint in place, so a deployed
 * predecessor needs an explicit, data-preserving table-rebuild migration.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SERVICE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const MIGRATIONS_ROOT = join(SERVICE_ROOT, "migrations");

function migrations(): { name: string; sql: string }[] {
  if (!existsSync(MIGRATIONS_ROOT)) return [];
  return readdirSync(MIGRATIONS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => ({
      name: entry.name,
      sql: readFileSync(join(MIGRATIONS_ROOT, entry.name), "utf8"),
    }));
}

describe("Phase 6/7 deployed share-schema migration", () => {
  it("rebuilds the predecessor documents table to accept posts without losing revisions", () => {
    const entries = migrations();
    const sql = entries.map((entry) => entry.sql).join("\n");
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

  it("executes the ordered baseline-to-post migration without losing deployed data", () => {
    const entries = migrations();
    expect(entries.map((entry) => entry.name)).toEqual([
      "0001-initial.sql",
      "0002-idempotency-age.sql",
      "0003-documents-post-kind.sql",
    ]);

    const db = new DatabaseSync(":memory:");
    try {
      const baseline = entries[0];
      if (!baseline) throw new Error("migration baseline missing");
      db.exec(baseline.sql);
      db.prepare(
        `INSERT INTO documents
           (slug, kind, revision, tokenHash, body, createdAt, updatedAt, revoked)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      ).run("weekend", "list", 1, "hash-list", "list body", "2026-07-01", "2026-07-01");
      db.prepare(
        `INSERT INTO documents
           (slug, kind, revision, tokenHash, body, createdAt, updatedAt, revoked)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      ).run("aside", "note", 1, "hash-note", "note body", "2026-07-01", "2026-07-01");
      db.prepare("INSERT INTO idempotency (key, response, status) VALUES (?, ?, ?)").run(
        "legacy-request",
        "{}",
        201,
      );

      for (const migration of entries.slice(1)) db.exec(migration.sql);

      expect(db.prepare("SELECT kind, body FROM documents ORDER BY kind").all()).toEqual([
        { kind: "list", body: "list body" },
        { kind: "note", body: "note body" },
      ]);
      expect(
        db.prepare("SELECT createdAt FROM idempotency WHERE key = ?").get("legacy-request"),
      ).toMatchObject({ createdAt: expect.stringMatching(/^20\d{2}-/) });
      db.prepare("INSERT INTO idempotency (key, response, status) VALUES (?, ?, ?)").run(
        "post-migration-request",
        "{}",
        200,
      );
      expect(
        db.prepare("SELECT createdAt FROM idempotency WHERE key = ?").get("post-migration-request"),
      ).toMatchObject({ createdAt: expect.stringMatching(/^20\d{2}-\d{2}-\d{2}T/) });

      expect(() =>
        db
          .prepare(
            `INSERT INTO documents
               (slug, kind, revision, tokenHash, body, createdAt, updatedAt, revoked)
             VALUES (?, 'post', 1, ?, ?, ?, ?, 0)`,
          )
          .run("article", "hash-post", "post body", "2026-07-02", "2026-07-02"),
      ).not.toThrow();

      db.prepare(
        "UPDATE documents SET revision = 2, body = ?, updatedAt = ? WHERE slug = ? AND kind = ?",
      ).run("list body v2", "2026-07-03", "weekend", "list");
      expect(
        db
          .prepare(
            "SELECT revision, body FROM document_revisions WHERE slug = ? AND kind = ? ORDER BY revision",
          )
          .all("weekend", "list"),
      ).toEqual([
        { revision: 1, body: "list body" },
        { revision: 2, body: "list body v2" },
      ]);
    } finally {
      db.close();
    }
  });

  it("makes ordered migrations a required part of the deployment workflow", () => {
    const wrangler = readFileSync(join(SERVICE_ROOT, "wrangler.toml"), "utf8");
    const operations = readFileSync(join(SERVICE_ROOT, "OPERATIONS.md"), "utf8");
    const packageJson = JSON.parse(readFileSync(join(SERVICE_ROOT, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(wrangler).toMatch(/migrations_dir\s*=\s*["']migrations["']/);
    expect(wrangler).not.toMatch(/d1\s+execute[^\n]*schema\.sql/i);
    expect(packageJson.scripts?.["db:migrate:remote"]).toMatch(
      /d1\s+migrations\s+apply.*--remote/i,
    );
    expect(packageJson.scripts?.predeploy).toMatch(/db:migrate:remote/);
    expect(operations).toMatch(/only production schema-upgrade path/i);
    expect(operations).toMatch(/do \*\*not\*\* execute it\s+as an upgrade/i);
  });
});

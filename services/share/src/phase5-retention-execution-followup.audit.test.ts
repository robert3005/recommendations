/** The 90-day internal retention policy must be executable, not prose alone. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SERVICE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SOURCE_ROOT = join(SERVICE_ROOT, "src");
const WRANGLER = readFileSync(join(SERVICE_ROOT, "wrangler.toml"), "utf8");
const OPERATIONS = readFileSync(join(SERVICE_ROOT, "OPERATIONS.md"), "utf8");
const SCHEMA = readFileSync(join(SERVICE_ROOT, "schema.sql"), "utf8");
const EXECUTABLE_SOURCE = readdirSync(SOURCE_ROOT, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.includes(".test.") &&
      !entry.name.includes(".spec."),
  )
  .map((entry) => readFileSync(join(SOURCE_ROOT, entry.name), "utf8"))
  .join("\n");

describe("Phase 5 executable internal-data retention", () => {
  it("schedules and runs the exact 90-day audit and revision purge", () => {
    expect
      .soft(
        /\[triggers\][\s\S]*\bcrons\s*=/i.test(WRANGLER),
        "no deployed cron trigger is configured",
      )
      .toBe(true);
    expect
      .soft(
        /\bscheduled\s*\(/i.test(EXECUTABLE_SOURCE),
        "the Worker has no scheduled-event handler",
      )
      .toBe(true);
    expect
      .soft(
        /DELETE\s+FROM\s+audit\b[\s\S]{0,300}\bWHERE\s+at\s*</i.test(EXECUTABLE_SOURCE),
        "audit retention is not executed with an age cutoff",
      )
      .toBe(true);
    expect
      .soft(
        /DELETE\s+FROM\s+document_revisions\b[\s\S]{0,300}\bWHERE\s+recordedAt\s*</i.test(
          EXECUTABLE_SOURCE,
        ),
        "revision retention is not executed with an age cutoff",
      )
      .toBe(true);
    expect
      .soft(
        /(?:90\s*days?|90\s*\*\s*24\s*\*\s*60\s*\*\s*60)/i.test(EXECUTABLE_SOURCE),
        "the executable purge has no 90-day horizon",
      )
      .toBe(true);
  });

  it("gives idempotency rows a cutoff when policy claims the same 90-day purge", () => {
    const claimsNinetyDayIdempotency = /idempotency[\s\S]{0,180}(?:same\s+)?90-day\s+purge/i.test(
      OPERATIONS,
    );
    if (!claimsNinetyDayIdempotency) return;

    const table = SCHEMA.match(/CREATE TABLE IF NOT EXISTS idempotency\s*\(([\s\S]*?)\);/i)?.[1];
    expect
      .soft(
        /\b(?:createdAt|updatedAt|recordedAt|expiresAt)\b/i.test(table ?? ""),
        "idempotency rows have no age or expiry column",
      )
      .toBe(true);

    const purge = OPERATIONS.match(/DELETE\s+FROM\s+idempotency\b[\s\S]*?;/i)?.[0];
    expect.soft(purge !== undefined, "idempotency purge is missing").toBe(true);
    expect
      .soft(
        /\b(?:createdAt|updatedAt|recordedAt|expiresAt)\b[\s\S]*?(?:-90\s+days|90\s+days)/i.test(
          purge ?? "",
        ),
        "idempotency purge has no timestamp cutoff",
      )
      .toBe(true);
  });
});

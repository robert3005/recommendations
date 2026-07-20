/**
 * Phase 5 deployment persistence contracts. The hosted service is not merely
 * an HTTP protocol: the spec chooses transactional D1, immutable revision
 * backups, and an explicit retention period for internal audit/version data.
 */
import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SharedGuide } from "@placemarks/schemas";
import { describe, expect, it } from "vitest";
import { createShareApp } from "./app";
import { type D1Like, D1Storage } from "./d1";

const TOKEN = "a".repeat(43);
const SERVICE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCHEMA = readFileSync(join(SERVICE_ROOT, "schema.sql"), "utf8");

interface SqlResult {
  meta: { changes: number };
}

interface DocumentRow {
  slug: string;
  kind: "list" | "note";
  revision: number;
  tokenHash: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  revoked: number;
}

interface IdempotencyRow {
  key: string;
  response: string;
  status: number;
}

class RecordingStatement {
  values: unknown[] = [];

  constructor(
    private readonly database: RecordingD1,
    readonly sql: string,
  ) {}

  bind(...values: unknown[]): RecordingStatement {
    this.values = values;
    return this;
  }

  run(): Promise<SqlResult> {
    return Promise.resolve(this.database.run(this.sql, this.values));
  }

  first<T = unknown>(): Promise<T | null> {
    return Promise.resolve(this.database.first(this.sql, this.values) as T | null);
  }
}

/** A small stateful D1 double that records actual transactional statement groups. */
class RecordingD1 {
  readonly atomicGroups: Array<Array<{ sql: string; values: readonly unknown[] }>> = [];
  private readonly documents = new Map<string, DocumentRow>();
  private readonly idempotency = new Map<string, IdempotencyRow>();
  private readonly rates = new Map<string, number>();
  private lastWriteChanges = 1;

  prepare(sql: string): RecordingStatement {
    return new RecordingStatement(this, sql);
  }

  async batch(statements: RecordingStatement[]): Promise<SqlResult[]> {
    this.atomicGroups.push(statements.map(({ sql, values }) => ({ sql, values: [...values] })));
    return Promise.all(statements.map((statement) => statement.run()));
  }

  run(sql: string, values: readonly unknown[]): SqlResult {
    if (sql.startsWith("INSERT INTO rate")) {
      const bucket = String(values[0]);
      this.rates.set(bucket, (this.rates.get(bucket) ?? 0) + 1);
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith("INSERT INTO audit")) return { meta: { changes: 1 } };
    // The revision guard: fails the batch only when the conditional write lost.
    if (sql.startsWith("INSERT INTO idempotency")) {
      if (this.lastWriteChanges === 0) {
        throw new Error("NOT NULL constraint failed: idempotency.key");
      }
      return { meta: { changes: 0 } };
    }
    if (sql.startsWith("INSERT OR IGNORE INTO idempotency")) {
      const row = {
        key: String(values[0]),
        response: String(values[1]),
        status: Number(values[2]),
      };
      if (this.idempotency.has(row.key)) return { meta: { changes: 0 } };
      this.idempotency.set(row.key, row);
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith("INSERT INTO documents")) {
      const row: DocumentRow = {
        slug: String(values[0]),
        kind: values[1] as DocumentRow["kind"],
        revision: Number(values[2]),
        tokenHash: String(values[3]),
        body: String(values[4]),
        createdAt: String(values[5]),
        updatedAt: String(values[6]),
        revoked: 0,
      };
      const key = `${row.kind}:${row.slug}`;
      if (this.documents.has(key)) throw new Error("UNIQUE constraint failed: documents.slug");
      this.documents.set(key, row);
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith("UPDATE documents SET revision = revision + 1")) {
      const key = `${String(values[2])}:${String(values[3])}`;
      const row = this.documents.get(key);
      if (!row || row.revoked === 1 || row.revision !== Number(values[4])) {
        this.lastWriteChanges = 0;
        return { meta: { changes: 0 } };
      }
      this.documents.set(key, {
        ...row,
        body: String(values[0]),
        updatedAt: String(values[1]),
        revision: row.revision + 1,
      });
      this.lastWriteChanges = 1;
      return { meta: { changes: 1 } };
    }
    throw new Error(`Unexpected D1 write: ${sql}`);
  }

  first(sql: string, values: readonly unknown[]): unknown {
    if (sql.startsWith("SELECT count FROM rate")) {
      return { count: this.rates.get(String(values[0])) ?? 0 };
    }
    if (sql.startsWith("SELECT * FROM idempotency")) {
      return this.idempotency.get(String(values[0])) ?? null;
    }
    if (sql.startsWith("SELECT * FROM documents")) {
      return this.documents.get(`${String(values[0])}:${String(values[1])}`) ?? null;
    }
    throw new Error(`Unexpected D1 read: ${sql}`);
  }
}

function retentionPolicyArtifacts(): Array<{ path: string; text: string }> {
  const extensions = new Set([
    ".json",
    ".md",
    ".mdx",
    ".sh",
    ".sql",
    ".toml",
    ".ts",
    ".txt",
    ".yaml",
    ".yml",
  ]);
  const ignoredDirectories = new Set([
    ".git",
    "book",
    "coverage",
    "dist",
    "node_modules",
    "playwright-report",
    "storybook-static",
    "test-results",
  ]);
  const ignoredFiles = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]);
  const visit = (directory: string): Array<{ path: string; text: string }> =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if (
        ignoredDirectories.has(entry.name) ||
        ignoredFiles.has(entry.name) ||
        entry.name.includes(".spec.") ||
        entry.name.includes(".test.")
      ) {
        return [];
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return visit(path);
      return extensions.has(extname(entry.name))
        ? [{ path, text: readFileSync(path, "utf8") }]
        : [];
    });
  return visit(SERVICE_ROOT);
}

describe("Phase 5 D1 transactional and versioned persistence", () => {
  it("commits the create audit, pending reservation, and slug claim as one D1 unit", async () => {
    const database = new RecordingD1();
    const storage = new D1Storage(database as unknown as D1Like);
    const app = createShareApp({
      storage,
      now: () => "2026-07-19T15:00:00.000Z",
    });
    const document: SharedGuide = {
      v: 1,
      title: "Transactional publication",
      blocks: [],
      contentHash: "transactional-publication",
    };

    const response = await app.request("https://share.test/s/lists", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "idempotency-key": "transactional-create",
      },
      body: JSON.stringify({ desiredSlug: "transactional-publication", document }),
    });

    expect(response.status).toBe(201);
    expect(
      database.atomicGroups.some((group) => {
        const hasAudit = group.some(({ sql }) => sql.startsWith("INSERT INTO audit"));
        const hasReservation = group.some(
          ({ sql, values }) => sql.includes("idempotency") && values.at(-1) === 0,
        );
        const hasSuccess = group.some(
          ({ sql, values }) => sql.includes("idempotency") && values.at(-1) === 201,
        );
        const hasSlugClaim = group.some(({ sql }) => sql.startsWith("INSERT INTO documents"));
        return hasAudit && hasReservation && hasSlugClaim && hasSuccess;
      }),
    ).toBe(true);
  });

  it("commits an update audit, reservation, and conditional revision write as one D1 unit", async () => {
    const database = new RecordingD1();
    const storage = new D1Storage(database as unknown as D1Like);
    const app = createShareApp({
      storage,
      now: () => "2026-07-19T15:00:00.000Z",
    });
    const create = await app.request("https://share.test/s/lists", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "idempotency-key": "transactional-update-create",
      },
      body: JSON.stringify({
        desiredSlug: "transactional-update",
        document: {
          v: 1,
          title: "Before update",
          blocks: [],
          contentHash: "before-update",
        } satisfies SharedGuide,
      }),
    });
    expect(create.status).toBe(201);

    const update = await app.request("https://share.test/s/lists/transactional-update", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "idempotency-key": "transactional-update-job",
        "if-match": '"1"',
      },
      body: JSON.stringify({
        document: {
          v: 1,
          title: "After update",
          blocks: [],
          contentHash: "after-update",
        } satisfies SharedGuide,
      }),
    });

    expect(update.status).toBe(200);
    expect(
      database.atomicGroups.some((group) => {
        const hasAudit = group.some(({ sql }) => sql.startsWith("INSERT INTO audit"));
        const hasReservation = group.some(
          ({ sql, values }) => sql.includes("idempotency") && values.at(-1) === 0,
        );
        const hasSuccess = group.some(
          ({ sql, values }) => sql.includes("idempotency") && values.at(-1) === 200,
        );
        const hasConditionalUpdate = group.some(({ sql }) =>
          sql.startsWith("UPDATE documents SET revision = revision + 1"),
        );
        return hasAudit && hasReservation && hasConditionalUpdate && hasSuccess;
      }),
    ).toBe(true);
  });

  it("has an append-only SQL store capable of retaining more than one body revision per slug", () => {
    const tables = [
      ...SCHEMA.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+([\w"]+)\s*\(([\s\S]*?)\);/gi),
    ];
    const revisionStore = tables.find((match) => {
      const name = (match[1] ?? "").replaceAll('"', "").toLowerCase();
      const definition = (match[2] ?? "").toLowerCase();
      const hasRevision = /\brevision\b/.test(definition);
      const hasPayload = /\b(?:body|document|payload|json)\b/.test(definition);
      const identityWithRevision = [
        ...definition.matchAll(/(?:PRIMARY KEY|UNIQUE)\s*\(([^)]+)\)/gi),
      ].some(
        ([, columns = ""]) =>
          /\brevision\b/i.test(columns) &&
          /\b(?:slug|document_?id|publication_?id)\b/i.test(columns),
      );
      return (
        hasRevision &&
        hasPayload &&
        (identityWithRevision || /(?:version|history|backup)/.test(name))
      );
    });

    expect(revisionStore?.[1], "schema can only overwrite the current document row").toBeDefined();
  });

  it("documents a concrete retention period for internal audit and version backups", () => {
    const duration = "\\b\\d+\\s*(?:hours?|days?|weeks?|months?|years?)\\b";
    const internalData = "(?:audit|versions?|revision(?:ed)? backups?)";
    const retention = "(?:retention|retain(?:ed)?|expire[sd]?|purge[sd]?)";
    const forward = new RegExp(
      `${internalData}[\\s\\S]{0,240}${retention}[\\s\\S]{0,120}${duration}`,
      "i",
    );
    const reverse = new RegExp(
      `${retention}[\\s\\S]{0,120}${duration}[\\s\\S]{0,240}${internalData}`,
      "i",
    );

    const policy = retentionPolicyArtifacts().find(
      ({ text }) => forward.test(text) || reverse.test(text),
    );
    expect(policy?.path, "no checked-in operational retention policy was found").toBeDefined();
  });
});

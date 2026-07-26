/**
 * Phase 5 service gaps not exercised by app.test.ts. These checks stay at the
 * public HTTP boundary: bearer strength, replay authorization/scope, strict
 * conditional requests, byte limits, abuse controls, and read auditing.
 */
import type { SharedGuide } from "@placemarks/schemas";
import { LIMITS } from "@placemarks/schemas";
import { describe, expect, it, vi } from "vitest";
import { createShareApp } from "./app";
import { type AuditEntry, MemoryStorage } from "./storage";

const TOKEN = "a".repeat(43); // 32 bytes encoded as unpadded base64url

function guide(overrides: Partial<SharedGuide> = {}): SharedGuide {
  return {
    v: 1,
    kind: "list",
    title: "Lisbon weekend",
    blocks: [],
    contentHash: "hash",
    ...overrides,
  };
}

function harness(storage = new MemoryStorage()) {
  const app = createShareApp({ storage, now: () => "2026-07-19T15:00:00.000Z" });
  const request = (path: string, init?: RequestInit) =>
    app.request(`https://share.test${path}`, init);
  const create = (
    slug: string,
    options: { token?: string; idKey?: string; ip?: string; document?: SharedGuide } = {},
  ) =>
    request("/s/lists", {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.token ?? TOKEN}`,
        "idempotency-key": options.idKey ?? `create-${slug}`,
        "content-type": "application/json",
        ...(options.ip ? { "cf-connecting-ip": options.ip } : {}),
      },
      body: JSON.stringify({ desiredSlug: slug, document: options.document ?? guide() }),
    });
  return { storage, request, create };
}

class UpdateAuditFailsOnceStorage extends MemoryStorage {
  private shouldFail = true;

  override async audit(entry: AuditEntry): Promise<void> {
    if (entry.action === "update" && this.shouldFail) {
      this.shouldFail = false;
      throw new Error("simulated audit write failure");
    }
    await super.audit(entry);
  }
}

class UpdateIdempotencyFailsOnceStorage extends MemoryStorage {
  private shouldFail = true;

  override async putIdempotent(record: { key: string; response: string; status: number }) {
    if (record.key.includes(":put:") && record.status >= 200 && this.shouldFail) {
      this.shouldFail = false;
      throw new Error("simulated idempotency write failure");
    }
    await super.putIdempotent(record);
  }
}

class DocumentUpdateFailsOnceStorage extends MemoryStorage {
  private shouldFail = true;

  override async update(...args: Parameters<MemoryStorage["update"]>) {
    if (this.shouldFail) {
      this.shouldFail = false;
      throw new Error("simulated document write failure");
    }
    return super.update(...args);
  }
}

describe("Phase 5 bearer and idempotency security", () => {
  it("rejects an editor token that cannot contain the required 256 random bits", async () => {
    const { create } = harness();

    const response = await create("weak-token", { token: "only-sixteen-char" });

    expect(response.status).toBe(401);
  });

  it("requires bearer authorization even when an idempotent PUT result already exists", async () => {
    const { request, create } = harness();
    await create("private-write");
    const update = {
      method: "PUT",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "if-match": '"1"',
        "idempotency-key": "update-private-write",
        "content-type": "application/json",
      },
      body: JSON.stringify({ document: guide({ title: "Updated" }) }),
    } satisfies RequestInit;
    expect((await request("/s/lists/private-write", update)).status).toBe(200);

    const unauthenticatedReplay = await request("/s/lists/private-write", {
      ...update,
      headers: {
        "if-match": '"1"',
        "idempotency-key": "update-private-write",
        "content-type": "application/json",
      },
    });

    expect(unauthenticatedReplay.status).toBe(401);
  });

  it("binds an idempotency key to its operation instead of falsely completing a DELETE", async () => {
    const { request, create } = harness();
    await create("operation-scope", { idKey: "same-job-key" });

    const revoke = await request("/s/lists/operation-scope", {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "if-match": '"1"',
        "idempotency-key": "same-job-key",
      },
    });

    expect(revoke.status).toBe(204);
    expect((await request("/s/lists/operation-scope")).status).toBe(404);
  });

  it("does not replay one slug's idempotent PUT as another slug's update", async () => {
    const { request, create } = harness();
    await create("first-target");
    await create("second-target");
    const update = (slug: string, title: string) =>
      request(`/s/lists/${slug}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "if-match": '"1"',
          "idempotency-key": "shared-put-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({ document: guide({ title }) }),
      });

    expect((await update("first-target", "First updated")).status).toBe(200);
    const second = await update("second-target", "Second updated");
    if (second.status === 200) {
      expect(await second.json()).toMatchObject({ slug: "second-target" });
      const read = await request("/s/lists/second-target");
      expect((await read.json()) as SharedGuide).toMatchObject({ title: "Second updated" });
    } else {
      expect([400, 409, 422]).toContain(second.status);
    }
  });

  it("replays concurrent identical creates instead of returning a conflict to one retry", async () => {
    const { create } = harness();

    const responses = await Promise.all([
      create("concurrent-retry", { idKey: "one-create-job" }),
      create("concurrent-retry", { idKey: "one-create-job" }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(await responses[0]?.text()).toBe(await responses[1]?.text());
  });

  it("does not commit a revision without its audit and idempotency records", async () => {
    const { request, create } = harness(new UpdateAuditFailsOnceStorage());
    await create("atomic-update");
    const update = {
      method: "PUT",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "if-match": '"1"',
        "idempotency-key": "atomic-update-job",
        "content-type": "application/json",
      },
      body: JSON.stringify({ document: guide({ title: "Atomic title" }) }),
    } satisfies RequestInit;

    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const firstAttempt = await request("/s/lists/atomic-update", update);
    logged.mockRestore();
    expect(firstAttempt.status).toBe(500);
    const retry = await request("/s/lists/atomic-update", update);

    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ slug: "atomic-update", revision: 2 });
  });

  it("does not commit a revision when persisting its idempotent result fails", async () => {
    const { request, create } = harness(new UpdateIdempotencyFailsOnceStorage());
    await create("atomic-idempotency");
    const update = {
      method: "PUT",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "if-match": '"1"',
        "idempotency-key": "atomic-idempotency-job",
        "content-type": "application/json",
      },
      body: JSON.stringify({ document: guide({ title: "Committed once" }) }),
    } satisfies RequestInit;

    expect((await request("/s/lists/atomic-idempotency", update)).status).toBe(500);
    const retry = await request("/s/lists/atomic-idempotency", update);

    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ slug: "atomic-idempotency", revision: 2 });
  });

  it("does not replay success when the document write itself failed", async () => {
    const { request, create } = harness(new DocumentUpdateFailsOnceStorage());
    await create("atomic-document");
    const update = {
      method: "PUT",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "if-match": '"1"',
        "idempotency-key": "atomic-document-job",
        "content-type": "application/json",
      },
      body: JSON.stringify({ document: guide({ title: "Actually committed" }) }),
    } satisfies RequestInit;

    expect((await request("/s/lists/atomic-document", update)).status).toBe(500);
    expect((await request("/s/lists/atomic-document", update)).status).toBe(200);

    const read = await request("/s/lists/atomic-document");
    expect((await read.json()) as SharedGuide).toMatchObject({ title: "Actually committed" });
    expect(read.headers.get("etag")).toBe('"2"');
  });
});

describe("Phase 5 conditional, limit, and audit enforcement", () => {
  it("answers browser preflight for the separately hosted web client", async () => {
    const { request } = harness();

    const response = await request("/s/lists", {
      method: "OPTIONS",
      headers: {
        origin: "https://app.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type,idempotency-key,if-match",
      },
    });

    expect(response.status).toBeLessThan(300);
    expect(response.headers.get("access-control-allow-origin")).toBeTruthy();
    expect(response.headers.get("access-control-allow-methods")).toMatch(/POST/i);
    expect(response.headers.get("access-control-allow-headers")).toMatch(/authorization/i);
    expect(response.headers.get("access-control-allow-headers")).toMatch(/idempotency-key/i);
    expect(response.headers.get("access-control-allow-headers")).toMatch(/if-match/i);

    const mutation = await request("/s/lists", {
      method: "POST",
      headers: {
        origin: "https://app.example",
        authorization: `Bearer ${TOKEN}`,
        "idempotency-key": "cors-create",
        "content-type": "application/json",
      },
      body: JSON.stringify({ desiredSlug: "cors-guide", document: guide() }),
    });
    expect(mutation.status).toBe(201);
    expect(mutation.headers.get("access-control-allow-origin")).toBe("https://app.example");

    const read = await request("/s/lists/cors-guide", {
      headers: { origin: "https://app.example" },
    });
    expect(read.status).toBe(200);
    expect(read.headers.get("access-control-allow-origin")).toBe("https://app.example");
  });

  it("rejects a malformed If-Match value rather than parsing its numeric prefix", async () => {
    const { request, create } = harness();
    await create("strict-etag");

    const response = await request("/s/lists/strict-etag", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "if-match": '"1"garbage',
        "idempotency-key": "strict-etag-update",
        "content-type": "application/json",
      },
      body: JSON.stringify({ document: guide({ title: "Must not publish" }) }),
    });

    expect([400, 412]).toContain(response.status);
  });

  it("enforces document limits in UTF-8 bytes, not JavaScript code units", async () => {
    const { create } = harness();
    const body = "😀".repeat(30_000); // 60k UTF-16 units, 120k UTF-8 bytes
    const oversized = guide({
      blocks: Array.from({ length: 7 }, (_, index) => ({
        id: `section-${index.toString()}`,
        type: "section" as const,
        note: { body },
      })),
    });
    const serialized = JSON.stringify(oversized);
    expect(serialized.length).toBeLessThan(LIMITS.documentBytes);
    expect(new TextEncoder().encode(serialized).byteLength).toBeGreaterThan(LIMITS.documentBytes);

    const response = await create("utf8-byte-limit", { document: oversized });

    expect(response.status).toBe(413);
  });

  it("rate-limits slug creation by request source even when an attacker rotates tokens", async () => {
    const { create } = harness();
    const statuses: number[] = [];

    for (let index = 0; index <= LIMITS.mutationsPerMinute; index += 1) {
      const token = `${index.toString(36).padStart(2, "0")}${"x".repeat(41)}`;
      statuses.push(
        (
          await create(`rotating-token-${index.toString()}`, {
            token,
            idKey: `rotating-job-${index.toString()}`,
            ip: "203.0.113.10",
          })
        ).status,
      );
    }

    expect(statuses.some((status) => status === 403 || status === 429)).toBe(true);
  });

  it("rate-limits DELETE mutations as well as create and update", async () => {
    const { storage, request } = harness();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(TOKEN));
    const tokenHash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    for (let index = 0; index <= LIMITS.mutationsPerMinute; index += 1) {
      await storage.create({
        slug: `delete-rate-${index.toString()}`,
        kind: "list",
        revision: 1,
        tokenHash,
        body: JSON.stringify(guide()),
        createdAt: "2026-07-19T15:00:00.000Z",
        updatedAt: "2026-07-19T15:00:00.000Z",
        revoked: false,
      });
    }

    const statuses: number[] = [];
    for (let index = 0; index <= LIMITS.mutationsPerMinute; index += 1) {
      statuses.push(
        (
          await request(`/s/lists/delete-rate-${index.toString()}`, {
            method: "DELETE",
            headers: {
              authorization: `Bearer ${TOKEN}`,
              "if-match": '"1"',
              "idempotency-key": `delete-rate-job-${index.toString()}`,
            },
          })
        ).status,
      );
    }

    expect(statuses).toContain(429);
  });

  it("audits successful public reads as well as mutations", async () => {
    const { storage, request, create } = harness();
    await create("audited-read");

    expect((await request("/s/lists/audited-read")).status).toBe(200);

    expect(storage.auditEntries.map((entry) => String(entry.action))).toContain("read");
  });
});

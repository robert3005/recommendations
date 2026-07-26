import { describe, expect, it } from "vitest";
import { pullResponseSchema, syncMutationSchema } from "./sync";

const validList = {
  id: "list-1",
  name: "Lisbon",
  marker: { color: "#dc2626", icon: "circle" },
  createdAt: "2026-07-20T10:00:00.000Z",
  updatedAt: "2026-07-20T10:00:00.000Z",
};

const validMutation = {
  id: "mutation-1",
  actorId: "device-a",
  table: "lists" as const,
  entityId: "list-1",
  hlc: "000001753006400:000000:device-a",
  row: validList,
};

describe("sync entity envelopes", () => {
  it("accepts a complete, actor-bound entity snapshot", () => {
    expect(syncMutationSchema.parse(validMutation).row).toEqual(validList);
  });

  it("rejects mismatched ids, malformed entity rows, and forged HLC actors", () => {
    expect(
      syncMutationSchema.safeParse({ ...validMutation, entityId: "another-list" }).success,
    ).toBe(false);
    expect(
      syncMutationSchema.safeParse({ ...validMutation, row: { id: "list-1", name: "partial" } })
        .success,
    ).toBe(false);
    expect(
      syncMutationSchema.safeParse({
        ...validMutation,
        hlc: "000001753006400:000000:another-device",
      }).success,
    ).toBe(false);
  });

  it("applies the same validation to pulled changes", () => {
    expect(() =>
      pullResponseSchema.parse({
        cursor: "1",
        changes: [
          {
            seq: 1,
            ...validMutation,
            row: { ...validList, id: "forged" },
          },
        ],
      }),
    ).toThrow();
  });

  it("accepts a large causal context without dropping a newly seen actor", () => {
    const version = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`device-${index.toString()}`, index + 1]),
    );
    expect(syncMutationSchema.parse({ ...validMutation, version }).version).toEqual(version);
    expect(syncMutationSchema.safeParse({ ...validMutation, version: { device: 0 } }).success).toBe(
      false,
    );
  });

  it("rejects an HLC stamp with no representable successor", () => {
    expect(
      syncMutationSchema.safeParse({
        ...validMutation,
        hlc: "999999999999999:ffffff:device-a",
      }).success,
    ).toBe(false);
  });
});

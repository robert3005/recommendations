import { describe, expect, it } from "vitest";
import { SYNC_LIMITS, syncPullResponseSchema, syncPushSchema } from "./sync";

const row = { k: "a".repeat(64), c: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=" };

describe("sync wire contract", () => {
  it("accepts opaque rows and nothing that names a table or an id", () => {
    expect(syncPushSchema.parse({ rows: [row] })).toEqual({ rows: [row] });
    expect(() => syncPushSchema.parse({ rows: [{ ...row, k: "places:1" }] })).toThrow();
    expect(() => syncPushSchema.parse({ rows: [{ ...row, c: "not base64!" }] })).toThrow();
  });

  it("bounds a push", () => {
    expect(() => syncPushSchema.parse({ rows: [] })).toThrow();
    const tooMany = Array.from({ length: SYNC_LIMITS.rowsPerPush + 1 }, () => row);
    expect(() => syncPushSchema.parse({ rows: tooMany })).toThrow();
  });

  it("a pull response carries sequence numbers and a cursor", () => {
    const parsed = syncPullResponseSchema.parse({
      rows: [{ ...row, seq: 7 }],
      cursor: 7,
      more: false,
    });
    expect(parsed.rows[0]?.seq).toBe(7);
  });
});

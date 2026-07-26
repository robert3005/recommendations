import { describe, expect, it } from "vitest";
import {
  compareVersionVectors,
  decodeHlc,
  encodeHlc,
  incrementVersionVector,
  mergeHlc,
  mergeRemoteChange,
  mergeVersionVectors,
  type RemoteChange,
  tickHlc,
} from "./sync";

describe("hybrid logical clock", () => {
  it("encodes sortably: later events compare greater as strings", () => {
    const a = encodeHlc({ millis: 1000, counter: 0, actorId: "a" });
    const b = encodeHlc({ millis: 1000, counter: 1, actorId: "a" });
    const c = encodeHlc({ millis: 2000, counter: 0, actorId: "a" });
    expect(a < b && b < c).toBe(true);
    expect(decodeHlc(b)).toEqual({ millis: 1000, counter: 1, actorId: "a" });
  });

  it("stays monotonic against a stalled or reversed wall clock", () => {
    let clock = tickHlc(undefined, 5000, "a");
    const first = clock;
    clock = tickHlc(clock, 5000, "a");
    expect(clock > first).toBe(true);
    const second = clock;
    clock = tickHlc(clock, 4000, "a"); // wall clock went BACKWARDS
    expect(clock > second).toBe(true);
  });

  it("merging a remote stamp keeps later local events after it", () => {
    const local = tickHlc(undefined, 1000, "a");
    const remote = encodeHlc({ millis: 9000, counter: 3, actorId: "b" });
    const merged = mergeHlc(local, remote, 1000, "a");
    expect(merged > remote).toBe(true);
    expect(decodeHlc(merged).actorId).toBe("a");
  });

  it("rolls a saturated counter into the next millisecond and rejects total exhaustion", () => {
    const saturated = encodeHlc({ millis: 5000, counter: 0xffffff, actorId: "a" });
    expect(decodeHlc(tickHlc(saturated, 4000, "a"))).toEqual({
      millis: 5001,
      counter: 0,
      actorId: "a",
    });
    const exhausted = encodeHlc({
      millis: 999_999_999_999_999,
      counter: 0xffffff,
      actorId: "a",
    });
    expect(() => tickHlc(exhausted, 0, "a")).toThrow(/no representable successor/);
  });
});

describe("version vectors", () => {
  it("distinguishes causal successors from concurrent edits", () => {
    expect(compareVersionVectors({ a: 1 }, { a: 1, b: 1 })).toBe("before");
    expect(compareVersionVectors({ a: 2 }, { a: 1, b: 1 })).toBe("concurrent");
    expect(compareVersionVectors({ a: 2, b: 1 }, { a: 1 })).toBe("after");
    expect(compareVersionVectors({ a: 2 }, { a: 2 })).toBe("equal");
  });

  it("never truncates a new actor from a large causal context", () => {
    const prior = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`device-${index.toString()}`, index + 1]),
    );
    const merged = mergeVersionVectors(prior, { newcomer: 1 });
    const incremented = incrementVersionVector(merged, "writer");
    expect(Object.keys(incremented)).toHaveLength(42);
    expect(incremented).toMatchObject({ newcomer: 1, writer: 1, "device-0": 1 });
  });
});

function change(overrides: Partial<RemoteChange>): RemoteChange {
  return {
    table: "notes",
    entityId: "note-1",
    hlc: "000000000005000:000000:b",
    actorId: "b",
    row: { id: "note-1", body: "remote", updatedAt: "2026-07-20T10:00:00.000Z" },
    ...overrides,
  };
}

describe("mergeRemoteChange", () => {
  it("drops changes at or below the known local revision (idempotent replay)", () => {
    const decision = mergeRemoteChange(change({}), {
      local: { id: "note-1", body: "local" },
      localRev: "000000000005000:000000:b",
      locallyDirty: false,
      newId: () => "copy-1",
      now: "2026-07-20T11:00:00.000Z",
    });
    expect(decision.apply).toBe(false);
  });

  it("applies newer rows last-writer-wins when there is no concurrent local edit", () => {
    const decision = mergeRemoteChange(change({}), {
      local: { id: "note-1", body: "local" },
      localRev: "000000000004000:000000:a",
      locallyDirty: false,
      newId: () => "copy-1",
      now: "2026-07-20T11:00:00.000Z",
    });
    expect(decision).toMatchObject({ apply: true, row: { body: "remote" } });
    expect(decision.apply && decision.conflictCopy).toBeFalsy();
  });

  it("preserves BOTH bodies of a concurrent Markdown edit via a conflict copy", () => {
    const decision = mergeRemoteChange(change({}), {
      local: { id: "note-1", body: "local words", title: "Mine" },
      localRev: "000000000004000:000000:a",
      locallyDirty: true,
      newId: () => "copy-1",
      now: "2026-07-20T11:00:00.000Z",
    });
    if (!decision.apply) throw new Error("expected apply");
    expect(decision.row).toMatchObject({ body: "remote" });
    expect(decision.conflictCopy?.row).toMatchObject({
      id: expect.stringMatching(/^conflict-note-/),
      body: "local words",
      title: "(conflict copy) Mine",
      shareable: false,
    });
  });

  it("preserves local Markdown when the concurrent incoming note is a tombstone", () => {
    const decision = mergeRemoteChange(
      change({ row: { id: "note-1", body: "old body", deleted: true } }),
      {
        local: { id: "note-1", body: "words still being written", shareable: true },
        localRev: "000000000004000:000000:a",
        locallyDirty: true,
        newId: () => "copy-after-delete",
        now: "2026-07-20T11:00:00.000Z",
      },
    );
    if (!decision.apply) throw new Error("expected apply");
    expect(decision.row).toMatchObject({ deleted: true });
    expect(decision.conflictCopy?.row).toMatchObject({
      id: expect.stringMatching(/^conflict-note-/),
      body: "words still being written",
      shareable: false,
    });
  });

  it("does not conflict-copy a causal successor observed and edited by another device", () => {
    const decision = mergeRemoteChange(change({ version: { a: 1, b: 2 } }), {
      local: { id: "note-1", body: "observed body" },
      localRev: "000000000004000:000000:a",
      localVersion: { a: 1, b: 1 },
      locallyDirty: true,
      newId: () => "unused",
      now: "2026-07-20T11:00:00.000Z",
    });
    expect(decision).toMatchObject({ apply: true, row: { body: "remote" } });
    expect(decision.apply && decision.conflictCopy).toBeFalsy();
  });

  it("falls back safely when a legacy incoming note meets a vector-aware local revision", () => {
    const decision = mergeRemoteChange(change({ version: undefined }), {
      local: { id: "note-1", body: "local unpushed words" },
      localRev: "000000000004000:000000:a",
      localVersion: { a: 1 },
      locallyDirty: true,
      newId: () => "unused",
      now: "2026-07-20T11:00:00.000Z",
    });
    if (!decision.apply) throw new Error("legacy remote edit was silently dropped");
    expect(decision.row).toMatchObject({ body: "remote" });
    expect(decision.conflictCopy?.row).toMatchObject({ body: "local unpushed words" });
  });

  it("preserves a lower-HLC legacy note when a higher-HLC local edit is still dirty", () => {
    const decision = mergeRemoteChange(
      change({
        hlc: "000000000003000:000000:b",
        version: undefined,
        row: { id: "note-1", body: "older-clock concurrent words" },
      }),
      {
        local: { id: "note-1", body: "higher-clock local words" },
        localRev: "000000000004000:000000:a",
        localVersion: { a: 1 },
        locallyDirty: true,
        newId: () => "unused",
        now: "2026-07-20T11:00:00.000Z",
      },
    );
    if (!decision.apply) throw new Error("legacy remote edit was silently dropped");
    expect(decision.row).toMatchObject({ body: "higher-clock local words" });
    expect(decision.conflictCopy?.row).toMatchObject({ body: "older-clock concurrent words" });
  });

  it("mints the same byte-identical conflict copy on both receivers", () => {
    const a = {
      id: "note-1",
      target: { kind: "place", placeId: "place-1" },
      title: "A",
      body: "device A words",
      shareable: true,
      createdAt: "2026-07-20T09:00:00.000Z",
      updatedAt: "2026-07-20T10:00:00.000Z",
    };
    const b = { ...a, title: "B", body: "device B words", updatedAt: "2026-07-20T10:01:00.000Z" };
    const aRev = "000000000004000:000000:a";
    const bRev = "000000000005000:000000:b";
    const onA = mergeRemoteChange(change({ hlc: bRev, version: { b: 1 }, row: b }), {
      local: a,
      localRev: aRev,
      localVersion: { a: 1 },
      newId: () => "random-a",
      now: "2026-07-20T12:00:00.000Z",
    });
    const onB = mergeRemoteChange(change({ hlc: aRev, actorId: "a", version: { a: 1 }, row: a }), {
      local: b,
      localRev: bRev,
      localVersion: { b: 1 },
      newId: () => "random-b",
      now: "2026-07-21T12:00:00.000Z",
    });
    if (!onA.apply || !onB.apply) throw new Error("expected concurrent merge");
    expect(onA.conflictCopy).toEqual(onB.conflictCopy);
    expect(onA.conflictCopy?.row).toMatchObject({
      body: "device A words",
      createdAt: a.updatedAt,
      updatedAt: a.updatedAt,
      shareable: false,
    });
  });

  it("unions former OSM refs and flags conflicting relinks needs-review", () => {
    // Overlapping sets: node/1 is on both sides and must not duplicate.
    const localPast = [
      { type: "node", id: "1" },
      { type: "node", id: "2" },
    ];
    const remotePast = [
      { type: "node", id: "1" },
      { type: "way", id: "9" },
    ];
    const decision = mergeRemoteChange(
      change({
        table: "places",
        entityId: "place-1",
        row: {
          id: "place-1",
          currentOsmRef: { type: "way", id: "77" },
          pastOsmRefs: remotePast,
          resolutionState: "resolved",
        },
      }),
      {
        local: {
          id: "place-1",
          currentOsmRef: { type: "node", id: "55" },
          pastOsmRefs: localPast,
          resolutionState: "resolved",
        },
        localRev: "000000000004000:000000:a",
        locallyDirty: true,
        newId: () => "copy-1",
        now: "2026-07-20T11:00:00.000Z",
      },
    );
    if (!decision.apply) throw new Error("expected apply");
    const merged = decision.row as {
      pastOsmRefs: { type: string; id: string }[];
      resolutionState: string;
    };
    // Union of both sides' former refs — nothing lost, nothing duplicated.
    expect(new Set(merged.pastOsmRefs.map((ref) => `${ref.type}/${ref.id}`))).toEqual(
      new Set(["node/1", "way/9", "node/2", "node/55"]),
    );
    // The losing side's current ref is retained, so no device forgets it.
    expect(merged.pastOsmRefs).toContainEqual({ type: "node", id: "55" });
    // Two sides chose DIFFERENT current elements: the owner reviews.
    expect(merged.resolutionState).toBe("needs-review");
  });
});

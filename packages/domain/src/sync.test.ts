import { describe, expect, it } from "vitest";
import {
  decodeHlc,
  encodeHlc,
  mergeHlc,
  mergeRemoteChange,
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
      id: "copy-1",
      body: "local words",
      title: "(conflict copy) Mine",
      shareable: false,
    });
  });

  it("merges place link history append-only and flags conflicting relinks needs-review", () => {
    const localHistory = [
      { ref: { type: "node", id: "1" }, linkedAt: "t1", unlinkedAt: "t2" },
      { ref: { type: "node", id: "2" }, linkedAt: "t2", unlinkedAt: "t3" },
    ];
    const remoteHistory = [
      { ref: { type: "node", id: "1" }, linkedAt: "t1", unlinkedAt: "t2" },
      { ref: { type: "way", id: "9" }, linkedAt: "t2", unlinkedAt: "t4" },
    ];
    const decision = mergeRemoteChange(
      change({
        table: "places",
        entityId: "place-1",
        row: {
          id: "place-1",
          currentOsmRef: { type: "way", id: "77" },
          osmRefHistory: remoteHistory,
          resolutionState: "resolved",
        },
      }),
      {
        local: {
          id: "place-1",
          currentOsmRef: { type: "node", id: "55" },
          osmRefHistory: localHistory,
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
      osmRefHistory: { ref: { type: string; id: string } }[];
      resolutionState: string;
    };
    // Union of both histories — nothing lost, nothing duplicated.
    expect(merged.osmRefHistory.map((entry) => `${entry.ref.type}/${entry.ref.id}`)).toEqual([
      "node/1",
      "way/9",
      "node/2",
    ]);
    // Two sides chose DIFFERENT current elements: the owner reviews.
    expect(merged.resolutionState).toBe("needs-review");
  });
});

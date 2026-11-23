import { describe, expect, it } from "vitest";
import type { Place } from "./entities";
import {
  deletionWins,
  effectiveTagLog,
  incomingRowWins,
  logTagChange,
  mergePlace,
  mergeTagLogs,
  tagsOf,
} from "./sync";

const T1 = "2026-11-23T10:00:00.000Z";
const T2 = "2026-11-23T11:00:00.000Z";
const T3 = "2026-11-23T12:00:00.000Z";
const NOW = "2026-11-23T13:00:00.000Z";

const place = (over: Partial<Place> = {}): Place => ({
  id: "p1",
  name: "Brat",
  lat: 51.52,
  lng: -0.07,
  origin: "search",
  createdAt: T1,
  updatedAt: T1,
  ...over,
});

/** A place as a device leaves it after editing its tags at `at`. */
function tagged(base: Place, tags: string[], at: string, over: Partial<Place> = {}): Place {
  return { ...base, ...over, tags, tagLog: logTagChange(base, tags, at), updatedAt: at };
}

describe("tag logs", () => {
  it("stamps what an edit added and what it removed", () => {
    const before = tagged(place(), ["wine", "brunch"], T1);
    const log = logTagChange(before, ["wine", "date night"], T2);
    expect(log).toEqual({
      wine: { at: T1, on: true },
      brunch: { at: T2, on: false },
      "date night": { at: T2, on: true },
    });
    expect(tagsOf(log)).toEqual(["date night", "wine"]);
  });

  it("treats a tag without a log entry as put on when the place was last updated", () => {
    expect(effectiveTagLog(place({ tags: ["wine"], updatedAt: T2 }))).toEqual({
      wine: { at: T2, on: true },
    });
  });

  it("merges per tag by the later stamp; a tie keeps the tag", () => {
    const merged = mergeTagLogs(
      { wine: { at: T1, on: true }, brunch: { at: T2, on: false } },
      { wine: { at: T2, on: false }, brunch: { at: T1, on: true }, cosy: { at: T1, on: true } },
    );
    expect(tagsOf(merged)).toEqual(["cosy"]);
    expect(
      tagsOf(mergeTagLogs({ wine: { at: T1, on: false } }, { wine: { at: T1, on: true } })),
    ).toEqual(["wine"]);
  });
});

describe("mergePlace", () => {
  it("keeps a tag added on each device — tags merge as a set", () => {
    const base = place();
    const phone = tagged(base, ["date night"], T2);
    const laptop = tagged(base, ["wood fire"], T3, { note: "Order the turbot." });

    const onPhone = mergePlace(phone, laptop, NOW);
    expect(onPhone.kind).toBe("merged");
    if (onPhone.kind !== "merged") throw new Error("unreachable");
    expect(onPhone.place.tags).toEqual(["date night", "wood fire"]);
    // Every other field is the later copy's.
    expect(onPhone.place.note).toBe("Order the turbot.");
    // The merged row out-ranks both sources, so it wins on every device.
    expect(onPhone.place.updatedAt > T3).toBe(true);

    // The other device, merging the other way round, reaches the same tags.
    const onLaptop = mergePlace(laptop, phone, NOW);
    expect(onLaptop.kind).toBe("merged");
    if (onLaptop.kind !== "merged") throw new Error("unreachable");
    expect(onLaptop.place.tags).toEqual(["date night", "wood fire"]);
  });

  it("a removal on one device is not undone by an older copy on the other", () => {
    const shared = tagged(place(), ["wine", "brunch"], T1);
    const removedOnPhone = tagged(shared, ["wine"], T3);
    const renamedOnLaptop = { ...shared, name: "Brat Restaurant", updatedAt: T2 };

    const merged = mergePlace(renamedOnLaptop, removedOnPhone, NOW);
    expect(merged.kind).toBe("incoming");
    if (merged.kind !== "incoming") throw new Error("unreachable");
    expect(merged.place.tags).toEqual(["wine"]);

    const other = mergePlace(removedOnPhone, renamedOnLaptop, NOW);
    expect(other.kind).toBe("local");
  });

  it("takes the incoming row untouched when it is simply newer", () => {
    const local = place({ note: "old" });
    const incoming = place({ note: "new", updatedAt: T2 });
    expect(mergePlace(local, incoming, NOW)).toEqual({ kind: "incoming", place: incoming });
  });

  it("keeps the local row when it is newer or the same", () => {
    expect(mergePlace(place({ updatedAt: T2 }), place(), NOW)).toEqual({ kind: "local" });
    expect(mergePlace(place(), place(), NOW)).toEqual({ kind: "local" });
  });

  it("converges: merging the merged row again changes nothing", () => {
    const phone = tagged(place(), ["a"], T2);
    const laptop = tagged(place(), ["b"], T3);
    const first = mergePlace(phone, laptop, NOW);
    if (first.kind !== "merged") throw new Error("unreachable");
    // The laptop receives the phone's merged row…
    const second = mergePlace(laptop, first.place, NOW);
    expect(second).toEqual({ kind: "incoming", place: first.place });
    // …and the phone, seeing its own row come back, does nothing.
    expect(mergePlace(first.place, first.place, NOW)).toEqual({ kind: "local" });
  });
});

describe("rows and deletions", () => {
  it("last writer wins between rows", () => {
    expect(incomingRowWins(undefined, { updatedAt: T1 })).toBe(true);
    expect(incomingRowWins({ updatedAt: T1 }, { updatedAt: T2 })).toBe(true);
    expect(incomingRowWins({ updatedAt: T2 }, { updatedAt: T1 })).toBe(false);
    expect(incomingRowWins({ updatedAt: T1 }, { updatedAt: T1 })).toBe(false);
  });

  it("breaks an exact tie by content, the same way round on both devices", () => {
    const a = { updatedAt: T1, note: "a" };
    const b = { updatedAt: T1, note: "b" };
    // Exactly one of the two devices gives way, so they end up agreeing.
    expect(incomingRowWins(a, b)).not.toBe(incomingRowWins(b, a));
    expect(incomingRowWins(a, { ...a })).toBe(false);
  });

  it("a deletion stands unless the row was edited after it", () => {
    expect(deletionWins(T2, undefined)).toBe(true);
    expect(deletionWins(T2, { updatedAt: T1 })).toBe(true);
    expect(deletionWins(T2, { updatedAt: T2 })).toBe(true);
    expect(deletionWins(T2, { updatedAt: T3 })).toBe(false);
  });
});

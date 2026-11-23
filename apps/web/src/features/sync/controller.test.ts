/**
 * Turning sync on, joining, and leaving (spec/src/sync.md §Pairing), against
 * the real service app: a code made on one device opens the library on
 * another, a code that opens nothing is refused, and leaving keeps the data.
 */
import { createShareApp, MemoryStorage } from "@placemarks/share-service";
import { beforeEach, describe, expect, it } from "vitest";
import { DexieRepository } from "../../data/repo";
import {
  deleteSyncedCopy,
  joinSync,
  leaveSync,
  runSync,
  type SyncDeps,
  startSync,
  storedCode,
  useSyncStatus,
} from "./controller";
import { newLibraryCode } from "./crypto";
import { collectPending } from "./engine";
import { httpTransport } from "./transport";

let counter = 0;
let storage: MemoryStorage;
let deps: SyncDeps;
let first: DexieRepository;
let second: DexieRepository;

beforeEach(() => {
  counter += 1;
  storage = new MemoryStorage();
  const app = createShareApp({ storage });
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(app.request(String(input), init))) as typeof fetch;
  deps = { transportFor: (keys) => httpTransport(keys, fetcher, "https://share.test") };
  first = new DexieRepository(`ctl-first-${Date.now()}-${counter}`);
  second = new DexieRepository(`ctl-second-${Date.now()}-${counter}`);
  useSyncStatus.setState({ phase: "off", error: undefined, reason: undefined });
});

const savePlace = (repo: DexieRepository, name: string) =>
  repo.savePlace({ name, lat: 51.5, lng: -0.1, origin: "search" }, { forceNew: true });

describe("pairing", () => {
  it("turning sync on makes a code, sends the library, and a second device joins with it", async () => {
    await savePlace(first, "Brat");
    const code = await startSync(first.db, deps);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await storedCode(first.db)).toBe(code);
    expect(useSyncStatus.getState().phase).toBe("idle");

    await savePlace(second, "Kiln");
    await joinSync(second.db, `https://app.example/settings#pair=${code}`, deps);
    const names = (await second.listPlaceViews()).map((v) => v.place.name).sort();
    // What the joining device already had is kept and merged in.
    expect(names).toEqual(["Brat", "Kiln"]);

    await runSync(first.db, deps);
    expect((await first.listPlaceViews()).map((v) => v.place.name).sort()).toEqual([
      "Brat",
      "Kiln",
    ]);
  });

  it("refuses a well-formed code that opens no library, and turns nothing on", async () => {
    await expect(joinSync(second.db, newLibraryCode(), deps)).rejects.toMatchObject({
      reason: "no-library",
    });
    expect(await storedCode(second.db)).toBeUndefined();
    await expect(joinSync(second.db, "nonsense", deps)).rejects.toThrow("not a library code");
  });

  it("does nothing while sync is off", async () => {
    await savePlace(first, "Brat");
    expect(await runSync(first.db, deps)).toBeUndefined();
    expect(useSyncStatus.getState().phase).toBe("off");
  });

  it("leaving keeps the library here and on the service; rejoining converges", async () => {
    await savePlace(first, "Brat");
    const code = await startSync(first.db, deps);
    await leaveSync(first.db);
    expect(await storedCode(first.db)).toBeUndefined();
    expect(await first.listPlaceViews()).toHaveLength(1);
    expect(useSyncStatus.getState().phase).toBe("off");

    await joinSync(first.db, code, deps);
    expect(await first.listPlaceViews()).toHaveLength(1);
    expect(await collectPending(first.db)).toEqual([]);
  });

  it("deleting the synced copy empties the service and leaves each device its library", async () => {
    await savePlace(first, "Brat");
    const code = await startSync(first.db, deps);
    await joinSync(second.db, code, deps);

    await deleteSyncedCopy(first.db, deps);
    expect(await first.listPlaceViews()).toHaveLength(1);
    expect(await storedCode(first.db)).toBeUndefined();

    // The other device still has its copy and is told plainly why sync stopped.
    await runSync(second.db, deps);
    expect(await second.listPlaceViews()).toHaveLength(1);
    expect(useSyncStatus.getState()).toMatchObject({ phase: "error", reason: "no-library" });
  });

  it("reports an unreachable service as offline, not as a failure of the library", async () => {
    await savePlace(first, "Brat");
    await startSync(first.db, deps);
    const offline: SyncDeps = {
      transportFor: (keys) =>
        httpTransport(
          keys,
          (() => Promise.reject(new TypeError("network"))) as typeof fetch,
          "https://share.test",
        ),
    };
    await savePlace(first, "Kiln");
    await runSync(first.db, offline);
    expect(useSyncStatus.getState()).toMatchObject({ phase: "error", reason: "offline" });
    expect((await collectPending(first.db)).length).toBe(1);
  });
});

/**
 * Turning sync on, joining, leaving, and running a cycle
 * (spec/src/sync.md §Pairing). One cycle runs at a time; a request made while
 * one is running makes it run once more afterwards, so a change that lands
 * mid-cycle is never left waiting for the next timer.
 */
import { create } from "zustand";
import type { PlacemarksDb } from "../../data/db";
import { nowIso } from "../../lib/time";
import { deriveKeys, newLibraryCode, parseLibraryCode } from "./crypto";
import {
  resetExchangeState,
  SYNC_CODE_KEY,
  SYNC_LAST_AT_KEY,
  type SyncSummary,
  syncOnce,
} from "./engine";
import { httpTransport, SyncError, type SyncTransport } from "./transport";

export type SyncPhase = "off" | "idle" | "syncing" | "error";

interface SyncStatus {
  phase: SyncPhase;
  /** A message fit to show when `phase` is "error". */
  error?: string;
  /** Why it failed — "offline" is expected and shown quietly. */
  reason?: SyncError["reason"];
  lastSyncedAt?: string;
  set: (patch: Partial<Omit<SyncStatus, "set">>) => void;
}

export const useSyncStatus = create<SyncStatus>((set) => ({
  phase: "off",
  set: (patch) => set(patch),
}));

export interface SyncDeps {
  /** Test seam: the transport for a set of keys. */
  transportFor?: (keys: Awaited<ReturnType<typeof deriveKeys>>) => SyncTransport;
  now?: () => string;
}

const transportOf = (deps: SyncDeps, keys: Awaited<ReturnType<typeof deriveKeys>>) =>
  (deps.transportFor ?? ((k) => httpTransport(k)))(keys);

export async function storedCode(db: PlacemarksDb): Promise<string | undefined> {
  const value = (await db.settings.get(SYNC_CODE_KEY))?.value;
  return typeof value === "string" ? parseLibraryCode(value) : undefined;
}

let running: Promise<SyncSummary | undefined> | undefined;
let again = false;

/**
 * Run a cycle if sync is on. Never throws: the outcome is the status store,
 * which is what the interface shows.
 */
export function runSync(db: PlacemarksDb, deps: SyncDeps = {}): Promise<SyncSummary | undefined> {
  if (running) {
    again = true;
    return running;
  }
  const status = useSyncStatus.getState();
  running = (async () => {
    try {
      const code = await storedCode(db);
      if (!code) {
        status.set({ phase: "off" });
        return undefined;
      }
      status.set({ phase: "syncing" });
      const keys = await deriveKeys(code);
      const summary = await syncOnce(db, keys, transportOf(deps, keys), deps.now ?? nowIso);
      const last = (await db.settings.get(SYNC_LAST_AT_KEY))?.value;
      useSyncStatus.setState({
        phase: "idle",
        error: undefined,
        reason: undefined,
        ...(typeof last === "string" ? { lastSyncedAt: last } : {}),
      });
      return summary;
    } catch (err) {
      const reason = err instanceof SyncError ? err.reason : "failed";
      status.set({
        phase: "error",
        reason,
        error: err instanceof Error ? err.message : "Sync failed.",
      });
      return undefined;
    } finally {
      running = undefined;
      if (again) {
        again = false;
        void runSync(db, deps);
      }
    }
  })();
  return running;
}

/**
 * Turn sync on for this library: make a key, claim its place on the service,
 * and send the library. Returns the code to pair other devices with.
 */
export async function startSync(db: PlacemarksDb, deps: SyncDeps = {}): Promise<string> {
  const code = newLibraryCode();
  const keys = await deriveKeys(code);
  await transportOf(deps, keys).claim();
  await resetExchangeState(db);
  await db.settings.put({ key: SYNC_CODE_KEY, value: code });
  await runSync(db, deps);
  return code;
}

/**
 * Join a library that another device started. The code must open an existing
 * library — a mistyped code is refused rather than quietly starting a new,
 * empty one. Whatever this device already holds is merged in and sent.
 */
export async function joinSync(db: PlacemarksDb, raw: string, deps: SyncDeps = {}): Promise<void> {
  const code = parseLibraryCode(raw);
  if (!code) throw new SyncError("That is not a library code.", "failed");
  const keys = await deriveKeys(code);
  // A pull is the existence check: 404 means no device ever started this library.
  await transportOf(deps, keys).pull(0);
  await resetExchangeState(db);
  await db.settings.put({ key: SYNC_CODE_KEY, value: code });
  await runSync(db, deps);
}

/** Stop syncing on this device. The library stays here, and stays on the service. */
export async function leaveSync(db: PlacemarksDb): Promise<void> {
  await db.settings.delete(SYNC_CODE_KEY);
  await resetExchangeState(db);
  useSyncStatus.setState({
    phase: "off",
    error: undefined,
    reason: undefined,
    lastSyncedAt: undefined,
  });
}

/**
 * Delete the synced copy from the service, then stop syncing here. Other
 * devices keep their libraries and report that the synced copy is gone.
 */
export async function deleteSyncedCopy(db: PlacemarksDb, deps: SyncDeps = {}): Promise<void> {
  const code = await storedCode(db);
  if (code) {
    const keys = await deriveKeys(code);
    await transportOf(deps, keys).remove();
  }
  await leaveSync(db);
}

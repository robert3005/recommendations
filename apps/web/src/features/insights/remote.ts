/**
 * Hosted review insights (spec/src/reviews.md §Hosted on import): the share
 * service reads a Google place's reviews and answers with what it learned —
 * place facts, photo links and the profile, never review text. Places queue
 * here after an import, from Settings, or from one place card; a small runner
 * works through them while the app is open and stops on the first answer that
 * would fail every place the same way (no key, wrong key, budget used up).
 *
 * The access key is the operator's: it lives in this browser's local storage
 * only, never in the library, sync or anything published.
 */
import type { Place, PlaceProfile } from "@placemarks/domain";
import { useSyncExternalStore } from "react";
import { SHARE_API_URL } from "../../config";
import { type InsightsDb, insightsDb, type PhotoRow, type PlaceSourceRow } from "./db";
import { placeSourceKey } from "./hooks";

const KEY_STORAGE = "placemarks.insightsAccessKey";

export function readAccessKey(): string | undefined {
  try {
    return localStorage.getItem(KEY_STORAGE)?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function saveAccessKey(key: string): void {
  try {
    if (key.trim()) localStorage.setItem(KEY_STORAGE, key.trim());
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    // Private mode: the key lasts for this page only.
  }
  notify();
}

/** The service's answer (services/share/src/insights.ts InsightsPayload). */
interface InsightsPayload {
  sourcePlaceKey: string;
  fetchedAt: string;
  place: { name?: string; rating?: number; ratingCount?: number; priceLevel?: number };
  photos: {
    id: string;
    url: string;
    caption?: string;
    attribution: { name: string; url?: string };
    source: string;
  }[];
  reviewCount: number;
  writtenCount: number;
  profile?: PlaceProfile;
}

export type InsightsTarget = Pick<Place, "name" | "lat" | "lng" | "googleUrl">;

export class InsightsError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "InsightsError";
  }
  /** Answers that would fail every other place the same way. */
  get stopsQueue(): boolean {
    return [401, 403, 429, 501].includes(this.status);
  }
}

/** Ask the service for one place and store the answer. */
export async function fetchPlaceInsights(
  place: InsightsTarget,
  opts: { refresh?: boolean; now: string; db?: InsightsDb; fetchImpl?: typeof fetch },
): Promise<PlaceSourceRow> {
  const key = placeSourceKey(place);
  if (!key) throw new InsightsError("This place has no Google listing link.", 400);
  const accessKey = readAccessKey();
  if (!accessKey) throw new InsightsError("Add the review-insights access key in Settings.", 401);
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${SHARE_API_URL}/i/places`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessKey}` },
      body: JSON.stringify({
        sourcePlaceKey: key,
        name: place.name,
        lat: place.lat,
        lng: place.lng,
        ...(opts.refresh ? { refresh: true } : {}),
      }),
    });
  } catch {
    throw new InsightsError("The review-insights service is unreachable.", 0);
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 200);
    const message =
      res.status === 403
        ? "The review-insights access key is wrong."
        : res.status === 501
          ? "Review insights are not set up on the service yet."
          : text || `The service answered ${res.status}.`;
    throw new InsightsError(message, res.status);
  }
  const payload = (await res.json()) as InsightsPayload;
  return storePayload(payload, opts.now, opts.db);
}

async function storePayload(
  payload: InsightsPayload,
  now: string,
  db: InsightsDb = insightsDb(),
): Promise<PlaceSourceRow> {
  const key = payload.sourcePlaceKey;
  const source: PlaceSourceRow = {
    sourcePlaceKey: key,
    name: payload.place.name,
    rating: payload.place.rating,
    ratingCount: payload.place.ratingCount,
    priceLevel: payload.place.priceLevel,
    loadedAt: now,
    origin: "service",
    fetchedAt: payload.fetchedAt,
    reviewCount: payload.reviewCount,
    writtenCount: payload.writtenCount,
  };
  const photos: PhotoRow[] = payload.photos
    // https from Google; a same-origin path only from the dev mock's sample photos.
    .filter((p) => /^(https:\/\/|\/(?!\/))/.test(p.url) && p.attribution?.name)
    .map((p) => ({
      id: p.id,
      sourcePlaceKey: key,
      url: p.url,
      attribution: p.attribution,
      source: p.source,
    }));
  await db.transaction("rw", db.placeSources, db.photos, db.placeProfiles, async () => {
    await db.placeSources.put(source);
    await db.photos.where("sourcePlaceKey").equals(key).delete();
    if (photos.length) await db.photos.bulkPut(photos);
    if (payload.profile) await db.placeProfiles.put(payload.profile);
    else await db.placeProfiles.delete(key);
  });
  return source;
}

// ── The queue ────────────────────────────────────────────────────────────────

export interface QueueState {
  queued: number;
  done: number;
  failed: number;
  running: boolean;
  /** Why the runner stopped early, or the last per-place failure. */
  error?: string;
}

let state: QueueState = { queued: 0, done: 0, failed: 0, running: false };
const listeners = new Set<() => void>();
const pending = new Map<string, InsightsTarget>();
let runner: Promise<void> | undefined;

function notify() {
  for (const l of listeners) l();
}
function setState(patch: Partial<QueueState>) {
  state = { ...state, ...patch };
  notify();
}

export function useInsightsQueue(): QueueState & { hasKey: boolean } {
  const s = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
  return { ...s, hasKey: Boolean(readAccessKey()) };
}

/** Library places with a Google listing whose insights are not loaded yet. */
export async function placesMissingInsights(
  places: InsightsTarget[],
  db: InsightsDb = insightsDb(),
): Promise<InsightsTarget[]> {
  const out: InsightsTarget[] = [];
  const seen = new Set<string>();
  for (const place of places) {
    const key = placeSourceKey(place);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (!(await db.placeSources.get(key))) out.push(place);
  }
  return out;
}

/**
 * Queue places and start the runner if it is idle. Nothing happens without an
 * access key, so an import on a device without one costs nothing.
 */
export function queueInsights(places: InsightsTarget[], now: () => string): number {
  if (!readAccessKey()) return 0;
  let added = 0;
  for (const place of places) {
    const key = placeSourceKey(place);
    if (!key || pending.has(key)) continue;
    pending.set(key, place);
    added++;
  }
  if (added === 0) return 0;
  setState({ queued: state.queued + added, ...(runner ? {} : { error: undefined }) });
  runner ??= run(now).finally(() => {
    runner = undefined;
    setState({ running: false });
  });
  return added;
}

/** After an import: every library place with a Google listing and no insights yet. */
export async function queueMissingInsights(
  repo: { listPlaceViews(): Promise<{ place: Place }[]> },
  now: () => string,
): Promise<number> {
  if (!readAccessKey()) return 0;
  const views = await repo.listPlaceViews();
  return queueInsights(await placesMissingInsights(views.map((v) => v.place)), now);
}

const CONCURRENCY = 2;

async function run(now: () => string): Promise<void> {
  setState({ running: true });
  let stop = false;
  const worker = async () => {
    while (!stop) {
      const next = pending.entries().next();
      if (next.done) return;
      const [key, place] = next.value;
      pending.delete(key);
      try {
        await fetchPlaceInsights(place, { now: now() });
        setState({ done: state.done + 1 });
      } catch (err) {
        const e = err instanceof InsightsError ? err : new InsightsError(String(err), 0);
        if (e.stopsQueue) {
          stop = true;
          // What was not tried goes back to "not queued"; a later run picks it up.
          const dropped = pending.size + 1;
          pending.clear();
          setState({ queued: Math.max(0, state.queued - dropped), error: e.message });
          return;
        }
        setState({ failed: state.failed + 1, error: `${place.name}: ${e.message}` });
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

/** Test seam. */
export function resetInsightsQueue(): void {
  pending.clear();
  state = { queued: 0, done: 0, failed: 0, running: false };
  notify();
}

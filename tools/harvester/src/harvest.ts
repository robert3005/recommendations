/**
 * A harvest run: skip what is fresh, respect the daily cap, hand the rest to
 * the provider in small paced batches, save each place as it arrives, and
 * record every input's outcome in the manifest after each batch — so an
 * interrupted run loses at most one batch and a re-run picks up the rest.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { googleFeatureId } from "@placemarks/domain";
import type { HarvestRun, HarvestRunItem } from "@placemarks/schemas";
import type { HarvestInput, HarvestOptions, Provider } from "./providers/types";
import type { HarvestStore } from "./store";

export interface RunSettings {
  kind: HarvestRun["kind"];
  /** Skip places fetched within this many days. */
  maxAgeDays: number;
  /** Inputs per provider call. */
  batchSize: number;
  /** Base pause between batches; a random 0–100% is added. */
  pauseMs: number;
  /** Most inputs fetched per rolling 24 hours, across runs. */
  dailyCap: number;
  dryRun: boolean;
  log: (line: string) => void;
  now?: () => Date;
  random?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
}

export interface RunOutcome {
  run: HarvestRun;
  /** Inputs left for a later run because of the daily cap. */
  deferred: HarvestInput[];
  /** Inputs that would be fetched (dry run only). */
  planned: HarvestInput[];
}

export async function fetchedInLastDay(store: HarvestStore, now: Date): Promise<number> {
  const manifest = await store.readManifest();
  const since = now.getTime() - 86_400_000;
  let count = 0;
  for (const run of manifest.runs) {
    if (Date.parse(run.startedAt) < since) continue;
    count += run.items.filter((i) => i.status !== "skipped-fresh").length;
  }
  return count;
}

export async function runHarvest(
  store: HarvestStore,
  provider: Provider,
  inputs: HarvestInput[],
  options: HarvestOptions,
  settings: RunSettings,
): Promise<RunOutcome> {
  const now = settings.now ?? (() => new Date());
  const random = settings.random ?? Math.random;
  const pause = settings.sleep ?? ((ms: number) => sleep(ms));
  const startedAt = now();
  const run: HarvestRun = {
    id: `run_${startedAt.toISOString().replace(/[-:.]/g, "")}`,
    provider: provider.name,
    kind: settings.kind,
    startedAt: startedAt.toISOString(),
    items: [],
  };

  // 1. Fresh places are skipped without asking the provider.
  const todo: HarvestInput[] = [];
  for (const input of inputs) {
    const key = input.kind === "url" ? googleFeatureId(input.query) : undefined;
    if (key && (await store.isFresh(key, settings.maxAgeDays, startedAt.getTime()))) {
      run.items.push(item(input, "skipped-fresh", [key]));
    } else {
      todo.push(input);
    }
  }

  // 2. The daily cap applies across runs.
  const budget = Math.max(0, settings.dailyCap - (await fetchedInLastDay(store, startedAt)));
  const planned = todo.slice(0, budget);
  const deferred = todo.slice(budget);
  if (deferred.length > 0) {
    settings.log(
      `Daily cap: fetching ${planned.length} now, ${deferred.length} left for a later run.`,
    );
  }
  if (settings.dryRun) return { run, deferred, planned };

  // 3. Paced batches.
  for (let start = 0; start < planned.length; start += settings.batchSize) {
    if (options.signal?.aborted) break;
    const batch = planned.slice(start, start + settings.batchSize);
    settings.log(
      `Batch ${start / settings.batchSize + 1}: ${batch.length} input(s) via ${provider.name}…`,
    );
    let result: Awaited<ReturnType<Provider["harvest"]>>;
    try {
      result = await provider.harvest(batch, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const input of batch) run.items.push(item(input, "failed", [], { error: message }));
      await store.appendRun(run);
      settings.log(`Batch failed: ${message}. Stopping; re-run to retry.`);
      break;
    }

    batch.forEach((input, index) => {
      const places = result.places.filter((p) => p.inputIndex === index);
      const failure = result.failures.find((f) => f.inputIndex === index);
      const runItem = item(
        input,
        places.length > 0 ? "fetched" : failure ? "failed" : "not-found",
        [],
      );
      if (failure && places.length === 0) runItem.error = failure.error;
      run.items.push(runItem);
    });
    const batchItems = run.items.slice(-batch.length);
    for (const harvested of result.places) {
      const saved = await store.savePlace(harvested.place, harvested.reviews, harvested.photos);
      const runItem = batchItems[harvested.inputIndex];
      if (!runItem) continue;
      if (!runItem.sourcePlaceKeys.includes(harvested.place.sourcePlaceKey)) {
        runItem.sourcePlaceKeys.push(harvested.place.sourcePlaceKey);
      }
      runItem.reviewsAdded += saved.reviewsAdded;
      runItem.reviewsUpdated += saved.reviewsUpdated;
      const c = harvested.place.reviewCollection;
      settings.log(
        `  ${harvested.place.name}: +${saved.reviewsAdded} new, ${saved.reviewsUpdated} edited` +
          (c?.expected !== undefined
            ? ` (${c.collected} of ${c.expected} on Google, ${c.status})`
            : ""),
      );
    }
    await store.appendRun(run);

    if (start + settings.batchSize < planned.length) {
      await pause(settings.pauseMs * (1 + random()));
    }
  }

  run.finishedAt = now().toISOString();
  await store.appendRun(run);
  return { run, deferred, planned };
}

function item(
  input: HarvestInput,
  status: HarvestRunItem["status"],
  keys: string[],
  extra: Partial<HarvestRunItem> = {},
): HarvestRunItem {
  return {
    input: input.query,
    ...(input.list ? { list: input.list } : {}),
    ...(input.title ? { title: input.title } : {}),
    status,
    sourcePlaceKeys: keys,
    reviewsAdded: 0,
    reviewsUpdated: 0,
    ...extra,
  };
}

export function summarize(outcome: RunOutcome): string {
  const counts = new Map<string, number>();
  let added = 0;
  let updated = 0;
  const places = new Set<string>();
  for (const i of outcome.run.items) {
    counts.set(i.status, (counts.get(i.status) ?? 0) + 1);
    added += i.reviewsAdded;
    updated += i.reviewsUpdated;
    for (const key of i.sourcePlaceKeys) if (i.status === "fetched") places.add(key);
  }
  const lines = [
    `Run ${outcome.run.id}`,
    `  inputs: ${outcome.run.items.length}` +
      [...counts].map(([status, n]) => `, ${status} ${n}`).join(""),
    `  places saved: ${places.size}; reviews: +${added} new, ${updated} edited`,
  ];
  if (outcome.deferred.length > 0)
    lines.push(`  deferred by daily cap: ${outcome.deferred.length}`);
  for (const i of outcome.run.items.filter(
    (x) => x.status === "failed" || x.status === "not-found",
  )) {
    lines.push(`  ${i.status}: ${i.title ?? i.input}${i.error ? ` — ${i.error}` : ""}`);
  }
  return lines.join("\n");
}

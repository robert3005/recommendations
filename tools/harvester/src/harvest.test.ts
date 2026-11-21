import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PlaceSnapshot } from "@placemarks/schemas";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunSettings, runHarvest, summarize } from "./harvest";
import { reviewContentHash } from "./normalize";
import type { HarvestedPlace, HarvestInput, Provider } from "./providers/types";
import { HarvestStore } from "./store";
import { inputsFromTakeoutFile } from "./takeout";

const KEY_A = "0xaaa:0x111";
const KEY_B = "0xbbb:0x222";
const urlFor = (key: string, name: string) =>
  `https://www.google.com/maps/place/${name}/data=!4m2!3m1!1s${key}`;

function place(key: string, name: string, fetchedAt: string): PlaceSnapshot {
  return {
    sourcePlaceKey: key,
    googleUrl: urlFor(key, name),
    name,
    lat: 51.5,
    lng: -0.1,
    types: [],
    reviewCollection: { status: "partial", collected: 0, expected: 10 },
    provider: "gosom",
    fetchedAt,
  };
}

function review(key: string, id: string, text: string, fetchedAt: string) {
  return {
    id: `rev_${id}`,
    sourcePlaceKey: key,
    source: "google" as const,
    sourceReviewId: id,
    rating: 4,
    text,
    provider: "gosom" as const,
    fetchedAt,
    contentHash: reviewContentHash({ rating: 4, text }),
  };
}

/** A provider that answers every URL input with a canned place. */
function fakeProvider(
  answers: Record<string, (fetchedAt: string) => Omit<HarvestedPlace, "inputIndex">>,
) {
  const calls: HarvestInput[][] = [];
  const provider: Provider = {
    name: "gosom",
    async harvest(inputs) {
      calls.push(inputs);
      const fetchedAt = new Date().toISOString();
      const places: HarvestedPlace[] = [];
      inputs.forEach((input, inputIndex) => {
        const answer = Object.entries(answers).find(([k]) => input.query.includes(k))?.[1];
        if (answer) places.push({ inputIndex, ...answer(fetchedAt) });
      });
      return { places, failures: [] };
    },
  };
  return { provider, calls };
}

let dir: string;
let store: HarvestStore;
const logs: string[] = [];
const settings = (over: Partial<RunSettings> = {}): RunSettings => ({
  kind: "urls",
  maxAgeDays: 30,
  batchSize: 1,
  pauseMs: 1000,
  dailyCap: 100,
  dryRun: false,
  log: (l) => logs.push(l),
  sleep: async () => {},
  random: () => 0,
  ...over,
});
const options = () => ({
  extraReviews: true,
  depth: 1,
  language: "en",
  workDir: path.join(dir, ".work"),
});

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "harvest-"));
  store = new HarvestStore(dir);
  logs.length = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("a harvest run", () => {
  it("saves places, reviews and a manifest entry for every input", async () => {
    const { provider } = fakeProvider({
      [KEY_A]: (t) => ({
        place: place(KEY_A, "A", t),
        reviews: [review(KEY_A, "r1", "Great", t)],
        photos: [],
      }),
    });
    const inputs: HarvestInput[] = [
      { query: urlFor(KEY_A, "A"), kind: "url", list: "Favs.csv", title: "A" },
      { query: urlFor(KEY_B, "B"), kind: "url", title: "B" },
    ];
    const outcome = await runHarvest(store, provider, inputs, options(), settings());

    expect(outcome.run.items.map((i) => [i.title, i.status, i.reviewsAdded])).toEqual([
      ["A", "fetched", 1],
      ["B", "not-found", 0],
    ]);
    expect(await store.readReviews(KEY_A)).toHaveLength(1);
    expect((await store.readPlace(KEY_A))?.reviewCollection?.collected).toBe(1);
    const manifest = await store.readManifest();
    expect(manifest.runs).toHaveLength(1);
    expect(manifest.runs[0]?.finishedAt).toBeDefined();
    expect(summarize(outcome)).toContain("not-found: B");
  });

  it("merges a refresh: adds new reviews, updates edited ones, never deletes", async () => {
    let round = 0;
    const { provider } = fakeProvider({
      [KEY_A]: (t) => {
        round++;
        return round === 1
          ? {
              place: place(KEY_A, "A", t),
              reviews: [review(KEY_A, "r1", "Good", t), review(KEY_A, "r2", "Meh", t)],
              photos: [],
            }
          : {
              place: place(KEY_A, "A", t),
              reviews: [review(KEY_A, "r1", "Good, edited", t), review(KEY_A, "r3", "New", t)],
              photos: [],
            };
      },
    });
    const input: HarvestInput[] = [{ query: urlFor(KEY_A, "A"), kind: "url" }];
    await runHarvest(store, provider, input, options(), settings());
    const second = await runHarvest(store, provider, input, options(), settings({ maxAgeDays: 0 }));

    expect(second.run.items[0]).toMatchObject({ reviewsAdded: 1, reviewsUpdated: 1 });
    const reviews = await store.readReviews(KEY_A);
    expect(reviews.map((r) => [r.sourceReviewId, r.text]).sort()).toEqual([
      ["r1", "Good, edited"],
      ["r2", "Meh"],
      ["r3", "New"],
    ]);
  });

  it("keeps only the top match for a URL input, but every result for a search", async () => {
    const provider: Provider = {
      name: "gosom",
      async harvest(inputs) {
        const t = new Date().toISOString();
        return {
          places: inputs.flatMap((_, inputIndex) => [
            { inputIndex, place: place(KEY_A, "Branch 1", t), reviews: [], photos: [] },
            { inputIndex, place: place(KEY_B, "Branch 2", t), reviews: [], photos: [] },
          ]),
          failures: [],
        };
      },
    };
    const url = await runHarvest(
      store,
      provider,
      [{ query: "https://www.google.com/maps/search/Bar+Douro", kind: "url" }],
      options(),
      settings(),
    );
    expect(url.run.items[0]?.sourcePlaceKeys).toEqual([KEY_A]);
    expect(await store.readPlace(KEY_B)).toBeUndefined();
    const search = await runHarvest(
      store,
      provider,
      [{ query: "Bar Douro", kind: "search" }],
      options(),
      settings({ kind: "search", maxAgeDays: 0 }),
    );
    expect(search.run.items[0]?.sourcePlaceKeys).toEqual([KEY_A, KEY_B]);
  });

  it("skips fresh places without calling the provider", async () => {
    const { provider, calls } = fakeProvider({
      [KEY_A]: (t) => ({ place: place(KEY_A, "A", t), reviews: [], photos: [] }),
    });
    const input: HarvestInput[] = [{ query: urlFor(KEY_A, "A"), kind: "url" }];
    await runHarvest(store, provider, input, options(), settings());
    const again = await runHarvest(store, provider, input, options(), settings());
    expect(calls).toHaveLength(1);
    expect(again.run.items[0]?.status).toBe("skipped-fresh");
  });

  it("applies the daily cap across runs and defers the rest", async () => {
    const { provider, calls } = fakeProvider({});
    const inputs: HarvestInput[] = ["0x1:0x1", "0x2:0x2", "0x3:0x3"].map((k) => ({
      query: urlFor(k, "P"),
      kind: "url",
    }));
    const first = await runHarvest(store, provider, inputs, options(), settings({ dailyCap: 2 }));
    expect(first.deferred).toHaveLength(1);
    const second = await runHarvest(
      store,
      provider,
      inputs.slice(2),
      options(),
      settings({ dailyCap: 2 }),
    );
    expect(second.deferred).toHaveLength(1);
    expect(calls.flat()).toHaveLength(2);
  });

  it("pauses with jitter between batches, not after the last", async () => {
    const pauses: number[] = [];
    const { provider } = fakeProvider({});
    const inputs: HarvestInput[] = ["0x1:0x1", "0x2:0x2", "0x3:0x3"].map((k) => ({
      query: urlFor(k, "P"),
      kind: "url",
    }));
    await runHarvest(
      store,
      provider,
      inputs,
      options(),
      settings({
        random: () => 0.5,
        sleep: async (ms) => {
          pauses.push(ms);
        },
      }),
    );
    expect(pauses).toEqual([1500, 1500]);
  });

  it("dry run plans without fetching or writing", async () => {
    const { provider, calls } = fakeProvider({});
    const outcome = await runHarvest(
      store,
      provider,
      [{ query: urlFor(KEY_A, "A"), kind: "url" }],
      options(),
      settings({ dryRun: true }),
    );
    expect(outcome.planned).toHaveLength(1);
    expect(calls).toHaveLength(0);
    await expect(readFile(path.join(dir, "manifest.json"))).rejects.toThrow();
  });

  it("records a failed batch and stops, so a re-run retries it", async () => {
    const provider: Provider = {
      name: "gosom",
      async harvest() {
        throw new Error("docker exited with code 1");
      },
    };
    const inputs: HarvestInput[] = ["0x1:0x1", "0x2:0x2"].map((k) => ({
      query: urlFor(k, "P"),
      kind: "url",
    }));
    const outcome = await runHarvest(store, provider, inputs, options(), settings());
    expect(outcome.run.items).toEqual([
      expect.objectContaining({ status: "failed", error: "docker exited with code 1" }),
    ]);
  });
});

describe("Takeout inputs", () => {
  it("takes Google place URLs from Saved CSVs and Saved Places.json, once each", () => {
    const csv =
      "﻿Title,Note,URL,Address\n" +
      `Bar Douro,octopus!,${urlFor(KEY_A, "Bar+Douro")},London\n` +
      "Dropped pin,,https://www.google.com/maps/search/51.5,-0.1,\n" +
      "No url,,,\n";
    const savedPlaces = JSON.stringify({
      type: "FeatureCollection",
      features: [
        { properties: { google_maps_url: urlFor(KEY_A, "dup"), location: { name: "Bar Douro" } } },
        {
          properties: {
            google_maps_url: "http://maps.google.com/?cid=12345",
            location: { name: "By cid" },
          },
        },
      ],
    });
    const zip = zipSync({
      "Takeout/Saved/Favourites.csv": strToU8(csv),
      "Takeout/Maps (your places)/Saved Places.json": strToU8(savedPlaces),
    });
    const result = inputsFromTakeoutFile("takeout.zip", zip);
    expect(result.inputs.map((i) => [i.list, i.title])).toEqual([
      ["Favourites.csv", "Bar Douro"],
      ["Saved Places.json", "By cid"],
    ]);
    expect(result.skipped.map((s) => s.title)).toEqual(["Dropped pin", "No url"]);
  });

  it("rejects files it doesn't understand", () => {
    expect(() => inputsFromTakeoutFile("notes.txt", new Uint8Array())).toThrow(/Takeout/);
  });
});

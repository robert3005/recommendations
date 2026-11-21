#!/usr/bin/env -S npx tsx
/**
 * placemarks-harvest — download Google Maps place facts and reviews into the
 * local harvest dataset (spec/src/harvest.md).
 *
 *   pnpm harvest takeout ~/Downloads/takeout.zip
 *   pnpm harvest search "ramen" --geo 51.5246,-0.0786 --radius 1500
 *   pnpm harvest urls my-places.txt
 *   pnpm harvest refresh
 *   pnpm harvest status
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { type RunSettings, runHarvest, summarize } from "./harvest";
import { DEFAULT_GOSOM_IMAGE, gosomProvider } from "./providers/gosom";
import type { HarvestInput, HarvestOptions, SearchArea } from "./providers/types";
import { defaultDataDir, HarvestStore } from "./store";
import { inputsFromTakeoutFile } from "./takeout";

const USAGE = `Usage: placemarks-harvest <command> [args] [options]

Commands:
  takeout <file>...      Harvest every Google place in a Takeout .zip, Saved-list .csv,
                         or Saved Places.json
  search "<query>"       Harvest the places a Google Maps search returns
  urls <file>            Harvest Google Maps place URLs, one per line
  refresh                Re-fetch places already in the dataset that are older than --max-age
  status                 Show what the dataset holds

Options:
  --data-dir <dir>       Dataset location (default: $PLACEMARKS_DATA or ~/placemarks-data)
  --geo <lat,lng>        Search around this point            (search)
  --radius <meters>      Search radius, default 2000           (search)
  --bbox <minLat,minLng,maxLat,maxLng>  Grid search inside a box (search)
  --depth <n>            Result pages to scroll per search, default 3 (search)
  --no-extra-reviews     Only the reviews on the place page (much faster)
  --max-age <days>       Skip places fetched within this many days, default 30
  --batch <n>            Inputs per scraper run, default 5
  --pause <seconds>      Base pause between batches, default 60 (plus 0–100% jitter)
  --daily-cap <n>        Most inputs fetched per 24 hours, default 150
  --lang <code>          Language for Google Maps, default en
  --gosom-bin <path>     Use a local google-maps-scraper binary instead of Docker
  --gosom-image <image>  Docker image, default ${DEFAULT_GOSOM_IMAGE}
  --dry-run              Show what would be fetched, fetch nothing
  -h, --help
`;

function fail(message: string): never {
  process.stderr.write(`${message}\n\n${USAGE}`);
  process.exit(2);
}

function numberOption(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) fail(`--${name} must be a non-negative number`);
  return n;
}

function coordsOption(value: string, count: number, name: string): number[] {
  const parts = value.split(",").map((p) => Number(p.trim()));
  if (parts.length !== count || parts.some((n) => !Number.isFinite(n))) {
    fail(`--${name} expects ${count} comma-separated numbers`);
  }
  return parts;
}

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "data-dir": { type: "string" },
      geo: { type: "string" },
      radius: { type: "string" },
      bbox: { type: "string" },
      depth: { type: "string" },
      "no-extra-reviews": { type: "boolean" },
      "max-age": { type: "string" },
      batch: { type: "string" },
      pause: { type: "string" },
      "daily-cap": { type: "string" },
      lang: { type: "string" },
      "gosom-bin": { type: "string" },
      "gosom-image": { type: "string" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...args] = positionals;
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return;
  }

  const store = new HarvestStore(path.resolve(values["data-dir"] ?? defaultDataDir()));
  const log = (line: string) => process.stderr.write(`${line}\n`);

  if (command === "status") {
    const manifest = await store.readManifest();
    const keys = new Set(
      manifest.runs.flatMap((r) =>
        r.items.filter((i) => i.status === "fetched").flatMap((i) => i.sourcePlaceKeys),
      ),
    );
    let reviews = 0;
    for (const key of keys) reviews += (await store.readReviews(key)).length;
    process.stdout.write(
      `${store.dataDir}\n  runs: ${manifest.runs.length}\n  places: ${keys.size}\n  reviews: ${reviews}\n`,
    );
    return;
  }

  let inputs: HarvestInput[] = [];
  let kind: RunSettings["kind"];
  let area: SearchArea | undefined;
  let maxAgeDays = numberOption(values["max-age"], "max-age", 30);

  switch (command) {
    case "takeout": {
      if (args.length === 0) fail("takeout needs at least one file");
      kind = "takeout";
      for (const file of args) {
        const parsed = inputsFromTakeoutFile(file, new Uint8Array(await readFile(file)));
        inputs.push(...parsed.inputs);
        for (const s of parsed.skipped)
          log(`skip: ${s.list} / ${s.title || "(untitled)"} — ${s.reason}`);
      }
      break;
    }
    case "search": {
      const query = args.join(" ").trim();
      if (!query) fail('search needs a query, e.g. search "ramen in Shoreditch"');
      kind = "search";
      inputs = [{ query, kind: "search" }];
      if (values.bbox) {
        area = { bbox: coordsOption(values.bbox, 4, "bbox") as [number, number, number, number] };
      } else if (values.geo) {
        const [lat, lng] = coordsOption(values.geo, 2, "geo") as [number, number];
        area = { geo: { lat, lng }, radiusMeters: numberOption(values.radius, "radius", 2000) };
      }
      maxAgeDays = 0; // a search is always run; its places dedupe on save
      break;
    }
    case "urls": {
      if (!args[0]) fail("urls needs a file with one Google Maps URL per line");
      kind = "urls";
      const lines = (await readFile(args[0], "utf8")).split("\n").map((l) => l.trim());
      inputs = lines
        .filter((l) => l && !l.startsWith("#"))
        .map((query) => ({ query, kind: "url" as const }));
      break;
    }
    case "refresh": {
      kind = "refresh";
      const manifest = await store.readManifest();
      const keys = new Set(
        manifest.runs.flatMap((r) =>
          r.items.filter((i) => i.status === "fetched").flatMap((i) => i.sourcePlaceKeys),
        ),
      );
      for (const key of keys) {
        const place = await store.readPlace(key);
        if (place?.googleUrl)
          inputs.push({ query: place.googleUrl, kind: "url", title: place.name });
      }
      break;
    }
    default:
      fail(`unknown command "${command}"`);
  }

  if (inputs.length === 0) {
    log("Nothing to harvest.");
    return;
  }

  const controller = new AbortController();
  process.once("SIGINT", () => {
    log("Stopping after the current batch… (Ctrl-C again to quit now)");
    controller.abort();
    process.once("SIGINT", () => process.exit(130));
  });

  const options: HarvestOptions = {
    extraReviews: !values["no-extra-reviews"],
    depth: numberOption(values.depth, "depth", 3),
    ...(area ? { area } : {}),
    language: values.lang ?? "en",
    workDir: path.join(store.dataDir, ".work"),
    signal: controller.signal,
  };
  const provider = gosomProvider({
    image: values["gosom-image"] ?? DEFAULT_GOSOM_IMAGE,
    ...(values["gosom-bin"] ? { binary: values["gosom-bin"] } : {}),
  });

  const outcome = await runHarvest(store, provider, inputs, options, {
    kind,
    maxAgeDays,
    batchSize: Math.max(1, numberOption(values.batch, "batch", 5)),
    pauseMs: numberOption(values.pause, "pause", 60) * 1000,
    dailyCap: numberOption(values["daily-cap"], "daily-cap", 150),
    dryRun: Boolean(values["dry-run"]),
    log,
  });

  if (values["dry-run"]) {
    process.stdout.write(
      `Would fetch ${outcome.planned.length} input(s); ${outcome.run.items.length} fresh, ` +
        `${outcome.deferred.length} over the daily cap.\n` +
        outcome.planned
          .map((i) => `  ${i.list ? `[${i.list}] ` : ""}${i.title ?? i.query}`)
          .join("\n") +
        "\n",
    );
    return;
  }
  process.stdout.write(`${summarize(outcome)}\n`);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

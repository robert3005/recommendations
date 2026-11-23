/**
 * The paid provider: SerpApi's Google Maps and Google Maps Reviews APIs.
 * Unlike anonymous scraping it pages through a place's full review history,
 * so it is the route to review volume. Every request is one SerpApi search
 * credit; `maxReviews` caps the spend per place. The requests and
 * normalization live in serpapi-client.ts; this adds the disk cache.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../normalize";
import { type SerpApiConfig, type SerpCache, serpApiClient } from "./serpapi-client";
import type { Provider, ProviderResult } from "./types";

export * from "./serpapi-client";

const CACHE_MAX_AGE_MS = 7 * 86_400_000;

/**
 * Successful responses are cached on disk for a week (keyed by the request
 * parameters, never the API key), so a re-run after a crash or a
 * normalization bug costs no credits for what was already fetched.
 */
function diskCache(workDir: string): SerpCache {
  const file = (key: string) => path.join(workDir, "serpapi-cache", `${sha256(key)}.json`);
  return {
    async get(key) {
      const cached = await stat(file(key)).catch(() => undefined);
      if (!cached || Date.now() - cached.mtimeMs >= CACHE_MAX_AGE_MS) return undefined;
      return JSON.parse(await readFile(file(key), "utf8")) as unknown;
    },
    async put(key, body) {
      await mkdir(path.dirname(file(key)), { recursive: true });
      await writeFile(file(key), JSON.stringify(body));
    },
  };
}

export function serpApiProvider(config: Omit<SerpApiConfig, "cache">): Provider {
  const log = config.log ?? (() => {});
  const clients = new Map<string, ReturnType<typeof serpApiClient>>();
  const clientFor = (workDir: string) => {
    let client = clients.get(workDir);
    if (!client) {
      client = serpApiClient({ ...config, cache: diskCache(workDir) });
      clients.set(workDir, client);
    }
    return client;
  };
  const totalCredits = () => [...clients.values()].reduce((n, c) => n + c.credits, 0);

  return {
    name: "serpapi",
    async harvest(inputs, options): Promise<ProviderResult> {
      const client = clientFor(options.workDir);
      const result: ProviderResult = { places: [], failures: [] };
      const startCredits = totalCredits();
      for (const [inputIndex, input] of inputs.entries()) {
        if (options.signal?.aborted) break;
        try {
          for (const raw of await client.placesFor(input, options)) {
            const place = await client.harvestPlace(raw, inputIndex, options);
            if ("error" in place) {
              result.failures.push({ inputIndex, error: place.error });
              continue;
            }
            result.places.push(place);
          }
        } catch (error) {
          // An auth or quota error fails every input the same way: stop the batch.
          const message = error instanceof Error ? error.message : String(error);
          if (/invalid api key|run out of searches|account/i.test(message)) throw error;
          result.failures.push({ inputIndex, error: message });
        }
      }
      log(
        `  SerpApi credits used this batch: ${totalCredits() - startCredits} (run total ${totalCredits()})`,
      );
      return result;
    },
  };
}

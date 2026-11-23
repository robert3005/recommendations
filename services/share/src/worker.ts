/** Cloudflare Workers entry: Hono app over D1 (deploy with `wrangler deploy`). */
import { createShareApp } from "./app";
import { type D1Like, D1Storage } from "./d1";
import { insightsProviders } from "./insightsProviders";

interface Env {
  SHARE_DB: D1Like;
  /** Review insights (OPERATIONS.md §Review insights): all three secrets, or none. */
  INSIGHTS_ACCESS_KEY?: string;
  SERPAPI_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  /** Plain vars in wrangler.toml. */
  INSIGHTS_DAILY_PLACES?: string;
  INSIGHTS_MAX_REVIEWS?: string;
}

/** Workers' non-standard default edge cache, typed structurally (no workers-types). */
interface EdgeCache {
  delete(url: string): Promise<boolean>;
}
const edgeCache = (globalThis as unknown as { caches?: { default?: EdgeCache } }).caches?.default;

const positive = (v: string | undefined) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    const providers =
      env.SERPAPI_KEY && env.ANTHROPIC_API_KEY
        ? insightsProviders({
            serpApiKey: env.SERPAPI_KEY,
            anthropicApiKey: env.ANTHROPIC_API_KEY,
            maxReviews: positive(env.INSIGHTS_MAX_REVIEWS),
          })
        : undefined;
    const app = createShareApp({
      storage: new D1Storage(env.SHARE_DB),
      // On update or revoke the worker purges that single URL
      // (spec/src/sharing.md §The share service); s-maxage bounds the rest.
      purge: edgeCache ? (url) => edgeCache.delete(url) : undefined,
      // Short-link expansion follows Google's share-link redirect by hand.
      fetchUpstream: (url, init) => fetch(url, init),
      insights: {
        accessKey: env.INSIGHTS_ACCESS_KEY,
        ...providers,
        dailyPlaces: positive(env.INSIGHTS_DAILY_PLACES),
      },
    });
    return app.fetch(request);
  },
};

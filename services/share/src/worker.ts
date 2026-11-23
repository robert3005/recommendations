/** Cloudflare Workers entry: Hono app over D1 (deploy with `wrangler deploy`). */
import { createShareApp } from "./app";
import { type D1Like, D1Storage } from "./d1";

interface Env {
  SHARE_DB: D1Like;
}

/** Workers' non-standard default edge cache, typed structurally (no workers-types). */
interface EdgeCache {
  delete(url: string): Promise<boolean>;
}
const edgeCache = (globalThis as unknown as { caches?: { default?: EdgeCache } }).caches?.default;

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    const app = createShareApp({
      storage: new D1Storage(env.SHARE_DB),
      // On update or revoke the worker purges that single URL
      // (spec/src/sharing.md §The share service); s-maxage bounds the rest.
      purge: edgeCache ? (url) => edgeCache.delete(url) : undefined,
      // Short-link expansion follows Google's share-link redirect by hand.
      fetchUpstream: (url, init) => fetch(url, init),
    });
    return app.fetch(request);
  },
};

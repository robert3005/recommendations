/** Cloudflare Workers entry: Hono app over D1 (deploy with `wrangler deploy`). */
import { createShareApp } from "./app";
import { type D1Like, D1Storage } from "./d1";

interface Env {
  SHARE_DB: D1Like;
}

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    const app = createShareApp({ storage: new D1Storage(env.SHARE_DB) });
    return app.fetch(request);
  },
};

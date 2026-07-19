/** Cloudflare Workers entry: Hono app over D1 (deploy with `wrangler deploy`). */
import { createShareApp } from "./app";
import { type D1Like, D1Storage } from "./d1";

interface Env {
  SHARE_DB: D1Like;
}

/** Internal audit/version/replay data is retained for 90 days, then purged. */
export const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * The executable retention policy (OPERATIONS.md): a scheduled purge of
 * internal audit entries, version backups, and replay records older than the
 * 90-day horizon. Public documents are untouched.
 */
export async function purgeExpiredInternalData(db: D1Like, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - RETENTION_MS).toISOString();
  await db.prepare("DELETE FROM audit WHERE at < ?").bind(cutoff).run();
  await db.prepare("DELETE FROM document_revisions WHERE recordedAt < ?").bind(cutoff).run();
  await db.prepare("DELETE FROM idempotency WHERE createdAt < ?").bind(cutoff).run();
}

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    const app = createShareApp({ storage: new D1Storage(env.SHARE_DB) });
    return app.fetch(request);
  },
  async scheduled(_event: unknown, env: Env): Promise<void> {
    await purgeExpiredInternalData(env.SHARE_DB, new Date());
  },
};

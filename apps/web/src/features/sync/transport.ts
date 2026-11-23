/**
 * The device's side of the sync wire (spec/src/sync.md §The service): four
 * calls against `/y/:library`, all carrying the library's Bearer token.
 */
import {
  SYNC_LIMITS,
  type SyncPullResponse,
  type SyncRow,
  syncPullResponseSchema,
  syncPushResponseSchema,
} from "@placemarks/schemas";
import { SHARE_API_URL } from "../../config";
import type { LibraryKeys } from "./crypto";

/** A sync failure with a message fit to show beside the Sync controls. */
export class SyncError extends Error {
  constructor(
    message: string,
    readonly reason: "offline" | "no-library" | "forbidden" | "unsupported" | "full" | "failed",
  ) {
    super(message);
    this.name = "SyncError";
  }
}

export interface SyncTransport {
  /** Claim the library for this key, or confirm it exists. True when it was just created. */
  claim(): Promise<boolean>;
  pull(since: number): Promise<SyncPullResponse>;
  /** Push up to `SYNC_LIMITS.rowsPerPush` rows; returns the service's cursor after the write. */
  push(rows: readonly SyncRow[]): Promise<number>;
  /** Delete the library and every row on the service. */
  remove(): Promise<void>;
}

function failure(status: number): SyncError {
  if (status === 404) {
    return new SyncError("No library was found for this code.", "no-library");
  }
  if (status === 401 || status === 403) {
    return new SyncError("This code does not open that library.", "forbidden");
  }
  if (status === 501) {
    return new SyncError("This share service does not support sync yet.", "unsupported");
  }
  if (status === 413) {
    return new SyncError("The synced library is full.", "full");
  }
  if (status === 429) {
    return new SyncError("Syncing too fast — it will try again shortly.", "failed");
  }
  return new SyncError(`Sync failed (${status.toString()}).`, "failed");
}

export function httpTransport(
  keys: LibraryKeys,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
  base: string = SHARE_API_URL,
): SyncTransport {
  const url = (path = "") => {
    const relative = `${base}/y/${keys.libraryId}${path}`;
    return typeof window === "undefined"
      ? relative
      : new URL(relative, window.location.href).toString();
  };
  const call = async (path: string, init: RequestInit): Promise<Response> => {
    try {
      return await fetcher(url(path), {
        ...init,
        headers: { authorization: `Bearer ${keys.token}`, ...(init.headers ?? {}) },
      });
    } catch {
      throw new SyncError("The sync service is unreachable — it will try again.", "offline");
    }
  };

  return {
    async claim() {
      const response = await call("", { method: "PUT" });
      if (response.status === 201) return true;
      if (response.status === 200) return false;
      throw failure(response.status);
    },
    async pull(since) {
      const response = await call(`/changes?since=${since.toString()}`, { method: "GET" });
      if (!response.ok) throw failure(response.status);
      const parsed = syncPullResponseSchema.safeParse(await response.json().catch(() => undefined));
      if (!parsed.success)
        throw new SyncError("The sync service sent an unreadable answer.", "failed");
      return parsed.data;
    },
    async push(rows) {
      if (rows.length > SYNC_LIMITS.rowsPerPush) throw new Error("push batch too large");
      const response = await call("/rows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rows }),
      });
      if (!response.ok) throw failure(response.status);
      const parsed = syncPushResponseSchema.safeParse(await response.json().catch(() => undefined));
      if (!parsed.success)
        throw new SyncError("The sync service sent an unreadable answer.", "failed");
      return parsed.data.cursor;
    },
    async remove() {
      const response = await call("", { method: "DELETE" });
      if (response.status !== 204) throw failure(response.status);
    },
  };
}

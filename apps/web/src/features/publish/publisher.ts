/**
 * The SharePublisher boundary (spec/src/architecture.md §External service
 * adapters): Bearer-authorized publish/revoke draining ONLY the durable
 * publication outbox — explicit jobs, never auto-published local edits.
 */
import type { SharePublisher } from "@placemarks/domain";
import type { DexieRepository } from "../../data/repo";
import { revokePublication, runPublicationOutbox } from "./publication";

export function createSharePublisher(
  repo: DexieRepository,
  fetcher: typeof fetch = fetch,
): SharePublisher {
  return {
    drainOutbox: () => runPublicationOutbox(repo, fetcher),
    revoke: (publicationId) =>
      revokePublication(repo, publicationId, new Date().toISOString(), fetcher),
  };
}

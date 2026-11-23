/**
 * The share-service URL for a document. SHARE_API_URL empty means same-origin;
 * resolving against the current location keeps fetch happy in every runtime.
 */
import { SHARE_API_URL } from "../../config";

export function shareDocumentUrl(kind: "list" | "post", slug: string): string {
  const path = `${SHARE_API_URL}/s/${kind === "list" ? "lists" : "posts"}/${encodeURIComponent(slug)}`;
  return typeof window === "undefined" ? path : new URL(path, window.location.href).toString();
}

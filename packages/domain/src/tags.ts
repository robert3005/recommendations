/** Tag names are normalized for uniqueness while preserving display casing. */
export function normalizeTagName(raw: string): string {
  return raw.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Small pure helpers shared by provider normalizers. */
import { createHash } from "node:crypto";

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Deterministic short id: the same parts always give the same id. */
export function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${sha256(parts.join("\u0000")).slice(0, 20)}`;
}

/** What makes a review "the same review": an edit to any of these changes the hash. */
export function reviewContentHash(review: {
  rating?: number | undefined;
  text: string;
  ownerResponse?: { text: string } | undefined;
}): string {
  return sha256(
    JSON.stringify([review.rating ?? null, review.text, review.ownerResponse?.text ?? null]),
  );
}

/** "$$" → 2, "€€€" → 3; anything else (ranges, words) is not a plain level. */
export function priceLevelFromText(text: string | undefined): number | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  const match = trimmed.match(/^([$€£¥₩₹])\1{0,3}$/u);
  return match ? [...trimmed].length : undefined;
}

/** Microseconds since the epoch → ISO string, or undefined for 0/absent/implausible. */
export function isoFromMicros(micros: number | undefined): string | undefined {
  if (!micros || micros <= 0) return undefined;
  const date = new Date(micros / 1000);
  const year = date.getUTCFullYear();
  return year >= 2005 && year <= 2100 ? date.toISOString() : undefined;
}

/** A trimmed non-empty string, or undefined for anything else (including non-strings). */
export function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/** A string or a list of strings (providers vary) → the non-empty strings. */
export function stringList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : [value];
  return items.map(nonEmpty).filter((v): v is string => v !== undefined);
}

export function isHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

const DAY_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** `{ Monday: ["9 AM–5 PM"] }` → `["Monday: 9 AM–5 PM", …]`, Monday first. */
export function openingHoursLines(
  hours: Record<string, string[]> | undefined,
): string[] | undefined {
  if (!hours) return undefined;
  const days = Object.keys(hours).sort((a, b) => {
    const ia = DAY_ORDER.indexOf(a);
    const ib = DAY_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const lines = days.map((day) => `${day}: ${(hours[day] ?? []).join(", ")}`);
  return lines.length > 0 ? lines : undefined;
}

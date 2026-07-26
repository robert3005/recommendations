import opening_hours from "opening_hours";

/**
 * Interpret an OSM opening_hours value defensively — many real-world values need
 * location context or are malformed; failure renders nothing rather than breaking.
 */
export function openState(value: string, at: Date): { open: boolean } | undefined {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: opening_hours' nominatim param is untyped
    const oh = new opening_hours(value, null as any);
    return { open: oh.getState(at) };
  } catch {
    return undefined;
  }
}

export function OpenNow({ openingHours, at }: { openingHours: string; at?: Date }) {
  const state = openState(openingHours, at ?? new Date());
  if (!state) return null;
  return state.open ? (
    <span className="text-xs font-medium text-emerald-700">Open now</span>
  ) : (
    <span className="text-xs font-medium text-coral-ink">Closed</span>
  );
}

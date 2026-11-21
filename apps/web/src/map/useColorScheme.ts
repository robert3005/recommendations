import { useSyncExternalStore } from "react";
import type { PlateScheme } from "./basemapStyle";

const QUERY = "(prefers-color-scheme: dark)";

function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia?.(QUERY);
  if (!media) return () => undefined;
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function snapshot(): PlateScheme {
  return window.matchMedia?.(QUERY).matches ? "night" : "paper";
}

/** The chrome theme the OS asks for: Night under prefers-color-scheme: dark. */
export function useColorScheme(): PlateScheme {
  return useSyncExternalStore(subscribe, snapshot, () => "paper");
}

/**
 * Client metrics with privacy redaction from the first release
 * (spec/src/roadmap.md §Cross-cutting): simple counters and error reports, no
 * fragment-bearing URLs, no tokens, no precise locations. The sink is
 * pluggable; the default keeps counts in memory and logs errors to the console
 * in dev builds only.
 */

export interface MetricsSink {
  count(name: string, delta: number): void;
  error(name: string, detail: string): void;
}

const counters = new Map<string, number>();

let sink: MetricsSink = {
  count(name, delta) {
    counters.set(name, (counters.get(name) ?? 0) + delta);
  },
  error(name, detail) {
    counters.set(`error:${name}`, (counters.get(`error:${name}`) ?? 0) + 1);
    if (import.meta.env?.DEV) console.warn(`[metrics] ${name}: ${detail}`);
  },
};

export function setMetricsSink(next: MetricsSink): void {
  sink = next;
}

export function metricsSnapshot(): ReadonlyMap<string, number> {
  return counters;
}

/**
 * Redact anything that must never reach telemetry: URL fragments (snapshot
 * documents live there), bearer tokens, and precise coordinates. Editor
 * tokens are ≥43 base64url characters by construction, so any such run is
 * removed even without a `Bearer`/label prefix — an opaque blob that long has
 * no diagnostic value anyway.
 */
export function redact(detail: string): string {
  return (
    detail
      .replace(/#\S+/g, "#[redacted-fragment]")
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/([?&][^=&\s]*token[^=&\s]*=)[^&\s"']+/gi, "$1[redacted]")
      .replace(/("[^"]*token[^"]*"\s*:\s*")[^"]+(")/gi, "$1[redacted]$2")
      .replace(/[A-Za-z0-9_-]{43,}/g, "[redacted]")
      .replace(/-?\d{1,3}\.\d{4,}/g, "[coord]")
      // A failing URL may percent-encode the decimal point — still a coordinate.
      .replace(/-?\d{1,3}%2E\d{4,}/gi, "[coord]")
  );
}

export function count(name: string, delta = 1): void {
  sink.count(name, delta);
}

export function reportError(name: string, err: unknown): void {
  sink.error(name, redact(err instanceof Error ? `${err.name}: ${err.message}` : String(err)));
}

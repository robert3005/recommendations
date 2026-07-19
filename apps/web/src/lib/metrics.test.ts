/** Metrics redaction (spec/src/roadmap.md): no fragments, tokens, or precise coordinates. */
import { describe, expect, it } from "vitest";
import { count, metricsSnapshot, redact, reportError } from "./metrics";

describe("metrics privacy redaction", () => {
  it("strips snapshot fragments, bearer tokens, and precise coordinates", () => {
    const detail = redact(
      "failed loading https://app.example/l#eJzT0yMAAheavyfragmentAAAA123456 " +
        "with Authorization: Bearer abc123deadbeefdeadbeef at 38.713944,-9.139412",
    );
    expect(detail).not.toContain("eJzT0yMAA");
    expect(detail).not.toContain("abc123deadbeef");
    expect(detail).not.toContain("38.713944");
    expect(detail).toContain("#[redacted-fragment]");
    expect(detail).toContain("Bearer [redacted]");
    expect(detail).toContain("[coord]");
  });

  it("counts and reports through the sink", () => {
    count("search.success");
    count("search.success");
    reportError("resolver", new Error("timeout at 38.713944,-9.139412"));
    expect(metricsSnapshot().get("search.success")).toBe(2);
    expect(metricsSnapshot().get("error:resolver")).toBe(1);
  });
});

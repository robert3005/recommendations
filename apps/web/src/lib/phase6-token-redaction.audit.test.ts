/**
 * Phase 6 telemetry privacy: editor credentials must never reach a metrics
 * sink, regardless of whether an error happened to preserve the `Bearer`
 * prefix. Browser/fetch diagnostics can serialize query parameters or local
 * credential records instead of an Authorization header.
 */
import { describe, expect, it } from "vitest";
import { redact } from "./metrics";

const EDITOR_TOKEN = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY";

describe("Phase 6 editor-token telemetry redaction", () => {
  it.each([
    `request failed at https://share.example/retry?editorToken=${EDITOR_TOKEN}`,
    `credential record: {"slug":"lisbon","token":"${EDITOR_TOKEN}"}`,
  ])("removes a labelled editor token without relying on a Bearer prefix", (detail) => {
    expect(redact(detail)).not.toContain(EDITOR_TOKEN);
  });
});

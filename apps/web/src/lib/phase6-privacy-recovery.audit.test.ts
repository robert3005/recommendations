/**
 * Hardening-phase privacy/recovery contracts (spec/src/roadmap.md Phase 9, formerly Phase 6).
 *
 * These cases intentionally cover malformed local/browser input too: telemetry
 * must never forward a fragment merely because it is not a valid snapshot, and
 * corrupt reminder metadata must not suppress backups forever.
 */
import { describe, expect, it } from "vitest";
import { shouldRemindBackup } from "./backupReminder";
import { redact } from "./metrics";

describe("Phase 6 privacy and recovery", () => {
  it("redacts short or malformed URL fragments before telemetry", () => {
    const detail = redact(
      "viewer failed at https://app.example/l#short.private-fragment?draft=family-trip",
    );

    expect(detail).not.toContain("short.private-fragment");
    expect(detail).not.toContain("family-trip");
  });

  it("redacts precise coordinates when a failing URL percent-encodes its decimal points", () => {
    const detail = redact(
      "resolver failed at https://geo.example/nearby?lat=38%2E713944&lng=-9%2E139412",
    );

    expect(detail).not.toContain("38%2E713944");
    expect(detail).not.toContain("-9%2E139412");
  });

  it("treats a corrupt last-backup timestamp as no usable backup", () => {
    const storage = {
      getItem: () => "not-an-iso-timestamp",
    };

    expect(shouldRemindBackup(3, "2026-07-19T12:00:00.000Z", storage)).toBe(true);
  });

  it("does not let a future backup timestamp suppress reminders after a clock correction", () => {
    const storage = {
      getItem: () => "2036-07-19T12:00:00.000Z",
    };

    expect(shouldRemindBackup(3, "2026-07-19T12:00:00.000Z", storage)).toBe(true);
  });
});

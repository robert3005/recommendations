/** Settings owns the provider/privacy disclosure specified by the Phase 0 design. */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";

vi.mock("../../data/hooks", () => ({ useLibraryPlaces: () => [] }));
vi.mock("../../data/RepoContext", () => ({
  useRepo: () => ({ db: {} }),
  getDefaultRepo: () => ({ db: {} }),
}));
vi.mock("../interop/ImportSection", () => ({ ImportSection: () => null }));

describe("Phase 0 provider privacy disclosure", () => {
  it("explains each provider data flow, minimization boundary, routing, and retention in Settings", () => {
    render(<SettingsPage />);
    const text = screen.getByTestId("settings-page").textContent ?? "";
    const containsAll = (...parts: RegExp[]) => parts.every((part) => part.test(text));

    expect.soft(containsAll(/tile/i, /coordinates/i, /network metadata/i)).toBe(true);
    expect.soft(containsAll(/(?:search|geocod)/i, /text/i, /location bias/i)).toBe(true);
    expect
      .soft(
        containsAll(/(?:resolver|POI|place lookup)/i, /(?:bounding box|element id|OSM reference)/i),
      )
      .toBe(true);
    expect
      .soft(
        containsAll(
          /(?:note bodies|notes)/i,
          /(?:list names|lists)/i,
          /tags/i,
          /(?:never|not sent|do not send|doesn't send)/i,
        ),
      )
      .toBe(true);
    expect.soft(containsAll(/direct/i, /proxied/i)).toBe(true);
    expect.soft(text).toMatch(/retention/i);
  });
});

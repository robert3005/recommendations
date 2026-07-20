/**
 * Phase 0 performance budget (spec/src/roadmap.md): map shell and first
 * tiles usable within ~2s on a mid-range phone over 4G — captured as a
 * REPEATABLE throttled acceptance check against the production build
 * (4× CPU throttle + emulated 4G network via CDP). Formal p75/p95 budgets on
 * named reference devices are Phase 9 scope.
 */
import { expect, test } from "@playwright/test";

const BUDGET_MS = Number(process.env.PERF_BUDGET_MS ?? "2000");

test("launch and first canvas paint fit the throttled ~2s budget", async ({ page }) => {
  const session = await page.context().newCDPSession(page);
  // A mid-range phone on 4G: 4× CPU slowdown, ~170ms RTT, ~9 Mbps down.
  await session.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await session.send("Network.enable");
  await session.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 170,
    downloadThroughput: (9 * 1024 * 1024) / 8,
    uploadThroughput: (1.5 * 1024 * 1024) / 8,
  });

  // Budget 1: launch → the Lists home pane is usable.
  const navigationStart = Date.now();
  await page.goto("/");
  await expect(page.getByTestId("lists-page")).toBeVisible();
  const shellMs = Date.now() - navigationStart;

  // Budget 2: revealing the canvas → the basemap has established itself
  // (the map reports its camera once the style is up; the designed
  // "Map unavailable" state must not be showing).
  const revealStart = Date.now();
  await page.getByTestId("pane-collapse").click();
  await expect(page.locator('[data-testid="map-canvas"][data-zoom]')).toBeAttached();
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  await expect(page.getByText("Map unavailable.")).toHaveCount(0);
  const canvasMs = Date.now() - revealStart;

  expect(shellMs, `Lists-home launch took ${shellMs.toString()}ms`).toBeLessThanOrEqual(BUDGET_MS);
  expect(canvasMs, `first canvas paint took ${canvasMs.toString()}ms`).toBeLessThanOrEqual(
    BUDGET_MS,
  );
});

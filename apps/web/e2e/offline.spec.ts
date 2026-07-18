/**
 * Phase 0 done-when: "the cached shell launches offline". Runs against the
 * production build + service worker (offline-preview project) — the dev server
 * has no SW. The basemap style is same-origin and precached, so even the map
 * renders offline.
 */
import { expect, test } from "@playwright/test";

test.describe("offline shell", () => {
  test("an already-opened installation launches offline", async ({ page, context }) => {
    // First visit online: register the service worker and let precache finish.
    await page.goto("/");
    await expect(page.locator(".maplibregl-canvas")).toBeVisible();
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    // The SW must control the page before we can rely on its cache.
    await page.reload();
    await page.evaluate(async () => {
      if (!navigator.serviceWorker.controller) {
        await new Promise((resolve) => {
          navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true });
        });
      }
    });

    // Kill the network and relaunch.
    await context.setOffline(true);
    await page.reload();

    // The shell renders from the SW cache: nav, map (precached local style), attribution.
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await expect(page.locator(".maplibregl-canvas")).toBeVisible();
    await expect(page.locator(".maplibregl-ctrl-attrib")).toContainText(
      "© OpenStreetMap contributors",
    );

    // Client-side routes work offline too.
    await page.getByRole("link", { name: "Lists" }).click();
    await expect(page.getByTestId("lists-page")).toBeVisible();
    await page.getByRole("link", { name: "Settings" }).click();
    await expect(page.getByTestId("settings-page")).toBeVisible();

    await context.setOffline(false);
  });
});

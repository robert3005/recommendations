/**
 * Map display tests (Phase 0 done-when): the map renders with correct attribution,
 * and geolocation denial never blocks the UI. The canvas is always mounted under
 * the content pane (spec/src/map-view.md §The grammar); interacting with it means
 * stepping the pane toward the map first — it is one collapse away, not a tab.
 */
import { expect, type Page, test } from "@playwright/test";

/** Step the pane toward the map: expanded → split → collapsed. */
async function collapsePane(page: Page, times = 1) {
  for (let index = 0; index < times; index += 1) {
    await page.getByTestId("pane-collapse").click();
  }
}

test.describe("map display", () => {
  test("renders the MapLibre canvas with OSM attribution", async ({ page }) => {
    await page.goto("/");
    const canvas = page.locator(".maplibregl-canvas");
    await expect(canvas).toBeVisible();
    // The canvas must have real dimensions (a zero-size canvas is a layout bug).
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.width ?? 0).toBeGreaterThan(200);
    expect(box?.height ?? 0).toBeGreaterThan(200);
    // Licensing requirement: attribution is visible on the map surface.
    await expect(page.locator(".maplibregl-ctrl-attrib")).toContainText(
      "© OpenStreetMap contributors",
    );
  });

  test("map pans on drag", async ({ page }) => {
    await page.goto("/");
    // Full-bleed canvas: collapse the pane out of the way so drags hit the map.
    await collapsePane(page, 2);
    const mapEl = page.getByTestId("map-canvas");
    await expect(page.locator(".maplibregl-canvas")).toBeVisible();
    const before = await mapEl.getAttribute("data-center");
    expect(before).not.toBeNull();
    const box = await mapEl.boundingBox();
    if (!box) throw new Error("no canvas box");
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 120, cy + 40, { steps: 8 });
    await page.mouse.up();
    await expect(mapEl).not.toHaveAttribute("data-center", before ?? "");
  });

  test("the map starts on a timezone-approximate location, no permission asked", async ({
    browser,
  }) => {
    // The suite pins Europe/Lisbon; this context is a Tokyo device.
    const context = await browser.newContext({ timezoneId: "Asia/Tokyo" });
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.locator(".maplibregl-canvas")).toBeVisible();
    await expect(page.getByTestId("map-canvas")).toHaveAttribute("data-center", "139.6900,35.6900");
    await expect(page.getByTestId("map-canvas")).toHaveAttribute("data-zoom", "10.00");
    await context.close();
  });

  test("the next launch restores the last viewport", async ({ page }) => {
    await page.goto("/");
    // Full-bleed canvas so the drag below reaches the map.
    await collapsePane(page, 2);
    const mapEl = page.getByTestId("map-canvas");
    await expect(page.locator(".maplibregl-canvas")).toBeVisible();
    // Start: the Lisbon approximation from the suite's pinned timezone.
    await expect(mapEl).toHaveAttribute("data-center", "-9.1400,38.7200");

    const box = await mapEl.boundingBox();
    if (!box) throw new Error("no canvas box");
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 160, cy + 60, { steps: 8 });
    await page.mouse.up();
    await expect(mapEl).not.toHaveAttribute("data-center", "-9.1400,38.7200");
    // Drag inertia settles before the debounced persist fires; wait for a
    // stored viewport that is no longer the starting approximation.
    await page.waitForFunction(() => {
      const raw = localStorage.getItem("placemarks:viewport");
      if (!raw) return false;
      const stored = JSON.parse(raw) as { lng: number; lat: number };
      return `${stored.lng.toFixed(4)},${stored.lat.toFixed(4)}` !== "-9.1400,38.7200";
    });
    // The persisted viewport is deliberately coarse (~1 km grid) so a
    // Locate-driven recenter never stores a precise position — the next
    // launch starts at the coarse persisted point, not the exact camera.
    const persisted = await page.evaluate(() => {
      const raw = localStorage.getItem("placemarks:viewport");
      const stored = JSON.parse(raw ?? "{}") as { lng: number; lat: number };
      return `${stored.lng.toFixed(4)},${stored.lat.toFixed(4)}`;
    });

    await page.reload();
    await expect(page.locator(".maplibregl-canvas")).toBeVisible();
    await expect(mapEl).toHaveAttribute("data-center", persisted);
  });

  test("geolocation denial produces a designed state, never a blank screen", async ({
    browser,
  }) => {
    const context = await browser.newContext({ permissions: [] });
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.locator(".maplibregl-canvas")).toBeVisible();
    // With geolocation unavailable, MapLibre disables the control with an accessible
    // explanation — the designed fallback state. The map itself stays fully usable.
    const locateButton = page.getByRole("button", { name: "Location not available" });
    await expect(locateButton).toBeDisabled();
    await expect(page.locator(".maplibregl-canvas")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await context.close();
  });

  test("granted geolocation recenters the map on locate", async ({ browser }) => {
    const context = await browser.newContext({
      permissions: ["geolocation"],
      geolocation: { latitude: 51.5074, longitude: -0.1278 }, // London
    });
    const page = await context.newPage();
    await page.goto("/");
    const mapEl = page.getByTestId("map-canvas");
    await expect(page.locator(".maplibregl-canvas")).toBeVisible();
    // The locate control floats on the canvas — reveal it beside the pane.
    await collapsePane(page);
    await page.locator(".maplibregl-ctrl-geolocate").click();
    // The map should fly to the mocked position.
    await expect(mapEl).toHaveAttribute("data-center", /-0\.12\d+,51\.50\d+/, {
      timeout: 10_000,
    });
    await context.close();
  });

  test("navigation shell renders all top-level routes", async ({ page }) => {
    // Launch: the Lists home in an expanded pane over the always-mounted canvas.
    await page.goto("/");
    const shell = page.getByTestId("app-shell");
    await expect(shell).toHaveAttribute("data-pane-state", "expanded");
    await expect(page.getByTestId("lists-page")).toBeVisible();

    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("link", { name: "Lists" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Review" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Settings" })).toBeVisible();
    // The map is not a tab any more — it is one collapse away.
    await expect(nav.getByRole("link", { name: "Map" })).toHaveCount(0);

    // While the pane fully occludes it, the canvas idles.
    await expect(page.locator("[data-canvas-idle]")).toHaveAttribute("data-canvas-idle", "1");

    // The detent cycle: expanded → split → collapsed and back.
    await page.getByTestId("pane-collapse").click();
    await expect(shell).toHaveAttribute("data-pane-state", "split");
    await expect(page.locator("[data-canvas-idle]")).toHaveAttribute("data-canvas-idle", "0");
    await page.getByTestId("pane-collapse").click();
    await expect(shell).toHaveAttribute("data-pane-state", "collapsed");
    // Collapsed on desktop hides the pane; a floating reopen affordance appears.
    await expect(page.getByTestId("content-pane")).toBeHidden();
    await page.getByTestId("pane-reopen").click();
    await expect(shell).toHaveAttribute("data-pane-state", "split");
    await page.getByTestId("pane-expand").click();
    await expect(shell).toHaveAttribute("data-pane-state", "expanded");

    // Public viewer routes still render designed states, never blanks.
    await page.goto("/l");
    await expect(page.getByTestId("snapshot-error")).toContainText("Could not open");
    await page.goto("/n/no-such-note");
    await expect(page.getByTestId("hosted-error")).toContainText("no longer available");
  });
});

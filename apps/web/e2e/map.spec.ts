/**
 * The notebook & the map (spec/src/map-view.md §The grammar): the map is not a
 * page — a single persistent canvas beside the notebook, split by default and
 * one collapse away, never a tab. The map renders with OSM attribution, starts
 * on a timezone-approximate location without a permission prompt, restores the
 * last (coarsened) viewport, and geolocation denial never blocks the UI.
 */
import { expect, test } from "@playwright/test";

const LISBON_START = "-9.1400,38.7200"; // the suite pins Europe/Lisbon

test.describe("map display", () => {
  test("renders the MapLibre canvas with OSM attribution beside the notebook", async ({ page }) => {
    await page.goto("/");
    // Split is the default: notebook and canvas are visible together.
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-pane-state", "split");
    const canvas = page.locator(".maplibregl-canvas");
    await expect(canvas).toBeVisible();
    // The canvas must have real dimensions (a zero-size canvas is a layout bug).
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.width ?? 0).toBeGreaterThan(200);
    expect(box?.height ?? 0).toBeGreaterThan(200);
    // Licensing requirement: attribution is visible on the map surface.
    await expect(page.getByTestId("map-attribution")).toContainText("© OpenStreetMap contributors");
  });

  test("map pans on drag", async ({ page }) => {
    await page.goto("/");
    // Full-bleed canvas: one collapse, so drags hit the map for sure.
    await page.getByTestId("pane-collapse").click();
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

  test("the next launch restores the last viewport, coarsened", async ({ page }) => {
    await page.goto("/");
    // Full-bleed canvas so the drag below reaches the map.
    await page.getByTestId("pane-collapse").click();
    const mapEl = page.getByTestId("map-canvas");
    await expect(page.locator(".maplibregl-canvas")).toBeVisible();
    // Start: the Lisbon approximation from the suite's pinned timezone.
    await expect(mapEl).toHaveAttribute("data-center", LISBON_START);

    const box = await mapEl.boundingBox();
    if (!box) throw new Error("no canvas box");
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 160, cy + 60, { steps: 8 });
    await page.mouse.up();
    await expect(mapEl).not.toHaveAttribute("data-center", LISBON_START);

    // The viewport persists in the repository's `settings` store
    // (spec/src/storage.md) after the debounced report — poll from the test
    // side for a stored camera that is no longer the starting approximation.
    const readStoredCenter = () =>
      page.evaluate(
        () =>
          new Promise<string | null>((resolve) => {
            const open = indexedDB.open("placemarks");
            open.onerror = () => resolve(null);
            open.onsuccess = () => {
              const db = open.result;
              try {
                const get = db
                  .transaction("settings", "readonly")
                  .objectStore("settings")
                  .get("lastViewport");
                get.onsuccess = () => {
                  db.close();
                  const row = get.result as { value?: { lat: number; lng: number } } | undefined;
                  if (!row?.value) return resolve(null);
                  resolve(`${row.value.lng.toFixed(4)},${row.value.lat.toFixed(4)}`);
                };
                get.onerror = () => {
                  db.close();
                  resolve(null);
                };
              } catch {
                db.close();
                resolve(null);
              }
            };
          }),
      );
    await expect
      .poll(
        async () => {
          const center = await readStoredCenter();
          return center !== null && center !== LISBON_START ? center : null;
        },
        { timeout: 10_000 },
      )
      .not.toBeNull();
    const persisted = String(await readStoredCenter());
    // Deliberately coarse (~1 km grid): a Locate-driven recenter never stores
    // a precise position — the next launch starts at the coarse point.
    expect(persisted).toMatch(/^-?\d+\.\d{2}00,-?\d+\.\d{2}00$/);

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
    // With geolocation unavailable, MapLibre disables the control with an
    // accessible explanation — the designed fallback. The map stays usable.
    const locateButton = page.getByRole("button", { name: "Location not available" });
    await expect(locateButton).toBeDisabled();
    await expect(page.locator(".maplibregl-canvas")).toBeVisible();
    await expect(page.getByTestId("home-link")).toBeVisible();
    await expect(page.getByTestId("add-place-field")).toBeVisible();
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
    // The locate control floats on the canvas, visible beside the notebook.
    await page.locator(".maplibregl-ctrl-geolocate").click();
    // The map should fly to the mocked position.
    await expect(mapEl).toHaveAttribute("data-center", /-0\.12\d+,51\.50\d+/, {
      timeout: 10_000,
    });
    await context.close();
  });

  test("the search-first shell reaches every notebook route; the map is one collapse away", async ({
    page,
  }) => {
    // Launch: the Lists home in the notebook beside the canvas.
    await page.goto("/");
    const shell = page.getByTestId("app-shell");
    await expect(shell).toHaveAttribute("data-pane-state", "split");
    await expect(page.getByTestId("lists-page")).toBeVisible();

    // The top bar is for search (2026-07-26 — search-first chrome): the
    // wordmark home affordance and the add-a-place field — no persistent
    // nav, no Map tab, and no review pill while nothing is reviewing.
    await expect(page.getByTestId("home-link")).toBeVisible();
    await expect(page.getByTestId("add-place-field")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Map" })).toHaveCount(0);
    await expect(page.getByTestId("review-pill")).toHaveCount(0);

    // Desktop widths: split ↔ collapsed, nothing else.
    await page.getByTestId("pane-collapse").click();
    await expect(shell).toHaveAttribute("data-pane-state", "collapsed");
    // Collapsed hides the notebook; a floating reopen affordance appears —
    // stacked above the settings gear in the same corner, never overlapping.
    await expect(page.getByTestId("content-pane")).toBeHidden();
    const reopenBox = await page.getByTestId("pane-reopen").boundingBox();
    const gearBox = await page.getByTestId("settings-gear").boundingBox();
    if (!reopenBox || !gearBox) throw new Error("floating chips have no bounding boxes");
    expect(gearBox.y).toBeGreaterThanOrEqual(reopenBox.y + reopenBox.height);
    await page.getByTestId("pane-reopen").click();
    await expect(shell).toHaveAttribute("data-pane-state", "split");

    // Notebook routes render designed states, never blanks: Settings behind
    // the bottom-left gear chip, /review deep-linkable without a pill.
    await page.goto("/review");
    await expect(page.getByTestId("review-page")).toBeVisible();
    await expect(page.getByTestId("review-empty")).toBeVisible();
    await page.getByTestId("settings-gear").click();
    await expect(page.getByTestId("settings-page")).toBeVisible();

    // Public viewer routes too: unknown slugs are answers, not blank pages,
    // under read-only chrome (spec/src/sharing.md §The public viewer).
    await page.goto("/l/no-such-list");
    await expect(page.getByTestId("public-readonly-chrome")).toBeVisible();
    await expect(page.getByTestId("published-error")).toHaveAttribute("data-reason", "not-found");
    await page.goto("/p/no-such-post");
    await expect(page.getByTestId("published-error")).toContainText(
      "There is nothing at this link.",
    );
  });
});

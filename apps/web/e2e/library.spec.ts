/**
 * Phase 2 end-to-end: the save loop and manual pins against real IndexedDB in a
 * real browser. Providers are MSW fixtures; the basemap is the local style.
 */
import { expect, test } from "@playwright/test";

test.describe("saving places", () => {
  test("search → resolve → save → persists across reload", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".maplibregl-canvas")).toBeVisible();

    // Search and select.
    await page.getByRole("combobox", { name: "Search places" }).fill("cafe");
    await page.getByRole("option", { name: /Café Central/ }).click();

    // The sheet resolves the exact OSM element; the website is the prize.
    const sheet = page.getByTestId("place-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId("website-link")).toHaveAttribute(
      "href",
      "https://cafecentral.pt/",
    );

    // Save → saved sheet with live repository state.
    await sheet.getByTestId("save-place").click();
    const savedSheet = page.getByTestId("saved-place-sheet");
    await expect(savedSheet).toBeVisible();
    // Healthy places show no state marker (freshness UI deferred).
    await expect(savedSheet.getByTestId("state-badge")).toHaveCount(0);

    // Tag it.
    await savedSheet.getByLabel("Add tag").fill("coffee");
    await savedSheet.getByLabel("Add tag").press("Enter");
    await expect(savedSheet.getByText("coffee")).toBeVisible();

    // Survives a full reload (IndexedDB persistence).
    await page.reload();
    await expect(page.locator(".maplibregl-canvas")).toBeVisible();
    // The saved pin is at the map's initial center; click it to reopen.
    const mapEl = page.getByTestId("map-canvas");
    // The map reports painted saved pins via a data attribute — no sleeps.
    await expect(mapEl).toHaveAttribute("data-saved-pins", /^[1-9]/, { timeout: 10_000 });
    const box = await mapEl.boundingBox();
    if (!box) throw new Error("no canvas");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const reopened = page.getByTestId("saved-place-sheet");
    await expect(reopened).toBeVisible();
    await expect(reopened.getByText("Café Central")).toBeVisible();
    await expect(reopened.getByText("coffee")).toBeVisible();
  });

  test("long-press → save as unlinked manual pin", async ({ page }) => {
    await page.goto("/");
    const mapEl = page.getByTestId("map-canvas");
    await expect(page.locator(".maplibregl-canvas")).toBeVisible();
    const box = await mapEl.boundingBox();
    if (!box) throw new Error("no canvas");

    // Right-click (contextmenu) opens the nearby-candidate picker.
    await page.mouse.click(box.x + box.width / 3, box.y + box.height / 3, { button: "right" });
    const picker = page.getByTestId("candidate-picker");
    await expect(picker).toBeVisible();
    // Both escape paths are offered (ratified design).
    await expect(picker.getByRole("link", { name: "Add it on OpenStreetMap" })).toBeVisible();

    await picker.getByTestId("save-manual").click();
    const dialog = page.getByTestId("manual-pin-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("manual-name").fill("Our picnic bench");
    await dialog.getByTestId("manual-save").click();

    const savedSheet = page.getByTestId("saved-place-sheet");
    await expect(savedSheet).toBeVisible();
    await expect(savedSheet.getByText("Our picnic bench")).toBeVisible();
    await expect(savedSheet.getByTestId("state-badge")).toHaveAttribute("data-state", "unlinked");
    // The manual pin is honestly labeled and upgradeable.
    await expect(savedSheet.getByTestId("manual-note")).toBeVisible();
    await expect(savedSheet.getByTestId("link-to-osm")).toBeVisible();
  });
});

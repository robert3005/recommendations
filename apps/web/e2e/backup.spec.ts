/**
 * Phase 2 done-when: restore from backup. Export the ZIP, destroy the data,
 * replace-import the download, and get the library back.
 */
import { expect, type Page, test } from "@playwright/test";

async function reopenSavedAtCenter(page: Page) {
  await page.reload();
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  // The pane relaunches expanded over the idle canvas — collapse once so the
  // canvas chrome is reachable and the pins paint (spec/src/map-view.md).
  await page.getByTestId("pane-collapse").click();
  const mapEl = page.getByTestId("map-canvas");
  // The map reports painted saved pins via a data attribute — no sleeps.
  await expect(mapEl).toHaveAttribute("data-pins", /^[1-9]/, { timeout: 10_000 });
  // Reopen camera-independently: search recognizes the listed place.
  await page.getByRole("combobox", { name: "Search places" }).fill("cafe");
  await page.getByRole("option", { name: /Café Central/ }).click();
  await page.getByTestId("open-place").click();
}

test("export → remove-place → import(replace) restores the library", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  // Reach the canvas search beside the pane.
  await page.getByTestId("pane-collapse").click();

  // Seed: Café Central enters the library via a new list, with a tag.
  await page.getByRole("combobox", { name: "Search places" }).fill("cafe");
  await page.getByRole("option", { name: /Café Central/ }).click();
  const placeSheet = page.getByTestId("place-sheet");
  await placeSheet.getByTestId("add-to-list").selectOption("__new__");
  await placeSheet.getByLabel("New list name").fill("Backup list");
  await placeSheet.getByTestId("create-list-and-add").click();
  const sheet = page.getByTestId("place-details");
  await expect(sheet).toBeVisible();
  await sheet.getByLabel("Add tag").fill("coffee");
  await sheet.getByLabel("Add tag").press("Enter");
  await expect(sheet.getByText("coffee")).toBeVisible();
  await sheet.getByRole("button", { name: "Close" }).click();

  // Export the backup ZIP.
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Settings" })
    .click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("export-backup").click();
  const download = await downloadPromise;
  const backupPath = await download.path();
  await expect(page.getByTestId("settings-message")).toContainText("Backup exported");

  // Destroy: remove-place the place. The canvas never navigated away —
  // reopenSavedAtCenter reloads and collapses the pane itself.
  await reopenSavedAtCenter(page);
  await expect(page.getByTestId("place-details")).toBeVisible();
  await page.getByTestId("remove-place").click();
  await expect(page.getByTestId("place-details")).toHaveCount(0);

  // Restore: replace-import the downloaded archive.
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Settings" })
    .click();
  await page.getByRole("radio", { name: "Replace everything" }).check();
  await page.getByLabel("Backup file").setInputFiles(backupPath);
  await expect(page.getByTestId("settings-message")).toContainText("Imported");

  // The library is back: same place, same tag.
  await reopenSavedAtCenter(page);
  const restored = page.getByTestId("place-details");
  await expect(restored).toBeVisible();
  await expect(restored.getByText("Café Central")).toBeVisible();
  await expect(restored.getByText("coffee")).toBeVisible();
});

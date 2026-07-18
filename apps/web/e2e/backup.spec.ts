/**
 * Phase 2 done-when: restore from backup. Export the ZIP, destroy the data,
 * replace-import the download, and get the library back.
 */
import { expect, type Page, test } from "@playwright/test";

async function reopenSavedAtCenter(page: Page) {
  const mapEl = page.getByTestId("map-canvas");
  const box = await mapEl.boundingBox();
  if (!box) throw new Error("no canvas");
  await page.waitForTimeout(700); // saved layer paints after style + data load
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test("export → unsave → import(replace) restores the library", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();

  // Seed: save Café Central (map center at initial zoom) with a tag.
  await page.getByRole("combobox", { name: "Search places" }).fill("cafe");
  await page.getByRole("option", { name: /Café Central/ }).click();
  await page.getByTestId("place-sheet").getByTestId("save-place").click();
  const sheet = page.getByTestId("saved-place-sheet");
  await expect(sheet).toBeVisible();
  await sheet.getByLabel("Add tag").fill("coffee");
  await sheet.getByLabel("Add tag").press("Enter");
  await expect(sheet.getByText("coffee")).toBeVisible();
  await sheet.getByRole("button", { name: "Close" }).click();

  // Export the backup ZIP.
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Settings" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("export-backup").click();
  const download = await downloadPromise;
  const backupPath = await download.path();
  await expect(page.getByTestId("settings-message")).toContainText("Backup exported");

  // Destroy: unsave the place.
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Map" }).click();
  await reopenSavedAtCenter(page);
  await expect(page.getByTestId("saved-place-sheet")).toBeVisible();
  await page.getByTestId("unsave").click();
  await expect(page.getByTestId("saved-place-sheet")).toHaveCount(0);

  // Restore: replace-import the downloaded archive.
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Settings" }).click();
  await page.getByRole("radio", { name: "Replace everything" }).check();
  await page.getByLabel("Backup file").setInputFiles(backupPath);
  await expect(page.getByTestId("settings-message")).toContainText("Imported");

  // The library is back: same place, same tag.
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Map" }).click();
  await reopenSavedAtCenter(page);
  const restored = page.getByTestId("saved-place-sheet");
  await expect(restored).toBeVisible();
  await expect(restored.getByText("Café Central")).toBeVisible();
  await expect(restored.getByText("coffee")).toBeVisible();
});

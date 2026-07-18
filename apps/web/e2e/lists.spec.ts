/**
 * Lists-first flow (book/src/vision.md): lists are created from a place's card;
 * the Lists tab is browse/edit — describe, reorder, remove, persist.
 */
import { expect, type Page, test } from "@playwright/test";

async function saveFromSearch(page: Page, optionName: RegExp) {
  const search = page.getByRole("combobox", { name: "Search places" });
  await search.fill("");
  await search.fill("cafe");
  await page.getByRole("option", { name: optionName }).click();
  await page.getByTestId("place-sheet").getByTestId("save-place").click();
  await expect(page.getByTestId("saved-place-sheet")).toBeVisible();
}

async function closeSavedSheet(page: Page) {
  await page.getByTestId("saved-place-sheet").getByRole("button", { name: "Close" }).click();
}

test("create a list from a place card, group, describe, reorder, persist", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();

  // Save Café Central and create the list right on its card.
  await saveFromSearch(page, /Café Central/);
  const sheet = page.getByTestId("saved-place-sheet");
  await sheet.getByTestId("add-to-list").selectOption("__new__");
  await sheet.getByLabel("New list name").fill("Lisbon favourites");
  await sheet.getByTestId("create-list-and-add").click();
  await expect(sheet.getByTestId("sheet-message")).toContainText('Added to "Lisbon favourites"');
  await closeSavedSheet(page);

  // Save Café do Rio and add it to the now-existing list.
  await saveFromSearch(page, /Café do Rio/);
  await sheet.getByTestId("add-to-list").selectOption({ label: "Lisbon favourites" });
  await expect(sheet.getByTestId("sheet-message")).toContainText('Added to "Lisbon favourites"');
  // A list the place is already in disappears from the dropdown.
  await expect(
    sheet.getByTestId("add-to-list").locator("option", { hasText: "Lisbon favourites" }),
  ).toHaveCount(0);
  await closeSavedSheet(page);

  // The Lists tab is browse/edit: open the list, describe it, reorder, remove.
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Lists" })
    .click();
  await expect(page.getByTestId("lists-page")).toBeVisible();
  await page.getByRole("link", { name: /Lisbon favourites/ }).click();
  await expect(page.getByTestId("list-page")).toBeVisible();

  const items = page.getByTestId("place-item");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText("Café Central");
  await expect(items.nth(1)).toContainText("Café do Rio");

  await page.getByTestId("edit-description").click();
  await page.getByTestId("description-input").fill("Places I keep coming back to.");
  await page.getByTestId("save-description").click();
  await expect(page.getByTestId("list-description")).toHaveText("Places I keep coming back to.");

  await items.nth(1).getByRole("button", { name: "Move up" }).click();
  await expect(items.nth(0)).toContainText("Café do Rio");

  await items.nth(1).getByRole("button", { name: "Remove from list" }).click();
  await expect(items).toHaveCount(1);

  // Everything persists across a full reload.
  await page.reload();
  await expect(page.getByTestId("list-page")).toBeVisible();
  await expect(page.getByTestId("list-description")).toHaveText("Places I keep coming back to.");
  await expect(page.getByTestId("place-item")).toHaveCount(1);
  await expect(page.getByTestId("place-item")).toContainText("Café do Rio");
});

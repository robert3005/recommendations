/**
 * Lists-first flow (book/src/vision.md): group saved places into a list,
 * describe the set, reorder, and persist.
 */
import { expect, type Page, test } from "@playwright/test";

async function savePlace(page: Page, query: string, optionName: RegExp) {
  const search = page.getByRole("combobox", { name: "Search places" });
  await search.fill("");
  await search.fill(query);
  await page.getByRole("option", { name: optionName }).click();
  await page.getByTestId("place-sheet").getByTestId("save-place").click();
  await expect(page.getByTestId("saved-place-sheet")).toBeVisible();
  await page.getByTestId("saved-place-sheet").getByRole("button", { name: "Close" }).click();
}

test("create a list, describe it, group places, reorder, persist", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();

  // Save two places from the map.
  await savePlace(page, "cafe", /Café Central/);
  await savePlace(page, "cafe", /Café do Rio/);

  // Create the list.
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Lists" })
    .click();
  await page.getByLabel("New list name").fill("Lisbon favourites");
  await page.getByTestId("create-list").click();
  await page.getByRole("link", { name: "Lisbon favourites" }).click();
  await expect(page.getByTestId("list-page")).toBeVisible();

  // Describe the set.
  await page.getByTestId("edit-description").click();
  await page.getByTestId("description-input").fill("Places I keep coming back to.");
  await page.getByTestId("save-description").click();
  await expect(page.getByTestId("list-description")).toHaveText("Places I keep coming back to.");

  // Group both places.
  const addPlace = page.getByLabel("Add saved place");
  await addPlace.selectOption({ label: "Café Central" });
  await addPlace.selectOption({ label: "Café do Rio" });
  const items = page.getByTestId("place-item");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText("Café Central");
  await expect(items.nth(1)).toContainText("Café do Rio");

  // Reorder.
  await items.nth(1).getByRole("button", { name: "Move up" }).click();
  await expect(items.nth(0)).toContainText("Café do Rio");
  await expect(items.nth(1)).toContainText("Café Central");

  // Remove one.
  await items.nth(1).getByRole("button", { name: "Remove from list" }).click();
  await expect(items).toHaveCount(1);
  // Removing from the list never deletes the saved place — it's re-addable.
  await expect(page.getByLabel("Add saved place").locator("option")).toContainText([
    "Add saved place…",
    "Café Central",
  ]);

  // Everything persists across a full reload.
  await page.reload();
  await expect(page.getByTestId("list-page")).toBeVisible();
  await expect(page.getByTestId("list-description")).toHaveText("Places I keep coming back to.");
  await expect(page.getByTestId("place-item")).toHaveCount(1);
  await expect(page.getByTestId("place-item")).toContainText("Café do Rio");

  // The lists index shows the description as the card subtitle.
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Lists" })
    .click();
  await expect(page.getByRole("link", { name: /Lisbon favourites/ })).toContainText(
    "Places I keep coming back to.",
  );
});

/**
 * Lists-first flow (book/src/vision.md): adding a place to a list IS the save;
 * lists carry a user-selected marker; the Lists tab reads list contents and can
 * create lists (2026-07-18) — contents are edited elsewhere.
 */
import { expect, type Page, test } from "@playwright/test";

async function openPlace(page: Page, optionName: RegExp) {
  const search = page.getByRole("combobox", { name: "Search places" });
  await search.fill("");
  await search.fill("cafe");
  await page.getByRole("option", { name: optionName }).click();
  await expect(page.getByTestId("place-sheet")).toBeVisible();
}

test("adding to a list saves the place; the Lists tab reads the marked list", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();

  // Café Central: never explicitly saved — adding it to a new list saves it.
  await openPlace(page, /Café Central/);
  const placeSheet = page.getByTestId("place-sheet");
  await placeSheet.getByTestId("add-to-list").selectOption("__new__");
  await placeSheet.getByLabel("New list name").fill("Lisbon favourites");
  // The default marker colour (first palette entry) is preselected.
  await expect(placeSheet.getByTestId("marker-#dc2626")).toBeChecked();
  await placeSheet.getByTestId("create-list-and-add").click();
  // The act of adding was the save: the saved sheet takes over, mark on map.
  const details = page.getByTestId("place-details");
  await expect(details).toBeVisible();
  await expect(page.getByTestId("map-canvas")).toHaveAttribute("data-pins", /^[1-9]/);
  await details.getByRole("button", { name: "Close" }).click();

  // Café do Rio: straight into the existing list from the unsaved card.
  await openPlace(page, /Café do Rio/);
  await placeSheet.getByTestId("add-to-list").selectOption({ label: "Lisbon favourites" });
  await expect(details).toBeVisible();
  await details.getByRole("button", { name: "Close" }).click();

  // The Lists tab reads: marker + both places in order, no edit affordances.
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Lists" })
    .click();
  await expect(page.getByTestId("lists-page")).toBeVisible();
  await expect(page.getByTestId("list-marker")).toHaveAttribute("data-color", "#dc2626");
  await page.getByRole("link", { name: /Lisbon favourites/ }).click();
  await expect(page.getByTestId("list-page")).toBeVisible();
  await expect(page.getByTestId("list-marker")).toHaveAttribute("data-color", "#dc2626");

  const items = page.getByTestId("place-item");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText("Café Central");
  await expect(items.nth(1)).toContainText("Café do Rio");
  await expect(page.getByRole("button", { name: "Move up" })).toHaveCount(0);
  await expect(page.getByLabel("Add saved place")).toHaveCount(0);

  // Persists across a full reload.
  await page.reload();
  await expect(page.getByTestId("list-page")).toBeVisible();
  await expect(page.getByTestId("place-item")).toHaveCount(2);
});

test("a list created on the Lists tab is offered on the place card", async ({ page }) => {
  // Lists exist on their own (2026-07-18): created here, before any place joins.
  await page.goto("/lists");
  await page.getByTestId("new-list").click();
  await page.getByLabel("New list name").fill("Weekend");
  await expect(page.getByTestId("marker-#dc2626")).toBeChecked();
  await page.getByTestId("create-list").click();
  const entry = page.getByRole("link", { name: /Weekend/ });
  await expect(entry).toBeVisible();
  await expect(page.getByTestId("list-marker")).toHaveAttribute("data-color", "#dc2626");

  // The app-created list receives its first place from the map card.
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Map" })
    .click();
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  await openPlace(page, /Café Central/);
  await page.getByTestId("place-sheet").getByTestId("add-to-list").selectOption({
    label: "Weekend",
  });
  await expect(page.getByTestId("place-details")).toBeVisible();
  await expect(page.getByTestId("map-canvas")).toHaveAttribute("data-pins", /^[1-9]/);
});

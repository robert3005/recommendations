/**
 * Lists-first flow (spec/src/vision.md): adding a place to a list IS the save;
 * lists carry a user-selected marker; the Lists home reads list contents and can
 * create lists (2026-07-18) — contents are edited elsewhere. The canvas is one
 * collapse away (spec/src/map-view.md §The grammar), never a tab switch.
 */
import { expect, type Page, test } from "@playwright/test";

/** Step the pane toward the map: expanded → split → collapsed. */
async function collapsePane(page: Page, times = 1) {
  for (let index = 0; index < times; index += 1) {
    await page.getByTestId("pane-collapse").click();
  }
}

async function openPlace(page: Page, optionName: RegExp) {
  const search = page.getByRole("combobox", { name: "Search places" });
  await search.fill("");
  await search.fill("cafe");
  await page.getByRole("option", { name: optionName }).click();
  await expect(page.getByTestId("place-sheet")).toBeVisible();
}

test("adding to a list saves the place; the Lists home reads the marked list", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  // The canvas chrome (search) is reachable once the pane is not expanded.
  await collapsePane(page);

  // Café Central: never explicitly saved — adding it to a new list saves it.
  await openPlace(page, /Café Central/);
  const placeSheet = page.getByTestId("place-sheet");
  await placeSheet.getByTestId("add-to-list").selectOption("__new__");
  await placeSheet.getByLabel("New list name").fill("Lisbon favourites");
  // The default marker (first unused colour+icon combination) is preselected.
  await expect(placeSheet.getByTestId("marker-#dc2626-circle")).toBeChecked();
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

  // The Lists home reads: marker + both places in order, no edit affordances.
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Lists" })
    .click();
  await expect(page.getByTestId("lists-page")).toBeVisible();
  await expect(page.getByTestId("list-row").getByTestId("marker-glyph")).toHaveAttribute(
    "data-color",
    "#dc2626",
  );
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

test("Edit mode reorders, renames, recolours, and removes; reading stays read-only", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  await collapsePane(page);

  // Two places into a fresh list.
  await openPlace(page, /Café Central/);
  const placeSheet = page.getByTestId("place-sheet");
  await placeSheet.getByTestId("add-to-list").selectOption("__new__");
  await placeSheet.getByLabel("New list name").fill("Curation");
  await placeSheet.getByTestId("create-list-and-add").click();
  const details = page.getByTestId("place-details");
  await details.getByRole("button", { name: "Close" }).click();
  await openPlace(page, /Café do Rio/);
  await placeSheet.getByTestId("add-to-list").selectOption({ label: "Curation" });
  await details.getByRole("button", { name: "Close" }).click();

  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Lists" })
    .click();
  await page.getByRole("link", { name: /Curation/ }).click();
  // Read view: no edit affordances.
  await expect(page.getByRole("button", { name: "Move up" })).toHaveCount(0);

  // Edit mode: reorder, rename, recolour.
  await page.getByTestId("edit-list").click();
  const items = page.getByTestId("place-item");
  await expect(items.nth(0)).toContainText("Café Central");
  await items.nth(1).getByRole("button", { name: "Move up" }).click();
  await expect(items.nth(0)).toContainText("Café do Rio");

  await page.getByTestId("list-name-input").fill("Curated Lisbon");
  // The radio itself is sr-only; its swatch label is the click target.
  await page.locator('label:has([data-testid="marker-#2563eb-diamond"])').click();
  await expect(page.getByTestId("marker-#2563eb-diamond")).toBeChecked();
  await page.getByTestId("edit-list").click(); // Done
  await expect(page.getByTestId("list-page")).toContainText("Curated Lisbon");
  await expect(page.getByTestId("list-marker")).toHaveAttribute("data-color", "#2563eb");

  // Removing the last remaining membership removes the place (membership is existence).
  await page.getByTestId("edit-list").click();
  await items.nth(1).getByTestId("remove-from-list").click();
  await expect(items).toHaveCount(1);
  await page.getByTestId("edit-list").click();
  // The canvas beside the pane projects the surviving pin — home shows all lists.
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Lists" })
    .click();
  await expect(page.getByTestId("map-canvas")).toHaveAttribute("data-pins", "1");
});

test("a list created on the Lists home is offered on the place card", async ({ page }) => {
  // Lists exist on their own (2026-07-18): created here, before any place joins.
  // The old /lists path still lands on the home via redirect.
  await page.goto("/lists");
  await expect(page.getByTestId("lists-page")).toBeVisible();
  await page.getByTestId("new-list").click();
  await page.getByLabel("New list name").fill("Weekend");
  await expect(page.getByTestId("marker-#dc2626-circle")).toBeChecked();
  await page.getByTestId("create-list").click();
  const entry = page.getByRole("link", { name: /Weekend/ });
  await expect(entry).toBeVisible();
  await expect(page.getByTestId("list-row").getByTestId("marker-glyph")).toHaveAttribute(
    "data-color",
    "#dc2626",
  );

  // The app-created list receives its first place from the card on the canvas —
  // one collapse away, on the same route.
  await collapsePane(page);
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  await openPlace(page, /Café Central/);
  await page.getByTestId("place-sheet").getByTestId("add-to-list").selectOption({
    label: "Weekend",
  });
  await expect(page.getByTestId("place-details")).toBeVisible();
  await expect(page.getByTestId("map-canvas")).toHaveAttribute("data-pins", /^[1-9]/);
});

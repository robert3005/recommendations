/**
 * Lists-first flow (spec/src/vision.md, spec/src/map-view.md §Home): adding a
 * place to a list IS the save; lists wear an auto-assigned (shape, colour)
 * marker pair; Edit mode is where curation lives. The notebook renders beside
 * the always-mounted canvas — split by default, never a tab switch.
 */
import { expect, type Page, test } from "@playwright/test";

/** The deterministic marker walk (domain markers): pair 0 then pair 1. */
const FIRST_COLOR = "#F97316"; // circle · signal orange
const SECOND_PAIR = "diamond-#2457E6"; // diamond · cobalt

/** Type into the one add-a-place field and pick a geocoder result. */
async function pickCandidate(page: Page, option: RegExp) {
  const field = page.getByRole("combobox", { name: "Add a place" });
  await field.fill("cafe");
  await page.getByRole("option", { name: option }).click();
  await expect(page.getByTestId("add-place-confirm")).toBeVisible();
}

/**
 * Both add paths end in "pick a list" (spec/src/map-view.md §The add-a-place
 * field) — one combobox picks or creates it; picking is the add. An unmatched
 * name puts Create "<name>" first.
 */
async function addToNewList(page: Page, option: RegExp, listName: string) {
  await pickCandidate(page, option);
  const confirm = page.getByTestId("add-place-confirm");
  await confirm.getByTestId("field-list-choice").fill(listName);
  await confirm.getByTestId("field-create-option").click();
}

/**
 * Keyboard path (spec/src/map-view.md §Accessibility and failure): the exact
 * name match is the first, active option — Enter adds it.
 */
async function addToExistingList(page: Page, option: RegExp, listName: string) {
  await pickCandidate(page, option);
  const combobox = page.getByTestId("add-place-confirm").getByTestId("field-list-choice");
  await combobox.fill(listName);
  await combobox.press("Enter");
}

async function closePlaceCard(page: Page) {
  await page.getByTestId("place-details").getByRole("button", { name: "Close" }).click();
}

test("adding to a list saves the place; the Lists home reads the marked list", async ({ page }) => {
  await page.goto("/");
  // The canvas sits beside the notebook from launch — split is the default.
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-pane-state", "split");
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();

  // Café Central: never explicitly saved — adding it to a new list saves it.
  await addToNewList(page, /Café Central/, "Lisbon favourites");
  // The act of adding was the save: the place card rises, the mark lands.
  await expect(page.getByTestId("place-details")).toBeVisible();
  await expect(page.getByTestId("map-canvas")).toHaveAttribute("data-pins", /^[1-9]/);
  await closePlaceCard(page);

  // Café do Rio: straight into the existing list from the same field.
  await addToExistingList(page, /Café do Rio/, "Lisbon favourites");
  await expect(page.getByTestId("place-details")).toBeVisible();
  await closePlaceCard(page);

  // The home reads: the auto-assigned marker (first free pair) + place count.
  const row = page.getByTestId("list-row");
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("marker-glyph")).toHaveAttribute("data-color", FIRST_COLOR);
  await expect(row.getByTestId("list-place-count")).toHaveText("2 places");

  await page.getByRole("link", { name: /Lisbon favourites/ }).click();
  await expect(page.getByTestId("list-page")).toBeVisible();
  await expect(page.getByTestId("list-marker")).toHaveAttribute("data-color", FIRST_COLOR);
  const items = page.getByTestId("place-item");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText("Café Central");
  await expect(items.nth(1)).toContainText("Café do Rio");
  // Read view: no edit affordances.
  await expect(page.getByRole("button", { name: "Move up" })).toHaveCount(0);

  // The whole entry row is the selection target (spec/src/map-view.md §The
  // list page): clicking anywhere on it raises the place card and flies.
  await items.nth(0).click();
  await expect(page.getByTestId("place-details")).toBeVisible();
  await expect(page.getByTestId("place-details")).toContainText("Café Central");
  await closePlaceCard(page);

  // Persists across a full reload (IndexedDB persistence).
  await page.reload();
  await expect(page.getByTestId("list-page")).toBeVisible();
  await expect(page.getByTestId("place-item")).toHaveCount(2);
});

test("Edit mode reorders, renames, re-marks, and removes; reading stays read-only", async ({
  page,
}) => {
  await page.goto("/");
  // Two places into a fresh list.
  await addToNewList(page, /Café Central/, "Curation");
  await closePlaceCard(page);
  await addToExistingList(page, /Café do Rio/, "Curation");
  await closePlaceCard(page);

  await page.getByRole("link", { name: /Curation/ }).click();
  await expect(page.getByTestId("list-page")).toBeVisible();
  await expect(page.getByRole("button", { name: "Move up" })).toHaveCount(0);

  // Edit mode: reorder, rename, swap the marker within free pairs.
  await page.getByTestId("edit-list").click();
  const items = page.getByTestId("place-item");
  await expect(items.nth(0)).toContainText("Café Central");
  await items.nth(1).getByRole("button", { name: "Move up" }).click();
  await expect(items.nth(0)).toContainText("Café do Rio");

  await page.getByTestId("list-name-input").fill("Curated Lisbon");
  // The radio itself is sr-only; its swatch label is the click target.
  await page.locator(`label:has([data-testid="marker-${SECOND_PAIR}"])`).click();
  await expect(page.getByTestId(`marker-${SECOND_PAIR}`)).toBeChecked();
  await page.getByTestId("edit-list").click(); // Done
  await expect(page.getByTestId("list-page")).toContainText("Curated Lisbon");
  await expect(page.getByTestId("list-marker")).toHaveAttribute("data-color", "#2457E6");

  // Removing the last remaining membership removes the place (membership is existence).
  await page.getByTestId("edit-list").click();
  await items.nth(1).getByTestId("remove-from-list").click();
  await expect(items).toHaveCount(1);
  await page.getByTestId("edit-list").click();
  // Home projects every list's pins on the canvas beside the notebook.
  await page.getByTestId("home-link").click();
  await expect(page.getByTestId("map-canvas")).toHaveAttribute("data-pins", "1");
});

test("a list created on the Lists home is offered in the add-a-place field", async ({ page }) => {
  // Lists exist on their own: created here, before any place joins.
  await page.goto("/");
  await expect(page.getByTestId("lists-page")).toBeVisible();
  // The home carries the actions that feed lists (spec/src/map-view.md §Home).
  await expect(page.getByTestId("import-entry")).toBeVisible();
  await page.getByTestId("new-list").click();
  await page.getByLabel("New list name").fill("Weekend");
  await page.getByTestId("create-list").click();
  const row = page.getByTestId("list-row");
  await expect(row).toHaveCount(1);
  // The repository auto-assigned the first free pair — no marker picker here.
  await expect(row.getByTestId("marker-glyph")).toHaveAttribute("data-color", FIRST_COLOR);
  await expect(row.getByTestId("list-place-count")).toHaveText("0 places");

  // The app-created list receives its first place from the same field.
  await addToExistingList(page, /Café Central/, "Weekend");
  await expect(page.getByTestId("place-details")).toBeVisible();
  await expect(page.getByTestId("map-canvas")).toHaveAttribute("data-pins", /^[1-9]/);
});

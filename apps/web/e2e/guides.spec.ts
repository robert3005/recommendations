/**
 * Phase 2 done-when: build and edit a Lisbon guide — interleaved sections and
 * places, reordering, note attachment, reading view, persistence.
 */
import { expect, type Page, test } from "@playwright/test";

async function savePlace(page: Page, query: string, optionName: RegExp) {
  const search = page.getByRole("combobox", { name: "Search places" });
  await search.fill("");
  await search.fill(query);
  await page.getByRole("option", { name: optionName }).click();
  await page.getByTestId("place-sheet").getByTestId("save-place").click();
  await expect(page.getByTestId("saved-place-sheet")).toBeVisible();
}

async function closeSheet(page: Page) {
  await page.getByTestId("saved-place-sheet").getByRole("button", { name: "Close" }).click();
}

test("building the Lisbon guide: sections, places, order, notes, reading view", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();

  // Save Café Central with a shareable note.
  await savePlace(page, "cafe", /Café Central/);
  const sheet = page.getByTestId("saved-place-sheet");
  await sheet.getByTestId("add-note").click();
  const editor = sheet.getByTestId("note-editor");
  await editor.getByLabel("Note body (Markdown)").fill("Order the **bica** at the counter");
  await editor.getByRole("checkbox").check(); // shareable
  await editor.getByRole("button", { name: "Save note" }).click();
  await expect(sheet.getByText("bica")).toBeVisible();
  await closeSheet(page);

  // Save Café do Rio.
  await savePlace(page, "cafe", /Café do Rio/);
  await closeSheet(page);

  // Create the guide.
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Guides" }).click();
  await page.getByLabel("New guide name").fill("Lisbon trip");
  await page.getByTestId("create-guide").click();
  await page.getByRole("link", { name: "Lisbon trip" }).click();
  await expect(page.getByTestId("guide-page")).toBeVisible();

  // Narrative section + both places.
  await page.getByTestId("section-draft").fill("## Morning coffee\n\nStart slow.");
  await page.getByTestId("add-section").click();
  await expect(page.getByRole("heading", { name: "Morning coffee" })).toBeVisible();
  const addPlace = page.getByLabel("Add saved place");
  await addPlace.selectOption({ label: "Café Central" });
  await addPlace.selectOption({ label: "Café do Rio" });

  const blocks = page.locator('[data-testid="section-block"], [data-testid="place-block"]');
  await expect(blocks).toHaveCount(3);
  await expect(blocks.nth(1)).toContainText("Café Central");
  await expect(blocks.nth(2)).toContainText("Café do Rio");

  // Reorder: move Café do Rio above Café Central.
  await blocks.nth(2).getByRole("button", { name: "Move up" }).click();
  await expect(blocks.nth(1)).toContainText("Café do Rio");
  await expect(blocks.nth(2)).toContainText("Café Central");

  // Attach the shareable note to the Café Central block.
  await blocks.nth(2).getByLabel("Attach note").selectOption({ index: 1 });
  const strong = blocks.nth(2).locator("strong", { hasText: "bica" });
  await expect(strong).toBeVisible();

  // Reading view hides editing controls but keeps content.
  await page.getByTestId("toggle-editing").click();
  await expect(page.getByRole("button", { name: "Move up" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Morning coffee" })).toBeVisible();
  await expect(strong).toBeVisible();

  // Everything persists across a full reload.
  await page.reload();
  await expect(page.getByTestId("guide-page")).toBeVisible();
  const reloaded = page.locator('[data-testid="section-block"], [data-testid="place-block"]');
  await expect(reloaded).toHaveCount(3);
  await expect(reloaded.nth(0)).toContainText("Morning coffee");
  await expect(reloaded.nth(1)).toContainText("Café do Rio");
  await expect(reloaded.nth(2)).toContainText("Café Central");
  await expect(reloaded.nth(2).locator("strong", { hasText: "bica" })).toBeVisible();
});

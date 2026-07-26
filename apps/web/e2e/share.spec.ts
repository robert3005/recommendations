/**
 * Phase 4 done-when (spec/src/roadmap.md): send a read-only guide without a
 * backend; the recipient cannot modify it and can import it into their own
 * library — in a completely fresh browser context.
 */
import { type Browser, expect, type Page, test } from "@playwright/test";

async function seedSharedList(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  // The canvas search is reachable once the pane is not expanded.
  await page.getByTestId("pane-collapse").click();
  await page.getByRole("combobox", { name: "Search places" }).fill("cafe");
  await page.getByRole("option", { name: /Café Central/ }).click();
  const sheet = page.getByTestId("place-sheet");
  await sheet.getByTestId("add-to-list").selectOption("__new__");
  await sheet.getByLabel("New list name").fill("Weekend picks");
  await sheet.getByTestId("create-list-and-add").click();
  const details = page.getByTestId("place-details");
  await expect(details).toBeVisible();

  // One shareable note and one private one — only the first may travel.
  await details.getByRole("button", { name: "Add note" }).click();
  const editor = page.getByTestId("note-editor");
  await editor.getByLabel("Note body (Markdown)").fill("Order the bica at the counter");
  await editor.getByRole("checkbox", { name: "Shareable" }).check();
  await editor.getByRole("button", { name: "Save note" }).click();
  await details.getByRole("button", { name: "Add note" }).click();
  await editor.getByLabel("Note body (Markdown)").fill("Secret: my usual table");
  await editor.getByRole("button", { name: "Save note" }).click();
  await details.getByRole("button", { name: "Close" }).click();
}

async function shareLink(page: Page): Promise<string> {
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Lists" })
    .click();
  await page.getByRole("link", { name: /Weekend picks/ }).click();
  await page.getByTestId("share-list").click();
  const preview = page.getByTestId("share-preview");
  await expect(preview).toBeVisible();
  await expect(preview.getByTestId("share-manifest")).toContainText("1 note marked shareable");
  const url = await preview.getByTestId("snapshot-url").inputValue();
  expect(url).toContain("/l#");
  return url;
}

async function freshViewer(browser: Browser, url: string): Promise<Page> {
  const context = await browser.newContext({ timezoneId: "Europe/Lisbon" });
  const viewer = await context.newPage();
  await viewer.goto(url);
  return viewer;
}

test("a snapshot link renders read-only in a fresh context and imports cleanly", async ({
  page,
  browser,
}) => {
  await seedSharedList(page);
  const url = await shareLink(page);

  const viewer = await freshViewer(browser, url);
  const shared = viewer.getByTestId("shared-guide");
  await expect(shared).toBeVisible();
  await expect(shared).toContainText("Weekend picks");
  await expect(viewer.getByTestId("shared-place")).toContainText("Café Central");
  // The shareable note travelled; the private one did not.
  await expect(shared).toContainText("Order the bica at the counter");
  await expect(shared).not.toContainText("Secret: my usual table");
  // Read-only: no editing affordances exist on the shared page.
  await expect(viewer.getByTestId("add-to-list")).toHaveCount(0);
  await expect(viewer.getByTestId("edit-list")).toHaveCount(0);

  // The recipient imports the guide into their own (empty) library.
  await viewer.getByTestId("save-shared-guide").click();
  await expect(viewer.getByTestId("save-result")).toContainText("Added 1 place");
  await viewer.getByTestId("open-saved-list").click();
  await expect(viewer.getByTestId("list-page")).toContainText("Weekend picks");
  await expect(viewer.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await viewer.context().close();
});

test("a damaged snapshot link fails with a designed error, never a blank page", async ({
  page,
}) => {
  await page.goto("/l#definitely-not-a-guide");
  await expect(page.getByTestId("snapshot-error")).toContainText("Could not open");
  await expect(page.getByTestId("public-readonly-chrome")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(0);
});

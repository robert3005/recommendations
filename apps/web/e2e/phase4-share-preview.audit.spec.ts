/** Privacy-facing Phase 4 acceptance checks from book/src/sharing.md. */
import { expect, test } from "@playwright/test";

test("the snapshot preview names the exact prose and OSM evidence that will leave", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  await page.getByRole("combobox", { name: "Search places" }).fill("cafe");
  await page.getByRole("option", { name: /Café Central/ }).click();
  const sheet = page.getByTestId("place-sheet");
  await sheet.getByTestId("add-to-list").selectOption("__new__");
  await sheet.getByLabel("New list name").fill("Privacy preview");
  await sheet.getByTestId("create-list-and-add").click();

  const details = page.getByTestId("place-details");
  await details.getByRole("button", { name: "Add note" }).click();
  const editor = page.getByTestId("note-editor");
  await editor.getByLabel("Note body (Markdown)").fill("Order the bica at the counter");
  await editor.getByRole("checkbox", { name: "Shareable" }).check();
  await editor.getByRole("button", { name: "Save note" }).click();
  await details.getByRole("button", { name: "Close" }).click();

  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Lists" })
    .click();
  await page.getByRole("link", { name: /Privacy preview/ }).click();
  await page.getByTestId("share-list").click();
  const preview = page.getByTestId("share-preview");

  await expect(preview).toContainText("Café Central");
  await expect(preview).toContainText("Rua Example 12, Lisboa");
  await expect(preview).toContainText("Order the bica at the counter");
  // The current authoritative SharedGuide schema has no marker-colour field.
  await expect(preview).not.toContainText("marker colour");

  const url = await preview.getByTestId("snapshot-url").inputValue();
  await page.goto(url);
  await expect(page.getByTestId("shared-guide")).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/i);
});

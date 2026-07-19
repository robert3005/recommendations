/**
 * Phase 5 done-when (spec/src/roadmap.md): a creator can publish, update, and
 * revoke a persistent read-only link; visitors read the latest successfully
 * published revision and can never modify it. The dev/e2e share service is the
 * real service app over in-memory storage inside the MSW worker (same page —
 * cross-context reads need the deployed Worker).
 */
import { expect, type Page, test } from "@playwright/test";

async function seedList(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  await page.getByRole("combobox", { name: "Search places" }).fill("cafe");
  await page.getByRole("option", { name: /Café Central/ }).click();
  const sheet = page.getByTestId("place-sheet");
  await sheet.getByTestId("add-to-list").selectOption("__new__");
  await sheet.getByLabel("New list name").fill("Hosted picks");
  await sheet.getByTestId("create-list-and-add").click();
  await page.getByTestId("place-details").getByRole("button", { name: "Close" }).click();
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Lists" })
    .click();
  await page.getByRole("link", { name: /Hosted picks/ }).click();
}

test("publish → public read-only page → update → unpublish", async ({ page }) => {
  await seedList(page);

  await page.getByTestId("publish-list").click();
  // The preflight disclosure shows the exact projection before anything leaves.
  await expect(page.getByTestId("publish-preflight")).toContainText("Café Central");
  await page.getByTestId("confirm-publish-list").click();
  await expect(page.getByTestId("publication-status")).toHaveAttribute("data-status", "published");
  const publicUrl = await page.getByTestId("public-link").getAttribute("href");
  expect(publicUrl).toContain("/l/hosted-picks");

  // The public page renders read-only.
  await page.goto(publicUrl ?? "");
  const shared = page.getByTestId("shared-guide");
  await expect(shared).toBeVisible();
  await expect(shared).toContainText("Hosted picks");
  await expect(page.getByTestId("shared-place")).toContainText("Café Central");
  await expect(page.getByTestId("edit-list")).toHaveCount(0);

  // A local edit is NOT public until published: add a place, check the page.
  await page.goto("/");
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  await page.getByRole("combobox", { name: "Search places" }).fill("cafe");
  await page.getByRole("option", { name: /Café do Rio/ }).click();
  await page.getByTestId("place-sheet").getByTestId("add-to-list").selectOption({
    label: "Hosted picks",
  });
  await page.getByTestId("place-details").getByRole("button", { name: "Close" }).click();
  await page.goto(publicUrl ?? "");
  await expect(page.getByTestId("shared-place")).toHaveCount(1);

  // Publish the update → the page shows both places.
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Lists" })
    .click();
  await page.getByRole("link", { name: /Hosted picks/ }).click();
  await expect(page.getByTestId("publication-status")).toContainText("local changes");
  await page.getByTestId("publish-update").click();
  await expect(page.getByTestId("publication-status")).not.toContainText("local changes");
  await page.goto(publicUrl ?? "");
  await expect(page.getByTestId("shared-place")).toHaveCount(2);

  // Unpublish → the public URL shows the designed gone state.
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Lists" })
    .click();
  await page.getByRole("link", { name: /Hosted picks/ }).click();
  await page.getByTestId("unpublish").click();
  await expect(page.getByTestId("publication-status")).toHaveAttribute("data-status", "revoked");
  await page.goto(publicUrl ?? "");
  await expect(page.getByTestId("hosted-error")).toContainText("no longer available");
});

test("a shareable note publishes as a standalone read-only page", async ({ page }) => {
  await seedList(page);
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Map" })
    .click();
  await page.getByRole("combobox", { name: "Search places" }).fill("cafe");
  await page.getByRole("option", { name: /Café Central/ }).click();
  await page.getByTestId("open-place").click();
  const details = page.getByTestId("place-details");
  await details.getByRole("button", { name: "Add note" }).click();
  const editor = page.getByTestId("note-editor");
  await editor.getByLabel("Note title").fill("Coffee ritual");
  await editor.getByLabel("Note body (Markdown)").fill("Ask for the house blend.");
  await editor.getByRole("checkbox", { name: "Shareable" }).check();
  await editor.getByRole("button", { name: "Save note" }).click();

  await details.getByTestId("publish-note").click();
  // The preflight disclosure shows the exact prose before anything leaves.
  await expect(details.getByTestId("note-publish-preflight")).toContainText(
    "Ask for the house blend.",
  );
  await details.getByTestId("confirm-publish-note").click();
  const pageLink = details.getByTestId("note-page-link");
  await expect(pageLink).toBeVisible();
  const noteUrl = await pageLink.getAttribute("href");

  await page.goto(noteUrl ?? "");
  const sharedNote = page.getByTestId("shared-note");
  await expect(sharedNote).toContainText("Coffee ritual");
  await expect(sharedNote).toContainText("Ask for the house blend.");
  await expect(sharedNote).toContainText("read-only shared page");
});

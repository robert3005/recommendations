/**
 * Sharing & publishing (spec/src/sharing.md): a creator publishes, updates,
 * and revokes a named read-only page in the foreground — each action visibly
 * succeeds or fails; nothing queues. Visitors read exactly the last published
 * document; a revoked slug tombstones forever. The dev/e2e share service is
 * the real service app over in-memory storage inside the MSW worker.
 */
import { expect, type Page, test } from "@playwright/test";

async function pickCandidate(page: Page, option: RegExp) {
  const field = page.getByRole("combobox", { name: "Add a place" });
  await field.fill("cafe");
  await page.getByRole("option", { name: option }).click();
  await expect(page.getByTestId("add-place-confirm")).toBeVisible();
}

/** One combobox picks or creates the list; picking is the add. */
async function addToNewList(page: Page, option: RegExp, listName: string) {
  await pickCandidate(page, option);
  const confirm = page.getByTestId("add-place-confirm");
  await confirm.getByTestId("field-list-choice").fill(listName);
  await confirm.getByTestId("field-create-option").click();
}

/** The exact name match is the first, active option — Enter adds it. */
async function addToExistingList(page: Page, option: RegExp, listName: string) {
  await pickCandidate(page, option);
  const combobox = page.getByTestId("add-place-confirm").getByTestId("field-list-choice");
  await combobox.fill(listName);
  await combobox.press("Enter");
}

/** Seed "Hosted picks" with Café Central and land on its list page. */
async function seedList(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  await addToNewList(page, /Café Central/, "Hosted picks");
  await page.getByTestId("place-details").getByRole("button", { name: "Close" }).click();
  await page.getByRole("link", { name: /Hosted picks/ }).click();
  await expect(page.getByTestId("list-page")).toBeVisible();
}

/** The public-link href is canonical https; navigate by its path instead. */
function pathOf(href: string | null): string {
  return new URL(href ?? "").pathname;
}

test("publish → public read-only page → update → unpublish tombstones the slug", async ({
  page,
}) => {
  await seedList(page);

  await page.getByTestId("publish-list").click();
  // The preflight is the exact disclosure of what leaves the device.
  const preflight = page.getByTestId("publish-preflight");
  await expect(preflight).toContainText("Hosted picks");
  await expect(preflight).toContainText("Café Central");
  await page.getByTestId("confirm-publish-list").click();
  await expect(page.getByTestId("publication-status")).toHaveAttribute("data-status", "published");
  // The slug derives from the normalised title.
  const publicPath = pathOf(await page.getByTestId("public-link").getAttribute("href"));
  expect(publicPath).toBe("/l/hosted-picks");

  // The public page renders read-only in the same shell.
  await page.goto(publicPath);
  const shared = page.getByTestId("published-list");
  await expect(shared).toBeVisible();
  await expect(shared).toContainText("Hosted picks");
  await expect(page.getByTestId("published-place")).toContainText("Café Central");
  await expect(page.getByTestId("public-readonly-chrome")).toBeVisible();
  await expect(page.getByTestId("edit-list")).toHaveCount(0);
  // The geocoded place carries an osmRef → ODbL attribution on the page.
  await expect(page.getByTestId("odbl-attribution")).toBeVisible();

  // A local edit is NOT public until published.
  await page.goto("/");
  await addToExistingList(page, /Café do Rio/, "Hosted picks");
  await page.getByTestId("place-details").getByRole("button", { name: "Close" }).click();
  await page.goto(publicPath);
  await expect(page.getByTestId("published-place")).toHaveCount(1);

  // The app shows "unpublished changes" (hash comparison); Publish update
  // replaces the document.
  await page.goto("/");
  await page.getByRole("link", { name: /Hosted picks/ }).click();
  await expect(page.getByTestId("publication-status")).toHaveAttribute(
    "data-status",
    "unpublished-changes",
  );
  await page.getByTestId("publish-update").click();
  await expect(page.getByTestId("publish-preflight")).toContainText("Café do Rio");
  await page.getByTestId("confirm-publish-list").click();
  await expect(page.getByTestId("publication-status")).toHaveAttribute("data-status", "published");
  await page.goto(publicPath);
  await expect(page.getByTestId("published-place")).toHaveCount(2);

  // Unpublish → the tombstoned slug is a designed gone state, forever.
  await page.goto("/");
  await page.getByRole("link", { name: /Hosted picks/ }).click();
  await page.getByTestId("unpublish").click();
  await expect(page.getByTestId("publication-status")).toHaveAttribute("data-status", "revoked");
  await page.goto(publicPath);
  await expect(page.getByTestId("published-error")).toHaveAttribute("data-reason", "gone");
  await expect(page.getByTestId("published-error")).toContainText("no longer available");
});

test("a list post publishes as a standalone read-only page under /p/", async ({ page }) => {
  await seedList(page);

  // Posts are the list page's quiet alternate view (spec/src/map-view.md §The
  // list page): toggle to Posts, then New post → the Markdown editor.
  await page.getByTestId("list-view-posts").click();
  await expect(page.getByTestId("list-posts")).toBeVisible();
  await page.getByTestId("new-post").click();
  await expect(page.getByTestId("post-editor")).toBeVisible();
  const title = page.getByTestId("post-title-input");
  await title.fill("Three cafés I love");
  await title.blur();
  await page.getByTestId("post-body-input").fill("Start at the counter.");
  await page.getByTestId("done-editing-post").click();
  await expect(page.getByTestId("post-page")).toBeVisible();

  // Foreground publish behind the exact-prose preflight.
  await page.getByTestId("publish-post").click();
  const preflight = page.getByTestId("publish-preflight");
  await expect(preflight).toContainText("Three cafés I love");
  await expect(preflight).toContainText("Start at the counter.");
  await page.getByTestId("confirm-publish-post").click();

  const postPath = pathOf(await page.getByTestId("post-public-link").getAttribute("href"));
  expect(postPath).toBe("/p/three-cafes-i-love");
  await page.goto(postPath);
  const shared = page.getByTestId("published-post");
  await expect(shared).toBeVisible();
  await expect(shared).toContainText("Three cafés I love");
  await expect(shared).toContainText("Start at the counter.");
  // A published list post names its list — name only while the list itself
  // has no public page (spec/src/sharing.md §Published documents).
  await expect(shared.getByTestId("published-post-list")).toContainText("Hosted picks");
  await expect(page.getByTestId("public-readonly-chrome")).toBeVisible();
});

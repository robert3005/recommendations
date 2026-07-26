/**
 * Membership is existence (spec/src/data-model.md): a place enters the library
 * by being added to a list — there is no Save button — it persists across
 * reload, it ceases to exist with its last membership, and teardown refuses to
 * delete a place whose posts still exist (spec/src/data-model.md §Teardown).
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

test.describe("places exist through lists", () => {
  test("search → pick a list → persists; the last membership removal deletes the place", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator(".maplibregl-canvas")).toBeVisible();

    // There is no Save button — adding to a list is the only way the place
    // comes to exist.
    await addToNewList(page, /Café Central/, "Coffee stops");
    const details = page.getByTestId("place-details");
    await expect(details).toBeVisible();
    // On desktop the card is its own vertical in the shell row — a labelled
    // aside beside the notebook, not a floating overlay or a modal
    // (spec/src/map-view.md §The place card: it "rises in the notebook").
    await expect(page.getByRole("complementary", { name: "Café Central" })).toBeVisible();
    await expect(details.getByRole("button", { name: "Save" })).toHaveCount(0);
    // Flat facts on the card (spec/src/map-view.md §The place card).
    await expect(details.getByTestId("place-name")).toHaveText("Café Central");
    await expect(details.getByTestId("place-coordinates")).toBeVisible();
    // Deep links out come from the one domain link module.
    await expect(details.getByTestId("open-google-maps")).toBeVisible();
    await expect(details.getByTestId("open-apple-maps")).toBeVisible();
    // The mark appears immediately, while the card is still open.
    const mapEl = page.getByTestId("map-canvas");
    await expect(mapEl).toHaveAttribute("data-pins", /^[1-9]/);
    await expect(mapEl).toHaveAttribute("data-selection", "1");
    await details.getByRole("button", { name: "Close" }).click();

    // Survives a full reload (IndexedDB persistence).
    await page.reload();
    await expect(page.getByTestId("lists-page")).toBeVisible();
    await expect(mapEl).toHaveAttribute("data-pins", /^[1-9]/, { timeout: 10_000 });
    await page.getByRole("link", { name: /Coffee stops/ }).click();
    await expect(page.getByTestId("place-item")).toContainText("Café Central");

    // Removing the last membership removes the place from the library and map.
    await page.getByTestId("edit-list").click();
    await page.getByTestId("place-item").getByTestId("remove-from-list").click();
    await expect(page.getByTestId("place-item")).toHaveCount(0);
    await page.getByTestId("home-link").click();
    await expect(mapEl).toHaveAttribute("data-pins", "0");
  });

  test("a place with a post refuses to lose its last membership until the post goes", async ({
    page,
  }) => {
    await page.goto("/");
    await addToNewList(page, /Café Central/, "Rituals");
    const details = page.getByTestId("place-details");
    await expect(details).toBeVisible();

    // Write a post about the place — born titled with the place's name
    // (spec/src/posts.md §Creating).
    await details.getByTestId("write-post").click();
    await expect(page.getByTestId("post-editor")).toBeVisible();
    await expect(page.getByTestId("post-title-input")).toHaveValue("Café Central");
    await page.getByTestId("post-body-input").fill("Ask for the house blend.");
    await page.getByTestId("done-editing-post").click();
    await expect(page.getByTestId("post-page")).toBeVisible();

    // Teardown runs bottom-up: the last membership removal is refused while
    // the post exists, and the refusal names it (spec/src/data-model.md).
    await page.getByTestId("home-link").click();
    await page.getByRole("link", { name: /Rituals/ }).click();
    await page.getByTestId("edit-list").click();
    await page.getByTestId("place-item").getByTestId("remove-from-list").click();
    const dialog = page.getByTestId("blocker-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("blocker-place-has-posts")).toContainText("Café Central");
    await dialog.getByTestId("blocker-dialog-close").click();
    // Nothing died as a side effect: the entry (and the place) are still here.
    await expect(page.getByTestId("place-item")).toHaveCount(1);
  });
});

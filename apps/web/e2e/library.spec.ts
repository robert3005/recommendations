/**
 * The library owns places (spec/src/data-model.md §The library): a place is
 * saved with one press and belongs to no list until the owner says so; lists
 * and saved views only group places. Leaving a list never deletes a place —
 * only an explicit Delete does, and it refuses while posts target the place
 * (spec/src/data-model.md §Teardown). The library is found by searching and
 * filtering: saved places first, the owner's tags apart from review tags.
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

/** The one-press path: saved to the library, on no list. */
async function savePlace(page: Page, option: RegExp) {
  await pickCandidate(page, option);
  await page.getByTestId("save-place").click();
  await expect(page.getByTestId("place-details")).toBeVisible();
}

async function closeCard(page: Page) {
  await page.getByTestId("place-details").getByRole("button", { name: "Close" }).click();
}

test.describe("the library owns places", () => {
  test("save with one press → on no list → persists; joins and leaves a list without dying", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator(".maplibregl-canvas")).toBeVisible();

    await savePlace(page, /Café Central/);
    const details = page.getByTestId("place-details");
    // On desktop the card is its own vertical in the shell row — a labelled
    // aside beside the notebook, not a floating overlay or a modal.
    await expect(page.getByRole("complementary", { name: "Café Central" })).toBeVisible();
    // The card reads as a listing: the enriched MSW fixture (osmNode101) fills
    // the fact rows after the save, and coordinates never render.
    await expect(details.getByTestId("place-name")).toHaveText("Café Central");
    await expect(details.getByTestId("place-website")).toContainText("cafecentral.pt");
    await expect(details.getByTestId("place-coordinates")).toHaveCount(0);
    await expect(details.getByTestId("open-google-maps")).toBeVisible();
    await expect(details.getByTestId("open-apple-maps")).toBeVisible();
    // Saved on no list, and on the map at once — in the neutral marker.
    await expect(details.getByTestId("current-list-memberships")).toHaveCount(0);
    const mapEl = page.getByTestId("map-canvas");
    await expect(mapEl).toHaveAttribute("data-pins", "1");
    await expect(mapEl).toHaveAttribute("data-selection", "1");

    // It joins a list from the card…
    await details.getByTestId("card-list-choice").fill("Coffee stops");
    await details.getByTestId("card-create-option").click();
    await expect(details.getByTestId("current-list-memberships")).toContainText("Coffee stops");
    await closeCard(page);

    // …survives a full reload (IndexedDB persistence)…
    await page.reload();
    await expect(page.getByTestId("lists-page")).toBeVisible();
    await expect(page.getByTestId("place-total")).toHaveText("1");
    await expect(mapEl).toHaveAttribute("data-pins", "1", { timeout: 10_000 });
    await page.getByRole("link", { name: /Coffee stops/ }).click();
    await expect(page.getByTestId("place-item")).toContainText("Café Central");

    // …and leaving its only list takes it off the list, not out of the library.
    await page.getByTestId("edit-list").click();
    await page.getByTestId("place-item").getByTestId("remove-from-list").click();
    await expect(page.getByTestId("place-item")).toHaveCount(0);
    await page.getByTestId("home-link").click();
    await expect(page.getByTestId("library-place")).toContainText("Café Central");
    await expect(mapEl).toHaveAttribute("data-pins", "1");
  });

  test("deleting a list keeps its places; deleting a place is explicit and refuses while it has posts", async ({
    page,
  }) => {
    await page.goto("/");
    await addToNewList(page, /Café Central/, "Rituals");
    const details = page.getByTestId("place-details");
    await expect(details).toBeVisible();

    // Write a post about the place — born titled with the place's name.
    await details.getByTestId("write-post").click();
    await expect(page.getByTestId("post-editor")).toBeVisible();
    await expect(page.getByTestId("post-title-input")).toHaveValue("Café Central");
    await page.getByTestId("post-body-input").fill("Ask for the house blend.");
    await page.getByTestId("done-editing-post").click();
    await expect(page.getByTestId("post-page")).toBeVisible();

    // The list goes with one confirmation; its place stays in the library.
    await page.getByTestId("home-link").click();
    await page.getByRole("link", { name: /Rituals/ }).click();
    await page.getByTestId("edit-list").click();
    await page.getByTestId("delete-list").click();
    await expect(page.getByTestId("delete-list-confirm")).toContainText("stays in your library");
    await page.getByTestId("confirm-delete-list").click();
    await expect(page.getByTestId("lists-page")).toBeVisible();
    await expect(page.getByTestId("list-row")).toHaveCount(0);
    await expect(page.getByTestId("library-place")).toContainText("Café Central");

    // Deleting the place is refused while its post exists — nothing the owner
    // wrote dies as a side effect — and goes through once the post is gone.
    await page.getByTestId("library-place").getByRole("button").click();
    await details.getByTestId("delete-place").click();
    await details.getByTestId("confirm-delete-place").click();
    await expect(details.getByTestId("delete-place-error")).toContainText("delete its posts first");
    await details.getByTestId("place-post-link").click();
    await page.getByTestId("edit-post").click();
    await page.getByTestId("delete-post").click();
    await page.getByTestId("home-link").click();
    await page.getByTestId("library-place").getByRole("button").click();
    await details.getByTestId("delete-place").click();
    await details.getByTestId("confirm-delete-place").click();
    await expect(page.getByTestId("library-place")).toHaveCount(0);
    await expect(page.getByTestId("map-canvas")).toHaveAttribute("data-pins", "0");
  });
});

test.describe("finding places", () => {
  test("own tags, rating and note are saved on the card and filter the library and the map", async ({
    page,
  }) => {
    await page.goto("/");
    await savePlace(page, /Café Central/);
    const details = page.getByTestId("place-details");
    await details.getByTestId("tag-input").fill("Date Night, espresso");
    await details.getByTestId("tag-input").press("Enter");
    // Tags are normalised free text, drawn as the owner's solid chips.
    await expect(details.getByTestId("own-tags").getByTestId("own-tag")).toHaveText([
      /date night/,
      /espresso/,
    ]);
    await details.getByTestId("rate-3").click();
    await details.getByTestId("status-been").click();
    await details.getByTestId("place-note").fill("Ask for the house blend.");
    await details.getByTestId("place-name").click(); // blur saves the note
    await closeCard(page);

    await savePlace(page, /Café do Rio/);
    await closeCard(page);

    const mapEl = page.getByTestId("map-canvas");
    await expect(page.getByTestId("place-total")).toHaveText("2");
    await expect(mapEl).toHaveAttribute("data-pins", "2");
    // The row carries the owner's layer: stars, status, tags, the note.
    const central = page.getByTestId("library-place").filter({ hasText: "Café Central" });
    await expect(central.getByTestId("rating-stars")).toBeVisible();
    await expect(central).toContainText("Ask for the house blend.");

    // Filter by an own tag: the notebook and the canvas narrow together.
    await page.getByTestId("facet-tags").click();
    await page.getByTestId("filter-own-tag").filter({ hasText: "date night" }).click();
    await expect(page.getByTestId("match-count")).toHaveText("1 of 2");
    await expect(page.getByTestId("library-place")).toHaveCount(1);
    await expect(mapEl).toHaveAttribute("data-pins", "1");

    // Save the filter as a view: it becomes a named layer in the legend.
    await page.getByTestId("save-view").click();
    await page.getByTestId("view-name-input").fill("Dates");
    await page.getByTestId("confirm-save-view").click();
    await page.getByTestId("clear-filter").click();
    await expect(page.getByTestId("view-row")).toContainText("Dates");
    await expect(mapEl).toHaveAttribute("data-pins", "2");
    const legend = page.getByTestId("list-toggles");
    await expect(legend.getByRole("button", { name: "Toggle Dates" })).toBeVisible();
    await expect(legend.getByRole("button", { name: "Toggle Other places" })).toBeVisible();
    // Layers toggle independently: hiding the ungrouped rest leaves the view's place.
    await legend.getByRole("button", { name: "Toggle Other places" }).click();
    await expect(mapEl).toHaveAttribute("data-pins", "1");
    await legend.getByRole("button", { name: "Toggle Other places" }).click();

    // Opening the view applies its filter again.
    await page.getByTestId("open-view").click();
    await expect(page.getByTestId("match-count")).toHaveText("1 of 2");
  });

  test("the search field finds saved places first, by tag or note, and shows all matches on the map", async ({
    page,
  }) => {
    await page.goto("/");
    await savePlace(page, /Café Central/);
    const details = page.getByTestId("place-details");
    await details.getByTestId("tag-input").fill("slow mornings");
    await details.getByTestId("tag-input").press("Enter");
    await expect(details.getByTestId("own-tags")).toContainText("slow mornings");
    await closeCard(page);

    const field = page.getByRole("combobox", { name: "Add a place" });
    await field.fill("slow morn");
    const panel = page.getByTestId("search-panel");
    await expect(panel.getByTestId("search-section-library")).toHaveText("Your places");
    await expect(panel.getByTestId("search-library-option")).toContainText("Café Central");
    // Picking a saved place opens it — it is not offered as a new place.
    await panel.getByTestId("search-library-option").click();
    await expect(details.getByTestId("place-name")).toHaveText("Café Central");
    await closeCard(page);

    // A saved place is not offered again under "Add a new place".
    await field.fill("cafe");
    await expect(panel.getByTestId("search-library-option")).toHaveCount(1);
    await expect(
      panel.getByRole("option", { name: /Café Central/ }).filter({ hasNotText: "Show all" }),
    ).toHaveCount(1);

    // Enter shows every match on the map, as a filter on the home page.
    await field.press("Enter");
    await expect(page.getByTestId("filter-summary")).toContainText("cafe");
    await expect(page.getByTestId("match-count")).toHaveText("1 of 1");
  });
});

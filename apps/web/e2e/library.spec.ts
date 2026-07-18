/**
 * Membership is existence: a place enters the library by being added to a list
 * (there is no standalone save), persists across reload, and manual pins are
 * born straight into a list.
 */
import { expect, test } from "@playwright/test";

test.describe("places exist through lists", () => {
  test("search → resolve → add to list → persists across reload", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".maplibregl-canvas")).toBeVisible();

    // Search and select.
    await page.getByRole("combobox", { name: "Search places" }).fill("cafe");
    await page.getByRole("option", { name: /Café Central/ }).click();

    // The sheet resolves the exact OSM element; there is no Save button —
    // adding to a list is the only way the place comes to exist.
    const sheet = page.getByTestId("place-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId("website-link")).toHaveAttribute(
      "href",
      "https://cafecentral.pt/",
    );
    await expect(sheet.getByRole("button", { name: "Save" })).toHaveCount(0);
    await sheet.getByTestId("add-to-list").selectOption("__new__");
    await sheet.getByLabel("New list name").fill("Coffee stops");
    await sheet.getByTestId("create-list-and-add").click();

    const details = page.getByTestId("place-details");
    await expect(details).toBeVisible();
    // The mark appears immediately, while the sheet is still open.
    const mapNow = page.getByTestId("map-canvas");
    await expect(mapNow).toHaveAttribute("data-pins", /^[1-9]/);
    await expect(mapNow).toHaveAttribute("data-selection", "1");

    // Tag it.
    await details.getByLabel("Add tag").fill("coffee");
    await details.getByLabel("Add tag").press("Enter");
    await expect(details.getByText("coffee")).toBeVisible();

    // Survives a full reload (IndexedDB persistence).
    await page.reload();
    await expect(page.locator(".maplibregl-canvas")).toBeVisible();
    const mapEl = page.getByTestId("map-canvas");
    await expect(mapEl).toHaveAttribute("data-pins", /^[1-9]/, { timeout: 10_000 });
    // Reopen camera-independently: search recognizes the listed place.
    await page.getByRole("combobox", { name: "Search places" }).fill("cafe");
    await page.getByRole("option", { name: /Café Central/ }).click();
    await page.getByTestId("open-place").click();
    const reopened = page.getByTestId("place-details");
    await expect(reopened).toBeVisible();
    await expect(reopened.getByText("Café Central")).toBeVisible();
    await expect(reopened.getByText("coffee")).toBeVisible();

    // Removing the place removes it from the map and the library.
    await reopened.getByTestId("remove-place").click();
    await expect(page.getByTestId("place-details")).toHaveCount(0);
    await expect(mapEl).toHaveAttribute("data-pins", "0");
  });

  test("long-press → manual pin is born into a list", async ({ page }) => {
    await page.goto("/");
    const mapEl = page.getByTestId("map-canvas");
    await expect(page.locator(".maplibregl-canvas")).toBeVisible();
    const box = await mapEl.boundingBox();
    if (!box) throw new Error("no canvas");

    // Right-click (contextmenu) opens the nearby-candidate picker.
    await page.mouse.click(box.x + box.width / 3, box.y + box.height / 3, { button: "right" });
    const picker = page.getByTestId("candidate-picker");
    await expect(picker).toBeVisible();
    await expect(picker.getByRole("link", { name: "Add it on OpenStreetMap" })).toBeVisible();

    await picker.getByTestId("save-manual").click();
    const dialog = page.getByTestId("manual-pin-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("manual-name").fill("Our picnic bench");
    // No lists exist yet, so the dialog defaults to creating one — required.
    await expect(dialog.getByTestId("manual-save")).toBeDisabled();
    await dialog.getByTestId("manual-new-list-name").fill("Secret spots");
    await dialog.getByTestId("manual-save").click();

    const details = page.getByTestId("place-details");
    await expect(details).toBeVisible();
    await expect(details.getByText("Our picnic bench")).toBeVisible();
    await expect(details.getByTestId("state-badge")).toHaveAttribute("data-state", "unlinked");
    await expect(details.getByTestId("manual-note")).toBeVisible();
    await expect(details.getByTestId("link-to-osm")).toBeVisible();
  });
});

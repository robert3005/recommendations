/**
 * Review insights on the place card (spec/src/reviews.md): classification
 * results and photos, never review text. Dev sample data stands in for a
 * real harvest.
 */
import { expect, test } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import { MOCK_INSIGHTS_ACCESS_KEY } from "../src/mocks/fixtures";

const PLACE_URL =
  "https://www.google.com/maps/place/Caf%C3%A9+Central/data=!4m2!3m1!1s0x1f9a2b:0xdeadbeef";

/** One Google place with coordinates (Saved Places.json), in one Saved list. */
function takeoutZip(): Buffer {
  const csv = ["Title,Note,URL", `"Café Central",,"${PLACE_URL}"`].join("\n");
  const savedPlaces = JSON.stringify({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [-9.142, 38.712] },
        properties: { Title: "Café Central", "Google Maps URL": PLACE_URL },
      },
    ],
  });
  return Buffer.from(
    zipSync({
      "Takeout/Saved/Coffee stops.csv": strToU8(csv),
      "Takeout/Maps (your places)/Saved Places.json": strToU8(savedPlaces),
    }),
  );
}

test("importing a Google place reads its reviews through the service", async ({ page }) => {
  await page.goto("/settings");
  await page.getByTestId("insights-access-key").fill(MOCK_INSIGHTS_ACCESS_KEY);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("insights-message")).toContainText("Access key saved");

  await page
    .getByLabel("Import places file")
    .setInputFiles({ name: "takeout.zip", mimeType: "application/zip", buffer: takeoutZip() });
  await expect(page.getByTestId("import-report")).toContainText("1 placed");
  await expect(page.getByTestId("insights-queue")).toContainText("1 of 1 read");
  await expect(page.getByTestId("insights-counts")).toContainText("1 places · 1 classified");
  await expect(page.getByTestId("fetch-missing-insights")).toContainText(
    "Every Google place has insights",
  );

  await page.goto("/");
  await page.getByRole("link", { name: /Coffee stops/ }).click();
  await page.getByTestId("place-item").first().click();
  const insights = page.getByTestId("place-details").getByTestId("place-insights");
  await expect(insights.getByTestId("insights-summary")).toContainText("custard tarts");
  await expect(insights.getByTestId("aspect-meter")).toHaveCount(5);
});

test("a wrong access key stops the queue with a plain message", async ({ page }) => {
  await page.goto("/settings");
  await page.getByTestId("insights-access-key").fill("x".repeat(43));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page
    .getByLabel("Import places file")
    .setInputFiles({ name: "takeout.zip", mimeType: "application/zip", buffer: takeoutZip() });
  await expect(page.getByTestId("insights-queue-error")).toContainText("access key is wrong");
  await expect(page.getByTestId("fetch-missing-insights")).toContainText(
    "Read reviews for 1 place",
  );
});

test("sample insights render on the place card with a photo lightbox", async ({ page }) => {
  await page.goto("/");
  const field = page.getByRole("combobox", { name: "Add a place" });
  await field.fill("cafe");
  await page.getByRole("option", { name: /Café Central/ }).click();
  const confirm = page.getByTestId("add-place-confirm");
  await confirm.getByTestId("field-list-choice").fill("Coffee stops");
  await confirm.getByTestId("field-create-option").click();
  const details = page.getByTestId("place-details");
  await expect(details).toBeVisible();
  await expect(details.getByTestId("place-insights")).toHaveCount(0);

  await page.goto("/settings");
  await page.getByTestId("attach-sample-insights").click();
  await expect(page.getByTestId("insights-message")).toContainText("1 places");

  await page.goto("/");
  await page.getByRole("link", { name: /Coffee stops/ }).click();
  await page.getByTestId("place-item").first().click();
  const insights = details.getByTestId("place-insights");
  await expect(insights.getByTestId("insights-summary")).toContainText("custard tarts");
  await expect(insights.getByTestId("aspect-meter")).toHaveCount(5);
  await expect(insights.getByTestId("insights-dishes")).toContainText("Pastel de nata");
  await expect(insights.getByTestId("insights-provenance")).toContainText("sample data");

  await details.getByRole("button", { name: /Open photos of/ }).click();
  const lightbox = page.getByTestId("place-lightbox");
  await expect(lightbox).toContainText("1 / 7");
  await page.keyboard.press("ArrowRight");
  await expect(lightbox).toContainText("2 / 7");
  await page.keyboard.press("Escape");
  await expect(lightbox).toHaveCount(0);
});

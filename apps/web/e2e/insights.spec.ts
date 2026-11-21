/**
 * Review insights on the place card (spec/src/reviews.md): classification
 * results and photos, never review text. Dev sample data stands in for a
 * real harvest.
 */
import { expect, test } from "@playwright/test";

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

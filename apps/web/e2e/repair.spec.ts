/**
 * Phase 2 done-when: "repair a simulated OSM node→way replacement without losing
 * notes or membership." node/599 resolves once, then reports deleted; recovery
 * finds way/777 with matching identity (website + name) and relinks automatically.
 */
import { expect, test } from "@playwright/test";

test("node→way replacement relinks automatically and keeps the note", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();

  // Save Café Migrado (backed by node/599, first and only successful resolve).
  await page.getByRole("combobox", { name: "Search places" }).fill("migrado");
  await page.getByRole("option", { name: /Café Migrado/ }).click();
  const osmSheet = page.getByTestId("place-sheet");
  await expect(osmSheet.getByTestId("website-link")).toHaveAttribute(
    "href",
    "https://cafemigrado.pt/",
  );
  await osmSheet.getByTestId("save-place").click();
  const sheet = page.getByTestId("saved-place-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("state-badge")).toHaveAttribute("data-state", "resolved");

  // A note that must survive the identity repair.
  await sheet.getByTestId("add-note").click();
  const editor = sheet.getByTestId("note-editor");
  await editor.getByLabel("Note body (Markdown)").fill("Do not lose me");
  await editor.getByRole("button", { name: "Save note" }).click();
  await expect(sheet.getByText("Do not lose me")).toBeVisible();

  // Upstream, the node is now deleted and redrawn as a way (test control switch).
  await page.evaluate(async () => {
    await fetch("https://api.openstreetmap.org/__test/delete-node-599", { method: "POST" });
  });
  await sheet.getByTestId("check-osm-updates").click();

  // Conservative recovery: unique high-confidence candidate → automatic relink.
  await expect(sheet.getByTestId("refresh-message")).toContainText("relinked automatically");
  await expect(sheet.getByTestId("state-badge")).toHaveAttribute("data-state", "resolved");
  // The binding now points at the replacement way…
  await expect(sheet.getByRole("link", { name: "View on OpenStreetMap" })).toHaveAttribute(
    "href",
    "https://www.openstreetmap.org/way/777",
  );
  // …and the personal layer stayed attached to the same PlaceId.
  await expect(sheet.getByText("Do not lose me")).toBeVisible();
  await expect(sheet.getByText("Café Migrado")).toBeVisible();
});

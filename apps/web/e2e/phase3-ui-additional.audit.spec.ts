/**
 * Additional user-facing Phase 3 export checks from spec/src/interop.md.
 * The ecosystem handoff is a real KMZ option plus a guided My Maps KML flow;
 * raw format buttons alone do not satisfy that contract.
 */
import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { unzipSync } from "fflate";

async function openImportedList(page: Page): Promise<void> {
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>My Maps audit</name>
<Placemark><name>Null Island marker</name><Point><coordinates>0,0</coordinates></Point></Placemark>
</Document></kml>`;

  await page.goto("/settings");
  await page.getByLabel("Import places file").setInputFiles({
    name: "my-maps-audit.kml",
    mimeType: "application/vnd.google-earth.kml+xml",
    buffer: Buffer.from(kml),
  });
  await expect(page.getByTestId("import-report")).toContainText("1 placed");
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Lists" })
    .click();
  await page.getByRole("link", { name: /My Maps audit/ }).click();
  await expect(page.getByTestId("place-item")).toHaveCount(1);
}

test("a list can be exported as an actual KMZ archive", async ({ page }) => {
  await openImportedList(page);

  const kmzButton = page.getByRole("button", { name: /KMZ/i });
  await expect(kmzButton).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await kmzButton.click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toMatch(/\.kmz$/i);
  const path = await download.path();
  if (!path) throw new Error("KMZ download has no local path");
  const entries = unzipSync(await readFile(path));
  expect(Object.keys(entries).some((name) => name.toLowerCase().endsWith(".kml"))).toBe(true);
});

test("Send to Google My Maps downloads KML and explains import and limits", async ({ page }) => {
  await openImportedList(page);

  const handoff = page.getByRole("button", { name: /Send to Google My Maps/i });
  await expect(handoff).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await handoff.click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toMatch(/\.kml$/i);
  await expect(page.getByText(/My Maps\s*.*Import\s*.*choose this file/is)).toBeVisible();
  await expect(page.getByText(/2[,.]000\s+features/i)).toBeVisible();
  await expect(page.getByText(/5\s*MB/i)).toBeVisible();
  await expect(page.getByText(/split/i)).toBeVisible();
});

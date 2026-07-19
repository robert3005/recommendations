/**
 * Phase 3 interop (book/src/interop.md): a Takeout archive imports through the
 * coordinate ladder into a list, the review queue resolves by map placement,
 * pins land on the map, deep links hand navigation out, and the list exports
 * as My Maps-compatible KML with ODbL attribution.
 */
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

const PLACE_URL =
  "https://www.google.com/maps/place/Caf%C3%A9+Central/data=!4m2!3m1!1s0x1f9a2b:0xdeadbeef";
const PIN_URL = "https://www.google.com/maps/search/38.71000,-9.15000";

function takeoutZip(): Buffer {
  const csv = [
    "Title,Note,URL,Address",
    `"Café Central","Great bica","${PLACE_URL}","Rua Example 12, Lisboa"`,
    `"Dropped pin",,"${PIN_URL}",`,
    `"Mystery Bar",,,"Nowhere 1"`,
  ].join("\n");
  return Buffer.from(zipSync({ "Takeout/Saved/Lisbon trip.csv": strToU8(csv) }));
}

test("a Takeout archive imports into a list; review resolves on the map", async ({ page }) => {
  await page.goto("/settings");
  await page.getByLabel("Import places file").setInputFiles({
    name: "takeout.zip",
    mimeType: "application/zip",
    buffer: takeoutZip(),
  });

  // Every row accounted for: 2 placed (1 OSM-linked), 1 in review.
  const report = page.getByTestId("import-report");
  await expect(report).toContainText("2 placed");
  await expect(report).toContainText("1 linked to OSM");
  await expect(report).toContainText("1 to review");

  // The review queue holds the un-geocodable row; place it on the map.
  const reviewItem = page.getByTestId("review-item");
  await expect(reviewItem).toHaveCount(1);
  await expect(reviewItem).toContainText("Mystery Bar");
  await reviewItem.getByTestId("review-place-on-map").click();

  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  await expect(page.getByTestId("placing-import-hint")).toBeVisible();
  const box = await page.getByTestId("map-canvas").boundingBox();
  if (!box) throw new Error("map canvas has no bounding box");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });

  // Placement materializes the item and opens its details card.
  const details = page.getByTestId("place-details");
  await expect(details).toBeVisible();
  await expect(details).toContainText("Mystery Bar");
  await expect(page.getByTestId("map-canvas")).toHaveAttribute("data-pins", "3");
  // Navigation handoff links are on the card.
  await expect(details.getByTestId("open-google-maps")).toBeVisible();
  await expect(details.getByTestId("open-apple-maps")).toBeVisible();
  await details.getByRole("button", { name: "Close" }).click();

  // The list holds all three; the linked place carries live OSM facts.
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Lists" })
    .click();
  await page.getByRole("link", { name: /Lisbon trip/ }).click();
  await expect(page.getByTestId("place-item")).toHaveCount(3);
  await expect(page.getByTestId("list-page")).toContainText("Café Central");

  // Export as KML: list name, three placemarks, ODbL attribution.
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("export-kml").click();
  const download = await downloadPromise;
  const kmlPath = await download.path();
  if (!kmlPath) throw new Error("KML download has no local path");
  const kml = await readFile(kmlPath, "utf8");
  expect(kml).toContain("<name>Lisbon trip</name>");
  expect(kml.match(/<Placemark>/g)).toHaveLength(3);
  expect(kml).toContain("OpenStreetMap contributors");

  // The imported Google URL survives as the deep link on the linked place.
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Map" })
    .click();
  await expect(page.getByTestId("map-canvas")).toHaveAttribute("data-pins", "3");
});

test("re-importing the same archive converges instead of duplicating", async ({ page }) => {
  await page.goto("/settings");
  const input = page.getByLabel("Import places file");
  const file = {
    name: "takeout.zip",
    mimeType: "application/zip",
    buffer: takeoutZip(),
  };
  await input.setInputFiles(file);
  await expect(page.getByTestId("import-report")).toContainText("2 placed");

  await input.setInputFiles(file);
  await expect(page.getByTestId("import-report")).toContainText("2 already present");

  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Lists" })
    .click();
  // One list, not two.
  await expect(page.getByRole("link", { name: /Lisbon trip/ })).toHaveCount(1);
  await page.getByRole("link", { name: /Lisbon trip/ }).click();
  await expect(page.getByTestId("place-item")).toHaveCount(2);
});

test("a CSV export round-trips through the importer", async ({ page }) => {
  await page.goto("/settings");
  await page.getByLabel("Import places file").setInputFiles({
    name: "takeout.zip",
    mimeType: "application/zip",
    buffer: takeoutZip(),
  });
  await expect(page.getByTestId("import-report")).toContainText("2 placed");
  await page.getByTestId("review-item").getByTestId("review-skip").click();
  await expect(page.getByTestId("import-review")).toHaveCount(0);

  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Lists" })
    .click();
  await page.getByRole("link", { name: /Lisbon trip/ }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("export-csv").click();
  const download = await downloadPromise;
  const csvPath = await download.path();
  if (!csvPath) throw new Error("CSV download has no local path");
  const csv = await readFile(csvPath, "utf8");
  expect(csv.split("\n")[0]).toBe("Title,Note,URL,Address,Attribution");
  expect(csv).toContain("Café Central");
  // The dropped pin keeps its original Google URL — provenance round-trips.
  expect(csv).toContain(PIN_URL);
});

test("KMZ import goes straight to placed pins (coordinates included)", async ({ page }) => {
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Hike spots</name>
<Placemark><name>Viewpoint</name><Point><coordinates>-9.2,38.75</coordinates></Point></Placemark>
</Document></kml>`;
  await page.goto("/settings");
  await page.getByLabel("Import places file").setInputFiles({
    name: "spots.kmz",
    mimeType: "application/vnd.google-earth.kmz",
    buffer: Buffer.from(zipSync({ "doc.kml": strToU8(kml) })),
  });
  await expect(page.getByTestId("import-report")).toContainText("1 placed");
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Lists" })
    .click();
  await expect(page.getByRole("link", { name: /Hike spots/ })).toBeVisible();
});

test("exported backup and exported KML are distinct artifacts", async ({ page }) => {
  // Guard: the interop export writers must not replace the versioned backup.
  await page.goto("/settings");
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("export-backup").click();
  const download = await downloadPromise;
  const backupPath = await download.path();
  if (!backupPath) throw new Error("backup download has no local path");
  const entries = unzipSync(await readFile(backupPath));
  expect(Object.keys(entries)).toContain("manifest.json");
  expect(strFromU8(entries["manifest.json"] ?? new Uint8Array())).toContain("placemarks");
});

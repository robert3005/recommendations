/**
 * Import & export (spec/src/interop.md): a Takeout archive imports through the
 * coordinate ladder into a list (CSV rows joined to Saved Places geometry by
 * Google feature id), the review queue resolves by clicking the canvas, a CSV
 * Note becomes a place post once per place, re-import converges, and the list
 * exports as My Maps-compatible KML/KMZ with the guided handoff. ODbL
 * attribution rides exports exactly when OSM-derived facts are present.
 */
import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { strToU8, unzipSync, zipSync } from "fflate";

const PLACE_URL =
  "https://www.google.com/maps/place/Caf%C3%A9+Central/data=!4m2!3m1!1s0x1f9a2b:0xdeadbeef";
const PIN_URL = "https://www.google.com/maps/search/38.71000,-9.15000";

/**
 * A real-shaped Takeout: a Saved list CSV (no coordinates) beside
 * Saved Places.json (geometry, no list structure). Café Central gains its
 * coordinates through the feature-id join — rung 2 of the ladder; the dropped
 * pin carries literal coordinates — rung 1; Mystery Bar must geocode — rung 3
 * (the MSW geocoder returns nothing for it, so it waits in review).
 */
function takeoutZip(): Buffer {
  const csv = [
    "Title,Note,URL,Address",
    `"Café Central","Great bica","${PLACE_URL}","Rua Example 12, Lisboa"`,
    `"Dropped pin",,"${PIN_URL}",`,
    `"Mystery Bar",,,"Nowhere 1"`,
  ].join("\n");
  const savedPlaces = JSON.stringify({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [-9.142, 38.712] },
        properties: {
          Title: "Café Central",
          "Google Maps URL": PLACE_URL,
          Location: { Address: "Rua Example 12, Lisboa" },
        },
      },
    ],
  });
  return Buffer.from(
    zipSync({
      "Takeout/Saved/Lisbon trip.csv": strToU8(csv),
      "Takeout/Maps (your places)/Saved Places.json": strToU8(savedPlaces),
    }),
  );
}

async function importFile(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  await page.goto("/settings");
  await page.getByLabel("Import places file").setInputFiles(file);
}

const takeoutFile = () => ({
  name: "takeout.zip",
  mimeType: "application/zip",
  buffer: takeoutZip(),
});

test("a Takeout archive imports through the ladder; review resolves on the canvas", async ({
  page,
}) => {
  await importFile(page, takeoutFile());

  // Every row accounted for (spec/src/interop.md §The import report).
  const report = page.getByTestId("import-report");
  await expect(report).toContainText("2 placed");
  await expect(report).toContainText("1 to review");

  // While a batch is reviewing, the top bar carries the review pill with the
  // queue count (2026-07-26 — search-first chrome).
  await expect(page.getByTestId("review-pill")).toContainText("1");

  // The review queue is its own notebook route.
  await page.getByTestId("open-review-queue").click();
  await expect(page.getByTestId("review-page")).toBeVisible();
  const reviewItem = page.getByTestId("review-item");
  await expect(reviewItem).toHaveCount(1);
  await expect(reviewItem).toContainText("Mystery Bar");

  // Manual placement is clicking the map (spec/src/map-view.md §Import
  // review): arm it, then click the canvas beside the notebook.
  await reviewItem.getByTestId("review-place-on-map").click();
  await expect(reviewItem.getByTestId("review-place-on-map")).toHaveText("Cancel placement");
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  const box = await page.getByTestId("map-canvas").boundingBox();
  if (!box) throw new Error("map canvas has no bounding box");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTestId("review-empty")).toBeVisible();
  // The queue emptied, the batch closed — the pill leaves the top bar.
  await expect(page.getByTestId("review-pill")).toHaveCount(0);

  // The list holds all three rows.
  await page.getByTestId("home-link").click();
  await page.getByRole("link", { name: /Lisbon trip/ }).click();
  await expect(page.getByTestId("place-item")).toHaveCount(3);
  await expect(page.getByTestId("list-page")).toContainText("Café Central");

  // The CSV Note became a place post titled with the place's name
  // (spec/src/interop.md §CSV Note → place post).
  await page
    .getByTestId("place-item")
    .filter({ hasText: "Café Central" })
    .getByTestId("select-place")
    .click();
  const details = page.getByTestId("place-details");
  await expect(details).toBeVisible();
  await expect(details.getByTestId("place-post-link")).toHaveText("Café Central");
  await details.getByRole("button", { name: "Close" }).click();

  // Export as KML — behind the one Export menu (spec/src/map-view.md §The
  // list page): list name, three placemarks — and NO ODbL attribution,
  // because no row here carries an osmRef (Google-derived and user-provided
  // coordinates only; spec/src/interop.md §Licensing).
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("export-menu").click();
  await page.getByTestId("export-kml").click();
  const download = await downloadPromise;
  const kmlPath = await download.path();
  if (!kmlPath) throw new Error("KML download has no local path");
  const kml = await readFile(kmlPath, "utf8");
  expect(kml).toContain("<name>Lisbon trip</name>");
  expect(kml.match(/<Placemark>/g)).toHaveLength(3);
  expect(kml).not.toContain("OpenStreetMap");

  // Home projects every import as a pin on the always-mounted canvas.
  await page.getByTestId("home-link").click();
  await expect(page.getByTestId("map-canvas")).toHaveAttribute("data-pins", "3");
});

test("re-importing the same archive converges; a Note becomes a post only once", async ({
  page,
}) => {
  await importFile(page, takeoutFile());
  await expect(page.getByTestId("import-report")).toContainText("2 placed");

  await page.getByLabel("Import places file").setInputFiles(takeoutFile());
  const report = page.getByTestId("import-report");
  await expect(report).toContainText("2 already present");
  // The deduped place already has its place post — the Note is dropped and
  // the report says so (local edits are canon).
  await expect(report).toContainText("notes dropped");

  await page.getByTestId("home-link").click();
  // One list, not two (sourceKey binding), and no duplicated members.
  await expect(page.getByRole("link", { name: /Lisbon trip/ })).toHaveCount(1);
  await page.getByRole("link", { name: /Lisbon trip/ }).click();
  await expect(page.getByTestId("place-item")).toHaveCount(2);
});

test("KMZ import goes straight to placed pins (coordinates included)", async ({ page }) => {
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Hike spots</name>
<Placemark><name>Viewpoint</name><Point><coordinates>-9.2,38.75</coordinates></Point></Placemark>
</Document></kml>`;
  await importFile(page, {
    name: "spots.kmz",
    mimeType: "application/vnd.google-earth.kmz",
    buffer: Buffer.from(zipSync({ "doc.kml": strToU8(kml) })),
  });
  await expect(page.getByTestId("import-report")).toContainText("1 placed");
  await page.getByTestId("home-link").click();
  await expect(page.getByRole("link", { name: /Hike spots/ })).toBeVisible();
});

test("a list exports as a real KMZ with the guided handoffs; CSV export is gone", async ({
  page,
}) => {
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>My Maps audit</name>
<Placemark><name>Miradouro</name><Point><coordinates>-9.2,38.75</coordinates></Point></Placemark>
</Document></kml>`;
  await importFile(page, {
    name: "my-maps-audit.kml",
    mimeType: "application/vnd.google-earth.kml+xml",
    buffer: Buffer.from(kml),
  });
  await expect(page.getByTestId("import-report")).toContainText("1 placed");
  await page.getByTestId("home-link").click();
  await page.getByRole("link", { name: /My Maps audit/ }).click();
  await expect(page.getByTestId("place-item")).toHaveCount(1);

  // Every export sits behind the one Export menu (spec/src/map-view.md §The
  // list page); the guided handoffs (spec/src/interop.md §Export) are its
  // grouped section, and CSV is no longer an export. Escape closes the menu.
  const menu = page.getByRole("menu", { name: "Export" });
  await page.getByTestId("export-menu").click();
  await expect(menu).toBeVisible();
  await expect(menu.getByTestId("handoff-my-maps")).toBeVisible();
  await expect(menu.getByTestId("handoff-umap")).toBeVisible();
  await expect(menu.getByTestId("export-csv")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();

  // The My Maps handoff downloads the KML and says what to do with it.
  const kmlPromise = page.waitForEvent("download");
  await page.getByTestId("export-menu").click();
  await menu.getByTestId("handoff-my-maps").click();
  const kmlDownload = await kmlPromise;
  expect(kmlDownload.suggestedFilename()).toMatch(/\.kml$/i);
  await expect(page.getByTestId("handoff-hint")).toContainText(/My Maps/);

  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("export-menu").click();
  await page.getByTestId("export-kmz").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.kmz$/i);
  const kmzPath = await download.path();
  if (!kmzPath) throw new Error("KMZ download has no local path");
  const entries = unzipSync(await readFile(kmzPath));
  expect(Object.keys(entries).some((name) => name.toLowerCase().endsWith(".kml"))).toBe(true);
});

test("GPX and GeoJSON are export-only — importing one fails visibly", async ({ page }) => {
  await importFile(page, {
    name: "route.gpx",
    mimeType: "application/gpx+xml",
    buffer: Buffer.from(`<gpx version="1.1"></gpx>`),
  });
  await expect(page.getByTestId("import-report")).toContainText("unsupported import file");
});

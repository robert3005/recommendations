import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

test("a browser backup contains and checksums note media", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  // Reach the canvas search beside the pane (spec/src/map-view.md §The grammar).
  await page.getByTestId("pane-collapse").click();

  await page.getByRole("combobox", { name: "Search places" }).fill("cafe");
  await page.getByRole("option", { name: /Café Central/ }).click();
  const placeSheet = page.getByTestId("place-sheet");
  await placeSheet.getByTestId("add-to-list").selectOption("__new__");
  await placeSheet.getByLabel("New list name").fill("Media backup");
  await placeSheet.getByTestId("create-list-and-add").click();

  const details = page.getByTestId("place-details");
  await details.getByRole("button", { name: "Add note" }).click();
  const editor = page.getByTestId("note-editor");
  await editor.getByLabel("Import image").setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: ONE_PIXEL_PNG,
  });
  await expect(editor.getByLabel("Note body (Markdown)")).toHaveValue(/asset:/);
  await editor.getByRole("button", { name: "Save note" }).click();

  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Settings" })
    .click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("export-backup").click();
  const download = await downloadPromise;
  const backupPath = await download.path();
  if (!backupPath) throw new Error("backup download has no local path");

  const entries = unzipSync(await readFile(backupPath));
  const mediaNames = Object.keys(entries).filter((name) => name.startsWith("media/"));
  expect(mediaNames).toHaveLength(1);
  const manifest = JSON.parse(strFromU8(entries["manifest.json"] ?? new Uint8Array())) as {
    checksums: Record<string, string>;
  };
  expect(manifest.checksums[mediaNames[0] ?? ""]).toMatch(/^[a-f0-9]{64}$/);
});

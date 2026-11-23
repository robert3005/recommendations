/**
 * Sync between devices (spec/src/sync.md): off until the owner turns it on;
 * turning it on shows the pairing code and its QR link and sends the library;
 * a pairing link fills the join field without joining; leaving keeps the
 * library. Two-device merging is covered against the real service in
 * src/features/sync/*.test.ts — one browser holds one library.
 */
import { expect, test } from "@playwright/test";

test("turn sync on → pairing code and QR → changes sync on their own → leave keeps the library", async ({
  page,
}) => {
  await page.goto("/");
  const field = page.getByRole("combobox", { name: "Add a place" });
  await field.fill("cafe");
  await page.getByRole("option", { name: /Café Central/ }).click();
  await page.getByTestId("save-place").click();
  await page.getByTestId("place-details").getByRole("button", { name: "Close" }).click();

  await page.getByTestId("settings-gear").click();
  const sync = page.getByTestId("sync-settings");
  // Off by default, and it says what turning it on means.
  await expect(sync).toContainText("There is no account");
  await expect(sync.getByTestId("sync-status")).toHaveCount(0);

  await sync.getByTestId("sync-start").click();
  await expect(sync.getByTestId("sync-status")).toContainText("Up to date");
  // The code is shown once sync is on, as text and as a QR of the pairing link.
  await expect(sync.getByTestId("sync-code")).toHaveText(/^[A-Za-z0-9_-]{43}$/);
  await expect(sync.getByTestId("sync-qr")).toBeVisible();
  await expect(sync).toContainText("Keep a copy somewhere safe");
  const code = (await sync.getByTestId("sync-code").innerText()).trim();

  // A change made afterwards goes out without a press.
  await page.getByTestId("home-link").click();
  await page.getByTestId("library-place").getByRole("button").click();
  await page.getByTestId("tag-input").fill("espresso");
  await page.getByTestId("tag-input").press("Enter");
  await page.getByTestId("place-details").getByRole("button", { name: "Close" }).click();
  await page.getByTestId("settings-gear").click();
  await expect(sync.getByTestId("sync-status")).toContainText("Up to date", { timeout: 15_000 });

  // Leaving stops sync here and keeps the library.
  await sync.getByTestId("sync-leave").click();
  await expect(sync.getByTestId("sync-start")).toBeVisible();
  await page.getByTestId("home-link").click();
  await expect(page.getByTestId("library-place")).toContainText("Café Central");

  // A pairing link fills the field and waits for the owner: nothing joins on
  // its own, and the code leaves the address bar. (The mock service forgets
  // its libraries on reload, so the join itself is covered in unit tests.)
  await page.goto(`/settings#pair=${code}`);
  await expect(sync.getByTestId("sync-join-code")).toHaveValue(code);
  expect(page.url()).not.toContain(code);
  await expect(sync.getByTestId("sync-start")).toBeVisible();
});

test("a code that opens no library is refused with a plain message", async ({ page }) => {
  await page.goto("/settings");
  const sync = page.getByTestId("sync-settings");
  await sync.getByTestId("sync-join-code").fill("A".repeat(43));
  await sync.getByTestId("sync-join").click();
  await expect(sync.getByTestId("sync-message")).toContainText("No library was found");
  await expect(sync.getByTestId("sync-start")).toBeVisible();
});

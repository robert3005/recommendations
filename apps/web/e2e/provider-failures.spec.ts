import { expect, test } from "@playwright/test";

// page.route cannot intercept fetches mediated by a service worker, and the dev
// server runs MSW's worker; block SWs so the 503 below actually reaches the map.
test.use({ serviceWorkers: "block" });

test("a basemap provider failure keeps the shell usable and exposes a designed state", async ({
  page,
}) => {
  await page.route("**/test-style.json", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
  );

  await page.goto("/");

  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Search places" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText(/map.*unavailable|could not load.*map/i);
});

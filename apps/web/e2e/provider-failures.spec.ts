import { expect, test } from "@playwright/test";

// page.route cannot intercept fetches mediated by a service worker, and the dev
// server runs MSW's worker; block SWs so the 503 below actually reaches the map.
test.use({ serviceWorkers: "block" });

test("a basemap provider failure keeps the shell usable and exposes a designed state", async ({
  page,
}) => {
  let styleRequests = 0;
  await page.route("**/test-style.json", (route) => {
    styleRequests += 1;
    return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  });

  await page.goto("/");

  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  expect(styleRequests).toBe(0);
  // Launch is intentionally full-content and the hidden map issues no
  // provider traffic. Revealing it starts the intercepted style request.
  await page.getByTestId("pane-collapse").click();
  await expect.poll(() => styleRequests).toBe(1);
  await expect(page.getByRole("combobox", { name: "Search places" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText(/map.*unavailable|could not load.*map/i);
});

/**
 * Provider failure states (spec/src/map-view.md §Accessibility and failure,
 * spec/src/data-sources.md): a basemap failure surfaces the accessible
 * top-anchored "Map unavailable" banner while the notebook keeps working, and
 * a geocoder failure is a designed message in the search field — never a
 * blank or a crash.
 */
import { expect, test } from "@playwright/test";

// page.route cannot intercept fetches mediated by a service worker, and the
// dev server runs MSW's worker; block SWs so the failures below actually
// reach the app.
test.use({ serviceWorkers: "block" });

test("basemap and geocoder failures keep the shell usable with designed states", async ({
  page,
}) => {
  await page.route("**/test-style.json", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
  );
  // With MSW blocked, keep the geocoder failure local and deterministic. Pin
  // the route to the geocoder HOST: a bare /stadia/ pattern would also abort
  // the dev server's own /src/providers/stadia.ts module request and the app
  // would never mount.
  await page.route("**://api.stadiamaps.com/**", (route) => route.abort());

  await page.goto("/");

  // The notebook is fully usable: the search-first top bar and the home page.
  await expect(page.getByTestId("home-link")).toBeVisible();
  await expect(page.getByTestId("add-place-field")).toBeVisible();
  await expect(page.getByTestId("lists-page")).toBeVisible();

  // The canvas mounts beside it at launch; its style request failed — the
  // designed banner, not a blank canvas or a full-bleed takeover.
  await expect(
    page.locator('[role="status"]').filter({ hasText: /map unavailable/i }),
  ).toBeVisible();

  // The geocoder being down is an answer in the field, not a crash.
  await page.getByRole("combobox", { name: "Add a place" }).fill("cafe");
  await expect(page.getByTestId("search-status")).toContainText(
    "Search is unavailable right now.",
    { timeout: 15_000 },
  );
});

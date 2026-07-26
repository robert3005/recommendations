/**
 * A stale pre-refocus dev database must never take the app down (db.ts
 * version-2 flush): the old build's rows — lists whose marker has no `shape` —
 * crashed the home page at first paint. Seed the old shape, then launch.
 */
import { expect, test } from "@playwright/test";

test("a pre-refocus database is flushed on open, and every page still renders", async ({
  page,
}) => {
  // Load a static asset first: same origin, no app code, no database opened.
  await page.goto("/test-style.json");
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        // The old build: Dexie version(1) = IndexedDB version 10.
        const open = indexedDB.open("placemarks", 10);
        open.onupgradeneeded = () => {
          const db = open.result;
          const lists = db.createObjectStore("lists", { keyPath: "id" });
          db.createObjectStore("places", { keyPath: "id" });
          db.createObjectStore("notes", { keyPath: "id" });
          lists.put({
            id: "old-1",
            name: "Old list",
            marker: { color: "#1f6f43", icon: "star" },
          });
        };
        open.onsuccess = () => {
          open.result.close();
          resolve();
        };
        open.onerror = () => reject(open.error);
      }),
  );

  await page.goto("/");
  // The home renders — no marker.shape crash — and the stale list is gone.
  await expect(page.getByTestId("lists-page")).toBeVisible();
  await expect(page.getByText("Old list")).toHaveCount(0);
});

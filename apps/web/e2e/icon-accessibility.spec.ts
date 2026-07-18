import { expect, test } from "@playwright/test";

test("the PWA icon has an accessible name", async ({ request }) => {
  const response = await request.get("/icon.svg");

  expect(response.ok()).toBe(true);
  expect(await response.text()).toMatch(/<title>\s*[^<\s][^<]*<\/title>/i);
});

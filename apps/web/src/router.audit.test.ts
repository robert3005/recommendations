import { describe, expect, it } from "vitest";
import { isPublicViewerPath, mapCanvasClasses } from "./router";

describe("route chrome projection", () => {
  it.each(["/l/public-list", "/p/public-post"])(
    "treats %s as a read-only public viewer",
    (pathname) => {
      expect(isPublicViewerPath(pathname)).toBe(true);
    },
  );

  it.each(["/", "/list/private-list", "/post/private-post", "/review", "/settings"])(
    "keeps %s in private application chrome",
    (pathname) => {
      expect(isPublicViewerPath(pathname)).toBe(false);
    },
  );
});

describe("persistent map route/layout state", () => {
  it("makes the desktop canvas the row's flexible sibling, never an overlay", () => {
    // The shell is a flex row on md+: the canvas takes the remainder beside
    // the notebook and the place column (spec/src/map-view.md §The grammar).
    expect(mapCanvasClasses()).toContain("md:flex-1");
    expect(mapCanvasClasses()).toContain("md:min-w-0");
    expect(mapCanvasClasses()).not.toMatch(/md:left-/);
  });
});

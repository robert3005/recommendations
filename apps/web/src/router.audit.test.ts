import { describe, expect, it } from "vitest";
import { isPublicViewerPath, mapCanvasClasses } from "./router";

describe("route chrome projection", () => {
  it.each(["/l", "/l/public-list", "/p/public-post"])(
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
  it("gives the desktop split canvas its own box beside the 26rem pane", () => {
    expect(mapCanvasClasses("split")).toContain("md:left-[26rem]");
    expect(mapCanvasClasses("collapsed")).not.toContain("md:left-[26rem]");
    expect(mapCanvasClasses("expanded")).not.toContain("md:left-[26rem]");
  });
});

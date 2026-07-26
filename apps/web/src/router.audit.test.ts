import { describe, expect, it } from "vitest";
import {
  isPublicViewerPath,
  mapCanvasClasses,
  paneStateAtHeight,
  validateViewportSearch,
} from "./router";

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

describe("mobile pane drag detents", () => {
  it("snaps the dragged sheet to peek, half, or full", () => {
    expect(paneStateAtHeight(70, 1000)).toBe("collapsed");
    expect(paneStateAtHeight(510, 1000)).toBe("split");
    expect(paneStateAtHeight(930, 1000)).toBe("expanded");
  });
});

describe("persistent map route/layout state", () => {
  it("gives the desktop split canvas its own box beside the 26rem pane", () => {
    expect(mapCanvasClasses("split")).toContain("md:left-[26rem]");
    expect(mapCanvasClasses("collapsed")).not.toContain("md:left-[26rem]");
    expect(mapCanvasClasses("expanded")).not.toContain("md:left-[26rem]");
  });

  it("parses a complete bounded viewport and discards unsafe or partial cameras", () => {
    expect(validateViewportSearch({ lat: "51.5", lng: "-0.12", zoom: "13.25" })).toEqual({
      lat: 51.5,
      lng: -0.12,
      zoom: 13.25,
    });
    expect(validateViewportSearch({ lat: 91, lng: 0, zoom: 10 })).toEqual({});
    expect(validateViewportSearch({ lat: 51.5, lng: -0.12 })).toEqual({});
    expect(validateViewportSearch({ lat: 0, lng: 0, zoom: 25 })).toEqual({});
  });
});

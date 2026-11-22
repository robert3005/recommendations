/**
 * Review insights in the browser (spec/src/reviews.md): the loader reads only
 * place.json, photos.jsonl (with local photo files) and profile.json — never
 * reviews — and a library place joins its insights by the Google feature id
 * in its googleUrl. The panel shows classification results, never review text.
 */
import type { PlaceProfile } from "@placemarks/domain";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { InsightsDb, setInsightsDb } from "./db";
import { readPlaceInsights } from "./hooks";
import { clearInsights, loadInsightsFolder, type PickedFile } from "./loader";
import { aspectWord, classifierLabel, PlaceInsightsPanel } from "./PlaceInsightsPanel";
import { sampleProfile } from "./sample";

const NOW = "2026-11-21T00:00:00.000Z";
const KEY = "0x47e66e2964e34e2d:0x8ddca9ee380ef7e0";
const DIR = "places/0x47e66e2964e34e2d_0x8ddca9ee380ef7e0";

function file(path: string, content: string): PickedFile {
  return { path, file: new Blob([content]) };
}

// jsdom Blobs lack text(); browsers' File objects have it.
if (!("text" in Blob.prototype)) {
  Object.defineProperty(Blob.prototype, "text", {
    writable: true,
    value(this: Blob) {
      return new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.readAsText(this);
      });
    },
  });
}

let db: InsightsDb;
beforeEach(async () => {
  db = new InsightsDb(`test-${Math.random()}`);
  setInsightsDb(db);
});

describe("loadInsightsFolder", () => {
  it("loads snapshot, photos and profile; ignores reviews; keys from file contents", async () => {
    const reviewsRead: string[] = [];
    const reviews = file(`${DIR}/reviews.jsonl`, '{"id":"r1","text":"secret"}');
    Object.defineProperty(reviews.file, "text", {
      value: async () => {
        reviewsRead.push("read");
        return "";
      },
    });
    const files = [
      file(
        `${DIR}/place.json`,
        JSON.stringify({
          sourcePlaceKey: KEY,
          name: "Tasca",
          rating: 4.4,
          ratingCount: 900,
          priceLevel: 2,
        }),
      ),
      file(`${DIR}/profile.json`, JSON.stringify(sampleProfile(KEY, NOW))),
      file(
        `${DIR}/photos.jsonl`,
        [
          {
            id: "p1",
            sourcePlaceKey: KEY,
            url: "https://lh3.googleusercontent.com/a.jpg",
            attribution: { name: "Ana" },
          },
          {
            id: "p2",
            sourcePlaceKey: KEY,
            localPath: "photos/p2.jpg",
            attribution: { name: "Rui", url: "https://example.com/rui" },
          },
          {
            id: "p3",
            sourcePlaceKey: KEY,
            url: "http://insecure.example/x.jpg",
            attribution: { name: "X" },
          },
          { id: "p4", sourcePlaceKey: KEY, url: "https://ok.example/y.jpg", attribution: {} },
        ]
          .map((r) => JSON.stringify(r))
          .join("\n"),
      ),
      file(`${DIR}/photos/p2.jpg`, "jpegbytes"),
      reviews,
      file("places/broken/place.json", "{not json"),
      file("manifest.json", "{}"),
    ];
    const summary = await loadInsightsFolder(files, NOW, db);
    expect(summary).toEqual({ places: 1, profiles: 1, photos: 2, skipped: ["broken"] });
    expect(reviewsRead).toEqual([]);

    const photos = await db.photos.toArray();
    expect(photos.map((p) => [p.id, p.url, p.blob !== undefined])).toEqual([
      ["p1", "https://lh3.googleusercontent.com/a.jpg", false],
      ["p2", "", true],
    ]);

    // A library place joins by the feature id in its googleUrl.
    const insights = await readPlaceInsights({
      id: "lib-1",
      googleUrl: `https://www.google.com/maps/place/Tasca/data=!4m2!3m1!1s${KEY}`,
    });
    expect(insights?.source?.name).toBe("Tasca");
    expect(insights?.profile?.usefulCount).toBe(187);
    expect(insights?.photos).toHaveLength(2);
    expect(await readPlaceInsights({ id: "other" })).toBeNull();

    await clearInsights(db);
    expect(await db.placeProfiles.count()).toBe(0);
  });

  it("skips a folder whose profile names another place", async () => {
    const summary = await loadInsightsFolder(
      [
        file(`${DIR}/place.json`, JSON.stringify({ sourcePlaceKey: KEY })),
        file(`${DIR}/profile.json`, JSON.stringify(sampleProfile("0x1:0x2", NOW))),
      ],
      NOW,
      db,
    );
    expect(summary.skipped).toEqual(["0x47e66e2964e34e2d_0x8ddca9ee380ef7e0"]);
  });
});

describe("PlaceInsightsPanel", () => {
  const profile: PlaceProfile = {
    ...sampleProfile(KEY, NOW),
    classifiers: ["anthropic:claude-haiku-5-5"],
    warnings: [{ flag: "rude_staff", mentions: 3, reviewIds: ["a"] }],
  };

  it("shows the summary, meters, dishes, tags and warnings with provenance", () => {
    render(
      <PlaceInsightsPanel
        source={{
          sourcePlaceKey: KEY,
          rating: 4.6,
          ratingCount: 1284,
          priceLevel: 2,
          loadedAt: NOW,
        }}
        profile={profile}
      />,
    );
    expect(screen.getByTestId("insights-rating")).toHaveTextContent(
      "★ 4.6 (1,284) on Google · Moderately priced",
    );
    expect(screen.getByTestId("insights-summary")).toHaveTextContent(/custard tarts/);
    expect(screen.getAllByTestId("aspect-meter")).toHaveLength(5);
    expect(screen.getByRole("img", { name: "Food: Excellent, 151 mentions" })).toBeInTheDocument();
    expect(screen.getByTestId("insights-dishes")).toHaveTextContent("Pastel de nata 58");
    // Review tags are drawn as derived chips — dashed, marked "from reviews".
    const occasion = screen.getByTestId("insights-tags-occasion");
    expect(occasion).toHaveTextContent(/Quick bite.*Solo.*Brunch/);
    expect(within(occasion).getAllByTestId("derived-tag")).toHaveLength(3);
    expect(screen.getByTestId("insights-warnings")).toHaveTextContent(
      "Rude staff reported in 3 recent reviews",
    );
    expect(screen.getByTestId("insights-provenance")).toHaveTextContent(
      "187 of 214 reviews by Claude Haiku 5.5",
    );
  });

  it("says when reviews are not classified yet", () => {
    render(<PlaceInsightsPanel source={{ sourcePlaceKey: KEY, loadedAt: NOW }} />);
    expect(screen.getByTestId("insights-pending")).toHaveTextContent(/pnpm classify run/);
  });

  it("labels words and classifiers", () => {
    expect([1.5, 0.6, 0, -1, -2].map(aspectWord)).toEqual([
      "Excellent",
      "Good",
      "Mixed",
      "Poor",
      "Bad",
    ]);
    expect(classifierLabel("typesafe:jev-latest")).toBe("Jev");
    expect(classifierLabel("codex:luna")).toBe("Luna");
  });
});

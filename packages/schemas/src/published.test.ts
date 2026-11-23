import { describe, expect, it } from "vitest";
import { normalizeSlug, slugSchema } from "./api";
import { PUBLISHED_LIMITS, parsePublishedDocument } from "./published";

const place = { id: "p1", name: "Cervejaria Ramiro", lat: 38.7207, lng: -9.1352 };

const listDoc = {
  v: 1,
  kind: "list",
  title: "Lisbon",
  marker: { shape: "circle", color: "#F97316" },
  places: [{ ...place, osmRef: { type: "node", id: "240109189" } }],
  posts: [{ title: "Guide", url: "https://app.example/p/guide" }],
};

const postDoc = {
  v: 1,
  kind: "post",
  title: "A weekend in Lisbon",
  body: "Start at [Ramiro](#place-p1).",
  places: [place],
  list: { title: "Lisbon", url: "https://app.example/l/lisbon" },
};

describe("parsePublishedDocument", () => {
  it("accepts well-formed documents of each kind", () => {
    expect(parsePublishedDocument("list", listDoc)).toEqual(listDoc);
    expect(parsePublishedDocument("post", postDoc)).toEqual(postDoc);
  });

  it("rejects a document of the wrong kind for the route", () => {
    expect(() => parsePublishedDocument("list", postDoc)).toThrow();
    expect(() => parsePublishedDocument("post", listDoc)).toThrow();
  });

  it("strips unknown keys — forward compatibility without leakage", () => {
    const parsed = parsePublishedDocument("post", { ...postDoc, editorToken: "secret" });
    expect("editorToken" in parsed).toBe(false);
  });

  it("enforces the places cap", () => {
    const places = Array.from({ length: PUBLISHED_LIMITS.maxPlaces + 1 }, (_, i) => ({
      ...place,
      id: `p${i}`,
    }));
    expect(() => parsePublishedDocument("list", { ...listDoc, places })).toThrow();
  });

  it("enforces the body byte cap, counting UTF-8 bytes not characters", () => {
    const ascii = "a".repeat(PUBLISHED_LIMITS.maxBodyBytes);
    expect(() => parsePublishedDocument("post", { ...postDoc, body: ascii })).not.toThrow();
    // “é” is two UTF-8 bytes: half as many characters still bursts the cap.
    const utf8 = "é".repeat(PUBLISHED_LIMITS.maxBodyBytes / 2 + 1);
    expect(() => parsePublishedDocument("post", { ...postDoc, body: utf8 })).toThrow();
  });

  it("enforces the title cap and coordinate ranges", () => {
    expect(() => parsePublishedDocument("list", { ...listDoc, title: "t".repeat(301) })).toThrow();
    expect(() =>
      parsePublishedDocument("list", { ...listDoc, places: [{ ...place, lat: 91 }] }),
    ).toThrow();
  });

  it("accepts only https Wikimedia-hosted imageUrls", () => {
    const withImage = (imageUrl: string) => ({
      ...listDoc,
      places: [{ ...place, imageUrl }],
    });
    expect(() =>
      parsePublishedDocument(
        "list",
        withImage("https://commons.wikimedia.org/wiki/Special:FilePath/Ramiro.jpg?width=640"),
      ),
    ).not.toThrow();
    expect(() =>
      parsePublishedDocument(
        "list",
        withImage("https://upload.wikimedia.org/wikipedia/commons/1/2a/Ramiro.jpg"),
      ),
    ).not.toThrow();
    expect(() => parsePublishedDocument("list", withImage("https://example.com/a.jpg"))).toThrow();
    expect(() =>
      parsePublishedDocument("list", withImage("http://commons.wikimedia.org/wiki/x.jpg")),
    ).toThrow();
  });

  it("caps the richer POI facts and constrains wheelchair to its enum", () => {
    const withFacts = (facts: Record<string, unknown>) => ({
      ...listDoc,
      places: [{ ...place, ...facts }],
    });
    const ok = withFacts({
      website: "https://ramiro.pt",
      phone: "+351 21 885 1024",
      openingHours: "Tu-Su 12:00-00:30",
      cuisine: "seafood",
      wheelchair: "limited",
      description: "d".repeat(600),
      wikipediaUrl: "https://pt.wikipedia.org/wiki/Cervejaria_Ramiro",
    });
    expect(() => parsePublishedDocument("list", ok)).not.toThrow();

    // https-only URL facts.
    expect(() =>
      parsePublishedDocument("list", withFacts({ website: "http://ramiro.pt" })),
    ).toThrow();
    expect(() =>
      parsePublishedDocument("list", withFacts({ wikipediaUrl: "http://pt.wikipedia.org/x" })),
    ).toThrow();
    // Length caps: description 600, phone 60, openingHours 300, cuisine 120.
    expect(() =>
      parsePublishedDocument("list", withFacts({ description: "d".repeat(601) })),
    ).toThrow();
    expect(() => parsePublishedDocument("list", withFacts({ phone: "9".repeat(61) }))).toThrow();
    expect(() =>
      parsePublishedDocument("list", withFacts({ openingHours: "h".repeat(301) })),
    ).toThrow();
    expect(() => parsePublishedDocument("list", withFacts({ cuisine: "c".repeat(121) }))).toThrow();
    // wheelchair is the three-value enum, nothing else.
    expect(() => parsePublishedDocument("list", withFacts({ wheelchair: "designated" }))).toThrow();
  });

  it("rejects non-https post URLs and malformed osmRefs", () => {
    expect(() =>
      parsePublishedDocument("list", {
        ...listDoc,
        posts: [{ title: "x", url: "javascript:alert(1)" }],
      }),
    ).toThrow();
    expect(() =>
      parsePublishedDocument("list", {
        ...listDoc,
        places: [{ ...place, osmRef: { type: "node", id: "abc" } }],
      }),
    ).toThrow();
  });
});

describe("slugs", () => {
  it("normalizes titles into valid slugs", () => {
    const slug = normalizeSlug("Café São João — Lisbon!");
    expect(slug).toBe("cafe-sao-joao-lisbon");
    expect(slugSchema.safeParse(slug).success).toBe(true);
  });

  it("rejects malformed slugs", () => {
    for (const bad of ["", "-lead", "trail-", "UPPER", "a b"]) {
      expect(slugSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("the curator's layer and the version stamp", () => {
  const voiced = {
    ...listDoc,
    description: "Where I take visitors.",
    author: "Robert",
    version: 3,
    updatedAt: "2026-11-22T22:00:00.000Z",
    places: [{ ...place, note: "Order the turbot.", tags: ["date night"], rating: 3 }],
  };

  it("accepts an intro, an author, a stamp, and per-place note, tags and rating", () => {
    expect(parsePublishedDocument("list", voiced)).toEqual(voiced);
    expect(parsePublishedDocument("post", { ...postDoc, version: 2 })).toMatchObject({
      version: 2,
    });
  });

  it("stays optional — a document written before these fields still parses", () => {
    expect(parsePublishedDocument("list", listDoc)).toEqual(listDoc);
  });

  it("refuses an out-of-range rating, a zero version, and an oversized note", () => {
    const withPlace = (extra: object) => ({ ...listDoc, places: [{ ...place, ...extra }] });
    expect(() => parsePublishedDocument("list", withPlace({ rating: 4 }))).toThrow();
    expect(() => parsePublishedDocument("list", withPlace({ note: "x".repeat(601) }))).toThrow();
    expect(() => parsePublishedDocument("list", { ...listDoc, version: 0 })).toThrow();
  });
});

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

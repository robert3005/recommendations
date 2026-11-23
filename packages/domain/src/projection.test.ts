import { describe, expect, it } from "vitest";
import type { List, Place, Post } from "./entities";
import { projectList, projectPost, stableStringify, toPublishedPlace } from "./projection";

function place(id: string, extra: Partial<Place> = {}): Place {
  return {
    id,
    name: `Place ${id}`,
    lat: 38.7,
    lng: -9.1,
    origin: "search",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
    ...extra,
  };
}

const list: List = {
  id: "l1",
  name: "Lisbon",
  marker: { shape: "circle", color: "#F97316" },
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

const post: Post = {
  id: "w1",
  target: { kind: "list", listId: "l1" },
  title: "A weekend in Lisbon",
  body: "Start at [Ramiro](place:p1), skip [gone](place:p9), read [more](post:w2).",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-03T00:00:00.000Z",
};

describe("toPublishedPlace", () => {
  it("keeps exactly the public facts, dropping provenance URLs and timestamps", () => {
    const published = toPublishedPlace(
      place("p1", {
        address: "Av. Almirante Reis 1",
        category: "restaurant",
        osmRef: { type: "node", id: "42" },
        imageUrl: "https://commons.wikimedia.org/wiki/Special:FilePath/Ramiro.jpg?width=640",
        googleUrl: "https://maps.google.com/?cid=1",
        appleUrl: "https://maps.apple.com/?ll=1,2",
      }),
    );
    expect(published).toEqual({
      id: "p1",
      name: "Place p1",
      lat: 38.7,
      lng: -9.1,
      address: "Av. Almirante Reis 1",
      category: "restaurant",
      osmRef: { type: "node", id: "42" },
      imageUrl: "https://commons.wikimedia.org/wiki/Special:FilePath/Ramiro.jpg?width=640",
    });
  });

  it("passes the richer POI facts through, but never descriptionSource", () => {
    const published = toPublishedPlace(
      place("p1", {
        website: "https://ramiro.pt",
        phone: "+351 21 885 1024",
        openingHours: "Tu-Su 12:00-00:30",
        cuisine: "seafood",
        wheelchair: "limited",
        description: "A Lisbon seafood institution.",
        descriptionSource: "wikipedia",
        wikipediaUrl: "https://pt.wikipedia.org/wiki/Cervejaria_Ramiro",
      }),
    );
    expect(published).toEqual({
      id: "p1",
      name: "Place p1",
      lat: 38.7,
      lng: -9.1,
      website: "https://ramiro.pt",
      phone: "+351 21 885 1024",
      openingHours: "Tu-Su 12:00-00:30",
      cuisine: "seafood",
      wheelchair: "limited",
      description: "A Lisbon seafood institution.",
      wikipediaUrl: "https://pt.wikipedia.org/wiki/Cervejaria_Ramiro",
    });
    expect("descriptionSource" in published).toBe(false);
  });

  it("omits absent optionals rather than writing undefined keys", () => {
    const published = toPublishedPlace(place("p1"));
    expect(Object.keys(published)).toEqual(["id", "name", "lat", "lng"]);
  });
});

describe("projectList", () => {
  it("projects title, marker, and places in list order", () => {
    const doc = projectList(list, [place("p2"), place("p1")], []);
    expect(doc.v).toBe(1);
    expect(doc.kind).toBe("list");
    expect(doc.title).toBe("Lisbon");
    expect(doc.marker).toEqual({ shape: "circle", color: "#F97316" });
    expect(doc.places.map((p) => p.id)).toEqual(["p2", "p1"]);
    expect(doc.posts).toBeUndefined();
  });

  it("links the published posts about the list when there are any", () => {
    const posts = [{ title: "Guide", url: "https://app.example/p/guide" }];
    expect(projectList(list, [], posts).posts).toEqual(posts);
  });
});

describe("projectPost", () => {
  it("rewrites the body against the post's own projection", () => {
    const doc = projectPost(post, [place("p1")], {
      postUrls: new Map([["w2", "https://app.example/p/more"]]),
    });
    expect(doc.v).toBe(1);
    expect(doc.kind).toBe("post");
    expect(doc.body).toBe(
      "Start at [Ramiro](#place-p1), skip gone, read [more](https://app.example/p/more).",
    );
    expect(doc.places.map((p) => p.id)).toEqual(["p1"]);
    expect(doc.list).toBeUndefined();
  });

  it("carries the list back-link for list posts only, url optional", () => {
    const doc = projectPost(post, [], { listRef: { title: "Lisbon" }, postUrls: new Map() });
    expect(doc.list).toEqual({ title: "Lisbon" });
  });
});

describe("stableStringify", () => {
  it("is independent of key insertion order at every depth", () => {
    const a = { z: 1, a: { c: [1, { y: 2, x: 3 }], b: 2 } };
    const b = { a: { b: 2, c: [1, { x: 3, y: 2 }] }, z: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(stableStringify(a)).toBe('{"a":{"b":2,"c":[1,{"x":3,"y":2}]},"z":1}');
  });

  it("keeps array order — lists are ordered content, not sets", () => {
    expect(stableStringify([2, 1])).toBe("[2,1]");
  });

  it("hashes projections stably: same projection, same string", () => {
    const doc1 = projectList(list, [place("p1")], []);
    const doc2 = projectList({ ...list }, [place("p1")], []);
    expect(stableStringify(doc1)).toBe(stableStringify(doc2));
  });
});

describe("the curator's layer", () => {
  const voiced = place("p1", { note: "Order the turbot.", tags: ["date night"], rating: 3 });

  it("a list shares notes, tags and ratings unless it opted out", () => {
    expect(projectList(list, [voiced], []).places[0]).toMatchObject({
      note: "Order the turbot.",
      tags: ["date night"],
      rating: 3,
    });
    const quiet = projectList({ ...list, shareNotes: false }, [voiced], []).places[0];
    expect(quiet).not.toHaveProperty("note");
    expect(quiet).not.toHaveProperty("tags");
    expect(quiet).not.toHaveProperty("rating");
  });

  it("carries the intro and a trimmed author name, and omits both when unset", () => {
    const doc = projectList({ ...list, description: "Three days." }, [], [], { author: " Ana " });
    expect(doc).toMatchObject({ description: "Three days.", author: "Ana" });
    const bare = projectList(list, [], [], { author: "  " });
    expect(bare).not.toHaveProperty("description");
    expect(bare).not.toHaveProperty("author");
  });

  it("a post document never carries the owner's notes", () => {
    const doc = projectPost(post, [voiced], { postUrls: new Map() });
    expect(doc.places[0]).not.toHaveProperty("note");
    expect(doc.places[0]).not.toHaveProperty("tags");
  });
});

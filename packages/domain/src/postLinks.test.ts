import { describe, expect, it } from "vitest";
import { extractMentionIds, extractPostLinkIds, rewriteBodyForPublish } from "./postLinks";

const body = [
  "Start at [Ramiro](place:p1), then [the park](place:p2).",
  "Read [the write-up](post:w1) and [another](post:w2).",
  "Back to [Ramiro again](place:p1) — and a [normal link](https://example.com).",
].join("\n\n");

describe("extractMentionIds", () => {
  it("collects place targets in order, deduped", () => {
    expect(extractMentionIds(body)).toEqual(["p1", "p2"]);
  });

  it("ignores post links, bare protocols, and prose", () => {
    expect(extractMentionIds("see [x](post:w1), place:loose, and [y](https://a.example)")).toEqual(
      [],
    );
    expect(extractMentionIds("")).toEqual([]);
  });
});

describe("extractPostLinkIds", () => {
  it("collects post targets in order, deduped", () => {
    expect(extractPostLinkIds(`${body} and [again](post:w1)`)).toEqual(["w1", "w2"]);
  });
});

describe("rewriteBodyForPublish", () => {
  it("rewrites projected mentions to stable fragments", () => {
    const out = rewriteBodyForPublish("Go to [Ramiro](place:p1).", {
      placeIdsInDoc: new Set(["p1"]),
      postUrls: new Map(),
    });
    expect(out).toBe("Go to [Ramiro](#place-p1).");
  });

  it("unwraps a mention outside the published places set to its text", () => {
    const out = rewriteBodyForPublish("Go to [Ramiro](place:p1).", {
      placeIdsInDoc: new Set(["other"]),
      postUrls: new Map(),
    });
    expect(out).toBe("Go to Ramiro.");
  });

  it("rewrites post links to their public URLs, unwrapping unpublished targets", () => {
    const out = rewriteBodyForPublish("[guide](post:w1) vs [draft](post:w2)", {
      placeIdsInDoc: new Set(),
      postUrls: new Map([["w1", "https://app.example/p/lisbon-guide"]]),
    });
    expect(out).toBe("[guide](https://app.example/p/lisbon-guide) vs draft");
  });

  it("leaves ordinary links and prose untouched", () => {
    const untouched = "A [normal link](https://example.com) and `code` and text.";
    expect(
      rewriteBodyForPublish(untouched, { placeIdsInDoc: new Set(), postUrls: new Map() }),
    ).toBe(untouched);
  });

  it("handles every form in one body — no custom protocol survives", () => {
    const out = rewriteBodyForPublish(body, {
      placeIdsInDoc: new Set(["p1"]),
      postUrls: new Map([["w2", "https://app.example/p/other"]]),
    });
    expect(out).toContain("[Ramiro](#place-p1)");
    expect(out).toContain("the park."); // p2 not published → unwrapped
    expect(out).toContain("the write-up"); // w1 unpublished → unwrapped
    expect(out).toContain("[another](https://app.example/p/other)");
    expect(out).toContain("[normal link](https://example.com)");
    expect(out).not.toContain("place:");
    expect(out).not.toContain("post:");
  });
});

/**
 * Short-link expansion (spec/src/interop.md §One place via a link): only
 * Google's share-link hosts are ever requested, redirects are walked by hand,
 * and only a Google Maps URL comes back.
 */
import { describe, expect, it } from "vitest";
import { createShareApp } from "./app";
import { type FetchLike, resolveShortLink } from "./resolveLink";
import { MemoryStorage } from "./storage";

const SHORT = "https://maps.app.goo.gl/ahHp1Y6MdgxDMFfb9";
const PLACE =
  "https://www.google.com/maps/place/Colonna+&+Small's/@51.5216362,-0.1125268,17z/data=!3m1!4b1!4m6!3m5!1s0x48761b6656cb87d5:0x2e6defda184b96ec!8m2!3d51.5216329!4d-0.1099519";

function redirects(map: Record<string, string>): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push(url);
      expect(init.redirect).toBe("manual");
      const location = map[url];
      return location
        ? new Response(null, { status: 302, headers: { location } })
        : new Response("<html>not a redirect</html>", { status: 200 });
    },
  };
}

describe("resolveShortLink", () => {
  it("returns the Google Maps URL a share link redirects to", async () => {
    const up = redirects({ [SHORT]: PLACE });
    expect(await resolveShortLink(SHORT, up.fetch)).toEqual({ ok: true, url: PLACE });
    expect(up.calls).toEqual([SHORT]);
  });

  it("walks a legacy goo.gl/maps hop and unwraps the consent interstitial", async () => {
    const legacy = "https://goo.gl/maps/abc123";
    const consent = `https://consent.google.com/m?continue=${encodeURIComponent(PLACE)}&gl=GB`;
    const up = redirects({ [legacy]: SHORT, [SHORT]: consent });
    expect(await resolveShortLink(legacy, up.fetch)).toEqual({ ok: true, url: PLACE });
    expect(up.calls).toEqual([legacy, SHORT]);
  });

  it.each([
    "https://example.com/x",
    "http://maps.app.goo.gl/abc",
    "https://goo.gl/abc",
    "https://maps.app.goo.gl.evil.example/abc",
    "https://user@maps.app.goo.gl/abc",
    "https://maps.app.goo.gl:8443/abc",
    "not a url",
    "",
  ])("never requests %s", async (input) => {
    const up = redirects({});
    expect(await resolveShortLink(input, up.fetch)).toEqual({
      ok: false,
      reason: "not-a-short-link",
    });
    expect(up.calls).toEqual([]);
  });

  it("stops at a redirect to any other host without requesting it", async () => {
    const up = redirects({ [SHORT]: "https://internal.example/admin" });
    expect(await resolveShortLink(SHORT, up.fetch)).toEqual({ ok: false, reason: "unresolved" });
    expect(up.calls).toEqual([SHORT]);
  });

  it("gives up on a redirect loop and on a non-redirect answer", async () => {
    const loop = redirects({ [SHORT]: SHORT });
    expect(await resolveShortLink(SHORT, loop.fetch)).toEqual({ ok: false, reason: "unresolved" });
    expect(loop.calls.length).toBe(4);
    expect(await resolveShortLink(SHORT, redirects({}).fetch)).toEqual({
      ok: false,
      reason: "unresolved",
    });
  });

  it("reports an unreachable upstream", async () => {
    const down: FetchLike = async () => {
      throw new Error("offline");
    };
    expect(await resolveShortLink(SHORT, down)).toEqual({ ok: false, reason: "upstream" });
  });
});

describe("GET /s/resolve-link", () => {
  const request = (app: ReturnType<typeof createShareApp>, url: string) =>
    app.request(`/s/resolve-link?url=${encodeURIComponent(url)}`);

  it("answers with the expanded URL, uncached and CORS-open", async () => {
    const app = createShareApp({
      storage: new MemoryStorage(),
      fetchUpstream: redirects({ [SHORT]: PLACE }).fetch,
    });
    const res = await request(app, SHORT);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: PLACE });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("maps failures to 400 / 422 / 502 and 501 when unconfigured", async () => {
    const app = createShareApp({
      storage: new MemoryStorage(),
      fetchUpstream: redirects({}).fetch,
    });
    expect((await request(app, "https://example.com/")).status).toBe(400);
    expect((await request(app, SHORT)).status).toBe(422);
    const down = createShareApp({
      storage: new MemoryStorage(),
      fetchUpstream: async () => {
        throw new Error("offline");
      },
    });
    expect((await request(down, SHORT)).status).toBe(502);
    const off = createShareApp({ storage: new MemoryStorage() });
    expect((await request(off, SHORT)).status).toBe(501);
  });

  it("rate limits one source", async () => {
    const app = createShareApp({
      storage: new MemoryStorage(),
      fetchUpstream: redirects({ [SHORT]: PLACE }).fetch,
    });
    let last = 200;
    for (let i = 0; i < 21; i++) last = (await request(app, SHORT)).status;
    expect(last).toBe(429);
  });
});

/** Bearer credentials must never cross an explicitly insecure share transport. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markerAt } from "@placemarks/domain";
import { expect, test, vi } from "vitest";
import { DexieRepository } from "../data/repo";

test("Bearer credentials cannot be sent to a non-TLS share-service URL", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "placemarks-share-tls-build-"));
  try {
    const result = spawnSync(
      "pnpm",
      ["exec", "vite", "build", "--emptyOutDir", "--outDir", outDir],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_ENV: "production",
          VITE_MAP_STYLE_URL: "https://tiles.example/style.json",
          VITE_PHOTON_URL: "https://photon.example",
          VITE_OSM_API_URL: "https://osm.example",
          VITE_OVERPASS_URL: "https://overpass.example",
          VITE_SHARE_API_URL: "http://share.example",
        },
      },
    );
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");

    if (result.status !== 0) {
      expect(output).toMatch(/share.*(?:https|tls|secure)|(?:https|tls|secure).*share/i);
      return;
    }

    // Runtime validation is also compliant: a deployment may build one
    // environment-neutral bundle, provided mutation code refuses to put the
    // private Bearer credential onto an insecure transport.
    vi.resetModules();
    vi.doMock("../config", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../config")>()),
      SHARE_API_URL: "http://share.example",
    }));
    const { publishList } = await import("../features/publish/publication");
    const repo = new DexieRepository(`phase5-insecure-share-${crypto.randomUUID()}`);
    const fetcher = vi.fn<typeof fetch>(async () => new Response("unavailable", { status: 503 }));
    try {
      const now = "2026-07-19T12:00:00.000Z";
      await repo.createList({
        id: "list-1",
        name: "Private token",
        marker: markerAt(0),
        createdAt: now,
        updatedAt: now,
      });
      await repo.addToList(
        "list-1",
        { kind: "manual", facts: { name: "Pin", lat: 51.5, lng: -0.12 } },
        now,
      );

      await publishList(repo, "list-1", now, fetcher).catch(() => undefined);

      const insecureBearerCalls = fetcher.mock.calls.filter(([input, init]) => {
        const url = new URL(String(input), "http://share.example");
        const authorization = new Headers(init?.headers).get("authorization");
        return url.protocol === "http:" && /^Bearer\s+/i.test(authorization ?? "");
      });
      expect(insecureBearerCalls).toHaveLength(0);
    } finally {
      repo.db.close();
      vi.doUnmock("../config");
      vi.resetModules();
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}, 30_000);

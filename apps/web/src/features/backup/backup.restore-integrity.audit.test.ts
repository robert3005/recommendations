/** Regression coverage for revised-spec restore and sync integrity. */
import { markerAt, type ResolvedPoi } from "@placemarks/domain";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { DexieRepository } from "../../data/repo";
import { exportBackup, importBackup } from "./backup";

const NOW = "2026-07-20T09:00:00.000Z";
const LATER = "2026-07-20T10:00:00.000Z";
const LATEST = "2026-07-20T11:00:00.000Z";

type MutableRow = { id: string; [key: string]: unknown };
type MutableData = Record<string, MutableRow[]>;

function repo(label: string): DexieRepository {
  return new DexieRepository(`${label}-${crypto.randomUUID()}`, {
    actorId: `${label}-${crypto.randomUUID()}`,
  });
}

function poi(osmId: string, name: string): ResolvedPoi {
  return {
    osmRef: { type: "node", id: osmId },
    name,
    category: "cafe",
    lat: 38.7139,
    lng: -9.1394,
    identityTags: { name, amenity: "cafe" },
    resolvedAt: NOW,
  };
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") return new Uint8Array(await blob.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function rewrite(archive: Blob, mutate: (data: MutableData) => void): Promise<Blob> {
  const entries = unzipSync(await bytesOf(archive));
  const dataBytes = entries["data.json"];
  const manifestBytes = entries["manifest.json"];
  if (!dataBytes || !manifestBytes) throw new Error("bad backup fixture");
  const data = JSON.parse(strFromU8(dataBytes)) as MutableData;
  const manifest = JSON.parse(strFromU8(manifestBytes)) as {
    checksums: Record<string, string>;
    counts: Record<string, number>;
  };
  mutate(data);
  const rewritten = strToU8(JSON.stringify(data));
  entries["data.json"] = rewritten;
  manifest.checksums["data.json"] = await sha256Hex(rewritten);
  manifest.counts = Object.fromEntries(
    Object.entries(data).map(([table, rows]) => [table, rows.length]),
  );
  entries["manifest.json"] = strToU8(JSON.stringify(manifest));
  const zipped = zipSync(entries);
  return new Blob([zipped.slice().buffer as ArrayBuffer], { type: "application/zip" });
}

async function seed(
  target: DexieRepository,
  ids: { list: string; placeOsm: string; post?: string; note?: string },
) {
  await target.createList({
    id: ids.list,
    name: ids.list,
    marker: markerAt(ids.list === "old-list" ? 0 : 1),
    createdAt: NOW,
    updatedAt: NOW,
  });
  const place = (
    await target.addToList(ids.list, { kind: "poi", poi: poi(ids.placeOsm, ids.list) }, NOW)
  ).place;
  let postBlockId: string | undefined;
  if (ids.post) {
    await target.createPost({
      id: ids.post,
      title: ids.post,
      listId: ids.list,
      createdAt: NOW,
      updatedAt: NOW,
    });
    postBlockId = (await target.embedPlaceInPost(ids.post, place.id, NOW)).id;
  }
  if (ids.note) {
    await target.createNote({
      id: ids.note,
      target: { kind: "place", placeId: place.id },
      body: `${ids.note} body`,
      shareable: true,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
  return { placeId: place.id, postBlockId };
}

describe("backup derived indexes", () => {
  it("recomputes every query-only index instead of trusting archive fields", async () => {
    const source = repo("derived-source");
    const target = repo("derived-target");
    try {
      const { placeId } = await seed(source, {
        list: "old-list",
        placeOsm: "101",
        post: "post-1",
        note: "note-1",
      });
      await source.assignTag(placeId, "Coffee Shops", NOW);
      const forged = await rewrite(await exportBackup(source, NOW), (data) => {
        const tag = data.tags?.[0];
        const note = data.notes?.[0];
        const membership = data.listBlocks?.find((row) => row.content !== undefined);
        const embed = data.postBlocks?.find(
          (row) => (row.content as { type?: string } | undefined)?.type === "place",
        );
        if (!tag || !note || !membership || !embed) throw new Error("fixture missing");
        tag.nameNorm = "forged-tag-key";
        note.targetKey = "post:forged-target";
        membership.kind = "section";
        membership.refId = "forged-membership-target";
        embed.kind = "section";
        embed.refId = "forged-embed-target";
      });

      await importBackup(target, forged, "replace", LATER);

      await expect(target.db.tags.toArray()).resolves.toEqual([
        expect.objectContaining({ name: "Coffee Shops", nameNorm: "coffee shops" }),
      ]);
      await expect(target.db.notes.get("note-1")).resolves.toMatchObject({
        target: { kind: "place", placeId },
        targetKey: `place:${placeId}`,
      });
      await expect(target.db.listBlocks.toArray()).resolves.toEqual([
        expect.objectContaining({
          kind: "place",
          refId: placeId,
          content: { type: "place", placeId },
        }),
      ]);
      await expect(target.db.postBlocks.toArray()).resolves.toEqual([
        expect.objectContaining({
          kind: "place",
          refId: placeId,
          content: { type: "place", placeId },
        }),
      ]);
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("rejects an unlinked place whose canonical manual fallback is missing", async () => {
    const source = repo("shape-source");
    const target = repo("shape-target");
    try {
      await source.createList({
        id: "old-list",
        name: "Pins",
        marker: markerAt(0),
        createdAt: NOW,
        updatedAt: NOW,
      });
      await source.addToList(
        "old-list",
        { kind: "manual", facts: { name: "Manual pin", lat: 38.7, lng: -9.1 } },
        NOW,
      );
      const malformed = await rewrite(await exportBackup(source, NOW), (data) => {
        const place = data.places?.[0];
        if (!place) throw new Error("place fixture missing");
        delete place.manual;
      });

      await expect(importBackup(target, malformed, "replace", LATER)).rejects.toThrow(
        /unlinked.*manual facts/i,
      );
      expect(await target.listPlaces()).toEqual([]);
    } finally {
      source.db.close();
      target.db.close();
    }
  });
});

describe("backup place identity merge", () => {
  it("rejects an archive that changes a PlaceId's immutable origin", async () => {
    const source = repo("immutable-source");
    const target = repo("immutable-target");
    try {
      await seed(source, { list: "old-list", placeOsm: "151" });
      const baseline = await exportBackup(source, NOW);
      await importBackup(target, baseline, "replace", NOW);
      const changed = await rewrite(baseline, (data) => {
        const place = data.places?.[0];
        if (!place) throw new Error("place fixture missing");
        place.origin = "manual";
      });

      await expect(importBackup(target, changed, "merge", LATER)).rejects.toThrow(
        /immutable origin/i,
      );
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("unions append-only history from an older row without rolling back immutable evidence", async () => {
    const source = repo("history-source");
    const target = repo("history-target");
    try {
      await seed(source, { list: "old-list", placeOsm: "161" });
      const baseline = await exportBackup(source, NOW);
      await importBackup(target, baseline, "replace", NOW);
      const local = (await target.db.places.toArray())[0];
      if (!local?.firstSeen) throw new Error("place fixture missing");
      await target.updatePlace({ ...local, updatedAt: LATEST });
      const incoming = await rewrite(baseline, (data) => {
        const place = data.places?.[0];
        if (!place) throw new Error("place fixture missing");
        place.firstSeen = { ...(place.firstSeen as Record<string, unknown>), name: "forged first" };
        place.osmRefHistory = [
          {
            ref: { type: "way", id: "9001" },
            linkedAt: "2026-07-19T08:00:00.000Z",
            unlinkedAt: "2026-07-19T09:00:00.000Z",
            reason: "replaced",
          },
        ];
      });

      await importBackup(target, incoming, "merge", LATER);

      const merged = (await target.db.places.toArray())[0];
      expect(merged?.firstSeen).toEqual(local.firstSeen);
      expect(merged?.osmRefHistory).toEqual(
        expect.arrayContaining([expect.objectContaining({ ref: { type: "way", id: "9001" } })]),
      );
      expect(merged?.updatedAt).toBe(LATEST);
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("surfaces two non-causal current bindings for one PlaceId as needs-review", async () => {
    const source = repo("relink-source");
    const target = repo("relink-target");
    try {
      await seed(source, { list: "old-list", placeOsm: "181" });
      const baseline = await exportBackup(source, NOW);
      await importBackup(target, baseline, "replace", NOW);
      const local = (await target.db.places.toArray())[0];
      if (!local) throw new Error("place fixture missing");
      const sharedHistory = {
        ref: { type: "relation" as const, id: "189" },
        linkedAt: "2026-07-18T08:00:00.000Z",
        unlinkedAt: "2026-07-18T09:00:00.000Z",
        reason: "replaced" as const,
      };
      await target.db.places.put({
        ...local,
        osmRefHistory: [sharedHistory],
        refKeys: ["node/181", "relation/189"],
        updatedAt: LATER,
      });
      const conflicting = await rewrite(baseline, (data) => {
        const place = data.places?.[0];
        if (!place) throw new Error("place fixture missing");
        place.currentOsmRef = { type: "way", id: "182" };
        place.currentOsmLinkedAt = LATEST;
        place.osmRefHistory = [sharedHistory];
        place.lastVerified = {
          ...(place.lastVerified as Record<string, unknown>),
          ref: { type: "way", id: "182" },
          observedAt: LATEST,
        };
        place.updatedAt = LATEST;
      });

      await importBackup(target, conflicting, "merge", LATEST);

      await expect(target.db.places.get(local.id)).resolves.toMatchObject({
        currentOsmRef: { type: "way", id: "182" },
        resolutionState: "needs-review",
      });
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("coalesces a transitive exact-reference bridge independent of archive order", async () => {
    const local = repo("bridge-local");
    const incoming = repo("bridge-incoming");
    try {
      const retained = await seed(local, { list: "old-list", placeOsm: "171" });
      await incoming.createList({
        id: "bridge-list-a",
        name: "Bridge A",
        marker: markerAt(1),
        createdAt: NOW,
        updatedAt: NOW,
      });
      await incoming.createList({
        id: "bridge-list-b",
        name: "Bridge B",
        marker: markerAt(2),
        createdAt: NOW,
        updatedAt: NOW,
      });
      const bridge = (
        await incoming.addToList("bridge-list-a", { kind: "poi", poi: poi("171", "Bridge") }, NOW)
      ).place;
      await incoming.db.places.put({
        ...bridge,
        osmRefHistory: [
          {
            ref: { type: "way", id: "172" },
            linkedAt: "2026-07-19T08:00:00.000Z",
            unlinkedAt: "2026-07-19T09:00:00.000Z",
            reason: "replaced",
          },
        ],
        refKeys: ["node/171", "way/172"],
        updatedAt: LATER,
      });
      const endpoint = (
        await incoming.addToList(
          "bridge-list-b",
          {
            kind: "poi",
            poi: { ...poi("172", "Endpoint"), osmRef: { type: "way", id: "172" } },
          },
          NOW,
        )
      ).place;
      expect((await incoming.db.places.get(bridge.id))?.refKeys).toEqual(["node/171", "way/172"]);

      await importBackup(local, await exportBackup(incoming, LATER), "merge", LATEST);

      expect(await local.db.places.get(bridge.id)).toBeUndefined();
      expect(await local.db.places.get(endpoint.id)).toBeUndefined();
      expect((await local.listPlaces()).map(({ place }) => place.id)).toEqual([retained.placeId]);
      await expect(local.db.places.get(retained.placeId)).resolves.toMatchObject({
        osmRefHistory: expect.arrayContaining([
          expect.objectContaining({ ref: { type: "way", id: "172" } }),
        ]),
      });
      expect((await local.getListBlocks("bridge-list-a"))[0]?.place?.id).toBe(retained.placeId);
      expect((await local.getListBlocks("bridge-list-b"))[0]?.place?.id).toBe(retained.placeId);
    } finally {
      local.db.close();
      incoming.db.close();
    }
  });
});

describe("backup merge planning", () => {
  it("commits a replacement edge even when it precedes the old edge's tombstone in the archive", async () => {
    const source = repo("edge-order-source");
    const target = repo("edge-order-target");
    try {
      await seed(source, { list: "old-list", placeOsm: "201" });
      const baseline = await exportBackup(source, NOW);
      await importBackup(target, baseline, "replace", NOW);
      const replacement = await rewrite(baseline, (data) => {
        const old = data.listBlocks?.[0];
        if (!old) throw new Error("membership fixture missing");
        const next = { ...old, id: "replacement-membership", updatedAt: LATER };
        old.deleted = true;
        old.updatedAt = LATER;
        // Deliberately adversarial order: replacement before the edge it replaces.
        data.listBlocks = [next, old];
      });

      await importBackup(target, replacement, "merge", LATEST);

      expect((await target.getListBlocks("old-list")).map(({ block }) => block.id)).toEqual([
        "replacement-membership",
      ]);
      expect((await target.db.listBlocks.toArray()).filter((row) => !row.deleted)).toHaveLength(1);
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("keeps skipped-id remapping scoped to post blocks", async () => {
    const source = repo("table-id-source");
    const target = repo("table-id-target");
    try {
      const { placeId } = await seed(source, { list: "old-list", placeOsm: "301" });
      const baseline = await exportBackup(source, NOW);
      await importBackup(target, baseline, "replace", NOW);
      const archive = await rewrite(baseline, (data) => {
        const membership = data.listBlocks?.[0];
        if (!membership) throw new Error("membership fixture missing");
        data.listBlocks?.push({ ...membership, id: "same-id", updatedAt: LATER });
        data.posts?.push({
          id: "post-1",
          title: "Post",
          listId: "old-list",
          createdAt: LATER,
          updatedAt: LATER,
        });
        data.postBlocks?.push({
          id: "same-id",
          postId: "post-1",
          rank: "a",
          kind: "place",
          refId: placeId,
          content: { type: "place", placeId },
          createdAt: LATER,
          updatedAt: LATER,
        });
        data.notes?.push({
          id: "attached-note",
          target: { kind: "place", placeId },
          targetKey: `place:${placeId}`,
          body: "publishable",
          shareable: true,
          createdAt: LATER,
          updatedAt: LATER,
        });
        data.blockNoteAttachments?.push({
          id: "attachment-1",
          blockId: "same-id",
          noteId: "attached-note",
          rank: "a",
          createdAt: LATER,
          updatedAt: LATER,
        });
      });

      await importBackup(target, archive, "merge", LATEST);

      await expect(target.db.postBlocks.get("same-id")).resolves.toMatchObject({
        postId: "post-1",
        refId: placeId,
      });
      await expect(target.db.blockNoteAttachments.get("attachment-1")).resolves.toMatchObject({
        blockId: "same-id",
        noteId: "attached-note",
      });
    } finally {
      source.db.close();
      target.db.close();
    }
  });
});

describe("replace restore sync convergence", () => {
  it("rebuilds the outbox and sends tombstones for every omitted old row", async () => {
    const oldSource = repo("replace-old-source");
    const newSource = repo("replace-new-source");
    const replacingDevice = repo("replace-device");
    const peer = repo("replace-peer");
    try {
      const old = await seed(oldSource, {
        list: "old-list",
        placeOsm: "401",
        note: "old-note",
      });
      const oldArchive = await exportBackup(oldSource, NOW);
      await importBackup(replacingDevice, oldArchive, "replace", NOW);
      await importBackup(peer, oldArchive, "replace", NOW);
      await replacingDevice.db.publications.put({
        id: "old-publication",
        target: { kind: "list", id: "old-list" },
        slug: "old-list",
        status: "published",
        localRevision: "old-revision",
        createdAt: NOW,
        updatedAt: NOW,
      });
      await replacingDevice.db.publicationOutbox.put({
        id: "stale-publish-job",
        publicationId: "old-publication",
        action: "publish",
        localRevision: "old-revision",
        payload: "stale public document",
        createdAt: NOW,
        attempts: 0,
      });
      const staleMutationIds = new Set(
        (await replacingDevice.db.mutationOutbox.toArray()).map((m) => m.id),
      );

      const fresh = await seed(newSource, {
        list: "new-list",
        placeOsm: "402",
        note: "new-note",
      });
      await importBackup(replacingDevice, await exportBackup(newSource, LATER), "replace", LATER);

      const mutations = await replacingDevice.db.mutationOutbox.orderBy("createdAt").toArray();
      expect(mutations.some((mutation) => staleMutationIds.has(mutation.id))).toBe(false);
      expect(mutations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            table: "places",
            entityId: old.placeId,
            row: expect.objectContaining({ deleted: true }),
          }),
          expect.objectContaining({
            table: "lists",
            entityId: "old-list",
            row: expect.objectContaining({ deleted: true }),
          }),
          expect.objectContaining({ table: "places", entityId: fresh.placeId }),
          expect.objectContaining({ table: "lists", entityId: "new-list" }),
        ]),
      );
      const entityRevisions = (await replacingDevice.db.syncRevs.toArray()).filter(
        (revision) => revision.key !== "__device_clock__",
      );
      expect(entityRevisions).toHaveLength(mutations.length);
      await expect(replacingDevice.db.publications.get("old-publication")).resolves.toMatchObject({
        status: "revoking",
      });
      const publicationJobs = await replacingDevice.db.publicationOutbox.toArray();
      expect(publicationJobs).toEqual([
        expect.objectContaining({ publicationId: "old-publication", action: "revoke" }),
      ]);

      await peer.applyRemoteChanges(
        mutations.map((mutation) => ({
          table: mutation.table as never,
          entityId: mutation.entityId,
          hlc: mutation.hlc,
          actorId: mutation.actorId,
          row: mutation.row,
        })),
      );
      expect((await peer.listLists()).map((list) => list.id)).toEqual(["new-list"]);
      expect((await peer.listPlaces()).map(({ place }) => place.id)).toEqual([fresh.placeId]);
      await expect(peer.db.places.get(old.placeId)).resolves.toMatchObject({ deleted: true });
    } finally {
      oldSource.db.close();
      newSource.db.close();
      replacingDevice.db.close();
      peer.db.close();
    }
  });
});

describe("backup note conflict privacy", () => {
  it("forces recoverable conflict copies private", async () => {
    const source = repo("private-copy-source");
    const target = repo("private-copy-target");
    try {
      const { placeId } = await seed(source, {
        list: "old-list",
        placeOsm: "501",
        note: "note-1",
      });
      const baseline = await exportBackup(source, NOW);
      await importBackup(target, baseline, "replace", NOW);
      const local = await target.db.notes.get("note-1");
      if (!local) throw new Error("note fixture missing");
      await target.updateNote({ ...local, body: "local body", updatedAt: LATER });
      const remote = await source.db.notes.get("note-1");
      if (!remote) throw new Error("note fixture missing");
      await source.updateNote({ ...remote, body: "incoming body", updatedAt: LATEST });

      const result = await importBackup(
        target,
        await exportBackup(source, LATEST),
        "merge",
        LATEST,
      );

      expect(result.conflictCopies).toBe(1);
      const copies = (await target.listNotesForPlace(placeId)).filter((note) =>
        note.title?.startsWith("(conflict copy)"),
      );
      expect(copies).toHaveLength(1);
      expect(copies[0]).toMatchObject({ body: "local body", shareable: false });
    } finally {
      source.db.close();
      target.db.close();
    }
  });
});

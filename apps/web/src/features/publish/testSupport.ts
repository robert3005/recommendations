/**
 * A seeded in-memory PublishRepo for publish-flow tests. Publishing is tested
 * against the REAL share-service protocol via MSW (src/mocks/handlers.ts); the
 * stub stands in only for the local repository contract (src/data/repo.ts).
 */
import {
  compareByRank,
  type List,
  type ListEntry,
  type OsmRef,
  type Place,
  type Post,
  type PostTarget,
  type Publication,
  postTargetKey,
  publicationTargetKey,
} from "@placemarks/domain";
import { newId } from "../../lib/id";
import type { PublishRepo } from "./publication";

export const NOW = "2026-07-26T12:00:00.000Z";

export interface SeedPlace {
  id?: string;
  name: string;
  lat: number;
  lng: number;
  address?: string;
  category?: string;
  osmRef?: OsmRef;
}

export class StubRepo implements PublishRepo {
  lists = new Map<string, List>();
  places = new Map<string, Place>();
  entries: ListEntry[] = [];
  posts = new Map<string, Post>();
  publications: Publication[] = [];

  seedList(name: string, seedPlaces: SeedPlace[]): List {
    const list: List = {
      id: newId(),
      name,
      marker: { shape: "circle", color: "#F97316" },
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.lists.set(list.id, list);
    seedPlaces.forEach((seed, index) => {
      const place: Place = {
        id: seed.id ?? newId(),
        name: seed.name,
        lat: seed.lat,
        lng: seed.lng,
        ...(seed.address !== undefined ? { address: seed.address } : {}),
        ...(seed.category !== undefined ? { category: seed.category } : {}),
        ...(seed.osmRef !== undefined ? { osmRef: seed.osmRef } : {}),
        origin: "search",
        createdAt: NOW,
        updatedAt: NOW,
      };
      this.places.set(place.id, place);
      this.entries.push({
        id: newId(),
        listId: list.id,
        placeId: place.id,
        rank: `r${index.toString().padStart(4, "0")}`,
        createdAt: NOW,
        updatedAt: NOW,
      });
    });
    return list;
  }

  seedPost(target: PostTarget, title: string, body = ""): Post {
    const post: Post = { id: newId(), target, title, body, createdAt: NOW, updatedAt: NOW };
    this.posts.set(post.id, post);
    return post;
  }

  async getList(id: string): Promise<List | undefined> {
    return this.lists.get(id);
  }

  async entriesOf(listId: string): Promise<{ entry: ListEntry; place: Place }[]> {
    return this.entries
      .filter((entry) => entry.listId === listId)
      .sort(compareByRank)
      .map((entry) => ({ entry, place: this.places.get(entry.placeId) as Place }));
  }

  async getPlace(id: string): Promise<Place | undefined> {
    return this.places.get(id);
  }

  async getPost(id: string): Promise<Post | undefined> {
    return this.posts.get(id);
  }

  async postsFor(target: PostTarget): Promise<Post[]> {
    const key = postTargetKey(target);
    return [...this.posts.values()].filter((post) => postTargetKey(post.target) === key);
  }

  async publicationFor(target: Publication["target"]): Promise<Publication | undefined> {
    const key = publicationTargetKey(target);
    const rows = this.publications.filter((p) => publicationTargetKey(p.target) === key);
    const row = rows[rows.length - 1];
    // A snapshot, like a real repository read — callers must never share the
    // stored row's identity across mutations.
    return row ? { ...row, target: { ...row.target } } : undefined;
  }

  async createPublication(
    target: Publication["target"],
    slug: string,
    editorToken: string,
    now: string,
  ): Promise<Publication> {
    const row: Publication = {
      id: newId(),
      target,
      slug,
      editorToken,
      createdAt: now,
      updatedAt: now,
    };
    this.publications.push(row);
    return row;
  }

  settings = new Map<string, unknown>();

  async getSetting<T>(key: string): Promise<T | undefined> {
    return this.settings.get(key) as T | undefined;
  }

  async recordPublished(
    id: string,
    lastPublishedHash: string,
    now: string,
    version?: number,
  ): Promise<void> {
    const row = this.publications.find((p) => p.id === id);
    if (!row) throw new Error(`no publication ${id}`);
    row.lastPublishedHash = lastPublishedHash;
    row.version = version ?? (row.version ?? 0) + 1;
    row.publishedAt = now;
    row.updatedAt = now;
  }

  async markRevoked(id: string, now: string): Promise<void> {
    const row = this.publications.find((p) => p.id === id);
    if (!row) throw new Error(`no publication ${id}`);
    row.revokedAt = now;
    row.updatedAt = now;
  }

  async livePublications(): Promise<Publication[]> {
    return this.publications.filter((p) => !p.revokedAt);
  }
}

/** Read a hosted document straight off the (MSW) share service. */
export async function getHosted(kind: "lists" | "posts", slug: string): Promise<Response> {
  return fetch(new URL(`/s/${kind}/${slug}`, window.location.href));
}

/** Claim a slug directly, as a rival client would. */
export async function putHosted(
  kind: "lists" | "posts",
  slug: string,
  doc: unknown,
  token: string,
): Promise<Response> {
  return fetch(new URL(`/s/${kind}/${slug}`, window.location.href), {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(doc),
  });
}

export function minimalListDoc(title: string): unknown {
  return {
    v: 1,
    kind: "list",
    title,
    marker: { shape: "circle", color: "#F97316" },
    places: [],
  };
}

/**
 * Additional Phase 3 export checks derived from the current
 * book/src/interop.md CSV portability contract.
 */
import type { List, Note, Place } from "@placemarks/domain";
import Papa from "papaparse";
import { describe, expect, it } from "vitest";
import { exportListCsv } from "./export";

const NOW = "2026-07-19T12:00:00.000Z";
const list: List = { id: "list", name: "Formula audit", createdAt: NOW, updatedAt: NOW };

function exportPayload(payload: string): Record<string, string> | undefined {
  const place: Place = {
    id: "place",
    origin: "import",
    osmRefHistory: [],
    manual: { name: payload, lat: 51.5, lng: -0.12, address: payload },
    resolutionState: "unlinked",
    createdAt: NOW,
    updatedAt: NOW,
  };
  const note: Note = {
    id: "note",
    target: { kind: "place", placeId: place.id },
    body: payload,
    mediaIds: [],
    shareable: false,
    createdAt: NOW,
    updatedAt: NOW,
  };

  const csv = exportListCsv(list, [{ place, notes: [note] }]);
  return Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true }).data[0];
}

describe("Phase 3 CSV export hardening", () => {
  it.each(["\t=1+1", "\r=1+1", " =1+1"])(
    "formula-escapes a spreadsheet-trimmable prefix in every user-authored column: %j",
    (payload) => {
      const row = exportPayload(payload);

      expect.soft(row?.Title).toBe(`'${payload}`);
      expect.soft(row?.Note).toBe(`'${payload}`);
      expect.soft(row?.Address).toBe(`'${payload}`);
    },
  );
});

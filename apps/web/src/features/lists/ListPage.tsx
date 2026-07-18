/**
 * A list: an ordered group of places with an owner-written description
 * (book/src/vision.md — lists first; narrative guide enrichment comes later).
 */
import { displayFacts } from "@placemarks/domain";
import { useParams } from "@tanstack/react-router";
import { useState } from "react";
import { useGuide, useGuideBlocks, useSavedPlaceViews } from "../../data/hooks";
import { useRepo } from "../../data/RepoContext";
import { nowIso } from "../../lib/time";
import { StateBadge } from "../place/StateBadge";

export function ListPage() {
  const { listId } = useParams({ from: "/lists/$listId" });
  const repo = useRepo();
  const list = useGuide(listId);
  const blocks = useGuideBlocks(listId);
  const savedViews = useSavedPlaceViews();
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState("");

  if (!list) return <div className="p-4 text-stone-500">List not found.</div>;

  // Lists lead with places; narrative section blocks are a later enrichment.
  const placeBlocks = (blocks ?? []).filter((v) => v.block.content.type === "place");
  const inList = new Set(
    placeBlocks.map((v) => (v.block.content.type === "place" ? v.block.content.savedPlaceId : "")),
  );
  const addable = (savedViews ?? []).filter((v) => !inList.has(v.savedPlace.id));

  const move = (index: number, direction: -1 | 1) => {
    const target = placeBlocks[index];
    if (!target) return;
    const swapWith = index + direction;
    if (swapWith < 0 || swapWith >= placeBlocks.length) return;
    const before =
      direction === -1
        ? placeBlocks[swapWith]?.block.id
        : (placeBlocks[swapWith + 1]?.block.id ?? null);
    void repo.moveBlock(target.block.id, before ?? null, nowIso());
  };

  return (
    <div className="mx-auto max-w-2xl p-4" data-testid="list-page">
      <h1 className="text-xl font-semibold text-stone-900">{list.name}</h1>

      {editingDescription ? (
        <div className="mt-2">
          <textarea
            value={descriptionDraft}
            onChange={(e) => setDescriptionDraft(e.target.value)}
            aria-label="List description"
            placeholder="What ties these places together?"
            rows={2}
            className="w-full rounded border border-stone-200 p-2 text-sm"
            data-testid="description-input"
          />
          <div className="mt-1 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditingDescription(false)}
              className="rounded px-2 py-0.5 text-xs text-stone-600"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                const description = descriptionDraft.trim();
                void repo.updateList({
                  ...list,
                  ...(description ? { description } : {}),
                  updatedAt: nowIso(),
                });
                setEditingDescription(false);
              }}
              className="rounded bg-stone-800 px-2 py-0.5 text-xs font-medium text-white"
              data-testid="save-description"
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-1 flex items-baseline gap-2">
          {list.description ? (
            <p className="text-sm text-stone-600" data-testid="list-description">
              {list.description}
            </p>
          ) : (
            <p className="text-sm text-stone-400">No description yet.</p>
          )}
          <button
            type="button"
            onClick={() => {
              setDescriptionDraft(list.description ?? "");
              setEditingDescription(true);
            }}
            className="shrink-0 text-[11px] text-stone-500 underline hover:text-stone-800"
            data-testid="edit-description"
          >
            {list.description ? "Edit" : "Add description"}
          </button>
        </div>
      )}

      <ul className="mt-4 space-y-2">
        {placeBlocks.map((view, index) => {
          const facts = view.place ? displayFacts(view.place) : undefined;
          return (
            <li
              key={view.block.id}
              className="rounded-lg border border-stone-200 bg-stone-50 p-3"
              data-testid="place-item"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <span className="font-medium text-stone-900">
                    {facts?.name ?? "Missing place"}
                  </span>
                  {facts?.category ? (
                    <span className="ml-2 text-xs capitalize text-stone-500">{facts.category}</span>
                  ) : null}
                  {view.place ? (
                    <span className="ml-2">
                      <StateBadge state={view.place.resolutionState} />
                    </span>
                  ) : null}
                  {facts?.website ? (
                    <a
                      href={facts.website}
                      target="_blank"
                      rel="noopener noreferrer nofollow ugc"
                      className="block text-sm text-blue-700 underline"
                    >
                      {facts.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                    </a>
                  ) : null}
                </div>
                <span className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    aria-label="Move up"
                    onClick={() => move(index, -1)}
                    className="rounded px-1.5 text-xs text-stone-500 hover:bg-stone-200"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label="Move down"
                    onClick={() => move(index, 1)}
                    className="rounded px-1.5 text-xs text-stone-500 hover:bg-stone-200"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    aria-label="Remove from list"
                    onClick={() => void repo.removeBlock(view.block.id, nowIso())}
                    className="rounded px-1.5 text-xs text-red-600 hover:bg-red-50"
                  >
                    ✕
                  </button>
                </span>
              </div>
            </li>
          );
        })}
        {blocks !== undefined && placeBlocks.length === 0 ? (
          <li className="py-4 text-sm text-stone-500">
            Empty list. Add saved places below — save them from the map first.
          </li>
        ) : null}
      </ul>

      {addable.length > 0 ? (
        <select
          aria-label="Add saved place"
          className="mt-3 w-full rounded border border-stone-200 px-2 py-1 text-sm"
          value=""
          onChange={(e) => {
            if (e.target.value) void repo.addPlaceBlock(listId, e.target.value, nowIso());
          }}
        >
          <option value="">Add saved place…</option>
          {addable.map((v) => {
            const facts = displayFacts(v.place);
            return (
              <option key={v.savedPlace.id} value={v.savedPlace.id}>
                {facts?.name ?? "Unnamed"}
              </option>
            );
          })}
        </select>
      ) : null}
    </div>
  );
}

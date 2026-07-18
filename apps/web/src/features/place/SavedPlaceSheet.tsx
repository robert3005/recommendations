/**
 * Saved-place detail: durable facts with honest state labeling, tags, Markdown
 * notes, guide membership, and the conservative refresh/repair flows
 * (book/src/place-identity.md).
 */
import {
  applyExactOutcome,
  applyRecovery,
  displayFacts,
  linkPlaceToOsm,
  type Note,
  type Place,
  recoveryEvidence,
  type ResolvedPoi,
  type SavedPlaceView,
  scoreCandidate,
} from "@placemarks/domain";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useRepo } from "../../data/RepoContext";
import { useLists, useNotesForPlace, useSavedPlaceView } from "../../data/hooks";
import { newId } from "../../lib/id";
import { nowIso } from "../../lib/time";
import { Markdown } from "../../markdown/Markdown";
import { poiResolver } from "../../providers";
import { useUiStore } from "../../state/ui";
import { NoteEditor } from "../notes/NoteEditor";
import { CandidatePicker } from "../picker/CandidatePicker";
import { OsmActions } from "./OsmActions";
import { PlaceFields } from "./PlaceFields";
import { TagEditor } from "./TagEditor";

function ReviewPanel({ place, onDone }: { place: Place; onDone: (updated: Place) => void }) {
  const repo = useRepo();
  const evidence = recoveryEvidence(place);
  const [candidates, setCandidates] = useState<ResolvedPoi[]>();
  const searchMutation = useMutation({
    mutationFn: async () => {
      if (!evidence) return [];
      return poiResolver.searchNearby({ lat: evidence.lat, lng: evidence.lng, radiusM: 250 });
    },
    onSuccess: setCandidates,
  });

  const confirm = async (candidate: ResolvedPoi) => {
    const updated = linkPlaceToOsm(place, candidate, nowIso(), "owner-confirmed");
    await repo.updatePlace(updated);
    onDone(updated);
  };

  return (
    <div className="mt-3 rounded-lg border border-violet-200 bg-violet-50 p-3" data-testid="review-panel">
      <p className="text-sm font-medium text-violet-900">
        This place's OSM link changed ambiguously. Pick the right record:
      </p>
      {candidates === undefined ? (
        <button
          type="button"
          onClick={() => searchMutation.mutate()}
          disabled={searchMutation.isPending}
          className="mt-2 rounded bg-violet-700 px-3 py-1 text-sm font-medium text-white"
        >
          {searchMutation.isPending ? "Searching…" : "Find candidates"}
        </button>
      ) : candidates.length === 0 ? (
        <p className="mt-2 text-sm text-violet-800">No candidates nearby.</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {candidates.map((candidate) => {
            const scored = evidence ? scoreCandidate(evidence, candidate) : undefined;
            return (
              <li key={`${candidate.osmRef.type}/${candidate.osmRef.id}`}>
                <button
                  type="button"
                  onClick={() => void confirm(candidate)}
                  className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm hover:bg-violet-100"
                >
                  <span>
                    {candidate.name ?? "Unnamed"}{" "}
                    <span className="text-xs text-violet-700">({candidate.category})</span>
                  </span>
                  {scored ? (
                    <span className="text-xs text-violet-600">match {scored.score}</span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function SavedPlaceSheet({ savedPlaceId }: { savedPlaceId: string }) {
  const repo = useRepo();
  const clearSelection = useUiStore((s) => s.clearSelection);
  const view = useSavedPlaceView(savedPlaceId);
  const notes = useNotesForPlace(view?.place.id);
  const lists = useLists();
  const [editingNote, setEditingNote] = useState<Note>();
  const [linking, setLinking] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState<string>();

  const refreshMutation = useMutation({
    mutationFn: async (current: SavedPlaceView) => {
      const now = nowIso();
      if (!current.place.currentOsmRef) return "This pin isn't linked to OSM.";
      const outcome = await poiResolver.resolveExact(current.place.currentOsmRef);
      const result = applyExactOutcome(current.place, outcome, now);
      if (result.kind === "updated") {
        await repo.updatePlace(result.place);
        return result.place.resolutionState === "resolved"
          ? "Up to date with OpenStreetMap."
          : result.place.resolutionState === "unavailable"
            ? "OSM unreachable — kept saved data."
            : "The link changed — review needed.";
      }
      // Definitive disappearance: conservative evidence-based recovery.
      const evidence = recoveryEvidence(current.place);
      const candidates = evidence
        ? await poiResolver.searchNearby({ lat: evidence.lat, lng: evidence.lng, radiusM: 250 })
        : [];
      const recovered = applyRecovery(result.place, candidates, nowIso());
      await repo.updatePlace(recovered);
      return recovered.resolutionState === "resolved"
        ? "The OSM element was replaced — relinked automatically."
        : recovered.resolutionState === "needs-review"
          ? "The OSM element is gone; several possible replacements need your review."
          : "The OSM element is gone and no replacement was found.";
    },
    onSuccess: setRefreshMessage,
  });

  if (!view) return null;
  const facts = displayFacts(view.place);
  const now = nowIso();

  return (
    <section
      role="dialog"
      aria-label={facts?.name ?? "Saved place"}
      className="absolute inset-x-0 bottom-0 z-20 max-h-[70%] overflow-y-auto rounded-t-2xl border border-stone-200 bg-white p-4 shadow-xl md:inset-x-auto md:right-4 md:bottom-4 md:w-96 md:rounded-2xl"
      data-testid="saved-place-sheet"
    >
      <button
        type="button"
        onClick={clearSelection}
        aria-label="Close"
        className="absolute top-2 right-3 rounded p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-700"
      >
        ✕
      </button>
      {facts ? (
        <PlaceFields
          {...(facts.name ? { name: facts.name } : {})}
          {...(facts.category ? { category: facts.category } : {})}
          {...(facts.address ? { address: facts.address } : {})}
          {...(facts.website ? { website: facts.website } : {})}
          {...(facts.phone ? { phone: facts.phone } : {})}
          {...(facts.openingHours ? { openingHours: facts.openingHours } : {})}
          source={facts.source}
          {...(facts.observedAt ? { observedAt: facts.observedAt } : {})}
          state={view.place.resolutionState}
        />
      ) : null}

      {view.place.resolutionState === "needs-review" ? (
        <ReviewPanel place={view.place} onDone={() => setRefreshMessage("Link confirmed.")} />
      ) : null}

      <div className="mt-3">
        <TagEditor
          tags={view.tags}
          onAdd={(name) => void repo.assignTag(view.savedPlace.id, name, now)}
          onRemove={(tagId) => void repo.removeTagAssignment(view.savedPlace.id, tagId, now)}
        />
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => refreshMutation.mutate(view)}
          disabled={refreshMutation.isPending}
          className="rounded border border-stone-300 px-2 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100"
          data-testid="check-osm-updates"
        >
          {refreshMutation.isPending ? "Checking…" : "Check for OSM updates"}
        </button>
        {view.place.resolutionState === "unlinked" ? (
          <button
            type="button"
            onClick={() => setLinking(true)}
            className="rounded border border-orange-300 px-2 py-1 text-xs font-medium text-orange-800 hover:bg-orange-50"
            data-testid="link-to-osm"
          >
            Link to OpenStreetMap
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => {
            void repo.unsave(view.savedPlace.id, now).then(clearSelection);
          }}
          className="rounded border border-red-200 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
          data-testid="unsave"
        >
          Unsave
        </button>
      </div>
      {refreshMessage ? (
        <p className="mt-2 text-xs text-stone-600" data-testid="refresh-message">
          {refreshMessage}
        </p>
      ) : null}

      {facts ? (
        <OsmActions
          {...(view.place.currentOsmRef ? { osmRef: view.place.currentOsmRef } : {})}
          lat={facts.lat}
          lng={facts.lng}
        />
      ) : null}

      {/* Guides */}
      <div className="mt-4">
        <h3 className="text-xs font-semibold tracking-wide text-stone-500 uppercase">Guides</h3>
        <select
          aria-label="Add to guide"
          className="mt-1 w-full rounded border border-stone-200 px-2 py-1 text-sm"
          value=""
          onChange={(e) => {
            if (e.target.value) {
              void repo
                .addPlaceBlock(e.target.value, view.savedPlace.id, now)
                .catch((err: unknown) => setRefreshMessage(String(err)));
            }
          }}
        >
          <option value="">Add to guide…</option>
          {(lists ?? []).map((list) => (
            <option key={list.id} value={list.id}>
              {list.name}
            </option>
          ))}
        </select>
      </div>

      {/* Notes */}
      <div className="mt-4">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold tracking-wide text-stone-500 uppercase">Notes</h3>
          <button
            type="button"
            onClick={() =>
              setEditingNote({
                id: newId(),
                target: { kind: "place", placeId: view.place.id },
                body: "",
                mediaIds: [],
                shareable: false,
                createdAt: now,
                updatedAt: now,
              })
            }
            className="rounded px-2 py-0.5 text-xs font-medium text-stone-600 hover:bg-stone-100"
            data-testid="add-note"
          >
            + Add note
          </button>
        </div>
        {editingNote ? (
          <div className="mt-2">
            <NoteEditor
              note={editingNote}
              onSave={(note) => {
                void (notes?.some((n) => n.id === note.id)
                  ? repo.updateNote(note)
                  : repo.createNote(note));
                setEditingNote(undefined);
              }}
              onCancel={() => setEditingNote(undefined)}
            />
          </div>
        ) : null}
        <ul className="mt-2 space-y-2">
          {(notes ?? [])
            .filter((n) => n.id !== editingNote?.id)
            .map((note) => (
              <li key={note.id} className="rounded-lg border border-stone-100 bg-stone-50 p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-stone-700">
                    {note.title ?? "Note"}
                    {note.shareable ? (
                      <span className="ml-1 rounded bg-emerald-100 px-1 text-[10px] text-emerald-800">
                        shareable
                      </span>
                    ) : null}
                  </span>
                  <span className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => setEditingNote(note)}
                      className="rounded px-1.5 text-xs text-stone-500 hover:bg-stone-200"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => void repo.deleteNote(note.id, nowIso())}
                      className="rounded px-1.5 text-xs text-red-600 hover:bg-red-50"
                    >
                      Delete
                    </button>
                  </span>
                </div>
                <div className="mt-1">
                  <Markdown body={note.body} />
                </div>
              </li>
            ))}
        </ul>
      </div>

      {linking && view.place.manual ? (
        <CandidatePicker
          lat={view.place.manual.lat}
          lng={view.place.manual.lng}
          onSelect={(candidate) => {
            const linked = linkPlaceToOsm(view.place, candidate, nowIso(), "owner-confirmed");
            void repo.updatePlace(linked);
            setLinking(false);
            setRefreshMessage("Linked to OpenStreetMap.");
          }}
          onClose={() => setLinking(false)}
        />
      ) : null}
    </section>
  );
}

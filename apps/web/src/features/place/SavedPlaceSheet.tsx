/**
 * Saved-place detail: facts, tags, Markdown notes (full-screen editor), and the
 * manual-pin link-to-OSM upgrade. The only OSM affordance is a portal link;
 * freshness/refresh UI is deferred, and list membership is managed from lists
 * (book/src/map-view.md).
 */
import { displayFacts, linkPlaceToOsm, type Note } from "@placemarks/domain";
import { useState } from "react";
import {
  useListIdsForSavedPlace,
  useLists,
  useNotesForPlace,
  useSavedPlaceView,
} from "../../data/hooks";
import { useRepo } from "../../data/RepoContext";
import { newId } from "../../lib/id";
import { nowIso } from "../../lib/time";
import { Markdown } from "../../markdown/Markdown";
import { useUiStore } from "../../state/ui";
import { NoteEditor } from "../notes/NoteEditor";
import { CandidatePicker } from "../picker/CandidatePicker";
import { AddToList } from "./AddToList";
import { OsmLink } from "./OsmLink";
import { PlaceFields } from "./PlaceFields";
import { TagEditor } from "./TagEditor";

export function SavedPlaceSheet({ savedPlaceId }: { savedPlaceId: string }) {
  const repo = useRepo();
  const clearSelection = useUiStore((s) => s.clearSelection);
  const view = useSavedPlaceView(savedPlaceId);
  const notes = useNotesForPlace(view?.place.id);
  const lists = useLists();
  const memberListIds = useListIdsForSavedPlace(view?.savedPlace.id);
  const [editingNote, setEditingNote] = useState<Note>();
  const [linking, setLinking] = useState(false);
  const [message, setMessage] = useState<string>();

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
          state={view.place.resolutionState}
        />
      ) : null}

      <div className="mt-3">
        <TagEditor
          tags={view.tags}
          onAdd={(name) => void repo.assignTag(view.savedPlace.id, name, now)}
          onRemove={(tagId) => void repo.removeTagAssignment(view.savedPlace.id, tagId, now)}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        {view.place.currentOsmRef ? <OsmLink osmRef={view.place.currentOsmRef} /> : null}
        {view.place.resolutionState === "unlinked" ? (
          <button
            type="button"
            onClick={() => setLinking(true)}
            className="text-[11px] font-medium text-orange-800 underline hover:text-orange-900"
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
          className="ml-auto text-[11px] font-medium text-red-700 underline hover:text-red-900"
          data-testid="unsave"
        >
          Unsave
        </button>
      </div>
      {message ? (
        <p className="mt-2 text-xs text-stone-600" data-testid="sheet-message">
          {message}
        </p>
      ) : null}

      {/* Lists: the place card is the only write surface for lists. */}
      <div className="mt-4">
        <h3 className="text-xs font-semibold tracking-wide text-stone-500 uppercase">Lists</h3>
        <AddToList
          lists={lists}
          memberListIds={memberListIds ?? []}
          onPick={(target) => {
            void (async () => {
              try {
                if (target.kind === "new") {
                  const listId = newId();
                  await repo.createList({
                    id: listId,
                    name: target.name,
                    color: target.color,
                    createdAt: now,
                    updatedAt: now,
                  });
                  await repo.addPlaceBlock(listId, view.savedPlace.id, nowIso());
                  setMessage(`Added to "${target.name}".`);
                } else {
                  await repo.addPlaceBlock(target.list.id, view.savedPlace.id, nowIso());
                  setMessage(`Added to "${target.list.name}".`);
                }
              } catch (err) {
                setMessage(err instanceof Error ? err.message : String(err));
              }
            })();
          }}
        />
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
        <ul className="mt-2 space-y-2">
          {(notes ?? []).map((note) => (
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

      {editingNote ? (
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
      ) : null}

      {linking && view.place.manual ? (
        <CandidatePicker
          lat={view.place.manual.lat}
          lng={view.place.manual.lng}
          onSelect={(candidate) => {
            const linked = linkPlaceToOsm(view.place, candidate, nowIso(), "owner-confirmed");
            void repo.updatePlace(linked);
            setLinking(false);
            setMessage("Linked to OpenStreetMap.");
          }}
          onClose={() => setLinking(false)}
        />
      ) : null}
    </section>
  );
}

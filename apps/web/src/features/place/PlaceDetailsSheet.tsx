/**
 * Details for a place in the library (i.e. in at least one list — membership is
 * existence, spec/src/data-model.md): facts, tags, Markdown notes, add-to-list,
 * the manual-pin link-to-OSM upgrade, and Remove (from all lists, which removes
 * the place).
 */
import {
  displayFacts,
  linkPlaceToOsm,
  type Note,
  type TeardownBlockers,
  TeardownRefusedError,
} from "@placemarks/domain";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useRef, useState } from "react";
import { useListIdsForPlace, useLists, useNotesForPlace, usePlaceView } from "../../data/hooks";
import { useRepo } from "../../data/RepoContext";
import { newId } from "../../lib/id";
import { nowIso } from "../../lib/time";
import { Markdown } from "../../markdown/Markdown";
import { useUiStore } from "../../state/ui";
import { BlockerDialog } from "../lists/BlockerDialog";
import { NoteEditor } from "../notes/NoteEditor";
import { CandidatePicker } from "../picker/CandidatePicker";
import { NotePublishButton } from "../publish/NotePublishButton";
import { AddToList } from "./AddToList";
import { NavLinks } from "./NavLinks";
import { OsmLink } from "./OsmLink";
import { PlaceFields } from "./PlaceFields";
import { TagEditor } from "./TagEditor";

/** "Embed in post" appears while a post editor is open (spec/src/map-view.md). */
function EmbedInPost({ placeId, memberListIds }: { placeId: string; memberListIds: string[] }) {
  const repo = useRepo();
  const embedTargetPostId = useUiStore((s) => s.embedTargetPostId);
  const post = useLiveQuery(
    () => (embedTargetPostId ? repo.getPost(embedTargetPostId) : undefined),
    [repo, embedTargetPostId],
  );
  const [message, setMessage] = useState<string>();
  if (!post) return null;
  const isMember = memberListIds.includes(post.listId);
  return (
    <div className="mt-3">
      <button
        type="button"
        className="rounded bg-stone-800 px-2.5 py-1 text-xs font-medium text-white"
        data-testid="embed-in-post"
        onClick={() => {
          void (async () => {
            try {
              // The one door: a place not yet in the post's list is added to
              // the list first, then embedded (membership is existence).
              if (!isMember) {
                await repo.addToList(post.listId, { kind: "existing", placeId }, nowIso());
              }
              await repo.embedPlaceInPost(post.id, placeId, nowIso());
              setMessage(`Embedded in “${post.title}”.`);
            } catch (err) {
              setMessage(err instanceof Error ? err.message : String(err));
            }
          })();
        }}
      >
        {isMember ? "Embed in post" : "Add to list & embed in post"}
      </button>
      {message ? <p className="mt-1 text-xs text-stone-600">{message}</p> : null}
    </div>
  );
}

export function PlaceDetailsSheet({ placeId }: { placeId: string }) {
  const repo = useRepo();
  const clearSelection = useUiStore((s) => s.clearSelection);
  const view = usePlaceView(placeId);
  const notes = useNotesForPlace(view?.place.id);
  const lists = useLists();
  const memberListIds = useListIdsForPlace(view?.place.id);
  const [editingNote, setEditingNote] = useState<Note>();
  const [linking, setLinking] = useState(false);
  const [message, setMessage] = useState<string>();
  const [refusal, setRefusal] = useState<TeardownBlockers>();
  // Modal focus: enter the sheet once it has actually rendered (the place
  // view resolves asynchronously — a mount-time effect fires while the sheet
  // is still null and focuses nothing), return to the invoker on close.
  const sheetRef = useRef<HTMLElement>(null);
  const focusedOnce = useRef(false);
  const previousFocus = useRef<HTMLElement | null>(null);
  const hasView = view !== undefined;
  useEffect(() => {
    if (!hasView || focusedOnce.current) return;
    focusedOnce.current = true;
    previousFocus.current = document.activeElement as HTMLElement | null;
    sheetRef.current?.focus();
  }, [hasView]);
  useEffect(() => () => previousFocus.current?.focus(), []);

  if (!view) return null;
  const facts = displayFacts(view.place);
  const now = nowIso();

  return (
    <section
      ref={sheetRef}
      tabIndex={-1}
      role="dialog"
      aria-label={facts?.name ?? "Place"}
      className="absolute inset-x-0 bottom-0 z-40 max-h-[70%] overflow-y-auto rounded-t-2xl border border-stone-200 bg-white p-4 shadow-xl md:inset-x-auto md:right-4 md:bottom-4 md:w-96 md:rounded-2xl"
      data-testid="place-details"
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
          onAdd={(name) => void repo.assignTag(view.place.id, name, now)}
          onRemove={(tagId) => void repo.removeTagAssignment(view.place.id, tagId, now)}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        {facts ? (
          <NavLinks
            lat={facts.lat}
            lng={facts.lng}
            {...(facts.name ? { name: facts.name } : {})}
            {...(() => {
              // A retained Google Maps ref is the deep link back — it wins
              // over whichever provenance ref happened to arrive first.
              const preferred =
                view.place.externalRefs?.find((ref) => ref.provider === "google-maps") ??
                view.place.externalRefs?.[0];
              return preferred?.url ? { externalUrl: preferred.url } : {};
            })()}
          />
        ) : null}
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
            // Bottom-up teardown: the refusal names the blockers and the
            // place stays selected so the owner can dismantle them here.
            void repo
              .removePlace(view.place.id, now)
              .then(clearSelection)
              .catch((err: unknown) => {
                if (err instanceof TeardownRefusedError) {
                  setRefusal(err.blockers);
                  return;
                }
                throw err;
              });
          }}
          className="ml-auto text-[11px] font-medium text-red-700 underline hover:text-red-900"
          data-testid="remove-place"
        >
          Remove place
        </button>
      </div>
      {refusal ? (
        <BlockerDialog
          title="Can’t remove this place yet"
          blockers={refusal}
          placeNames={{ [view.place.id]: facts?.name ?? "Unnamed place" }}
          onOpenPlace={() => setRefusal(undefined)}
          onClose={() => setRefusal(undefined)}
        />
      ) : null}
      {message ? (
        <p className="mt-2 text-xs text-stone-600" data-testid="sheet-message">
          {message}
        </p>
      ) : null}

      {/* An open post editor offers the embed gesture right on the card
          (spec/src/posts.md §Authoring: browse-tap-embed; a non-member goes
          through the one door — add to the list first, then embed). */}
      <EmbedInPost placeId={view.place.id} memberListIds={memberListIds ?? []} />

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
                    marker: target.marker,
                    createdAt: now,
                    updatedAt: now,
                  });
                  await repo.addToList(
                    listId,
                    { kind: "existing", placeId: view.place.id },
                    nowIso(),
                  );
                  setMessage(`Added to "${target.name}".`);
                } else {
                  await repo.addToList(
                    target.list.id,
                    { kind: "existing", placeId: view.place.id },
                    nowIso(),
                  );
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
                  {note.shareable ? <NotePublishButton note={note} /> : null}
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
          // Imported coordinates are Google-derived: linking to an existing OSM
          // element is fine, but they must never pre-fill an OSM contribution.
          allowOsmAdd={view.place.origin !== "import"}
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

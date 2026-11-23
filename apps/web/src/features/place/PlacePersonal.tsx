/**
 * The owner's own layer on a place (spec/src/data-model.md §The personal
 * layer): a rating, been / want to go, free-text tags, and a short note.
 * Everything here is the owner's word and saves as it changes. Tags derived
 * from reviews live in the review section, drawn differently; here they are
 * only suggested, and become an own tag with one deliberate press.
 */
import { normalizeTag, type Place, type PlaceStatus, vocabLabel } from "@placemarks/domain";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRepo } from "../../data/RepoContext";
import { StarInput } from "../library/Stars";
import { OwnTag } from "../library/TagChip";

export function PlacePersonal({
  place,
  derivedTags,
  knownTags,
}: {
  place: Place;
  /** Review-derived vocabulary keys for this place. */
  derivedTags: readonly string[];
  /** Every own tag used in the library, for suggestions. */
  knownTags: readonly string[];
}) {
  const repo = useRepo();
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState(place.note ?? "");
  const listId = useId();
  const noteId = useId();
  const tags = place.tags ?? [];

  // The note saves as it is typed (after a pause), when the field loses focus,
  // when the page is hidden and when the card closes — a phone user who types
  // a note and switches apps keeps it. `savedNote` is what the store holds as
  // far as this card knows, so its own write echoing back does not reset the
  // field mid-word (the store trims; the draft keeps a trailing space).
  const savedNote = useRef(place.note ?? "");
  const noteDraft = useRef(note);
  noteDraft.current = note;
  const saveNote = useCallback(() => {
    const trimmed = noteDraft.current.trim();
    if (trimmed === savedNote.current) return;
    savedNote.current = trimmed;
    void repo.updatePlacePersonal(place.id, { note: trimmed === "" ? null : trimmed });
  }, [repo, place.id]);

  // The note changed elsewhere (an import, another tab): follow the store.
  // The card remounts this component per place, so a draft never crosses places.
  useEffect(() => {
    const incoming = place.note ?? "";
    if (incoming === savedNote.current) return;
    savedNote.current = incoming;
    setNote(incoming);
  }, [place.note]);

  useEffect(() => {
    const timer = setTimeout(saveNote, 600);
    return () => clearTimeout(timer);
  }, [note, saveNote]);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") saveNote();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", saveNote);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", saveNote);
      saveNote();
    };
  }, [saveNote]);

  const addTags = (raw: string) => {
    const incoming = raw
      .split(",")
      .map(normalizeTag)
      .filter((tag) => tag !== "" && !tags.includes(tag));
    if (incoming.length > 0) {
      void repo.updatePlacePersonal(place.id, { addTags: incoming });
    }
    setDraft("");
  };

  const setStatus = (status: PlaceStatus) =>
    void repo.updatePlacePersonal(place.id, { status: place.status === status ? null : status });

  const adoptable = derivedTags.filter((tag) => !tags.includes(normalizeTag(vocabLabel(tag))));

  return (
    <section className="mt-3 space-y-3" aria-label="Your notes" data-testid="place-personal">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <StarInput
          stars={place.stars}
          onChange={(stars) => void repo.updatePlacePersonal(place.id, { stars })}
        />
        <fieldset className="flex items-center gap-1.5" aria-label="Been or want to go">
          {(
            [
              ["been", "Been"],
              ["want", "Want to go"],
            ] as const
          ).map(([status, label]) => (
            <button
              key={status}
              type="button"
              aria-pressed={place.status === status}
              onClick={() => setStatus(status)}
              data-testid={`status-${status}`}
              className={`rounded-pill border px-2.5 py-0.5 text-xs font-medium ${
                place.status === status
                  ? "border-ink bg-ink text-paper"
                  : "border-hairline text-ink hover:bg-hover"
              }`}
            >
              {label}
            </button>
          ))}
        </fieldset>
      </div>

      <div>
        <h3 className="eyebrow">Your tags</h3>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5" data-testid="own-tags">
          {tags.map((tag) => (
            <OwnTag
              key={tag}
              tag={tag}
              onRemove={() =>
                void repo.updatePlacePersonal(place.id, { removeTags: [tag] })
              }
            />
          ))}
          <input
            type="text"
            value={draft}
            onChange={(e) => {
              // A comma finishes a tag, like Enter.
              if (e.target.value.includes(",")) addTags(e.target.value);
              else setDraft(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTags(draft);
              }
            }}
            onBlur={() => {
              if (draft.trim() !== "") addTags(draft);
            }}
            list={listId}
            placeholder={tags.length === 0 ? "Add a tag — date night, natural wine…" : "Add a tag"}
            aria-label="Add a tag"
            enterKeyHint="done"
            autoCapitalize="none"
            className="min-w-[8rem] flex-1 rounded-pill border border-hairline bg-paper px-2.5 py-1 text-xs text-ink focus:border-ink focus:outline-none"
            data-testid="tag-input"
          />
          <datalist id={listId}>
            {knownTags
              .filter((tag) => !tags.includes(tag))
              .map((tag) => (
                <option key={tag} value={tag} />
              ))}
          </datalist>
        </div>
      </div>

      {/* Review tags are drawn in the review section below; here they are
          only offered — adopting one makes it an own tag, deliberately. */}
      {adoptable.length > 0 ? (
        <p className="text-[11px] text-ink/60" data-testid="derived-suggestions">
          <span aria-hidden="true">✦</span> Reviews suggest:{" "}
          {adoptable.map((tag, index) => (
            <span key={tag}>
              {index > 0 ? ", " : ""}
              <button
                type="button"
                className="italic underline hover:text-ink"
                onClick={() => addTags(vocabLabel(tag))}
                data-testid="adopt-derived-tag"
              >
                {vocabLabel(tag).toLowerCase()}
              </button>
            </span>
          ))}{" "}
          — press one to make it your tag.
        </p>
      ) : null}

      <div>
        <label htmlFor={noteId} className="eyebrow">
          Your note
        </label>
        <textarea
          id={noteId}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={saveNote}
          rows={2}
          maxLength={600}
          placeholder="Why it's here, what to order, who told you…"
          className="mt-1.5 block w-full rounded-crisp border border-hairline bg-paper px-2.5 py-1.5 text-sm text-ink focus:border-ink focus:outline-none"
          data-testid="place-note"
        />
      </div>
    </section>
  );
}

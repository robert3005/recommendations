/**
 * Add a place to a list — the one door into the library (membership is
 * existence, spec/src/data-model.md). One combobox picks or creates the list;
 * picking is the add. Handles the repository's AddResult in full: added,
 * already-member, and the name-proximity conflict, which prompts the user
 * rather than merging silently.
 */
import type { List, Place } from "@placemarks/domain";
import { useState } from "react";
import { useRepo } from "../../data/RepoContext";
import type { AddResult, AddSource } from "../../data/repo";
import { ListCombobox, type ListTarget } from "../lists/ListCombobox";
import { MarkerGlyph } from "../lists/MarkerGlyph";

export interface AddToListProps {
  /** What is being added: an existing library place, or new facts. */
  source: AddSource;
  lists: List[] | undefined;
  /** Lists the place already belongs to — shown as chips, not offered again. */
  memberListIds?: string[];
  onAdded?: (place: Place, listId: string) => void;
  /** Distinguishes controls and test hooks when several pickers exist. */
  idPrefix?: string;
}

export function AddToList({
  source,
  lists,
  memberListIds = [],
  onAdded,
  idPrefix = "add",
}: AddToListProps) {
  const repo = useRepo();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [conflict, setConflict] = useState<{ existing: Place; listId: string }>();
  const memberLists = (lists ?? []).filter((list) => memberListIds.includes(list.id));

  const listIdFor = async (picked: ListTarget): Promise<string> => {
    if (picked.kind === "existing") return picked.listId;
    const created = await repo.createList(picked.name);
    return created.id;
  };

  const finish = (
    result: Extract<AddResult, { status: "added" | "already-member" }>,
    listId: string,
  ) => {
    setConflict(undefined);
    setMessage(
      result.status === "already-member"
        ? `“${result.place.name}” is already on that list.`
        : `Added “${result.place.name}”.`,
    );
    if (result.status === "added") onAdded?.(result.place, listId);
  };

  const add = async (picked: ListTarget, useSource: AddSource, forceNew = false) => {
    setBusy(true);
    setMessage(undefined);
    try {
      const listId = await listIdFor(picked);
      const result = await repo.addToList(listId, useSource, forceNew ? { forceNew } : undefined);
      if (result.status === "name-proximity-conflict") {
        // The dedup ladder's last rung prompts instead of merging silently
        // (spec/src/data-model.md §Normative rules).
        setConflict({ existing: result.existing, listId });
        return;
      }
      finish(result, listId);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="add-to-list">
      {memberLists.length > 0 ? (
        <ul
          className="mb-1 flex flex-wrap gap-1.5 text-xs text-ink"
          aria-label="Current lists"
          data-testid="current-list-memberships"
        >
          {memberLists.map((list) => (
            <li
              key={list.id}
              className="inline-flex items-center gap-1 rounded-pill border border-hairline px-2 py-0.5"
            >
              <MarkerGlyph marker={list.marker} size={12} />
              {list.name}
            </li>
          ))}
        </ul>
      ) : null}

      {/* One control: picking (or creating) the list IS the add — no submit
          (spec/src/map-view.md §The place card). */}
      <ListCombobox
        lists={lists}
        onPick={(target) => void add(target, source)}
        idPrefix={idPrefix}
        excludeListIds={memberListIds}
        disabled={busy}
      />
      {busy ? (
        <p className="mt-1 text-xs text-ink/60" role="status">
          Adding…
        </p>
      ) : null}

      {conflict ? (
        <div
          className="mt-2 rounded-crisp border border-hairline p-2 text-xs text-ink"
          data-testid="name-proximity-conflict"
        >
          <p>
            This looks like <span className="font-medium">“{conflict.existing.name}”</span>, which
            is already in your library.
          </p>
          <div className="mt-1.5 flex gap-2">
            <button
              type="button"
              disabled={busy}
              className="rounded-pill bg-ink px-2 py-1 font-medium text-paper disabled:opacity-40"
              data-testid={`${idPrefix}-use-existing`}
              onClick={() =>
                void add(
                  { kind: "existing", listId: conflict.listId },
                  { kind: "existing", placeId: conflict.existing.id },
                )
              }
            >
              Use the existing place
            </button>
            <button
              type="button"
              disabled={busy}
              className="rounded-pill border border-hairline px-2 py-1 font-medium text-ink disabled:opacity-40"
              data-testid={`${idPrefix}-force-new`}
              onClick={() => void add({ kind: "existing", listId: conflict.listId }, source, true)}
            >
              Keep both
            </button>
          </div>
        </div>
      ) : null}

      {message ? (
        <p className="mt-1 text-xs text-ink/70" data-testid={`${idPrefix}-message`}>
          {message}
        </p>
      ) : null}
    </div>
  );
}

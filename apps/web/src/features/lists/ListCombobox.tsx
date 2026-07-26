/**
 * One control to pick or create the list a place joins — "pick a list or
 * create one inline" (spec/src/map-view.md §The place card) as a single ARIA
 * combobox: the listbox holds the available lists (marker glyph + name,
 * member lists excluded) filtered by the typed text, and when the text
 * exactly names no list the first option is Create "<text>". Picking is the
 * action — there is no separate submit. Every add path ends here because
 * membership is existence (spec/src/data-model.md). Fully keyboard operable
 * (spec/src/map-view.md §Accessibility and failure).
 */
import type { List } from "@placemarks/domain";
import { useEffect, useId, useRef, useState } from "react";
import { MarkerGlyph } from "./MarkerGlyph";

export type ListTarget = { kind: "existing"; listId: string } | { kind: "new"; name: string };

export interface ListComboboxProps {
  lists: List[] | undefined;
  /** Fired the moment an option is chosen — the caller adds immediately. */
  onPick: (target: ListTarget) => void;
  /** Distinguishes controls and test hooks when several exist on a page. */
  idPrefix: string;
  /** Lists the place already belongs to — not offered again. */
  excludeListIds?: string[];
  disabled?: boolean;
}

type ComboOption = { kind: "create"; name: string } | { kind: "existing"; list: List };

export function ListCombobox({
  lists,
  onPick,
  idPrefix,
  excludeListIds = [],
  disabled = false,
}: ListComboboxProps) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const inputId = `${baseId}-input`;
  const listboxId = `${baseId}-listbox`;

  const trimmed = text.trim();
  const available = (lists ?? []).filter((list) => !excludeListIds.includes(list.id));
  const matches =
    trimmed === ""
      ? available
      : available.filter((list) => list.name.toLowerCase().includes(trimmed.toLowerCase()));
  // "Exactly matches no list" counts member lists too: a place already on
  // "Porto" must not mint a second Porto (dedup by prompt, never by accident —
  // spec/src/data-model.md §Normative rules).
  const exactList = (lists ?? []).find((list) => list.name.toLowerCase() === trimmed.toLowerCase());
  const options: ComboOption[] = [
    ...(trimmed !== "" && exactList === undefined
      ? [{ kind: "create", name: trimmed } as const]
      : []),
    ...matches.map((list) => ({ kind: "existing", list }) as const),
  ];
  // Typing narrows the options under a held arrow position — clamp, don't drop.
  const active = Math.min(activeIndex, options.length - 1);
  const statusText =
    options.length === 0 && exactList !== undefined && excludeListIds.includes(exactList.id)
      ? `Already on “${exactList.name}”.`
      : undefined;
  const popupVisible = open && (options.length > 0 || statusText !== undefined);

  const optionDomId = (option: ComboOption) =>
    option.kind === "create" ? `${listboxId}-create` : `${listboxId}-${option.list.id}`;
  const activeOption = active >= 0 ? options[active] : undefined;

  // Clicking outside closes the popup without picking anything.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        rootRef.current &&
        event.target instanceof Node &&
        !rootRef.current.contains(event.target)
      ) {
        setOpen(false);
        setActiveIndex(-1);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const pick = (option: ComboOption) => {
    setOpen(false);
    setActiveIndex(-1);
    setText("");
    onPick(
      option.kind === "create"
        ? { kind: "new", name: option.name }
        : { kind: "existing", listId: option.list.id },
    );
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setActiveIndex(options.length === 0 ? -1 : (active + 1) % options.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex(options.length === 0 ? -1 : active <= 0 ? options.length - 1 : active - 1);
    } else if (e.key === "Enter") {
      if (open && activeOption !== undefined) {
        e.preventDefault();
        pick(activeOption);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
      setActiveIndex(-1);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <label htmlFor={inputId} className="mt-2 block text-xs font-medium text-ink">
        List
      </label>
      <input
        id={inputId}
        type="text"
        role="combobox"
        aria-expanded={popupVisible}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeOption !== undefined ? optionDomId(activeOption) : undefined}
        placeholder="Choose or create a list…"
        value={text}
        disabled={disabled}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          // A typed name always has a live default: the first option.
          setActiveIndex(e.target.value.trim() === "" ? -1 : 0);
        }}
        onFocus={() => setOpen(true)}
        // A click on the already-focused input reopens after Escape/outside.
        onClick={() => setOpen(true)}
        onKeyDown={onKeyDown}
        className="mt-1 w-full rounded-crisp border border-hairline bg-paper px-2 py-1.5 text-sm text-ink focus:border-ink focus:outline-none disabled:opacity-40"
        data-testid={`${idPrefix}-list-choice`}
      />

      {popupVisible ? (
        <div className="absolute top-full right-0 left-0 z-30 mt-1 overflow-hidden rounded-crisp border border-hairline bg-panel">
          {statusText !== undefined ? (
            <p className="px-3 py-2 text-sm text-ink/60">{statusText}</p>
          ) : (
            <ul
              id={listboxId}
              // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: ul[role=listbox] with option children is the standard ARIA combobox pattern
              role="listbox"
              aria-label="Lists"
            >
              {options.map((option, index) => (
                <li key={optionDomId(option)} role="presentation">
                  <button
                    type="button"
                    role="option"
                    id={optionDomId(option)}
                    aria-selected={index === active}
                    onClick={() => pick(option)}
                    onMouseEnter={() => setActiveIndex(index)}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink ${
                      index === active ? "bg-ink/5" : ""
                    }`}
                    data-testid={
                      option.kind === "create"
                        ? `${idPrefix}-create-option`
                        : `${idPrefix}-option-${option.list.id}`
                    }
                  >
                    {option.kind === "create" ? (
                      <span>
                        Create <span className="font-medium">“{option.name}”</span>
                      </span>
                    ) : (
                      <>
                        <MarkerGlyph marker={option.list.marker} size={14} />
                        <span className="truncate">{option.list.name}</span>
                      </>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

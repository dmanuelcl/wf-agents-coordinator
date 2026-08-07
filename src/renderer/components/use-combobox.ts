import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";

// Cap how many options render at once — a repo with hundreds of branches must
// stay responsive. The count line tells the user to keep typing to narrow it.
const MAX_SHOWN = 60;

/**
 * One option in a combobox. `id` is what gets committed, `label` is what the
 * input shows once picked, and `searchText` is what the query matches against.
 * Keeping the three apart is what lets a checkpoint be picked by title while
 * `id` stays the path the session actually adopts.
 */
export interface ComboboxEntry {
  id: string;
  label: string;
  searchText: string;
  /** Survives every query — for a standing choice like "None", which must stay
   *  reachable no matter what has been typed. */
  pinned?: boolean;
}

/**
 * Every whitespace-separated term must appear somewhere in `searchText`, so
 * `session planned` narrows across fields rather than looking for that literal
 * string. A single term behaves exactly like a plain substring match.
 */
export function filterComboboxEntries(entries: readonly ComboboxEntry[], query: string): ComboboxEntry[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...entries];
  return entries.filter((entry) => {
    if (entry.pinned) return true;
    const haystack = entry.searchText.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export interface UseComboboxParams {
  entries: readonly ComboboxEntry[];
  /** What the input shows for the currently committed value. */
  displayValue: string;
  onSelect: (entry: ComboboxEntry) => void;
  /** Fires when the user empties the input, for pickers where a blank field
   *  means "nothing chosen". Omitted where clearing the text must not clear
   *  the choice. */
  onCleared?: () => void;
}

export interface Combobox {
  rootRef: RefObject<HTMLDivElement>;
  query: string;
  open: boolean;
  highlight: number;
  /** The filtered entries actually rendered, capped at `MAX_SHOWN`. */
  shown: ComboboxEntry[];
  /** How many matches the cap hid. */
  overflow: number;
  setHighlight: (index: number) => void;
  choose: (entry: ComboboxEntry) => void;
  onQueryChange: (text: string) => void;
  onFocus: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
}

/**
 * The interaction shared by every combobox in the app: type to filter, arrow
 * keys and Enter to pick, Escape or an outside click to dismiss. Callers supply
 * the entries and draw the rows; nothing here knows what an entry represents.
 */
export function useCombobox(params: UseComboboxParams): Combobox {
  const { entries, displayValue, onSelect, onCleared } = params;
  const [query, setQuery] = useState(displayValue);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Keep the input text in sync when the value is set/cleared from outside.
  useEffect(() => {
    setQuery(displayValue);
  }, [displayValue]);

  // Filter unless the query is exactly the committed label (then show
  // everything so the user can re-browse without clearing first).
  const filtered = useMemo<ComboboxEntry[]>(() => {
    if (query === displayValue) return [...entries];
    return filterComboboxEntries(entries, query);
  }, [entries, query, displayValue]);

  const shown = filtered.slice(0, MAX_SHOWN);
  const overflow = filtered.length - shown.length;

  // Close the dropdown on an outside click.
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(event: MouseEvent): void {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  function choose(entry: ComboboxEntry): void {
    onSelect(entry);
    setQuery(entry.label);
    setOpen(false);
  }

  function onQueryChange(text: string): void {
    setQuery(text);
    setOpen(true);
    setHighlight(0);
    if (!text && onCleared) onCleared();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.min(h + 1, shown.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (event.key === "Enter") {
      const pick = shown[highlight];
      if (open && pick) {
        event.preventDefault();
        choose(pick);
      }
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  return {
    rootRef,
    query,
    open,
    highlight,
    shown,
    overflow,
    setHighlight,
    choose,
    onQueryChange,
    onFocus: () => setOpen(true),
    onKeyDown,
  };
}

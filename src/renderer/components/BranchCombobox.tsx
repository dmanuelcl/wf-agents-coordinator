import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { BranchList } from "../../shared/ipc/contract";

interface BranchComboboxProps {
  branches: BranchList | null;
  loading: boolean;
  value: string;
  onChange: (branch: string) => void;
  inputId?: string;
}

interface BranchEntry {
  name: string;
  scope: "remote" | "local";
}

// Cap how many options render at once — a repo with hundreds of branches must
// stay responsive. The count line tells the user to keep typing to narrow it.
const MAX_SHOWN = 60;

/**
 * A searchable branch picker. Type to filter across remote + local branches
 * (remote first, since most PRs are remote); arrow keys + Enter or click to
 * select. Controlled: `value` is the committed branch, `onChange` fires on pick.
 */
export function BranchCombobox(props: BranchComboboxProps): JSX.Element {
  const { branches, loading, value, onChange, inputId } = props;
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Keep the input text in sync when the value is set/cleared from outside.
  useEffect(() => {
    setQuery(value);
  }, [value]);

  const all = useMemo<BranchEntry[]>(() => {
    if (!branches) return [];
    return [
      ...branches.remote.map((name): BranchEntry => ({ name, scope: "remote" })),
      ...branches.local.map((name): BranchEntry => ({ name, scope: "local" })),
    ];
  }, [branches]);

  // Filter unless the query is exactly the committed value (then show everything
  // so the user can re-browse without clearing first).
  const filtered = useMemo<BranchEntry[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q || query === value) return all;
    return all.filter((entry) => entry.name.toLowerCase().includes(q));
  }, [all, query, value]);

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

  function select(entry: BranchEntry): void {
    onChange(entry.name);
    setQuery(entry.name);
    setOpen(false);
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
        select(pick);
      }
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  const placeholder = loading ? "Loading branches…" : "Type to search branches…";

  return (
    <div className="branch-combobox" ref={rootRef}>
      <input
        id={inputId}
        type="text"
        role="combobox"
        aria-expanded={open}
        autoComplete="off"
        placeholder={placeholder}
        value={query}
        disabled={loading && all.length === 0}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          setHighlight(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {open && !loading && (
        <div className="branch-combobox-list" role="listbox">
          {shown.length === 0 ? (
            <div className="branch-combobox-empty">No matching branches</div>
          ) : (
            shown.map((entry, index) => (
              <button
                key={`${entry.scope}:${entry.name}`}
                type="button"
                role="option"
                aria-selected={index === highlight}
                className={`branch-combobox-option${index === highlight ? " highlight" : ""}`}
                // mousedown (not click) so it fires before the input blur closes the list
                onMouseDown={(event) => {
                  event.preventDefault();
                  select(entry);
                }}
                onMouseEnter={() => setHighlight(index)}
              >
                <span className="branch-combobox-name">{entry.name}</span>
                <span className={`branch-combobox-scope ${entry.scope}`}>{entry.scope}</span>
              </button>
            ))
          )}
          {overflow > 0 && <div className="branch-combobox-more">+{overflow} more — keep typing to narrow</div>}
        </div>
      )}
    </div>
  );
}

import { useMemo } from "react";
import type { BranchList } from "../../shared/ipc/contract";
import { useCombobox } from "./use-combobox";
import type { ComboboxEntry } from "./use-combobox";

interface BranchComboboxProps {
  branches: BranchList | null;
  loading: boolean;
  value: string;
  onChange: (branch: string) => void;
  inputId?: string;
}

/**
 * A searchable branch picker. Type to filter across remote + local branches
 * (remote first, since most PRs are remote); arrow keys + Enter or click to
 * select. Controlled: `value` is the committed branch, `onChange` fires on pick.
 */
export function BranchCombobox(props: BranchComboboxProps): JSX.Element {
  const { branches, loading, value, onChange, inputId } = props;

  // Remote refs are listed short-qualified ("origin/feature/x") and locals bare,
  // so a name identifies exactly one row.
  const remoteNames = useMemo(() => new Set(branches?.remote ?? []), [branches]);

  const entries = useMemo<ComboboxEntry[]>(() => {
    if (!branches) return [];
    return [...branches.remote, ...branches.local].map((name) => ({ id: name, label: name, searchText: name }));
  }, [branches]);

  const combobox = useCombobox({
    entries,
    displayValue: value,
    onSelect: (entry) => onChange(entry.id),
  });

  const placeholder = loading ? "Loading branches…" : "Type to search branches…";

  return (
    <div className="combobox" ref={combobox.rootRef}>
      <input
        id={inputId}
        type="text"
        role="combobox"
        aria-expanded={combobox.open}
        autoComplete="off"
        placeholder={placeholder}
        value={combobox.query}
        disabled={loading && entries.length === 0}
        onChange={(event) => combobox.onQueryChange(event.target.value)}
        onFocus={combobox.onFocus}
        onKeyDown={combobox.onKeyDown}
      />
      {combobox.open && !loading && (
        <div className="combobox-list" role="listbox">
          {combobox.shown.length === 0 ? (
            <div className="combobox-empty">No matching branches</div>
          ) : (
            combobox.shown.map((entry, index) => (
              <button
                key={entry.id}
                type="button"
                role="option"
                aria-selected={index === combobox.highlight}
                className={`combobox-option${index === combobox.highlight ? " highlight" : ""}`}
                // mousedown (not click) so it fires before the input blur closes the list
                onMouseDown={(event) => {
                  event.preventDefault();
                  combobox.choose(entry);
                }}
                onMouseEnter={() => combobox.setHighlight(index)}
              >
                <span className="combobox-name">{entry.id}</span>
                <span className={`combobox-scope ${remoteNames.has(entry.id) ? "remote" : "local"}`}>
                  {remoteNames.has(entry.id) ? "remote" : "local"}
                </span>
              </button>
            ))
          )}
          {combobox.overflow > 0 && (
            <div className="combobox-more">+{combobox.overflow} more — keep typing to narrow</div>
          )}
        </div>
      )}
    </div>
  );
}

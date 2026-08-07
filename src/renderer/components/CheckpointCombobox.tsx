import { useMemo } from "react";
import type { RefCheckpointSummary } from "../../shared/ipc/contract";
import { checkpointLabel, checkpointSearchText, statusBadgeClass } from "./checkpoint-display";
import { useCombobox } from "./use-combobox";
import type { ComboboxEntry } from "./use-combobox";

// Adopting nothing is a real choice, not the absence of one, so it is a row of
// its own that no query can hide. Its label is empty because picking it leaves
// the input blank rather than filled with a pseudo-value.
const NONE: ComboboxEntry = { id: "", label: "", searchText: "", pinned: true };

interface CheckpointComboboxProps {
  checkpoints: RefCheckpointSummary[] | null;
  loading: boolean;
  /** No branch has been chosen yet, so there is nothing to list. */
  disabled: boolean;
  /** The committed checkpoint path; "" means start at Architect. */
  value: string;
  onChange: (checkpointPath: string) => void;
  inputId?: string;
}

interface CheckpointOptionRowProps {
  checkpoint: RefCheckpointSummary;
  highlighted: boolean;
  onSelect: () => void;
  onHover: () => void;
}

/**
 * One checkpoint in the list: title and status on the first line, the full
 * repo-relative path on the second. The path is what the session actually
 * adopts, and it is the only thing that tells two same-titled checkpoints
 * apart, so it is always shown rather than used as a fallback title.
 */
export function CheckpointOptionRow(props: CheckpointOptionRowProps): JSX.Element {
  const { checkpoint, highlighted, onSelect, onHover } = props;
  return (
    <button
      type="button"
      role="option"
      aria-selected={highlighted}
      className={`combobox-option combobox-option-checkpoint${highlighted ? " highlight" : ""}`}
      // mousedown (not click) so it fires before the input blur closes the list
      onMouseDown={(event) => {
        event.preventDefault();
        onSelect();
      }}
      onMouseEnter={onHover}
    >
      <span className="combobox-option-title">{checkpointLabel(checkpoint)}</span>
      <span className={statusBadgeClass(checkpoint.status)}>{checkpoint.status}</span>
      <span className="combobox-option-path">{checkpoint.path}</span>
    </button>
  );
}

/**
 * A searchable checkpoint picker over the checkpoints committed on the chosen
 * ref. Type to filter across title, slug, path and status; arrow keys + Enter
 * or click to select. Controlled: `value` is the committed path, `onChange`
 * fires on pick — including on "None", which commits "".
 */
export function CheckpointCombobox(props: CheckpointComboboxProps): JSX.Element {
  const { checkpoints, loading, disabled, value, onChange, inputId } = props;

  const byPath = useMemo(() => {
    return new Map((checkpoints ?? []).map((checkpoint) => [checkpoint.path, checkpoint]));
  }, [checkpoints]);

  const entries = useMemo<ComboboxEntry[]>(() => {
    return [
      NONE,
      ...(checkpoints ?? []).map((checkpoint) => ({
        id: checkpoint.path,
        label: checkpointLabel(checkpoint),
        searchText: checkpointSearchText(checkpoint),
      })),
    ];
  }, [checkpoints]);

  const selected = value ? byPath.get(value) : undefined;
  const combobox = useCombobox({
    entries,
    displayValue: selected ? checkpointLabel(selected) : "",
    onSelect: (entry) => onChange(entry.id),
    onCleared: () => onChange(""),
  });

  const placeholder = loading
    ? "Reading the branch…"
    : disabled
      ? "Pick a branch first"
      : "Type to search checkpoints…";
  // A ref that carries no checkpoint has nothing to search. `null` is "not read
  // yet" rather than "none", so it must not disable the field for the frame
  // between picking a branch and the read starting.
  const empty = !loading && !disabled && checkpoints !== null && checkpoints.length === 0;

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
        disabled={disabled || loading || empty}
        onChange={(event) => combobox.onQueryChange(event.target.value)}
        onFocus={combobox.onFocus}
        onKeyDown={combobox.onKeyDown}
      />
      {combobox.open && !disabled && !loading && (
        <div className="combobox-list" role="listbox">
          {combobox.shown.map((entry, index) => {
            const checkpoint = byPath.get(entry.id);
            if (!checkpoint) {
              return (
                <button
                  key="none"
                  type="button"
                  role="option"
                  aria-selected={index === combobox.highlight}
                  className={`combobox-option combobox-option-none${index === combobox.highlight ? " highlight" : ""}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    combobox.choose(entry);
                  }}
                  onMouseEnter={() => combobox.setHighlight(index)}
                >
                  None — start at Architect
                </button>
              );
            }
            return (
              <CheckpointOptionRow
                key={entry.id}
                checkpoint={checkpoint}
                highlighted={index === combobox.highlight}
                onSelect={() => combobox.choose(entry)}
                onHover={() => combobox.setHighlight(index)}
              />
            );
          })}
          {combobox.shown.length === 1 && combobox.query.trim() !== "" && (
            <div className="combobox-empty">No matching checkpoints</div>
          )}
          {combobox.overflow > 0 && (
            <div className="combobox-more">+{combobox.overflow} more — keep typing to narrow</div>
          )}
        </div>
      )}
    </div>
  );
}

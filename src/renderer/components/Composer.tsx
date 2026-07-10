import { useEffect, useRef, useState } from "react";

export interface SendTarget {
  key: string;
  label: string;
}

interface ComposerProps {
  text: string;
  onTextChange: (text: string) => void;
  sendTargets: SendTarget[];
  // Returns true if the text was actually sent (a live target existed). `execute`
  // appends Enter so a shell runs it / an agent submits it.
  onSend: (targetKey: string, text: string, execute: boolean) => boolean;
  onClose: () => void;
  // Bumped each time the host appends a block: focus the textarea and drop the
  // caret at the end so the user can annotate immediately.
  focusSignal?: number;
}

/**
 * A per-file scratchpad: the user accumulates `file:line` blocks (via the
 * editor's "Add") and free-text notes here, picks one agent/shell tab, and sends
 * the whole thing at once. Shells run it; agents get it as a paste. Clears on a
 * successful send.
 */
export function Composer(props: ComposerProps): JSX.Element {
  const { text, onTextChange, sendTargets, onSend, onClose, focusSignal } = props;
  const [target, setTarget] = useState("");
  const [flash, setFlash] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // After the host appends a block, focus + drop the caret at the very end.
  useEffect(() => {
    if (!focusSignal) return;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
    el.scrollTop = el.scrollHeight;
  }, [focusSignal]);

  const effective =
    target && sendTargets.some((candidate) => candidate.key === target)
      ? target
      : (sendTargets[0]?.key ?? "");
  const canSend = effective !== "" && text.trim().length > 0;

  // Both actions are offered for every target: "Send" pastes without submitting
  // (refine a prompt / press Enter yourself); "Send & Run" pastes + Enter (a
  // shell runs it, an agent submits it).
  function send(execute: boolean): void {
    if (!canSend) return;
    const label = sendTargets.find((candidate) => candidate.key === effective)?.label ?? effective;
    const sent = onSend(effective, text, execute);
    if (!sent) return;
    onTextChange("");
    setFlash(`${execute ? "ran in" : "sent →"} ${label}`);
    window.setTimeout(() => setFlash(null), 2000);
  }

  return (
    <div className="composer">
      <div className="composer-head">
        <span className="composer-title">Composer</span>
        <span className="composer-hint">Select lines → “Add” · edit freely · send once</span>
        <div className="composer-actions">
          {flash && <span className="composer-flash">{flash}</span>}
          <select
            className="composer-target"
            value={effective}
            onChange={(event) => setTarget(event.target.value)}
            disabled={sendTargets.length === 0}
            title="Which tab to send to"
          >
            {sendTargets.length === 0 ? (
              <option value="">No open agent/shell tab</option>
            ) : (
              sendTargets.map((candidate) => (
                <option key={candidate.key} value={candidate.key}>
                  {candidate.label}
                </option>
              ))
            )}
          </select>
          <button
            type="button"
            className="composer-send"
            disabled={!canSend}
            onClick={() => send(false)}
            title="Paste into the tab without submitting — you press Enter"
          >
            Send
          </button>
          <button
            type="button"
            className="composer-send composer-run"
            disabled={!canSend}
            onClick={() => send(true)}
            title="Paste and submit / run immediately"
          >
            Send &amp; Run
          </button>
          <button
            type="button"
            className="composer-clear"
            disabled={text.length === 0}
            onClick={() => onTextChange("")}
          >
            Clear
          </button>
          <button type="button" className="composer-close" aria-label="Hide composer" onClick={onClose}>
            ×
          </button>
        </div>
      </div>
      <textarea
        ref={textareaRef}
        className="composer-text"
        value={text}
        spellCheck={false}
        placeholder="Add file selections here, annotate why, then send to an agent or run in a shell…"
        onChange={(event) => onTextChange(event.target.value)}
      />
    </div>
  );
}

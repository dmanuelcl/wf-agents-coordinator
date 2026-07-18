import { useEffect, useRef, useState } from "react";
import { Composer } from "./Composer";
import type { SendTarget } from "./Composer";
import { MarkdownContent } from "./MarkdownContent";

interface MarkdownFileViewProps {
  path: string;
  // Markdown gets a rendered preview + edit toggle; other text files are edit-only.
  markdown?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  // Composer wiring (per file). worktreePath makes `path#Lx` headers relative;
  // sendTargets + onSend deliver the composed text to a chosen tab.
  worktreePath?: string;
  sendTargets?: SendTarget[];
  onSend?: (targetKey: string, text: string, execute: boolean) => boolean;
}

/**
 * In-app viewer/editor for a markdown file opened from a terminal link. Defaults
 * to a rendered preview; toggle to Edit to change it and Save (or ⌘/Ctrl+S)
 * writes it back to disk.
 */
export function MarkdownFileView(props: MarkdownFileViewProps): JSX.Element {
  const { path, onDirtyChange, markdown = true, worktreePath, sendTargets, onSend } = props;
  const [content, setContent] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState<"preview" | "edit">(markdown ? "preview" : "edit");
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // This file's own composer (per-file, not shared across tabs).
  const [composerText, setComposerText] = useState("");
  const [composerOpen, setComposerOpen] = useState(false);
  // Bumped on each Add so the composer focuses with the caret at the end.
  const [focusSignal, setFocusSignal] = useState(0);
  // Floating "Add to composer" affordance, positioned at the selection.
  const [selMenu, setSelMenu] = useState<{ x: number; y: number } | null>(null);
  const composerEnabled = sendTargets !== undefined && onSend !== undefined;

  // Stage the selection into this file's composer as just a GitHub-style
  // `path#Lstart-Lend` reference — NOT the code itself (the agent reads the file
  // from the reference). Then focus the composer to annotate.
  function addSelection(): void {
    const el = textareaRef.current;
    if (!el) return;
    const { selectionStart: start, selectionEnd: end } = el;
    if (end <= start) return;
    const startLine = content.slice(0, start).split("\n").length;
    const endOffset = content.slice(start, end).endsWith("\n") ? end - 1 : end;
    const endLine = content.slice(0, endOffset).split("\n").length;
    const relPath = worktreePath && path.startsWith(`${worktreePath}/`) ? path.slice(worktreePath.length + 1) : path;
    const ref = endLine === startLine ? `${relPath}#L${startLine}` : `${relPath}#L${startLine}-L${endLine}`;
    setComposerText((current) => current + ref + "\n");
    setComposerOpen(true);
    setSelMenu(null);
    setFocusSignal((value) => value + 1);
  }

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setError(null);
    void window.agentCoordinator.system.readFile(path).then(
      (text) => {
        if (cancelled) return;
        setContent(text);
        setDirty(false);
        setLoaded(true);
      },
      (caught) => {
        if (cancelled) return;
        setError(String(caught));
        setLoaded(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [path]);

  // Report dirty changes up so the host can warn on close.
  useEffect(() => {
    onDirtyChange?.(dirty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  function save(): void {
    void window.agentCoordinator.system.writeFile(path, content).then(
      () => setDirty(false),
      (caught) => setError(String(caught)),
    );
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (dirty) save();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, content, path]);

  return (
    <div className="file-view">
      <div className="file-view-toolbar">
        {markdown ? (
          <div className="file-view-modes" role="tablist">
            <button
              type="button"
              className={`file-view-mode${mode === "preview" ? " active" : ""}`}
              onClick={() => setMode("preview")}
            >
              Preview
            </button>
            <button
              type="button"
              className={`file-view-mode${mode === "edit" ? " active" : ""}`}
              onClick={() => setMode("edit")}
            >
              Edit
            </button>
          </div>
        ) : (
          <span className="file-view-plainlabel">Editing</span>
        )}
        <div className="file-view-right">
          {composerEnabled && (
            <button
              type="button"
              className={`file-view-addsel${composerOpen ? " active" : ""}`}
              onClick={() => setComposerOpen((value) => !value)}
              title="Show/hide this file's composer"
            >
              Compose
            </button>
          )}
          {dirty && <span className="file-view-dirty">unsaved</span>}
          <button type="button" className="file-view-save" disabled={!dirty} onClick={save}>
            Save
          </button>
        </div>
      </div>

      {error ? (
        <div className="file-view-error">{error}</div>
      ) : !loaded ? (
        <div className="file-view-loading">Loading…</div>
      ) : markdown && mode === "preview" ? (
        <MarkdownContent markdown={content} className="file-view-preview" />
      ) : (
        <textarea
          ref={textareaRef}
          className="file-view-editor"
          value={content}
          spellCheck={false}
          onSelect={() => {
            const el = textareaRef.current;
            if (el && el.selectionEnd <= el.selectionStart) setSelMenu(null);
          }}
          onMouseUp={(event) => {
            if (!composerEnabled) return;
            const el = textareaRef.current;
            if (el && el.selectionEnd > el.selectionStart) setSelMenu({ x: event.clientX, y: event.clientY });
            else setSelMenu(null);
          }}
          onKeyUp={(event) => {
            if (!composerEnabled || !event.shiftKey) return;
            const el = textareaRef.current;
            if (el && el.selectionEnd > el.selectionStart) {
              const rect = el.getBoundingClientRect();
              setSelMenu({ x: rect.right - 150, y: rect.top + 8 });
            }
          }}
          onScroll={() => setSelMenu(null)}
          onChange={(event) => {
            setContent(event.target.value);
            setDirty(true);
            setSelMenu(null);
          }}
        />
      )}

      {selMenu && (
        <button
          type="button"
          className="sel-float"
          style={{ left: selMenu.x, top: selMenu.y - 38 }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={addSelection}
        >
          + Add to composer
        </button>
      )}

      {sendTargets && onSend && composerOpen && (
        <Composer
          text={composerText}
          onTextChange={setComposerText}
          sendTargets={sendTargets}
          onSend={onSend}
          onClose={() => setComposerOpen(false)}
          focusSignal={focusSignal}
        />
      )}
    </div>
  );
}

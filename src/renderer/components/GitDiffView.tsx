import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { Composer } from "./Composer";
import type { SendTarget } from "./Composer";

interface GitDiffViewProps {
  worktreePath: string;
  // Composer wiring (shared with the session's file views).
  sendTargets?: SendTarget[];
  onSend?: (targetKey: string, text: string, execute: boolean) => boolean;
}

type DiffStatus = "modified" | "added" | "deleted" | "renamed";

interface DiffFile {
  path: string;
  status: DiffStatus;
  additions: number;
  deletions: number;
  lines: string[];
}

// Split a unified diff into per-file entries with stats + status.
function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  for (const line of diff.split("\n")) {
    const header = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (header) {
      current = { path: header[2] ?? header[1] ?? "?", status: "modified", additions: 0, deletions: 0, lines: [] };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("new file")) current.status = "added";
    else if (line.startsWith("deleted file")) current.status = "deleted";
    else if (line.startsWith("rename to ")) current.status = "renamed";
    if (line.startsWith("+") && !line.startsWith("+++")) current.additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) current.deletions++;
    current.lines.push(line);
  }
  return files;
}

// The new-side (post-change) file line number for each rendered diff line, or
// null for headers / hunk markers / deletions (which have no new-side line).
// Used to turn a text selection in the diff into a `path#Lstart-Lend` reference.
function newSideLineNumbers(lines: string[]): (number | null)[] {
  const result: (number | null)[] = [];
  let newLine = 0;
  for (const line of lines) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number.parseInt(hunk[1] ?? "0", 10);
      result.push(null);
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      result.push(null); // deletion: no new-side line
      continue;
    }
    const isContentLine = newLine > 0 && (line.startsWith("+") ? !line.startsWith("+++") : !/^(diff |index |--- |\+\+\+ |new file|deleted file|rename |similarity )/.test(line));
    if (isContentLine) {
      result.push(newLine);
      newLine++;
    } else {
      result.push(null);
    }
  }
  return result;
}

function classForLine(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "diff-line diff-filehdr";
  if (line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file") || line.startsWith("rename ") || line.startsWith("similarity ")) {
    return "diff-line diff-meta";
  }
  if (line.startsWith("@@")) return "diff-line diff-hunk";
  if (line.startsWith("+")) return "diff-line diff-add";
  if (line.startsWith("-")) return "diff-line diff-del";
  return "diff-line";
}

const STATUS_LABEL: Record<DiffStatus, string> = { modified: "M", added: "A", deleted: "D", renamed: "R" };

export function GitDiffView(props: GitDiffViewProps): JSX.Element {
  const { worktreePath, sendTargets, onSend } = props;
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [composerText, setComposerText] = useState("");
  const [composerOpen, setComposerOpen] = useState(false);
  const [focusSignal, setFocusSignal] = useState(0);
  // Floating "+ Add" at a diff-body selection, and the new-side line range it maps to.
  const [selMenu, setSelMenu] = useState<{ x: number; y: number } | null>(null);
  const [selRange, setSelRange] = useState<{ min: number; max: number } | null>(null);
  const diffBodyRef = useRef<HTMLDivElement | null>(null);
  const composerEnabled = sendTargets !== undefined && onSend !== undefined;

  useEffect(() => {
    setLoading(true);
    let cancelled = false;
    void window.agentCoordinator.system.gitDiff(worktreePath).then(
      (result) => {
        if (!cancelled) {
          setDiff(result);
          setLoading(false);
        }
      },
      () => {
        if (!cancelled) {
          setDiff("");
          setLoading(false);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [worktreePath, refreshKey]);

  const files = useMemo(() => (diff ? parseDiff(diff) : []), [diff]);
  const active = files.find((file) => file.path === selectedPath) ?? files[0] ?? null;
  const lineNumbers = useMemo(() => (active ? newSideLineNumbers(active.lines) : []), [active]);

  // On a text selection in the diff, find the new-side line range covered so
  // "Add" can send just that section (`path#Lstart-Lend`).
  function onDiffMouseUp(event: ReactMouseEvent): void {
    if (!composerEnabled || !active) return;
    const selection = window.getSelection();
    const body = diffBodyRef.current;
    if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !body) {
      setSelMenu(null);
      return;
    }
    const nums: number[] = [];
    body.querySelectorAll<HTMLElement>(".diff-line").forEach((el) => {
      const raw = el.dataset.line;
      if (raw && selection.containsNode(el, true)) nums.push(Number.parseInt(raw, 10));
    });
    if (nums.length === 0) {
      setSelMenu(null);
      return;
    }
    setSelRange({ min: Math.min(...nums), max: Math.max(...nums) });
    setSelMenu({ x: event.clientX, y: event.clientY });
  }

  function addDiffSelection(): void {
    if (!active || !selRange) return;
    const ref =
      selRange.min === selRange.max ? `${active.path}#L${selRange.min}` : `${active.path}#L${selRange.min}-L${selRange.max}`;
    setComposerText((current) => current + ref + "\n");
    setComposerOpen(true);
    setSelMenu(null);
    setFocusSignal((value) => value + 1);
  }

  return (
    <div className="diff-view">
      <div className="diff-toolbar">
        <span className="diff-title">
          Changes{files.length > 0 ? ` · ${files.length} file${files.length > 1 ? "s" : ""}` : ""}
        </span>
        <div className="diff-toolbar-actions">
          {composerEnabled && (
            <button
              type="button"
              className={`diff-refresh${composerOpen ? " active" : ""}`}
              onClick={() => setComposerOpen((value) => !value)}
            >
              Compose
            </button>
          )}
          <button type="button" className="diff-refresh" onClick={() => setRefreshKey((key) => key + 1)}>
            Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <div className="diff-empty">Loading…</div>
      ) : files.length === 0 ? (
        <div className="diff-empty">No changes in this worktree.</div>
      ) : (
        <div className="diff-split">
          <div className="diff-filelist">
            {files.map((file) => {
              const parts = file.path.split("/");
              const name = parts.pop() ?? file.path;
              const dir = parts.join("/");
              return (
                <button
                  key={file.path}
                  type="button"
                  className={`diff-fileitem${active?.path === file.path ? " active" : ""}`}
                  onClick={() => setSelectedPath(file.path)}
                  title={file.path}
                >
                  <span className={`diff-filestatus diff-status-${file.status}`}>{STATUS_LABEL[file.status]}</span>
                  <span className="diff-filelabel">
                    <span className="diff-fname">{name}</span>
                    {dir && <span className="diff-fdir">{dir}</span>}
                  </span>
                  <span className="diff-filestat">
                    <span className="diff-plus">+{file.additions}</span>
                    <span className="diff-minus">−{file.deletions}</span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="diff-body" ref={diffBodyRef} onMouseUp={onDiffMouseUp}>
            {active?.lines.map((line, index) => (
              <div key={index} className={classForLine(line)} data-line={lineNumbers[index] ?? undefined}>
                {line || " "}
              </div>
            ))}
          </div>
        </div>
      )}

      {selMenu && (
        <button
          type="button"
          className="sel-float"
          style={{ left: selMenu.x, top: selMenu.y - 38 }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={addDiffSelection}
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

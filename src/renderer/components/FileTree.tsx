import { useEffect, useState } from "react";
import type { SystemDirEntry } from "../../shared/ipc/contract";

interface FileTreeProps {
  rootPath: string;
  onOpenFile: (path: string) => void;
  // Bump to force a re-scan (pick up new/removed files without close+reopen).
  refreshKey?: number;
}

function ChevronIcon(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function FileGlyph(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 3v5h5" />
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    </svg>
  );
}

function TreeNode(props: {
  entry: SystemDirEntry;
  depth: number;
  refreshKey: number;
  onOpenFile: (path: string) => void;
}): JSX.Element {
  const { entry, depth, refreshKey, onOpenFile } = props;
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<SystemDirEntry[] | null>(null);

  // Fetch children whenever the folder is open — on first expand, on re-expand,
  // and on a refresh — so the listing is always current. Collapsed folders skip
  // the read (nothing to show), keeping this lazy.
  useEffect(() => {
    if (!expanded || !entry.isDirectory) return;
    let cancelled = false;
    void window.agentCoordinator.system.listDir(entry.path).then((list) => {
      if (!cancelled) setChildren(list);
    });
    return () => {
      cancelled = true;
    };
  }, [expanded, entry.isDirectory, entry.path, refreshKey]);

  const indent = { paddingLeft: `${6 + depth * 13}px` };

  if (!entry.isDirectory) {
    return (
      <button type="button" className="tree-row tree-file" style={indent} onClick={() => onOpenFile(entry.path)} title={entry.name}>
        <span className="tree-glyph tree-fileglyph">
          <FileGlyph />
        </span>
        <span className="tree-name">{entry.name}</span>
      </button>
    );
  }

  return (
    <div>
      <button type="button" className="tree-row" style={indent} onClick={() => setExpanded((value) => !value)} title={entry.name}>
        <span className={`tree-glyph tree-chevron${expanded ? " expanded" : ""}`}>
          <ChevronIcon />
        </span>
        <span className="tree-name">{entry.name}</span>
      </button>
      {expanded && children !== null && (
        <div>
          {children.map((child) => (
            <TreeNode key={child.path} entry={child} depth={depth + 1} refreshKey={refreshKey} onOpenFile={onOpenFile} />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileTree(props: FileTreeProps): JSX.Element {
  const { rootPath, onOpenFile, refreshKey = 0 } = props;
  const [entries, setEntries] = useState<SystemDirEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.agentCoordinator.system.listDir(rootPath).then((list) => {
      if (!cancelled) setEntries(list);
    });
    return () => {
      cancelled = true;
    };
  }, [rootPath, refreshKey]);

  return (
    <div className="filetree">
      {entries === null ? (
        <div className="tree-loading">Loading…</div>
      ) : entries.length === 0 ? (
        <div className="tree-loading">Empty</div>
      ) : (
        entries.map((entry) => <TreeNode key={entry.path} entry={entry} depth={0} refreshKey={refreshKey} onOpenFile={onOpenFile} />)
      )}
    </div>
  );
}

import { useEffect, useRef } from "react";

interface ProjectContextMenuProps {
  x: number;
  y: number;
  onRename: () => void;
  onOpenInFileManager: () => void;
  onOpenSettings: () => void;
  onRequestRemove: () => void;
  onClose: () => void;
}

export function ProjectContextMenu(props: ProjectContextMenuProps): JSX.Element {
  const { x, y, onRename, onOpenInFileManager, onOpenSettings, onRequestRemove, onClose } = props;
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent): void {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return (
    <div ref={menuRef} className="context-menu" style={{ top: y, left: x }}>
      <button type="button" onClick={onRename}>
        <span className="context-menu-icon">✎</span> Rename
      </button>
      <button type="button" onClick={onOpenInFileManager}>
        <span className="context-menu-icon">📁</span> Open in Finder
      </button>
      <button type="button" onClick={onOpenSettings}>
        <span className="context-menu-icon">⚙</span> Project Settings
      </button>
      <div className="context-menu-divider" />
      <button type="button" className="context-menu-danger" onClick={onRequestRemove}>
        <span className="context-menu-icon">✕</span> Close Project
      </button>
    </div>
  );
}

interface RemoveProjectConfirmDialogProps {
  projectName: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function RemoveProjectConfirmDialog(props: RemoveProjectConfirmDialogProps): JSX.Element {
  const { projectName, onConfirm, onCancel } = props;

  return (
    <div className="modal-overlay">
      <div className="modal">
        <p>
          Remove <strong>{projectName}</strong> from Agent Coordinator?
        </p>
        <p className="warning">This only removes it from the app. No files on disk are deleted.</p>
        <div className="modal-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="modal-confirm-danger" onClick={onConfirm}>
            Close project
          </button>
        </div>
      </div>
    </div>
  );
}

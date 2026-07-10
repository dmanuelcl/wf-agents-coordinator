import { useState } from "react";

function CopyGlyph(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}

function CheckGlyph(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function CopyButton(props: { value: string; label?: string }): JSX.Element {
  const { value, label = "Copy" } = props;
  const [copied, setCopied] = useState(false);

  function handleCopy(): void {
    void window.agentCoordinator.system.copyText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  }

  return (
    <button
      type="button"
      className={`copy-button${copied ? " copied" : ""}`}
      onClick={handleCopy}
      title={copied ? "Copied" : label}
      aria-label={label}
    >
      {copied ? <CheckGlyph /> : <CopyGlyph />}
    </button>
  );
}

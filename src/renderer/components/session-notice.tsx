import type { ReactNode } from "react";

export type SessionNoticeTone = "info" | "progress" | "success" | "warning" | "danger";

export function toneForReviewMessage(message: string): SessionNoticeTone {
  if (/\b(?:failed|error)\b/i.test(message)) return "danger";
  if (/✓|\b(?:posted|pushed)\b/i.test(message)) return "success";
  return "progress";
}

const NOTICE_ICON: Record<SessionNoticeTone, string> = {
  info: "i",
  progress: "",
  success: "✓",
  warning: "!",
  danger: "!",
};

export function SessionNotice(props: { tone: SessionNoticeTone; children: ReactNode }): JSX.Element {
  const { tone, children } = props;
  const urgent = tone === "warning" || tone === "danger";
  return (
    <div
      className={`session-notice session-notice-${tone}`}
      role={urgent ? "alert" : "status"}
      aria-live={urgent ? "assertive" : "polite"}
    >
      <span className="session-notice-icon" aria-hidden="true">
        {NOTICE_ICON[tone]}
      </span>
      <span className="session-notice-copy">{children}</span>
    </div>
  );
}

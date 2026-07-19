// Kimi Code CLI currently creates ids in the form `session_<uuid-v4>` and
// renders the id in its welcome/status UI. Keep extraction shared so the
// renderer and the persistence IPC validate exactly the same value.
const KIMI_SESSION_ID_SOURCE = "session_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const KIMI_SESSION_ID_RE = new RegExp(`^${KIMI_SESSION_ID_SOURCE}$`, "i");
const KIMI_SESSION_ID_IN_TEXT_RE = new RegExp(`\\b(${KIMI_SESSION_ID_SOURCE})\\b`, "i");

export function isKimiSessionId(value: string): boolean {
  return KIMI_SESSION_ID_RE.test(value);
}

export function findKimiSessionId(text: string): string | null {
  return KIMI_SESSION_ID_IN_TEXT_RE.exec(text)?.[1] ?? null;
}

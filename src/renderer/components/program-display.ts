import { normalizeRepoPath } from "../../shared/workflow/program-spec";
import type { ChildMerge, ProgramChildState, ProgramChildView, ProgramVerdict, ProgramVerdictKind } from "../../shared/workflow/program-verdict";
import type { SessionNoticeTone } from "./session-notice";

export type ProgramAction = { kind: "start"; index: number } | { kind: "adopt"; index: number } | { kind: "refresh" };

export interface ProgramBanner {
  tone: SessionNoticeTone;
  title: string;
  lines: string[];
  actions: ProgramAction[];
}

export interface RailBadge {
  symbol: string;
  tone: "danger" | "warning" | "ready";
  title: string;
}

/** The child whose checkpoint this session is bound to, if any. */
export function boundChild(verdict: ProgramVerdict, sessionCheckpointPath: string | null): ProgramChildView | null {
  if (!sessionCheckpointPath) return null;
  const bound = normalizeRepoPath(sessionCheckpointPath);
  return verdict.children.find((child) => child.checkpoint !== null && normalizeRepoPath(child.checkpoint) === bound) ?? null;
}

function hasMergeBlock(verdict: ProgramVerdict): boolean {
  return verdict.children.some((child) => child.merge !== null && child.merge.state !== "merged");
}

/**
 * What the session banner says, in order of what the developer must act on
 * first. The session that IS the child in progress gets no banner: the Log
 * panel shows the program; there is nothing to decide.
 */
export function programBanner(verdict: ProgramVerdict, sessionCheckpointPath: string | null): ProgramBanner | null {
  const bound = boundChild(verdict, sessionCheckpointPath);
  if (bound?.state === "IN_PROGRESS") return null;
  const open = verdict.children.find((child) => child.state === "IN_PROGRESS" && child.linked === true && child !== bound);
  if (open) {
    return {
      tone: "warning",
      title: sessionCheckpointPath
        ? `El hijo ${open.index} («${open.name}») está en curso y esta sesión mira otro checkpoint.`
        : `El hijo ${open.index} («${open.name}») ya tiene checkpoint: engancha esta sesión a él.`,
      lines: [],
      actions: [{ kind: "adopt", index: open.index }],
    };
  }
  if (hasMergeBlock(verdict)) {
    const lines = verdict.children.flatMap((child) => (child.merge?.reason ? [child.merge.reason] : []));
    return {
      tone: "danger",
      title: "⛔ Programa bloqueado: hay un hijo DONE que no está merjeado en develop.",
      lines: verdict.fetchNote ? [...lines, verdict.fetchNote] : lines,
      actions: [{ kind: "refresh" }],
    };
  }
  if (verdict.verdict === "BLOCKED") {
    return { tone: "warning", title: "Programa bloqueado.", lines: verdict.reasons, actions: [{ kind: "refresh" }] };
  }
  if (sessionCheckpointPath === null) {
    const waitingFor = verdict.next ? `del hijo ${verdict.next.index} («${verdict.next.name}»)` : "del hijo";
    return { tone: "info", title: `Esperando el checkpoint ${waitingFor}: el Architect lo escribe al cerrar el INIT.`, lines: [], actions: [] };
  }
  if (verdict.verdict === "READY" && verdict.next) {
    return {
      tone: "success",
      title: `▶ El hijo ${verdict.next.index} («${verdict.next.name}») puede empezar.`,
      lines: [],
      actions: [{ kind: "start", index: verdict.next.index }],
    };
  }
  return { tone: "success", title: "Programa completo: todos los hijos DONE y merjeados.", lines: [], actions: [] };
}

/** The Log panel always lets the developer re-check, whatever the banner offers. */
export function panelActions(banner: ProgramBanner | null): ProgramAction[] {
  const actions = banner?.actions ?? [];
  return actions.some((action) => action.kind === "refresh") ? actions : [...actions, { kind: "refresh" }];
}

export function programRailBadge(verdict: ProgramVerdict | null, sessionCheckpointPath: string | null): RailBadge | null {
  if (!verdict) return null;
  const banner = programBanner(verdict, sessionCheckpointPath);
  if (!banner) return null;
  if (banner.tone === "danger") return { symbol: "⛔", tone: "danger", title: banner.title };
  if (banner.tone === "warning") return { symbol: "⚠", tone: "warning", title: banner.title };
  if (banner.actions.some((action) => action.kind === "start")) return { symbol: "▶", tone: "ready", title: banner.title };
  return null;
}

export function mergeLabel(merge: ChildMerge | null): { text: string; className: string } | null {
  if (!merge) return null;
  if (merge.state === "merged") return { text: "✓ merjeado", className: "badge badge-done" };
  if (merge.state === "unmerged") return { text: "✗ sin merge", className: "badge badge-attention" };
  if (merge.state === "uncommitted") return { text: "✗ cierre sin commitear", className: "badge badge-attention" };
  return { text: "? sin verificar", className: "badge badge-attention" };
}

export function childStateClass(state: ProgramChildState): string {
  return state === "DONE" ? "badge badge-done" : "badge";
}

export function verdictBadgeClass(verdict: ProgramVerdictKind): string {
  return verdict === "BLOCKED" ? "badge badge-attention" : "badge badge-done";
}

export function checkedAgo(epochMs: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - epochMs) / 60_000);
  if (minutes < 1) return "hace menos de 1 min";
  if (minutes < 60) return `hace ${minutes} min`;
  return `hace ${Math.floor(minutes / 60)} h`;
}

/** Electron wraps a handler's error as "Error invoking remote method '<channel>': Error: <message>". */
export function ipcErrorMessage(caught: unknown): string {
  const message = caught instanceof Error ? caught.message : String(caught);
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}

/** Which session holds `ref` checked out (git allows a branch in one worktree only). */
export function sessionHoldingBranch<T extends { branch: string }>(sessions: readonly T[], ref: string): T | null {
  const local = ref.replace(/^origin\//, "");
  return sessions.find((session) => session.branch === ref || session.branch === local) ?? null;
}

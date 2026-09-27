import {
  buildSessionPrFixReviewerKickoff,
  getSessionPrFixGate,
  sessionPrFixLanes,
} from "../../shared/workflow/session-pr-fix";
import type { SessionAgentRole } from "../../shared/workflow/session-role-launch";
import type { PrLink, WorkSession } from "../../shared/workflow/work-session";
import type { ParsedCheckpoint } from "../../shared/workflow/workflow-types";
import type { ResolvedPr } from "../vcs/vcs-provider";
import { PR_CONTEXT_ARTIFACT } from "./session-registry";

export interface SessionPrFixActions {
  /** «PR fix» on a feature/fix session: its Reviewer reopens the DONE checkpoint with the PR's comments. */
  start(sessionId: string, url: string): Promise<WorkSession>;
}

/**
 * The in-place alternative to a PR-fix session. Everything that can refuse runs
 * before the session record changes or an agent launches, and nothing trusts
 * what the UI showed: the checkpoint is re-read here.
 */
export function createSessionPrFixActions(deps: {
  getSession(sessionId: string): Promise<WorkSession | null>;
  readCheckpoint(session: WorkSession): Promise<ParsedCheckpoint | null>;
  resolvePr(projectId: string, url: string): Promise<ResolvedPr>;
  /** Fetch, then report the worktree HEAD and whether it contains `sha`. */
  worktreeHead(session: WorkSession, sha: string): Promise<{ head: string; contains: boolean }>;
  /** Write the PR conversation into the worktree's gitignored context file. */
  writePrContext(session: WorkSession): Promise<{ comments: number; loadError: string | null }>;
  setSessionPr(params: { sessionId: string; pr: PrLink }): Promise<WorkSession>;
  resetAutopilot(sessionId: string): Promise<void>;
  runCommand(sessionId: string, role: SessionAgentRole, lane: string, command: string): Promise<void>;
  broadcastSession(session: WorkSession): void;
}): SessionPrFixActions {
  return {
    async start(sessionId, url) {
      const session = await deps.getSession(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);
      const checkpoint = await deps.readCheckpoint(session);
      const gate = getSessionPrFixGate(session, checkpoint);
      if (!gate.allowed || !checkpoint || !session.checkpointPath) throw new Error(gate.reason ?? "PR fix is not available.");

      const resolved = await deps.resolvePr(session.projectId, url.trim());
      if (resolved.source !== session.branch) {
        throw new Error(
          `PR #${resolved.prId} comes from \`${resolved.source}\` and this session works on \`${session.branch}\`. Use New session → PR fix for a PR from another branch.`,
        );
      }
      const { head, contains } = await deps.worktreeHead(session, resolved.headSha);
      if (resolved.headSha && !contains) {
        throw new Error(
          `The worktree does not contain the PR head (${resolved.headSha.slice(0, 7)}): the branch moved on the remote. Pull it in this session, then start the PR fix again.`,
        );
      }

      const samePr = session.pr?.host === resolved.host && session.pr.workspace === resolved.workspace &&
        session.pr.repo === resolved.repo && session.pr.prId === resolved.prId;
      const pr: PrLink = {
        host: resolved.host,
        workspace: resolved.workspace,
        repo: resolved.repo,
        prId: resolved.prId,
        url: resolved.url,
        lastReviewedSha: samePr ? (session.pr?.lastReviewedSha ?? null) : null,
        fixBaseSha: head,
      };

      // The Reviewer's only input is this file: without the conversation there is nothing to reopen with.
      const context = await deps.writePrContext({ ...session, pr });
      if (context.loadError) throw new Error(`Could not download the PR comments: ${context.loadError}`);
      if (context.comments === 0) throw new Error(`PR #${resolved.prId} has no comments to fix.`);

      const updated = await deps.setSessionPr({ sessionId, pr });
      await deps.resetAutopilot(sessionId);
      deps.broadcastSession(updated);

      const lanes = sessionPrFixLanes(checkpoint.kind);
      const command = buildSessionPrFixReviewerKickoff({
        prId: resolved.prId,
        title: resolved.title,
        source: resolved.source,
        target: resolved.target,
        contextFile: PR_CONTEXT_ARTIFACT,
        checkpointPath: session.checkpointPath,
        checkpointKind: checkpoint.kind,
        program: checkpoint.program,
        baselineSha: head,
      });
      await deps.runCommand(sessionId, "reviewer", lanes.reviewer, command);
      return updated;
    },
  };
}

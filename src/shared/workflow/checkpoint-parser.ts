import type {
  CorrectionPlan,
  FindingStatus,
  FindingCounts,
  LedgerRow,
  ParsedCheckpoint,
  WorkflowFinding,
  WorkflowKind,
  WorkflowNext,
  WorkflowRole,
  WorkflowStatus,
} from "./workflow-types";

const KNOWN_ROLES: readonly WorkflowRole[] = ["architect", "implementer", "reviewer"];
const KNOWN_ROLE_SET = new Set<string>(KNOWN_ROLES);
const KNOWN_STATUSES: readonly WorkflowStatus[] = ["IN_PROGRESS", "BLOCKED", "DONE"];
const KNOWN_STATUS_SET = new Set<string>(KNOWN_STATUSES);
const ROLE_LABELS = new Set(["rol", "role"]);
const TASK_LABELS = new Set(["tarea", "task"]);
const TIER_LABELS = new Set(["abre sesion fresca en", "open fresh session in"]);

function isWorkflowRole(value: string): value is WorkflowRole {
  return KNOWN_ROLE_SET.has(value);
}

function isWorkflowStatus(value: string): value is WorkflowStatus {
  return KNOWN_STATUS_SET.has(value);
}

interface Sections {
  next: string | null;
  ledger: string | null;
  log: string | null;
}

const COMBINING_DIACRITICS_PATTERN = new RegExp("[\\u0300-\\u036f]", "g");

function normalizeLabel(label: string): string {
  return label
    .normalize("NFD")
    .replace(COMBINING_DIACRITICS_PATTERN, "")
    .toLowerCase()
    .trim();
}

function parseFrontmatterLines(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    const value = line
      .slice(colonIndex + 1)
      .replace(/\s+#.*$/, "")
      .trim();
    result[key] = value;
  }
  return result;
}

function splitFrontmatter(markdown: string): { frontmatter: Record<string, string>; body: string } {
  const lines = markdown.split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== "---") {
    return { frontmatter: {}, body: markdown };
  }
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (endIndex === -1) {
    return { frontmatter: {}, body: markdown };
  }
  const frontmatter = parseFrontmatterLines(lines.slice(1, endIndex).join("\n"));
  const body = lines.slice(endIndex + 1).join("\n");
  return { frontmatter, body };
}

function splitSections(body: string): Sections {
  const lines = body.split(/\r?\n/);
  const markers: { kind: keyof Sections; index: number }[] = [];

  lines.forEach((line, index) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("# ▶ NEXT")) {
      markers.push({ kind: "next", index });
    } else if (trimmed.startsWith("# Plans ledger")) {
      markers.push({ kind: "ledger", index });
    } else if (trimmed.startsWith("# Log")) {
      markers.push({ kind: "log", index });
    }
  });

  const sections: Sections = { next: null, ledger: null, log: null };
  markers.forEach((marker, i) => {
    const nextMarker = markers[i + 1];
    const end = nextMarker ? nextMarker.index : lines.length;
    sections[marker.kind] = lines.slice(marker.index + 1, end).join("\n");
  });

  return sections;
}

function roleFromCommand(command: string | null): WorkflowRole | null {
  if (!command) return null;
  const match = command.match(/^wf\s+(\S+)/);
  const verb = match?.[1];
  if (verb === "implement") return "implementer";
  if (verb === "verify" || verb === "fix") return "architect";
  if (verb === "review") return "reviewer";
  return null;
}

function parseNextSection(sectionText: string): { next: WorkflowNext; warnings: string[] } {
  const warnings: string[] = [];
  let roleValue: string | null = null;
  let taskValue: string | null = null;
  let tierValue: string | null = null;

  for (const rawLine of sectionText.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(/^-\s*\*\*(.+?):\*\*\s*(.*)$/);
    if (!match) continue;
    const label = normalizeLabel(match[1] ?? "");
    const value = (match[2] ?? "").trim();
    if (ROLE_LABELS.has(label)) {
      roleValue = value;
    } else if (TASK_LABELS.has(label)) {
      taskValue = value;
    } else if (TIER_LABELS.has(label)) {
      tierValue = value;
    }
  }

  const commandMatch = sectionText.match(/`(wf\s[^`]*)`/);
  const command = commandMatch ? (commandMatch[1] ?? "").trim() : null;

  const cwdMatch = sectionText.match(/cwd\s*`([^`]*)`/);
  const cwd = cwdMatch ? (cwdMatch[1] ?? "").trim() : null;
  if (!cwd) {
    warnings.push("NEXT block is missing a cwd value.");
  }

  let role: WorkflowRole | "unknown" = "unknown";
  if (roleValue) {
    const normalizedRole = roleValue.toLowerCase().trim();
    if (isWorkflowRole(normalizedRole)) {
      role = normalizedRole;
    } else {
      warnings.push(`NEXT role "${roleValue}" is not a known role.`);
    }
  } else {
    const derived = roleFromCommand(command);
    if (derived) {
      role = derived;
      warnings.push("NEXT role label is missing; derived role from the command instead.");
    } else {
      warnings.push("NEXT role is missing and could not be derived from the command.");
    }
  }

  return {
    next: {
      role,
      command,
      cwd,
      tier: tierValue,
      task: taskValue,
      rawMarkdown: sectionText.trim(),
    },
    warnings,
  };
}

function parseLedgerSection(sectionText: string): LedgerRow[] {
  const tableLines: string[] = [];
  let inTable = false;

  for (const rawLine of sectionText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("|")) {
      inTable = true;
      tableLines.push(line);
    } else if (inTable) {
      break;
    }
  }

  const dataLines = tableLines.slice(2);

  return dataLines.map((line) => {
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells[0] === "") cells.shift();
    if (cells[cells.length - 1] === "") cells.pop();

    return {
      index: cells[0] ?? "",
      plan: cells[1] ?? "",
      implement: cells[2] ?? "",
      archReview: cells[3] ?? "",
      prReview: cells[4] ?? "",
      state: cells[cells.length - 1] ?? "",
      rawCells: cells,
    };
  });
}

function extractLatestLog(sectionText: string): string | null {
  const lines = sectionText.split(/\r?\n/);
  let lastHeadingIndex = -1;
  lines.forEach((line, index) => {
    if (line.trim().startsWith("## ")) {
      lastHeadingIndex = index;
    }
  });
  if (lastHeadingIndex === -1) return null;
  const latest = lines.slice(lastHeadingIndex).join("\n").trim();
  return latest.length > 0 ? latest : null;
}

interface MarkdownHeading {
  index: number;
  level: number;
  title: string;
}

function markdownHeading(line: string, index: number): MarkdownHeading | null {
  const match = line.trimStart().match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
  if (!match) return null;
  return {
    index,
    level: (match[1] ?? "").length,
    title: (match[2] ?? "").trim(),
  };
}

function isFence(line: string): boolean {
  return /^\s*(`{3,}|~{3,})/.test(line);
}

function extractLatestCorrectionPlan(sectionText: string): CorrectionPlan | null {
  const lines = sectionText.split(/\r?\n/);
  let inFence = false;
  const correctionPlanHeadings: MarkdownHeading[] = [];

  lines.forEach((line, index) => {
    if (isFence(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const heading = markdownHeading(line, index);
    if (heading && normalizeLabel(heading.title).startsWith("plan de correccion")) {
      correctionPlanHeadings.push(heading);
    }
  });

  const latest = correctionPlanHeadings.at(-1);
  if (!latest) return null;

  let endIndex = lines.length;
  inFence = false;
  for (let index = latest.index + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (isFence(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = markdownHeading(line, index);
    if (heading && heading.level <= latest.level) {
      endIndex = index;
      break;
    }
  }

  return {
    title: latest.title,
    markdown: lines.slice(latest.index + 1, endIndex).join("\n").trim(),
  };
}

function findingStatus(checked: boolean, text: string): FindingStatus {
  const explicit = text.match(/^(PENDING|RESOLVED|OBSOLETE)\b/i)?.[1]?.toUpperCase();
  if (explicit === "PENDING" || explicit === "RESOLVED" || explicit === "OBSOLETE") {
    return explicit;
  }
  return checked ? "RESOLVED" : "PENDING";
}

function planFromLogHeading(heading: MarkdownHeading): string | null {
  const numberedPlan = heading.title.match(/\bPlan-(\d+)\b/i)?.[1];
  if (numberedPlan) return `Plan-${numberedPlan}`;
  return /\bfix-brief\b/i.test(heading.title) ? "fix-brief" : null;
}

function parseFindings(sectionText: string): { findings: WorkflowFinding[]; counts: FindingCounts } {
  const byScopedId = new Map<string, WorkflowFinding>();
  let inFence = false;
  let currentPlan: string | null = null;

  for (const line of sectionText.split(/\r?\n/)) {
    if (isFence(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const heading = markdownHeading(line, 0);
    if (heading?.level === 2) {
      currentPlan = planFromLogHeading(heading);
    }

    const match = line.match(/^\s*-\s*\[([ xX])\]\s*([IV]\d+)\b(.*)$/i);
    if (!match) continue;
    const id = (match[2] ?? "").toUpperCase();
    const remainder = (match[3] ?? "").trim();
    const scopedId = `${currentPlan ?? "checkpoint"}:${id}`;
    byScopedId.set(scopedId, {
      plan: currentPlan,
      id,
      status: findingStatus((match[1] ?? "").toLowerCase() === "x", remainder),
      summary: remainder.replace(/^[-—:]\s*/, ""),
    });
  }

  const findings = Array.from(byScopedId.values());
  const open = findings.filter((finding) => finding.status === "PENDING").length;
  const closed = findings.length - open;
  return { findings, counts: { open, closed, total: findings.length } };
}

export function parseCheckpointMarkdown(params: { checkpointPath: string; markdown: string }): ParsedCheckpoint {
  const { checkpointPath, markdown } = params;
  const warnings: string[] = [];

  const { frontmatter, body } = splitFrontmatter(markdown);

  const kindRaw = frontmatter["kind"];
  const kind: WorkflowKind = kindRaw === "feature" || kindRaw === "fix" ? kindRaw : "unknown";

  const statusRaw = frontmatter["status"] ?? "";
  const status: WorkflowStatus = isWorkflowStatus(statusRaw) ? statusRaw : "UNKNOWN";

  const activeRaw = frontmatter["active"] ?? "";
  let activeRole: WorkflowRole | "none" | "unknown" = "unknown";
  if (activeRaw === "none") {
    activeRole = "none";
  } else if (isWorkflowRole(activeRaw)) {
    activeRole = activeRaw;
  }

  const sections = splitSections(body);

  let next: WorkflowNext | null = null;
  if (sections.next !== null) {
    const parsed = parseNextSection(sections.next);
    next = parsed.next;
    warnings.push(...parsed.warnings);
  } else {
    warnings.push("Checkpoint is missing a # ▶ NEXT section.");
  }

  let ledgerRows: LedgerRow[] = [];
  if (sections.ledger !== null) {
    ledgerRows = parseLedgerSection(sections.ledger);
  } else {
    warnings.push("Checkpoint is missing a # Plans ledger section.");
  }

  let latestLogMarkdown: string | null = null;
  let correctionPlan: CorrectionPlan | null = null;
  let findings: WorkflowFinding[] = [];
  let findingCounts: FindingCounts = { open: 0, closed: 0, total: 0 };
  if (sections.log !== null) {
    latestLogMarkdown = extractLatestLog(sections.log);
    correctionPlan = extractLatestCorrectionPlan(sections.log);
    const parsedFindings = parseFindings(sections.log);
    findings = parsedFindings.findings;
    findingCounts = parsedFindings.counts;
    if (latestLogMarkdown === null) {
      warnings.push("Log section has no ## entries.");
    }
  } else {
    warnings.push("Checkpoint is missing a # Log section.");
  }

  return {
    checkpointPath,
    frontmatter,
    feature: frontmatter["feature"] ?? null,
    slug: frontmatter["slug"] ?? null,
    kind,
    branch: frontmatter["branch"] ?? null,
    worktree: frontmatter["worktree"] ?? null,
    status,
    activeRole,
    next,
    ledgerRows,
    correctionPlan,
    findings,
    findingCounts,
    latestLogMarkdown,
    warnings,
  };
}

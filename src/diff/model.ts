import type {
  SessionEntry,
  SessionMessageEntry,
} from "@mariozechner/pi-coding-agent";

export interface DiffStats {
  additions: number;
  removals: number;
}

export type ReviewModeKind =
  | "session-turns"
  | "git-changes"
  | "git-branch-main"
  | "git-branch-selected";

export interface ReviewModeInfo {
  kind: ReviewModeKind;
  label: string;
  description?: string;
  baseRef?: string;
  emptyTitle: string;
  emptyHint?: string;
}

export const SESSION_TURNS_REVIEW_MODE: ReviewModeInfo = {
  kind: "session-turns",
  label: "Session turns",
  description: "pi session edit/write history by user turn",
  emptyTitle: "No edit/write changes found in this session tree.",
  emptyHint: "Make a file change with edit/write, then reopen /diff.",
};

export interface ReviewHunk extends DiffStats {
  id: string;
  turnId: string;
  fileId: string;
  path: string;
  entryId: string;
  toolCallId: string;
  toolName: "edit" | "write" | "apply_patch" | "git";
  oldStart: number | undefined;
  oldLines: number | undefined;
  newStart: number | undefined;
  newLines: number | undefined;
  jumpLine: number;
  bodyLines: string[];
}

export interface ReviewFile extends DiffStats {
  id: string;
  turnId: string;
  path: string;
  hunks: ReviewHunk[];
}

export interface ReviewTurn extends DiffStats {
  id: string;
  ordinal: number;
  userEntryId: string;
  parentEntryId: string | null;
  timestamp: string;
  prompt: string;
  files: ReviewFile[];
  children: ReviewTurn[];
}

export interface ReviewModel extends DiffStats {
  mode: ReviewModeInfo;
  /** All diff-producing user turns in traversal order. */
  turns: ReviewTurn[];
  /** Diff-producing user turns arranged by compressed pi session-tree ancestry. */
  roots: ReviewTurn[];
  /** Diff-producing turn ids that are on the current active pi branch. */
  activeTurnIds: string[];
  totalFiles: number;
  totalHunks: number;
}

export interface ReviewSessionTreeNode {
  entry: SessionEntry;
  children: ReviewSessionTreeNode[];
}

interface ToolCallInfo {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

interface MutableReviewTurn extends DiffStats {
  id: string;
  ordinal: number;
  userEntryId: string;
  parentEntryId: string | null;
  timestamp: string;
  prompt: string;
  files: ReviewFile[];
  children: MutableReviewTurn[];
  fileByPath: Map<string, ReviewFile>;
}

interface EditDetails {
  diff: string;
  firstChangedLine?: number;
}

type SessionMutationToolName = "edit" | "write" | "apply_patch";

type MutableReviewHunk = Omit<ReviewHunk, "fileId">;

const MAX_WRITE_PREVIEW_LINES = 80;

export function buildReviewModel(
  entries: readonly SessionEntry[],
  activeLeafId?: string | null,
): ReviewModel {
  return buildReviewModelFromEntries(entries, activeLeafId);
}

export function buildReviewModelFromTree(
  tree: readonly ReviewSessionTreeNode[],
  activeLeafId?: string | null,
): ReviewModel {
  return buildReviewModelFromEntries(flattenSessionTree(tree), activeLeafId);
}

function buildReviewModelFromEntries(
  entries: readonly SessionEntry[],
  activeLeafId: string | null | undefined,
): ReviewModel {
  const byId = new Map<string, SessionEntry>();
  const toolCalls = new Map<string, ToolCallInfo>();
  const turnByUserEntryId = new Map<string, MutableReviewTurn>();
  let userMessageCount = 0;

  for (const entry of entries) {
    byId.set(entry.id, entry);
    if (entry.type !== "message") continue;

    if (entry.message.role === "user") {
      userMessageCount += 1;
      turnByUserEntryId.set(entry.id, createTurn(entry, userMessageCount));
      continue;
    }

    if (entry.message.role === "assistant") {
      for (const toolCall of extractToolCalls(entry.message.content)) {
        toolCalls.set(toolCall.id, toolCall);
      }
    }
  }

  for (const entry of entries) {
    if (!isMutationToolResultEntry(entry)) continue;

    const turn = findNearestUserTurn(entry, byId, turnByUserEntryId);
    if (!turn) continue;

    const toolCall = toolCalls.get(entry.message.toolCallId);
    const args = toolCall?.name === entry.message.toolName ? toolCall.args : {};
    const hunks = hunksFromMutation(entry, turn.id, args);

    if (hunks.length === 0) continue;

    for (const hunk of hunks) {
      const file = getOrCreateFile(turn, hunk.path);
      const finalizedHunk: ReviewHunk = {
        ...hunk,
        fileId: file.id,
      };
      file.hunks.push(finalizedHunk);
      addStats(file, finalizedHunk);
      addStats(turn, finalizedHunk);
    }
  }

  const visibleTurns = [...turnByUserEntryId.values()].filter(
    (turn) => turn.files.length > 0,
  );
  const roots = connectDiffTurnTree(visibleTurns, byId);
  const activeTurnIds = findActiveTurnIds(activeLeafId, byId, visibleTurns);
  const { turns, roots: immutableRoots } = stripMutableTurns(
    visibleTurns,
    roots,
  );

  return {
    mode: SESSION_TURNS_REVIEW_MODE,
    turns,
    roots: immutableRoots,
    activeTurnIds,
    totalFiles: countUniqueFiles(visibleTurns),
    totalHunks: countHunks(visibleTurns),
    additions: visibleTurns.reduce((total, turn) => total + turn.additions, 0),
    removals: visibleTurns.reduce((total, turn) => total + turn.removals, 0),
  };
}

function flattenSessionTree(
  tree: readonly ReviewSessionTreeNode[],
): SessionEntry[] {
  const entries: SessionEntry[] = [];
  const stack = [...tree].reverse();
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    entries.push(node.entry);
    for (let index = node.children.length - 1; index >= 0; index--) {
      const child = node.children[index];
      if (child) stack.push(child);
    }
  }
  return entries;
}

function isMutationToolResultEntry(
  entry: SessionEntry,
): entry is SessionMessageEntry & {
  message: Extract<SessionMessageEntry["message"], { role: "toolResult" }> & {
    toolName: SessionMutationToolName;
  };
} {
  return (
    entry.type === "message" &&
    entry.message.role === "toolResult" &&
    !entry.message.isError &&
    (entry.message.toolName === "edit" ||
      entry.message.toolName === "write" ||
      entry.message.toolName === "apply_patch")
  );
}

function findNearestUserTurn(
  entry: SessionEntry,
  byId: ReadonlyMap<string, SessionEntry>,
  turnByUserEntryId: ReadonlyMap<string, MutableReviewTurn>,
): MutableReviewTurn | undefined {
  let currentId = entry.parentId;
  while (currentId) {
    const current = byId.get(currentId);
    if (!current) return undefined;
    if (current.type === "message" && current.message.role === "user") {
      const turn = turnByUserEntryId.get(current.id);
      if (turn) return turn;
    }
    currentId = current.parentId;
  }
  return undefined;
}

function connectDiffTurnTree(
  visibleTurns: readonly MutableReviewTurn[],
  byId: ReadonlyMap<string, SessionEntry>,
): MutableReviewTurn[] {
  const visibleByUserEntryId = new Map(
    visibleTurns.map((turn) => [turn.userEntryId, turn] as const),
  );
  const roots: MutableReviewTurn[] = [];

  for (const turn of visibleTurns) {
    turn.children = [];
  }

  for (const turn of visibleTurns) {
    const parent = findNearestDiffAncestor(turn, visibleByUserEntryId, byId);
    if (parent) {
      parent.children.push(turn);
    } else {
      roots.push(turn);
    }
  }

  return roots;
}

function findNearestDiffAncestor(
  turn: MutableReviewTurn,
  visibleByUserEntryId: ReadonlyMap<string, MutableReviewTurn>,
  byId: ReadonlyMap<string, SessionEntry>,
): MutableReviewTurn | undefined {
  let currentId = turn.parentEntryId;
  while (currentId) {
    const current = byId.get(currentId);
    if (!current) return undefined;
    if (current.type === "message" && current.message.role === "user") {
      const ancestor = visibleByUserEntryId.get(current.id);
      if (ancestor) return ancestor;
    }
    currentId = current.parentId;
  }
  return undefined;
}

function findActiveTurnIds(
  activeLeafId: string | null | undefined,
  byId: ReadonlyMap<string, SessionEntry>,
  visibleTurns: readonly MutableReviewTurn[],
): string[] {
  if (!activeLeafId) return [];

  const visibleByUserEntryId = new Map(
    visibleTurns.map((turn) => [turn.userEntryId, turn] as const),
  );
  const activeTurnIds: string[] = [];
  let currentId: string | null = activeLeafId;

  while (currentId) {
    const current = byId.get(currentId);
    if (!current) break;
    if (current.type === "message" && current.message.role === "user") {
      const turn = visibleByUserEntryId.get(current.id);
      if (turn) activeTurnIds.push(turn.id);
    }
    currentId = current.parentId;
  }

  return activeTurnIds.reverse();
}

function stripMutableTurns(
  visibleTurns: readonly MutableReviewTurn[],
  roots: readonly MutableReviewTurn[],
): { turns: ReviewTurn[]; roots: ReviewTurn[] } {
  const cache = new Map<string, ReviewTurn>();
  const strip = (turn: MutableReviewTurn): ReviewTurn => {
    const cached = cache.get(turn.id);
    if (cached) return cached;

    const stripped: ReviewTurn = {
      id: turn.id,
      ordinal: turn.ordinal,
      userEntryId: turn.userEntryId,
      parentEntryId: turn.parentEntryId,
      timestamp: turn.timestamp,
      prompt: turn.prompt,
      files: turn.files,
      children: [],
      additions: turn.additions,
      removals: turn.removals,
    };
    cache.set(turn.id, stripped);
    stripped.children = turn.children.map(strip);
    return stripped;
  };

  return {
    turns: visibleTurns.map(strip),
    roots: roots.map(strip),
  };
}

function countUniqueFiles(turns: readonly MutableReviewTurn[]): number {
  const paths = new Set<string>();
  for (const turn of turns) {
    for (const file of turn.files) {
      paths.add(file.path);
    }
  }
  return paths.size;
}

function countHunks(turns: readonly MutableReviewTurn[]): number {
  let count = 0;
  for (const turn of turns) {
    for (const file of turn.files) {
      count += file.hunks.length;
    }
  }
  return count;
}

function createTurn(
  entry: SessionMessageEntry,
  ordinal: number,
): MutableReviewTurn {
  return {
    id: `turn:${entry.id}`,
    ordinal,
    userEntryId: entry.id,
    parentEntryId: entry.parentId,
    timestamp: entry.timestamp,
    prompt: normalizePromptText(
      entry.message.role === "user" ? extractText(entry.message.content) : "",
    ),
    files: [],
    children: [],
    fileByPath: new Map<string, ReviewFile>(),
    additions: 0,
    removals: 0,
  };
}

function getOrCreateFile(turn: MutableReviewTurn, path: string): ReviewFile {
  const existing = turn.fileByPath.get(path);
  if (existing) return existing;

  const file: ReviewFile = {
    id: `${turn.id}:file:${turn.files.length}:${path}`,
    turnId: turn.id,
    path,
    hunks: [],
    additions: 0,
    removals: 0,
  };
  turn.fileByPath.set(path, file);
  turn.files.push(file);
  return file;
}

function hunksFromMutation(
  entry: SessionMessageEntry & {
    message: Extract<SessionMessageEntry["message"], { role: "toolResult" }> & {
      toolName: SessionMutationToolName;
    };
  },
  turnId: string,
  args: Record<string, unknown>,
): MutableReviewHunk[] {
  const path = getString(args.path) ?? getString(args.file_path);
  if (entry.message.toolName === "edit") {
    return path ? hunksFromEdit(entry, turnId, path) : [];
  }
  if (entry.message.toolName === "write") {
    return path ? hunksFromWrite(entry, turnId, path, args) : [];
  }
  return hunksFromApplyPatch(entry, turnId, args);
}

function hunksFromEdit(
  entry: SessionMessageEntry,
  turnId: string,
  path: string,
): MutableReviewHunk[] {
  const message = entry.message;
  if (message.role !== "toolResult" || message.toolName !== "edit") return [];

  const details = isEditDetails(message.details) ? message.details : undefined;
  if (!details?.diff.trim()) return [];

  return parsePiEditDiff(details.diff, {
    turnId,
    path,
    entryId: entry.id,
    toolCallId: message.toolCallId,
    toolName: "edit",
    fallbackJumpLine: details.firstChangedLine ?? 1,
  });
}

function hunksFromWrite(
  entry: SessionMessageEntry,
  turnId: string,
  path: string,
  args: Record<string, unknown>,
): MutableReviewHunk[] {
  const message = entry.message;
  if (message.role !== "toolResult" || message.toolName !== "write") return [];

  const content = getString(args.content);
  if (content === undefined) return [];

  const allLines = splitDisplayLines(content);
  const previewLines = allLines.slice(0, MAX_WRITE_PREVIEW_LINES);
  const omitted = allLines.length - previewLines.length;
  const lineNumberWidth = String(Math.max(1, allLines.length)).length;
  const bodyLines = previewLines.map(
    (line, index) =>
      `+${String(index + 1).padStart(lineNumberWidth, " ")} ${line}`,
  );
  if (omitted > 0) {
    bodyLines.push(
      ` ${"".padStart(lineNumberWidth, " ")} ... (${omitted} more lines)`,
    );
  }

  const additions = allLines.length;
  return [
    {
      id: `${entry.id}:write:0`,
      turnId,
      path,
      entryId: entry.id,
      toolCallId: message.toolCallId,
      toolName: "write",
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: allLines.length,
      jumpLine: 1,
      bodyLines,
      additions,
      removals: 0,
    },
  ];
}

function hunksFromApplyPatch(
  entry: SessionMessageEntry,
  turnId: string,
  args: Record<string, unknown>,
): MutableReviewHunk[] {
  const message = entry.message;
  if (message.role !== "toolResult" || message.toolName !== "apply_patch") {
    return [];
  }

  const input = getString(args.input) ?? getString(args.patch);
  if (!input?.trim()) return [];

  return parseApplyPatch(input, {
    turnId,
    entryId: entry.id,
    toolCallId: message.toolCallId,
  });
}

interface ApplyPatchContext {
  turnId: string;
  entryId: string;
  toolCallId: string;
}

type ApplyPatchSectionKind = "add" | "update" | "delete";

interface MutableApplyPatchSection {
  kind: ApplyPatchSectionKind;
  path: string;
  bodyLines: string[];
  hunkStartLine: number;
}

function parseApplyPatch(
  patch: string,
  context: ApplyPatchContext,
): MutableReviewHunk[] {
  const hunks: MutableReviewHunk[] = [];
  let current: MutableApplyPatchSection | undefined;

  const flushCurrent = (): void => {
    if (!current || !segmentHasChange(current.bodyLines)) return;
    hunks.push(applyPatchSectionToHunk(current, hunks.length, context));
  };

  for (const line of splitDisplayLines(patch)) {
    const nextSection = parseApplyPatchSectionHeader(line);
    if (nextSection) {
      flushCurrent();
      current = {
        ...nextSection,
        bodyLines: [],
        hunkStartLine: 1,
      };
      continue;
    }

    if (!current) continue;
    if (line.startsWith("*** ")) {
      flushCurrent();
      current = undefined;
      continue;
    }

    if (current.kind === "update" && line.startsWith("@@")) {
      flushCurrent();
      current.bodyLines = [];
      current.hunkStartLine = parseApplyPatchHunkStart(line) ?? 1;
      continue;
    }

    if (isApplyPatchBodyLine(line)) {
      current.bodyLines.push(line);
    }
  }

  flushCurrent();
  return hunks;
}

function parseApplyPatchSectionHeader(
  line: string,
): { kind: ApplyPatchSectionKind; path: string } | undefined {
  const addPath = parseApplyPatchHeaderPath(line, "*** Add File: ");
  if (addPath) return { kind: "add", path: addPath };

  const updatePath = parseApplyPatchHeaderPath(line, "*** Update File: ");
  if (updatePath) return { kind: "update", path: updatePath };

  const deletePath = parseApplyPatchHeaderPath(line, "*** Delete File: ");
  if (deletePath) return { kind: "delete", path: deletePath };

  return undefined;
}

function parseApplyPatchHeaderPath(
  line: string,
  prefix: "*** Add File: " | "*** Update File: " | "*** Delete File: ",
): string | undefined {
  if (!line.startsWith(prefix)) return undefined;
  const path = line.slice(prefix.length).trim();
  return path || undefined;
}

function parseApplyPatchHunkStart(line: string): number | undefined {
  const match = /^@@\s+(\d+)/u.exec(line);
  if (!match?.[1]) return undefined;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isApplyPatchBodyLine(line: string): boolean {
  return line.startsWith("+") || line.startsWith("-") || line.startsWith(" ");
}

function applyPatchSectionToHunk(
  section: MutableApplyPatchSection,
  index: number,
  context: ApplyPatchContext,
): MutableReviewHunk {
  const additions = section.bodyLines.filter((line) =>
    line.startsWith("+"),
  ).length;
  const removals = section.bodyLines.filter((line) =>
    line.startsWith("-"),
  ).length;
  const contextLines = section.bodyLines.filter((line) =>
    line.startsWith(" "),
  ).length;
  const newLines =
    section.kind === "delete" ? 0 : Math.max(1, additions + contextLines);
  const oldLines =
    section.kind === "add" ? 0 : Math.max(1, removals + contextLines);

  return {
    id: `${context.entryId}:apply_patch:${index}`,
    turnId: context.turnId,
    path: section.path,
    entryId: context.entryId,
    toolCallId: context.toolCallId,
    toolName: "apply_patch",
    oldStart: section.kind === "add" ? 0 : section.hunkStartLine,
    oldLines,
    newStart: section.kind === "delete" ? 0 : section.hunkStartLine,
    newLines,
    jumpLine: Math.max(1, section.hunkStartLine),
    bodyLines: section.bodyLines,
    additions,
    removals,
  };
}

interface ParseDiffContext {
  turnId: string;
  path: string;
  entryId: string;
  toolCallId: string;
  toolName: "edit";
  fallbackJumpLine: number;
}

function parsePiEditDiff(
  diff: string,
  context: ParseDiffContext,
): MutableReviewHunk[] {
  const lines = diff.split("\n");
  const segments: string[][] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (isElisionLine(line)) {
      if (segmentHasChange(current)) {
        segments.push(current);
      }
      current = [];
      continue;
    }
    current.push(line);
  }
  if (segmentHasChange(current)) {
    segments.push(current);
  }

  return segments.map((segment, index) =>
    segmentToHunk(segment, index, context),
  );
}

function segmentToHunk(
  segment: string[],
  index: number,
  context: ParseDiffContext,
): MutableReviewHunk {
  let additions = 0;
  let removals = 0;
  let firstNew: number | undefined;
  let lastNew: number | undefined;
  let firstAdded: number | undefined;
  let lastAdded: number | undefined;
  let firstOld: number | undefined;
  let lastOld: number | undefined;
  let firstRemoved: number | undefined;
  let lastRemoved: number | undefined;

  for (const line of segment) {
    const marker = line[0];
    const lineNumber = parseDiffLineNumber(line);
    if (marker === "+") {
      additions += 1;
      if (lineNumber !== undefined) {
        firstNew ??= lineNumber;
        lastNew = lineNumber;
        firstAdded ??= lineNumber;
        lastAdded = lineNumber;
      }
    } else if (marker === "-") {
      removals += 1;
      if (lineNumber !== undefined) {
        firstOld ??= lineNumber;
        lastOld = lineNumber;
        firstRemoved ??= lineNumber;
        lastRemoved = lineNumber;
      }
    } else if (marker === " ") {
      if (lineNumber !== undefined) {
        firstNew ??= lineNumber;
        lastNew = lineNumber;
        firstOld ??= lineNumber;
        lastOld = lineNumber;
      }
    }
  }

  const jumpLine = firstAdded ?? firstNew ?? context.fallbackJumpLine;
  const newStart = firstAdded ?? firstNew;
  const oldStart = firstRemoved ?? firstOld;
  const newLines = rangeLength(newStart, lastAdded ?? lastNew);
  const oldLines = rangeLength(oldStart, lastRemoved ?? lastOld);

  return {
    id: `${context.entryId}:edit:${index}`,
    turnId: context.turnId,
    path: context.path,
    entryId: context.entryId,
    toolCallId: context.toolCallId,
    toolName: context.toolName,
    oldStart,
    oldLines,
    newStart,
    newLines,
    jumpLine,
    bodyLines: segment,
    additions,
    removals,
  };
}

function rangeLength(
  start: number | undefined,
  end: number | undefined,
): number | undefined {
  if (start === undefined || end === undefined) return undefined;
  return Math.max(1, end - start + 1);
}

function segmentHasChange(segment: readonly string[]): boolean {
  return segment.some((line) => line.startsWith("+") || line.startsWith("-"));
}

function isElisionLine(line: string): boolean {
  return /^\s*\.\.\.(?:\s|$)/u.test(line.slice(1));
}

function parseDiffLineNumber(line: string): number | undefined {
  const match = /^[-+ ]\s*(\d+)/u.exec(line);
  if (!match?.[1]) return undefined;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function extractToolCalls(content: unknown): ToolCallInfo[] {
  if (!Array.isArray(content)) return [];

  const calls: ToolCallInfo[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type !== "toolCall") continue;
    const id = getString(block.id);
    const name = getString(block.name);
    if (!id || !name) continue;
    calls.push({
      id,
      name,
      args: isRecord(block.arguments) ? block.arguments : {},
    });
  }
  return calls;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (!isRecord(block)) return "";
      if (block.type !== "text") return "";
      return getString(block.text) ?? "";
    })
    .join("\n");
}

function normalizePromptText(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function splitDisplayLines(content: string): string[] {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    return lines.slice(0, -1);
  }
  return lines;
}

function addStats(target: DiffStats, stats: DiffStats): void {
  target.additions += stats.additions;
  target.removals += stats.removals;
}

function isEditDetails(value: unknown): value is EditDetails {
  return isRecord(value) && typeof value.diff === "string";
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

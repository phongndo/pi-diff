import { TextDecoder } from "node:util";

import type {
  ReviewFile,
  ReviewHunk,
  ReviewModeInfo,
  ReviewModeKind,
  ReviewModel,
  ReviewTurn,
} from "./model.js";

export type GitDiffSectionKind = "staged" | "unstaged";

export const GIT_CHANGES_REVIEW_MODE: ReviewModeInfo = {
  kind: "git-changes",
  label: "Git changes",
  description:
    "staged (HEAD → index) above unstaged/untracked (index → working tree)",
  emptyTitle: "No staged, unstaged, or untracked changes found.",
  emptyHint:
    "Stage changes with git add, edit tracked files, or create untracked files, then reopen /diff.",
};

interface HunkRange {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

type GitBranchReviewModeKind = Extract<
  ReviewModeKind,
  "git-branch-main" | "git-branch-selected"
>;

interface MutableGitFile {
  id: string;
  turnId: string;
  path: string | undefined;
  oldPath: string | undefined;
  newPath: string | undefined;
  metadataLines: string[];
  hunks: ReviewHunk[];
}

const GIT_DIFF_BASE_ARGS = [
  "diff",
  "--no-color",
  "--no-ext-diff",
  "--patch",
  "--find-renames",
] as const;

const GIT_PATH_DECODER = new TextDecoder("utf-8");

const SIMPLE_GIT_ESCAPES = new Map<string, string>([
  ["\\", "\\"],
  ['"', '"'],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
  ["b", "\b"],
  ["f", "\f"],
]);

export function gitDiffArgs(section: GitDiffSectionKind): string[] {
  return section === "staged"
    ? [...GIT_DIFF_BASE_ARGS, "--cached"]
    : [...GIT_DIFF_BASE_ARGS];
}

export function gitUntrackedFilesArgs(): string[] {
  return ["ls-files", "--others", "--exclude-standard", "-z"];
}

export function gitUntrackedDiffArgs(path: string): string[] {
  return [...GIT_DIFF_BASE_ARGS, "--no-index", "--", "/dev/null", path];
}

export function parseGitNulPathList(stdout: string): string[] {
  return stdout.split("\0").filter((path) => path.length > 0);
}

export function joinGitPatches(patches: readonly string[]): string {
  return patches.filter((patch) => patch.length > 0).join("\n");
}

export function gitBranchDiffArgs(
  baseRef: string,
  targetRef = "HEAD",
): string[] {
  return [...GIT_DIFF_BASE_ARGS, `${baseRef}...${targetRef}`, "--"];
}

export function parseGitChangesReviewModel(
  stagedPatch: string,
  unstagedPatch: string,
): ReviewModel {
  const stagedFiles = parseGitPatchFiles(
    stagedPatch,
    gitSectionTurnId("staged"),
  );
  const unstagedFiles = parseGitPatchFiles(
    unstagedPatch,
    gitSectionTurnId("unstaged"),
  );

  if (stagedFiles.length === 0 && unstagedFiles.length === 0) {
    return emptyGitChangesReviewModel();
  }

  const stagedTurn = createGitSectionTurn("staged", stagedFiles);
  const unstagedTurn = createGitSectionTurn("unstaged", unstagedFiles);
  const turns = [stagedTurn, unstagedTurn];
  const activeTurn = turns.find((turn) => turn.files.length > 0);

  return modelFromTurns(GIT_CHANGES_REVIEW_MODE, turns, activeTurn?.id);
}

export function parseGitBranchReviewModel(
  patch: string,
  options: {
    kind: GitBranchReviewModeKind;
    baseRef: string;
    currentRef: string;
    range: string;
  },
): ReviewModel {
  const mode: ReviewModeInfo = {
    kind: options.kind,
    label: `Current branch vs ${options.baseRef}`,
    description: `merge-base(${options.baseRef}, ${options.currentRef}) → ${options.currentRef}`,
    baseRef: options.baseRef,
    emptyTitle: `No branch changes found for ${options.range}.`,
    emptyHint: `The current branch has no changes relative to ${options.baseRef}.`,
  };
  const turnId = `git:branch:${options.kind}:${slugId(options.baseRef)}`;
  const files = parseGitPatchFiles(patch, turnId);
  if (files.length === 0) {
    return emptyReviewModel(mode);
  }

  const turn = createGitBranchTurn(turnId, mode.label, options.range, files);
  return modelFromTurns(mode, [turn], turn.id);
}

function parseGitPatchFiles(patch: string, turnId: string): ReviewFile[] {
  const mutableFiles: MutableGitFile[] = [];
  let currentFile: MutableGitFile | undefined;
  let currentHunk: ReviewHunk | undefined;

  forEachPatchLine(patch, (line) => {
    if (line.startsWith("diff --git ")) {
      currentFile = createMutableFile(turnId, mutableFiles.length, line);
      mutableFiles.push(currentFile);
      currentHunk = undefined;
      return;
    }

    if (!currentFile) return;

    const oldPath = parseOldPathLine(line);
    if (oldPath !== undefined) {
      currentFile.oldPath = oldPath;
      currentFile.path = chooseDisplayPath(currentFile);
      currentHunk = undefined;
      return;
    }

    const newPath = parseNewPathLine(line);
    if (newPath !== undefined) {
      currentFile.newPath = newPath;
      currentFile.path = chooseDisplayPath(currentFile);
      currentHunk = undefined;
      return;
    }

    const renameFrom = parseMetadataPathLine(line, "rename from ");
    if (renameFrom !== undefined) {
      currentFile.oldPath = renameFrom;
      currentFile.path = chooseDisplayPath(currentFile);
      currentFile.metadataLines.push(line);
      currentHunk = undefined;
      return;
    }

    const renameTo = parseMetadataPathLine(line, "rename to ");
    if (renameTo !== undefined) {
      currentFile.newPath = renameTo;
      currentFile.path = chooseDisplayPath(currentFile);
      currentFile.metadataLines.push(line);
      currentHunk = undefined;
      return;
    }

    const copyFrom = parseMetadataPathLine(line, "copy from ");
    if (copyFrom !== undefined) {
      currentFile.oldPath = copyFrom;
      currentFile.path = chooseDisplayPath(currentFile);
      currentFile.metadataLines.push(line);
      currentHunk = undefined;
      return;
    }

    const copyTo = parseMetadataPathLine(line, "copy to ");
    if (copyTo !== undefined) {
      currentFile.newPath = copyTo;
      currentFile.path = chooseDisplayPath(currentFile);
      currentFile.metadataLines.push(line);
      currentHunk = undefined;
      return;
    }

    const hunkRange = parseHunkHeader(line);
    if (hunkRange) {
      currentHunk = createGitHunk(currentFile, hunkRange);
      currentFile.hunks.push(currentHunk);
      return;
    }

    if (currentHunk && isGitDiffBodyLine(line)) {
      addGitDiffBodyLine(currentHunk, line);
      return;
    }

    if (isDisplayMetadataLine(line)) {
      currentFile.metadataLines.push(line);
    }

    currentHunk = undefined;
  });

  return mutableFiles.flatMap((file) => finalizeGitFile(file));
}

function createMutableFile(
  turnId: string,
  index: number,
  diffHeaderLine: string,
): MutableGitFile {
  const parsed = parseDiffGitHeader(diffHeaderLine);
  const id = `${turnId}:file:${index}`;
  return {
    id,
    turnId,
    path: parsed?.newPath ?? parsed?.oldPath,
    oldPath: parsed?.oldPath,
    newPath: parsed?.newPath,
    metadataLines: [],
    hunks: [],
  };
}

function finalizeGitFile(file: MutableGitFile): ReviewFile[] {
  const path = chooseDisplayPath(file);
  if (!path) return [];

  if (file.hunks.length === 0 && file.metadataLines.length > 0) {
    file.hunks.push(createMetadataHunk(file, path));
  }

  if (file.hunks.length === 0 && file.metadataLines.length === 0) {
    return [];
  }

  for (const hunk of file.hunks) {
    hunk.path = path;
  }

  const reviewFile: ReviewFile = {
    id: file.id,
    turnId: file.turnId,
    path,
    hunks: file.hunks,
    additions: file.hunks.reduce((total, hunk) => total + hunk.additions, 0),
    removals: file.hunks.reduce((total, hunk) => total + hunk.removals, 0),
  };
  return [reviewFile];
}

function createGitSectionTurn(
  section: GitDiffSectionKind,
  files: readonly ReviewFile[],
): ReviewTurn {
  return createGitTurn({
    id: gitSectionTurnId(section),
    ordinal: section === "staged" ? 1 : 2,
    userEntryId: `git:changes:${section}`,
    prompt: gitSectionPrompt(section),
    files,
  });
}

function createGitBranchTurn(
  turnId: string,
  label: string,
  range: string,
  files: readonly ReviewFile[],
): ReviewTurn {
  return createGitTurn({
    id: turnId,
    ordinal: 1,
    userEntryId: turnId,
    prompt: `${label} — ${range}`,
    files,
  });
}

function createGitTurn({
  id,
  ordinal,
  userEntryId,
  prompt,
  files,
}: {
  id: string;
  ordinal: number;
  userEntryId: string;
  prompt: string;
  files: readonly ReviewFile[];
}): ReviewTurn {
  return {
    id,
    ordinal,
    userEntryId,
    parentEntryId: null,
    timestamp: "1970-01-01T00:00:00.000Z",
    prompt,
    files: [...files],
    children: [],
    additions: files.reduce((total, file) => total + file.additions, 0),
    removals: files.reduce((total, file) => total + file.removals, 0),
  };
}

function gitSectionTurnId(section: GitDiffSectionKind): string {
  return `git:changes:${section}`;
}

function gitSectionPrompt(section: GitDiffSectionKind): string {
  return section === "staged"
    ? "Staged changes — HEAD → index"
    : "Unstaged/untracked changes — index → working tree";
}

function emptyGitChangesReviewModel(): ReviewModel {
  return emptyReviewModel(GIT_CHANGES_REVIEW_MODE);
}

function emptyReviewModel(mode: ReviewModeInfo): ReviewModel {
  return {
    mode,
    turns: [],
    roots: [],
    activeTurnIds: [],
    totalFiles: 0,
    totalHunks: 0,
    additions: 0,
    removals: 0,
  };
}

function modelFromTurns(
  mode: ReviewModeInfo,
  turns: readonly ReviewTurn[],
  activeTurnId: string | undefined,
): ReviewModel {
  return {
    mode,
    turns: [...turns],
    roots: [...turns],
    activeTurnIds: activeTurnId ? [activeTurnId] : [],
    totalFiles: turns.reduce((total, turn) => total + turn.files.length, 0),
    totalHunks: turns.reduce(
      (total, turn) =>
        total +
        turn.files.reduce(
          (fileTotal, file) => fileTotal + file.hunks.length,
          0,
        ),
      0,
    ),
    additions: turns.reduce((total, turn) => total + turn.additions, 0),
    removals: turns.reduce((total, turn) => total + turn.removals, 0),
  };
}

function slugId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/gu, "-");
}

function createGitHunk(file: MutableGitFile, range: HunkRange): ReviewHunk {
  return {
    id: `${file.id}:hunk:${file.hunks.length}`,
    turnId: file.turnId,
    fileId: file.id,
    path: chooseDisplayPath(file) ?? "(unknown)",
    entryId: `${file.id}:hunk:${file.hunks.length}`,
    toolCallId: "git diff",
    toolName: "git",
    oldStart: range.oldStart,
    oldLines: range.oldLines,
    newStart: range.newStart,
    newLines: range.newLines,
    jumpLine:
      range.newLines > 0
        ? Math.max(1, range.newStart)
        : Math.max(1, range.oldStart),
    bodyLines: [],
    additions: 0,
    removals: 0,
  };
}

function createMetadataHunk(file: MutableGitFile, path: string): ReviewHunk {
  return {
    id: `${file.id}:metadata`,
    turnId: file.turnId,
    fileId: file.id,
    path,
    entryId: `${file.id}:metadata`,
    toolCallId: "git diff",
    toolName: "git",
    oldStart: undefined,
    oldLines: undefined,
    newStart: undefined,
    newLines: undefined,
    jumpLine: 1,
    bodyLines: file.metadataLines.map((line) => ` ${line}`),
    additions: 0,
    removals: 0,
  };
}

function addGitDiffBodyLine(hunk: ReviewHunk, line: string): void {
  hunk.bodyLines.push(line);
  if (line.startsWith("+") && !line.startsWith("+++")) {
    hunk.additions += 1;
  } else if (line.startsWith("-") && !line.startsWith("---")) {
    hunk.removals += 1;
  }
}

function parseHunkHeader(line: string): HunkRange | undefined {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
  if (!match?.[1] || !match[3]) return undefined;

  return {
    oldStart: Number.parseInt(match[1], 10),
    oldLines: match[2] ? Number.parseInt(match[2], 10) : 1,
    newStart: Number.parseInt(match[3], 10),
    newLines: match[4] ? Number.parseInt(match[4], 10) : 1,
  };
}

function parseDiffGitHeader(
  line: string,
): { oldPath: string | undefined; newPath: string | undefined } | undefined {
  const rest = line.slice("diff --git ".length);
  const tokens = parseDiffGitPathTokens(rest);
  if (!tokens) return undefined;

  return {
    oldPath: normalizeGitPath(tokens.oldToken),
    newPath: normalizeGitPath(tokens.newToken),
  };
}

function parseDiffGitPathTokens(
  text: string,
): { oldToken: string; newToken: string } | undefined {
  if (text.startsWith('"')) {
    const oldParsed = parseQuotedToken(text, 0);
    if (!oldParsed) return undefined;
    const nextStart = skipWhitespace(text, oldParsed.nextIndex);
    const newParsed = parseQuotedToken(text, nextStart);
    if (!newParsed) return undefined;
    return { oldToken: oldParsed.value, newToken: newParsed.value };
  }

  const candidates: Array<{ oldToken: string; newToken: string }> = [];
  for (let index = 0; index < text.length; index++) {
    if (!text.startsWith(" b/", index)) continue;
    const oldToken = text.slice(0, index);
    const newToken = text.slice(index + 1);
    if (!oldToken.startsWith("a/") || !newToken.startsWith("b/")) continue;
    candidates.push({ oldToken, newToken });
  }

  return (
    candidates.find(({ oldToken, newToken }) => {
      const oldPath = normalizeGitPath(oldToken);
      const newPath = normalizeGitPath(newToken);
      return oldPath !== undefined && oldPath === newPath;
    }) ?? candidates[0]
  );
}

function parseOldPathLine(line: string): string | undefined {
  if (!line.startsWith("--- ")) return undefined;
  return normalizeGitFileHeaderPath(line.slice(4));
}

function parseNewPathLine(line: string): string | undefined {
  if (!line.startsWith("+++ ")) return undefined;
  return normalizeGitFileHeaderPath(line.slice(4));
}

function parseMetadataPathLine(
  line: string,
  prefix: "rename from " | "rename to " | "copy from " | "copy to ",
): string | undefined {
  if (!line.startsWith(prefix)) return undefined;
  return unquoteGitPath(line.slice(prefix.length));
}

function normalizeGitFileHeaderPath(rawPath: string): string | undefined {
  return normalizeGitPath(stripGitFileHeaderSuffix(rawPath));
}

function stripGitFileHeaderSuffix(rawPath: string): string {
  if (rawPath.startsWith('"')) return rawPath;
  const tabIndex = rawPath.indexOf("\t");
  return tabIndex === -1 ? rawPath : rawPath.slice(0, tabIndex);
}

function normalizeGitPath(rawPath: string): string | undefined {
  const path = unquoteGitPath(rawPath);
  if (path === "/dev/null") return undefined;
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
  return path;
}

function chooseDisplayPath(file: {
  newPath: string | undefined;
  oldPath: string | undefined;
  path: string | undefined;
}): string | undefined {
  return file.newPath ?? file.oldPath ?? file.path;
}

function unquoteGitPath(path: string): string {
  if (!path.startsWith('"')) return stripTrailingTimestamp(path);
  return parseQuotedToken(path, 0)?.value ?? path;
}

function stripTrailingTimestamp(path: string): string {
  const match =
    /^(.*)\t\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)? [+-]\d{4}$/u.exec(
      path,
    );
  return match?.[1] ?? path;
}

function parseQuotedToken(
  text: string,
  startIndex: number,
): { value: string; nextIndex: number } | undefined {
  if (text[startIndex] !== '"') return undefined;

  let value = "";
  const pendingBytes: number[] = [];
  const flushBytes = (): void => {
    if (pendingBytes.length === 0) return;
    value += GIT_PATH_DECODER.decode(Uint8Array.from(pendingBytes));
    pendingBytes.length = 0;
  };

  for (let index = startIndex + 1; index < text.length; index++) {
    const char = text[index];
    if (char === undefined) break;
    if (char === '"') {
      flushBytes();
      return { value, nextIndex: index + 1 };
    }
    if (char !== "\\") {
      flushBytes();
      value += char;
      continue;
    }

    const next = text[index + 1];
    if (next === undefined) {
      flushBytes();
      value += "\\";
      break;
    }

    const decoded = decodeGitEscape(text, index + 1);
    if (decoded.kind === "byte") {
      pendingBytes.push(decoded.byte);
    } else {
      flushBytes();
      value += decoded.value;
    }
    index = decoded.nextIndex - 1;
  }

  return undefined;
}

type DecodedGitEscape =
  | { kind: "text"; value: string; nextIndex: number }
  | { kind: "byte"; byte: number; nextIndex: number };

function decodeGitEscape(text: string, escapeStart: number): DecodedGitEscape {
  const char = text[escapeStart];
  if (char === undefined) {
    return { kind: "text", value: "", nextIndex: escapeStart };
  }

  const simple = SIMPLE_GIT_ESCAPES.get(char);
  if (simple !== undefined) {
    return { kind: "text", value: simple, nextIndex: escapeStart + 1 };
  }

  if (/[0-7]/u.test(char)) {
    const octal = text
      .slice(escapeStart, escapeStart + 3)
      .match(/^[0-7]{1,3}/u)?.[0];
    if (octal) {
      return {
        kind: "byte",
        byte: Number.parseInt(octal, 8),
        nextIndex: escapeStart + octal.length,
      };
    }
  }

  return { kind: "text", value: char, nextIndex: escapeStart + 1 };
}

function skipWhitespace(text: string, startIndex: number): number {
  let index = startIndex;
  while (index < text.length && /\s/u.test(text[index] ?? "")) index += 1;
  return index;
}

function isGitDiffBodyLine(line: string): boolean {
  return (
    line.startsWith("+") ||
    line.startsWith("-") ||
    line.startsWith(" ") ||
    line.startsWith("\\")
  );
}

function isDisplayMetadataLine(line: string): boolean {
  return /^(?:old mode|new mode|deleted file mode|new file mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to|Binary files |GIT binary patch|literal |delta )/u.test(
    line,
  );
}

function forEachPatchLine(patch: string, visit: (line: string) => void): void {
  let startIndex = 0;

  for (let index = 0; index < patch.length; index++) {
    const charCode = patch.charCodeAt(index);
    if (charCode !== 10 && charCode !== 13) continue;

    visit(patch.slice(startIndex, index));
    if (charCode === 13 && patch.charCodeAt(index + 1) === 10) {
      index += 1;
    }
    startIndex = index + 1;
  }

  if (startIndex <= patch.length) {
    visit(patch.slice(startIndex));
  }
}

import type { KeybindingsManager, Theme } from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";
import { bench, describe } from "vitest";

import { parseGitChangesReviewModel } from "../src/diff/git.js";
import type { ReviewFile, ReviewModel, ReviewTurn } from "../src/diff/model.js";
import { DiffReviewComponent } from "../src/render/diff-review-ui.js";

type BenchComponent = {
  getAllRowSet(): { rows: unknown[] };
  getSelectedRow(): unknown;
  invalidate(): void;
  render(width: number): string[];
  searchMatches(): unknown[];
  searchMode: "tree" | "grep";
  searchQuery: string;
  summaryRequestForRow(row: unknown): { body: string };
};

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const tui = {
  terminal: { rows: 50 },
  requestRender() {},
  stop() {},
  start() {},
} as unknown as TUI;

const keybindings = {
  matches: () => false,
} as unknown as KeybindingsManager;

const largePatch = generatePatch({
  files: 500,
  hunksPerFile: 4,
  changedPairsPerHunk: 12,
});
const largeModel = parseGitChangesReviewModel(largePatch, "");
const largeComponent = asBenchComponent(createComponent(largeModel));
const summaryComponent = asBenchComponent(
  createComponent(
    buildReviewModel({ files: 200, hunksPerFile: 8, linesPerHunk: 20 }),
  ),
);

describe("BetterDiff performance", () => {
  bench("parse large git patch", () => {
    parseGitChangesReviewModel(largePatch, "");
  });

  bench("build rendered row cache", () => {
    largeComponent.invalidate();
    if (largeComponent.getAllRowSet().rows.length === 0) {
      throw new Error("expected rendered rows");
    }
  });

  bench("render cached viewport", () => {
    largeComponent.render(140);
  });

  bench("grep cached model targets", () => {
    largeComponent.searchMode = "grep";
    largeComponent.searchQuery = "needle_3";
    largeComponent.searchMatches();
  });

  bench("tree search cached visible targets", () => {
    largeComponent.searchMode = "tree";
    largeComponent.searchQuery = "file-000";
    largeComponent.searchMatches();
  });

  bench("build capped summary request", () => {
    summaryComponent.summaryRequestForRow(summaryComponent.getSelectedRow());
  });
});

function asBenchComponent(component: DiffReviewComponent): BenchComponent {
  return component as unknown as BenchComponent;
}

function createComponent(model: ReviewModel): DiffReviewComponent {
  return new DiffReviewComponent(
    model,
    process.cwd(),
    tui,
    theme,
    keybindings,
    () => {},
  );
}

function generatePatch({
  files,
  hunksPerFile,
  changedPairsPerHunk,
  contextPerHunk = 2,
}: {
  files: number;
  hunksPerFile: number;
  changedPairsPerHunk: number;
  contextPerHunk?: number;
}): string {
  const lines: string[] = [];
  for (let fileIndex = 0; fileIndex < files; fileIndex++) {
    const path = `src/bench/file-${String(fileIndex).padStart(6, "0")}.ts`;
    lines.push(`diff --git a/${path} b/${path}`);
    lines.push("index 0000000..1111111 100644");
    lines.push(`--- a/${path}`);
    lines.push(`+++ b/${path}`);

    for (let hunkIndex = 0; hunkIndex < hunksPerFile; hunkIndex++) {
      const start = 1 + hunkIndex * (changedPairsPerHunk + contextPerHunk + 3);
      const length = changedPairsPerHunk + contextPerHunk;
      lines.push(`@@ -${start},${length} +${start},${length} @@`);
      for (
        let contextIndex = 0;
        contextIndex < contextPerHunk;
        contextIndex++
      ) {
        lines.push(
          ` const context_${fileIndex}_${hunkIndex}_${contextIndex} = ${contextIndex};`,
        );
      }
      for (let lineIndex = 0; lineIndex < changedPairsPerHunk; lineIndex++) {
        lines.push(
          `-const value_${fileIndex}_${hunkIndex}_${lineIndex} = ${lineIndex};`,
        );
        lines.push(
          `+const value_${fileIndex}_${hunkIndex}_${lineIndex} = ${lineIndex + 1}; // needle_${lineIndex % 11}`,
        );
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

function buildReviewModel({
  files,
  hunksPerFile,
  linesPerHunk,
}: {
  files: number;
  hunksPerFile: number;
  linesPerHunk: number;
}): ReviewModel {
  const turn: ReviewTurn = {
    id: "turn:bench",
    ordinal: 1,
    userEntryId: "user:bench",
    parentEntryId: null,
    timestamp: new Date(0).toISOString(),
    prompt: "bench prompt",
    files: [],
    children: [],
    additions: 0,
    removals: 0,
  };

  for (let fileIndex = 0; fileIndex < files; fileIndex++) {
    const file: ReviewFile = {
      id: `${turn.id}:file:${fileIndex}`,
      turnId: turn.id,
      path: `src/bench-${fileIndex}.ts`,
      hunks: [],
      additions: 0,
      removals: 0,
    };

    for (let hunkIndex = 0; hunkIndex < hunksPerFile; hunkIndex++) {
      const bodyLines = Array.from(
        { length: linesPerHunk },
        (_value, lineIndex) =>
          `+${lineIndex + 1} const generated_${fileIndex}_${hunkIndex}_${lineIndex} = ${lineIndex}; // summary needle`,
      );
      const hunk = {
        id: `${file.id}:hunk:${hunkIndex}`,
        turnId: turn.id,
        fileId: file.id,
        path: file.path,
        entryId: `${file.id}:hunk:${hunkIndex}`,
        toolCallId: "bench",
        toolName: "edit" as const,
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: linesPerHunk,
        jumpLine: 1,
        bodyLines,
        additions: linesPerHunk,
        removals: 0,
      };
      file.hunks.push(hunk);
      file.additions += hunk.additions;
    }
    turn.files.push(file);
    turn.additions += file.additions;
  }

  return {
    mode: {
      kind: "session-turns",
      label: "Session turns",
      emptyTitle: "empty",
    },
    turns: [turn],
    roots: [turn],
    activeTurnIds: [turn.id],
    totalFiles: turn.files.length,
    totalHunks: turn.files.reduce(
      (total, file) => total + file.hunks.length,
      0,
    ),
    additions: turn.additions,
    removals: 0,
  };
}

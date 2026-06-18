import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { KeybindingsManager, Theme } from "@mariozechner/pi-coding-agent";
import {
  DynamicBorder,
  getLanguageFromPath,
  highlightCode,
  keyText,
} from "@mariozechner/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
} from "@mariozechner/pi-tui";

import type {
  ReviewFile,
  ReviewHunk,
  ReviewModeKind,
  ReviewModel,
  ReviewTurn,
} from "../diff/model.js";

export type DiffReviewLoadRequest =
  | { kind: "session-turns" }
  | { kind: "git-changes" }
  | { kind: "git-branch-main" }
  | { kind: "git-branch-selected"; baseRef: string };

export type DiffReviewModelLoader = (
  request: DiffReviewLoadRequest,
) => Promise<ReviewModel>;

export type DiffReviewBranchRefsLoader = () => Promise<string[]>;

export interface DiffReviewSummaryRequest {
  title: string;
  body: string;
}

export type DiffReviewAction =
  | { type: "close" }
  | {
      type: "summarize";
      custom: boolean;
      summary: DiffReviewSummaryRequest;
    };

interface Gutter {
  position: number;
  show: boolean;
}

interface TurnRow {
  id: string;
  kind: "turn";
  selectable: true;
  turn: ReviewTurn;
  indent: number;
  showConnector: boolean;
  isLast: boolean;
  gutters: Gutter[];
  isVirtualRootChild: boolean;
}

interface FileRow {
  id: string;
  kind: "file";
  selectable: true;
  turn: ReviewTurn;
  prefix: string;
  file: ReviewFile;
}

interface HunkRow {
  id: string;
  kind: "hunk";
  selectable: true;
  turn: ReviewTurn;
  prefix: string;
  file: ReviewFile;
  hunk: ReviewHunk;
}

interface DiffLineRow {
  id: string;
  kind: "diff";
  selectable: true;
  turn: ReviewTurn;
  prefix: string;
  file: ReviewFile;
  hunk: ReviewHunk;
  text: string;
}

type RenderRow = TurnRow | FileRow | HunkRow | DiffLineRow;
type DetailRow = FileRow | HunkRow | DiffLineRow;
type FoldableDetailRow = FileRow | HunkRow;

interface RowSet {
  rows: RenderRow[];
}

interface ScopedRowSetCache {
  source: RowSet;
  scopeTurnId: string;
  rowSet: RowSet;
}

const MAX_SUMMARY_BODY_CHARS = 24_000;
const BRACKET_CHORD_TIMEOUT_MS = 600;

interface ActionMenuItem {
  id: string;
  label: string;
  description: string;
  run: () => void;
}

interface ActionMenuState {
  title: string;
  prompt: string;
  items: ActionMenuItem[];
  selectedIndex: number;
}

type SearchMode = "tree" | "grep";

interface SearchMatch {
  id: string;
  kind: RenderRow["kind"];
  turn: ReviewTurn;
  file?: ReviewFile;
  hunk?: ReviewHunk;
  text: string;
  normalizedText: string;
}

interface SearchTargetCache {
  mode: SearchMode;
  rowSet: RowSet | undefined;
  targets: SearchMatch[];
}

interface SearchMatchesCache {
  mode: SearchMode;
  queryKey: string;
  targets: SearchMatch[];
  matches: SearchMatch[];
}

interface BracketCommand {
  bracket: "[" | "]";
  target: "file" | "hunk";
}

interface DiffModeChoice {
  kind: ReviewModeKind;
  label: string;
  description: string;
  request?: DiffReviewLoadRequest;
  branchPicker?: boolean;
}

const DIFF_MODE_CHOICES: readonly DiffModeChoice[] = [
  {
    kind: "session-turns",
    label: "Session turns",
    description: "agent edit/write history by user turn",
    request: { kind: "session-turns" },
  },
  {
    kind: "git-changes",
    label: "Git changes",
    description: "staged above unstaged/untracked",
    request: { kind: "git-changes" },
  },
  {
    kind: "git-branch-main",
    label: "Current branch vs main/master",
    description: "PR-style merge-base diff against the default branch",
    request: { kind: "git-branch-main" },
  },
  {
    kind: "git-branch-selected",
    label: "Current branch vs selected branch…",
    description: "pick a branch/ref as the PR-style base",
    branchPicker: true,
  },
];

export class DiffReviewComponent implements Component {
  private readonly turnsById = new Map<string, ReviewTurn>();
  private readonly parentById = new Map<string, string | undefined>();
  private readonly childrenById = new Map<string, string[]>();
  private readonly activeTurnIds = new Set<string>();
  private readonly activeDescendantMemo = new Map<string, boolean>();
  private readonly foldedBranchIds = new Set<string>();
  private readonly foldedDetailIds = new Set<string>();
  private visibleParentById = new Map<string, string | undefined>();
  private visibleChildrenById = new Map<string | undefined, string[]>();
  private multipleVisibleRoots = false;
  private cachedRowSet: RowSet | undefined;
  private scopedRowSetCache: ScopedRowSetCache | undefined;
  private searchTargetCache: SearchTargetCache | undefined;
  private searchMatchesCache: SearchMatchesCache | undefined;
  private readonly highlightedDiffLineCache = new Map<string, string>();
  private selectedId: string | undefined;
  private detailTurnId: string | undefined;
  private lastPageSize = 5;
  private pendingG = false;
  private pendingBracket: "[" | "]" | undefined;
  private pendingBracketTimer: ReturnType<typeof setTimeout> | undefined;
  private notice: string | undefined;
  private loadingMessage: string | undefined;
  private loadRequestId = 0;
  private actionMenu: ActionMenuState | undefined;
  private searchEditing = false;
  private searchMode: SearchMode = "tree";
  private searchQuery = "";

  constructor(
    private model: ReviewModel,
    private readonly cwd: string,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly done: (result: DiffReviewAction) => void,
    private readonly modelLoader?: DiffReviewModelLoader,
    private readonly branchRefsLoader?: DiffReviewBranchRefsLoader,
  ) {
    this.indexModel();
    this.foldDetailHunksByDefault();
    const initialTurnId = this.preferredHeadTurnId();
    this.detailTurnId = initialTurnId;
    this.selectedId = initialTurnId;
    this.expandDetailRowsForTurn(initialTurnId);
  }

  invalidate(): void {
    this.invalidateRows();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const border = new DynamicBorder((text: string) =>
      this.theme.fg("border", text),
    );
    lines.push("");
    lines.push(...border.render(width));
    lines.push(
      truncateToWidth(
        `  ${this.theme.bold(`Better Diff — ${this.model.mode.label}`)} ${this.summaryText()}`,
        width,
      ),
    );
    if (this.model.mode.description) {
      lines.push(
        truncateToWidth(
          this.theme.fg("muted", `  ${this.model.mode.description}`),
          width,
        ),
      );
    }
    lines.push(
      truncateToWidth(
        this.theme.fg(
          "muted",
          `  ↑/↓: move. ←/→ or ctrl+u/d: page. h/l: fold/dive. tab: turn/files. [h/]h: hunk. [f/]f: file. /: search. ?: grep all. n/N: next/prev. m: mode. r: refresh. enter: actions. ${keyText("app.editor.external")}: open hunk. q/esc: close`,
        ),
        width,
      ),
    );
    if (this.loadingMessage) {
      lines.push(
        truncateToWidth(
          `  ${this.theme.fg("muted", this.loadingMessage)}`,
          width,
        ),
      );
    }
    if (this.notice) {
      lines.push(
        truncateToWidth(`  ${this.theme.fg("warning", this.notice)}`, width),
      );
    }
    const searchLine = this.renderSearchLine(width);
    if (searchLine) lines.push(searchLine);
    lines.push(...this.renderActionMenu(width));
    lines.push(...border.render(width));
    lines.push("");

    if (this.model.turns.length === 0) {
      lines.push(
        truncateToWidth(
          this.theme.fg("muted", `  ${this.model.mode.emptyTitle}`),
          width,
        ),
      );
      if (this.model.mode.emptyHint) {
        lines.push(
          truncateToWidth(
            this.theme.fg("muted", `  ${this.model.mode.emptyHint}`),
            width,
          ),
        );
      }
      lines.push("");
      lines.push(...border.render(width));
      return lines;
    }

    let rows = this.getRows();
    this.ensureSelectionVisible(rows);
    rows = this.getRows();
    const maxBodyLines = this.getBodyBudgetLines(width);
    this.lastPageSize = Math.max(1, maxBodyLines - 1);
    const selectedRowIndex = Math.max(
      0,
      rows.findIndex((row) => row.id === this.selectedId),
    );
    const startIndex = Math.max(
      0,
      Math.min(
        selectedRowIndex - Math.floor(maxBodyLines / 2),
        rows.length - maxBodyLines,
      ),
    );
    const endIndex = Math.min(rows.length, startIndex + maxBodyLines);

    for (let index = startIndex; index < endIndex; index++) {
      const row = rows[index];
      if (!row) continue;
      lines.push(this.renderRow(row, width));
    }

    lines.push(
      truncateToWidth(this.theme.fg("muted", this.statusText()), width),
    );
    lines.push("");
    lines.push(...border.render(width));
    return lines;
  }

  private getBodyBudgetLines(width: number): number {
    const reservedLines =
      9 +
      (this.model.mode.description ? 1 : 0) +
      (this.loadingMessage ? 1 : 0) +
      (this.notice ? 1 : 0) +
      (this.hasSearchLine() ? 1 : 0) +
      this.getActionMenuLineCount(width);
    return Math.max(5, this.tui.terminal.rows - reservedLines);
  }

  private getActionMenuLineCount(width: number): number {
    const menu = this.actionMenu;
    if (!menu) return 0;
    return menu.items.length + 2 + this.getActionMenuPromptLineCount(width);
  }

  private getActionMenuPromptLineCount(width: number): number {
    const prompt = this.actionMenu?.prompt.trim();
    if (!prompt) return 0;
    return (
      1 + wrapTextWithAnsi(prompt, this.getActionMenuPromptWidth(width)).length
    );
  }

  private getActionMenuPromptWidth(width: number): number {
    return Math.max(10, width - 4);
  }

  private renderSearchLine(width: number): string | undefined {
    if (!this.hasSearchLine()) return undefined;

    const { total, selectedIndex } = this.searchStatus();
    const label = this.searchMode === "grep" ? "Grep all:" : "Search:";
    const query = this.searchQuery
      ? this.theme.fg("accent", this.searchQuery)
      : this.theme.fg("muted", "(type query)");
    const cursor = this.searchEditing ? this.theme.fg("accent", "▌") : "";
    const countText =
      this.searchQuery.trim().length === 0
        ? ""
        : total === 0
          ? "no matches"
          : selectedIndex === undefined
            ? `${total} match${total === 1 ? "" : "es"}`
            : `${selectedIndex + 1}/${total}`;
    const hint = this.searchEditing
      ? "enter: keep. esc: close."
      : `n/N: next/prev. ${this.searchMode === "grep" ? "?: edit grep." : "/: edit search."}`;
    const suffix = [countText, hint].filter(Boolean).join(" · ");

    return truncateToWidth(
      `  ${this.theme.fg("muted", label)} ${query}${cursor}${suffix ? this.theme.fg("muted", `  ${suffix}`) : ""}`,
      width,
    );
  }

  private hasSearchLine(): boolean {
    return this.searchEditing || this.searchQuery.length > 0;
  }

  private renderActionMenu(width: number): string[] {
    const menu = this.actionMenu;
    if (!menu) return [];

    const lines: string[] = [];
    lines.push(
      truncateToWidth(
        `  ${this.theme.bold("Actions")} ${this.theme.fg("muted", "·")} ${this.theme.fg("accent", menu.title)}`,
        width,
      ),
    );

    const prompt = menu.prompt.trim();
    if (prompt) {
      lines.push(truncateToWidth(this.theme.fg("muted", "  Prompt:"), width));
      for (const promptLine of wrapTextWithAnsi(
        prompt,
        this.getActionMenuPromptWidth(width),
      )) {
        lines.push(
          truncateToWidth(`    ${this.theme.fg("text", promptLine)}`, width),
        );
      }
    }

    for (let index = 0; index < menu.items.length; index++) {
      const item = menu.items[index];
      if (!item) continue;
      const selected = index === menu.selectedIndex;
      const cursor = selected ? this.theme.fg("accent", "› ") : "  ";
      const label = selected ? this.theme.bold(item.label) : item.label;
      let line = `  ${cursor}${label}${this.theme.fg("muted", ` — ${item.description}`)}`;
      if (selected) line = this.theme.bg("selectedBg", line);
      lines.push(truncateToWidth(line, width));
    }

    lines.push(
      truncateToWidth(
        this.theme.fg(
          "muted",
          "  ↑/↓ or j/k: move. enter: run action. esc/q: back.",
        ),
        width,
      ),
    );
    return lines;
  }

  private ensureSelectionVisible(rows: readonly RenderRow[]): void {
    if (rows.some((row) => row.selectable && row.id === this.selectedId)) {
      return;
    }

    const preferredHeadId = this.preferredHeadTurnId();
    const preferredRow = rows.find((row) => row.id === preferredHeadId);
    this.selectRow(preferredRow?.id ?? rows[rows.length - 1]?.id);
  }

  private setPendingBracket(bracket: "[" | "]"): void {
    this.clearPendingBracket();
    this.pendingBracket = bracket;
    this.pendingBracketTimer = setTimeout(() => {
      this.pendingBracket = undefined;
      this.pendingBracketTimer = undefined;
    }, BRACKET_CHORD_TIMEOUT_MS);
  }

  private consumePendingBracket(): "[" | "]" | undefined {
    const pendingBracket = this.pendingBracket;
    this.clearPendingBracket();
    return pendingBracket;
  }

  private clearPendingBracket(): void {
    if (this.pendingBracketTimer) {
      clearTimeout(this.pendingBracketTimer);
      this.pendingBracketTimer = undefined;
    }
    this.pendingBracket = undefined;
  }

  handleInput(data: string): void {
    this.notice = undefined;

    if (this.actionMenu) {
      this.clearPendingBracket();
      this.pendingG = false;
      this.handleActionMenuInput(data);
      return;
    }

    if (this.searchEditing) {
      this.clearPendingBracket();
      this.pendingG = false;
      this.handleSearchInput(data);
      return;
    }

    if (this.searchQuery.length > 0 && this.matchesCancel(data)) {
      this.clearPendingBracket();
      this.pendingG = false;
      this.clearSearch();
      this.tui.requestRender();
      return;
    }

    const bracketCommand = parseBracketCommand(data);
    if (bracketCommand) {
      this.clearPendingBracket();
      this.runBracketCommand(bracketCommand);
      this.pendingG = false;
      this.tui.requestRender();
      return;
    }

    if (
      this.pendingBracket &&
      (this.matchesCancel(data) || data === "q" || data === "Q")
    ) {
      this.clearPendingBracket();
    }

    const pendingBracket = this.consumePendingBracket();
    if (pendingBracket && (data === "f" || data === "F")) {
      this.moveToFile(pendingBracket === "]" ? 1 : -1);
      this.pendingG = false;
      this.tui.requestRender();
      return;
    }
    if (pendingBracket && (data === "h" || data === "H")) {
      this.moveToHunk(pendingBracket === "]" ? 1 : -1);
      this.pendingG = false;
      this.tui.requestRender();
      return;
    }
    if (this.matchesCancel(data)) {
      this.done({ type: "close" });
      return;
    }

    if (data === "q" || data === "Q") {
      this.done({ type: "close" });
      return;
    }

    if (data === "/") {
      this.openSearch("tree");
      this.tui.requestRender();
      return;
    }

    if (data === "?") {
      this.openSearch("grep");
      this.tui.requestRender();
      return;
    }

    if (data === "\t") {
      this.toggleTurnFileJump();
      this.tui.requestRender();
      return;
    }

    if (this.matchesExternalEditor(data)) {
      this.openSelectedHunk();
      this.tui.requestRender(true);
      return;
    }

    if (data === "m" || data === "M") {
      this.openModeMenu();
      this.tui.requestRender();
      return;
    }

    if (data === "r" || data === "R") {
      this.refreshCurrentMode();
      this.tui.requestRender();
      return;
    }

    if (this.matchesSelectUp(data) || data === "k") {
      this.moveSelection(-1);
    } else if (this.matchesSelectDown(data) || data === "j") {
      this.moveSelection(1);
    } else if (data === "n") {
      this.moveSearch(1);
    } else if (data === "N") {
      this.moveSearch(-1);
    } else if (this.matchesPageUp(data) || matchesKey(data, "ctrl+u")) {
      this.moveSelection(-Math.max(1, this.lastPageSize));
    } else if (this.matchesPageDown(data) || matchesKey(data, "ctrl+d")) {
      this.moveSelection(Math.max(1, this.lastPageSize));
    } else if (this.matchesConfirm(data)) {
      this.openActionMenu();
    } else if (
      data === "h" ||
      this.keybindings.matches(data, "app.tree.foldOrUp")
    ) {
      this.moveParentOrCollapse();
    } else if (
      data === "l" ||
      this.keybindings.matches(data, "app.tree.unfoldOrDown")
    ) {
      this.moveChildOrExpand();
    } else if (data === "c" || data === "C") {
      this.collapseSelectedScope();
    } else if (data === "e" || data === "E") {
      this.expandSelectedScope();
    } else if (data === "]" || data === "[") {
      this.setPendingBracket(data);
      this.pendingG = false;
      this.tui.requestRender();
      return;
    } else if (data === "G") {
      this.selectLast();
    } else if (data === "g") {
      if (this.pendingG) {
        this.selectFirst();
        this.pendingG = false;
      } else {
        this.pendingG = true;
      }
      this.tui.requestRender();
      return;
    } else if (matchesKey(data, "left")) {
      this.moveSelection(-Math.max(1, this.lastPageSize));
    } else if (matchesKey(data, "right")) {
      this.moveSelection(Math.max(1, this.lastPageSize));
    } else {
      this.pendingG = false;
      return;
    }

    this.pendingG = false;
    this.tui.requestRender();
  }

  private handleActionMenuInput(data: string): void {
    if (this.matchesExternalEditor(data)) {
      this.actionMenu = undefined;
      this.openSelectedHunk();
      this.tui.requestRender(true);
      return;
    }

    if (this.matchesCancel(data) || data === "q" || data === "Q") {
      this.actionMenu = undefined;
      this.tui.requestRender();
      return;
    }

    if (this.matchesSelectUp(data) || data === "k") {
      this.moveActionMenuSelection(-1);
    } else if (this.matchesSelectDown(data) || data === "j") {
      this.moveActionMenuSelection(1);
    } else if (this.matchesConfirm(data)) {
      this.runSelectedActionMenuItem();
    } else {
      return;
    }

    this.tui.requestRender();
  }

  private handleSearchInput(data: string): void {
    if (this.matchesCancel(data)) {
      this.clearSearch();
      this.tui.requestRender();
      return;
    }

    if (this.matchesConfirm(data)) {
      this.searchEditing = false;
      if (this.searchQuery.trim().length === 0) {
        this.searchQuery = "";
      } else if (this.searchMatches().length === 0) {
        this.notice = `No matches for "${this.searchQuery}".`;
      }
      this.tui.requestRender();
      return;
    }

    if (this.matchesDeleteBackward(data)) {
      const chars = [...this.searchQuery];
      chars.pop();
      this.searchQuery = chars.join("");
      this.selectCurrentSearchMatch();
      this.tui.requestRender();
      return;
    }

    if (!isPrintableInput(data)) return;

    this.searchQuery += data;
    this.selectCurrentSearchMatch();
    this.tui.requestRender();
  }

  private runBracketCommand(command: BracketCommand): void {
    const delta = command.bracket === "]" ? 1 : -1;
    if (command.target === "file") {
      this.moveToFile(delta);
    } else {
      this.moveToHunk(delta);
    }
  }

  private openSearch(mode: SearchMode): void {
    this.searchMode = mode;
    this.searchEditing = true;
    this.searchQuery = "";
    this.notice = undefined;
    this.selectCurrentSearchMatch();
  }

  private clearSearch(): void {
    this.searchEditing = false;
    this.searchQuery = "";
  }

  private moveActionMenuSelection(delta: number): void {
    const menu = this.actionMenu;
    if (!menu || menu.items.length === 0) return;
    menu.selectedIndex = clamp(
      menu.selectedIndex + delta,
      0,
      menu.items.length - 1,
    );
  }

  private runSelectedActionMenuItem(): void {
    const menu = this.actionMenu;
    if (!menu) return;
    const item = menu.items[menu.selectedIndex];
    if (!item) return;
    this.actionMenu = undefined;
    item.run();
  }

  private openActionMenu(): void {
    const row = this.getSelectedRow();
    if (!row) {
      this.notice = "No diff row is selected.";
      return;
    }

    const items = this.actionMenuItemsForRow(row);
    if (items.length === 0) {
      this.notice = "No actions available for this row.";
      return;
    }

    this.actionMenu = {
      title: this.actionMenuTitle(row),
      prompt: row.turn.prompt || "(empty prompt)",
      items,
      selectedIndex: 0,
    };
  }

  private openModeMenu(): void {
    const items = DIFF_MODE_CHOICES.map((choice): ActionMenuItem => {
      const current = choice.kind === this.model.mode.kind;
      return {
        id: `mode-${choice.kind}`,
        label: `${current ? "✓ " : "  "}${choice.label}`,
        description: choice.description,
        run: () => {
          if (choice.branchPicker) {
            this.openBranchRefMenu();
            return;
          }
          if (current || !choice.request) return;
          this.switchMode(choice.request);
        },
      };
    });
    const selectedIndex = Math.max(
      0,
      DIFF_MODE_CHOICES.findIndex(
        (choice) => choice.kind === this.model.mode.kind,
      ),
    );

    this.actionMenu = {
      title: "diff mode",
      prompt: `Current mode: ${this.model.mode.label}`,
      items,
      selectedIndex,
    };
  }

  private refreshCurrentMode(): void {
    const request = this.currentLoadRequest();
    if (!request) return;
    this.switchMode(request);
  }

  private currentLoadRequest(): DiffReviewLoadRequest | undefined {
    if (this.model.mode.kind === "git-branch-selected") {
      const baseRef = this.model.mode.baseRef;
      if (!baseRef) {
        this.openBranchRefMenu();
        return undefined;
      }
      return { kind: "git-branch-selected", baseRef };
    }
    return { kind: this.model.mode.kind };
  }

  private openBranchRefMenu(): void {
    if (!this.branchRefsLoader) {
      this.notice = "Branch selection is unavailable in this context.";
      return;
    }

    const requestId = this.loadRequestId + 1;
    this.loadRequestId = requestId;
    this.actionMenu = undefined;
    this.loadingMessage = "Loading git branches…";
    this.notice = undefined;

    void this.branchRefsLoader()
      .then((refs) => {
        if (requestId !== this.loadRequestId) return;
        if (refs.length === 0) {
          this.notice = "No git branches or refs found.";
          return;
        }

        this.actionMenu = {
          title: "base branch/ref",
          prompt:
            "Select the base branch/ref. BetterDiff will compare merge-base(base, current branch) → current branch.",
          items: refs.map(
            (ref): ActionMenuItem => ({
              id: `branch-${ref}`,
              label: ref,
              description: `current branch vs ${ref}`,
              run: () =>
                this.switchMode({ kind: "git-branch-selected", baseRef: ref }),
            }),
          ),
          selectedIndex: 0,
        };
      })
      .catch((error: unknown) => {
        if (requestId !== this.loadRequestId) return;
        this.notice = `Failed to load git branches: ${error instanceof Error ? error.message : String(error)}`;
      })
      .finally(() => {
        if (requestId !== this.loadRequestId) return;
        this.loadingMessage = undefined;
        this.tui.requestRender();
      });
  }

  private switchMode(request: DiffReviewLoadRequest): void {
    if (!this.modelLoader) {
      this.notice = "Diff mode switching is unavailable in this context.";
      return;
    }

    const label = requestLabel(request);
    const requestId = this.loadRequestId + 1;
    this.loadRequestId = requestId;
    this.actionMenu = undefined;
    this.loadingMessage = `Loading ${label} diff…`;
    this.notice = undefined;

    void this.modelLoader(request)
      .then((model) => {
        if (requestId !== this.loadRequestId) return;
        this.replaceModel(model);
      })
      .catch((error: unknown) => {
        if (requestId !== this.loadRequestId) return;
        this.notice = `Failed to load ${label}: ${error instanceof Error ? error.message : String(error)}`;
      })
      .finally(() => {
        if (requestId !== this.loadRequestId) return;
        this.loadingMessage = undefined;
        this.tui.requestRender();
      });
  }

  private replaceModel(model: ReviewModel): void {
    this.model = model;
    this.turnsById.clear();
    this.parentById.clear();
    this.childrenById.clear();
    this.activeTurnIds.clear();
    this.activeDescendantMemo.clear();
    this.foldedBranchIds.clear();
    this.foldedDetailIds.clear();
    this.visibleParentById = new Map<string, string | undefined>();
    this.visibleChildrenById = new Map<string | undefined, string[]>();
    this.multipleVisibleRoots = false;
    this.cachedRowSet = undefined;
    this.scopedRowSetCache = undefined;
    this.invalidateSearchCaches();
    this.highlightedDiffLineCache.clear();
    this.selectedId = undefined;
    this.detailTurnId = undefined;
    this.pendingG = false;
    this.clearPendingBracket();
    this.actionMenu = undefined;
    this.searchEditing = false;
    this.searchMode = "tree";
    this.searchQuery = "";

    this.indexModel();
    this.foldDetailHunksByDefault();
    const initialTurnId = this.preferredHeadTurnId();
    this.detailTurnId = initialTurnId;
    this.selectedId = initialTurnId;
    this.expandDetailRowsForTurn(initialTurnId);
    this.invalidateRows();
  }

  private actionMenuTitle(row: RenderRow): string {
    if (row.kind === "turn") return `turn ${row.turn.ordinal}`;
    if (row.kind === "file") return `file ${row.file.path}`;
    if (row.kind === "hunk")
      return `hunk ${row.hunk.path}:${row.hunk.jumpLine}`;
    return `diff line ${row.hunk.path}:${row.hunk.jumpLine}`;
  }

  private actionMenuItemsForRow(row: RenderRow): ActionMenuItem[] {
    const items: ActionMenuItem[] = [
      {
        id: "summarize-scope",
        label: "Generate summary",
        description: "Ask the agent to summarize this selected diff scope",
        run: () =>
          this.done({
            type: "summarize",
            custom: false,
            summary: this.summaryRequestForRow(row),
          }),
      },
      {
        id: "custom-summarize-scope",
        label: "Custom summary…",
        description: "Add focus instructions before generating the summary",
        run: () =>
          this.done({
            type: "summarize",
            custom: true,
            summary: this.summaryRequestForRow(row),
          }),
      },
    ];

    if (row.kind === "hunk" || row.kind === "diff") {
      this.addUndoAction(items, "undo-hunk", "Undo this hunk", row.hunk.path, [
        row.hunk,
      ]);
    }

    if (row.kind === "file" || row.kind === "hunk" || row.kind === "diff") {
      this.addUndoAction(
        items,
        "undo-file-in-turn",
        "Undo this file in this turn",
        row.file.path,
        row.file.hunks,
      );
    }

    this.addUndoAction(
      items,
      "undo-turn",
      "Undo this turn",
      this.turnLabel(row.turn),
      this.hunksForTurn(row.turn),
    );

    return items;
  }

  private summaryRequestForRow(row: RenderRow): DiffReviewSummaryRequest {
    return {
      title: this.summaryTitleForRow(row),
      body: this.summaryBodyForRow(row),
    };
  }

  private summaryTitleForRow(row: RenderRow): string {
    if (row.kind === "turn") {
      return `turn ${row.turn.ordinal}: ${row.turn.prompt || "(empty prompt)"}`;
    }
    return this.actionMenuTitle(row);
  }

  private summaryBodyForRow(row: RenderRow): string {
    if (row.kind === "turn") return this.summaryForTurn(row.turn);
    if (row.kind === "file") return this.summaryForFile(row.file, row.turn);
    if (row.kind === "hunk")
      return this.summaryForHunk(row.hunk, row.file, row.turn);
    return this.summaryForHunk(row.hunk, row.file, row.turn);
  }

  private summaryForTurn(turn: ReviewTurn): string {
    const builder = new SummaryBodyBuilder(MAX_SUMMARY_BODY_CHARS);
    builder.addLine(`Scope: turn ${turn.ordinal}`);
    builder.addLine(`Prompt: ${turn.prompt || "(empty prompt)"}`);
    builder.addLine(`Stats: +${turn.additions} -${turn.removals}`);
    builder.addLine(`Files: ${turn.files.length}`);
    builder.addLine();
    for (const file of turn.files) {
      this.addSummaryLinesForFile(builder, file);
    }
    return builder.toString();
  }

  private summaryForFile(file: ReviewFile, turn: ReviewTurn): string {
    const builder = new SummaryBodyBuilder(MAX_SUMMARY_BODY_CHARS);
    builder.addLine(`Scope: file ${file.path}`);
    builder.addLine(`Turn: ${turn.prompt || "(empty prompt)"}`);
    builder.addLine(`Stats: +${file.additions} -${file.removals}`);
    builder.addLine();
    this.addSummaryLinesForFile(builder, file);
    return builder.toString();
  }

  private summaryForHunk(
    hunk: ReviewHunk,
    file: ReviewFile,
    turn: ReviewTurn,
  ): string {
    const builder = new SummaryBodyBuilder(MAX_SUMMARY_BODY_CHARS);
    builder.addLine(`Scope: hunk ${hunk.path}:${hunk.jumpLine}`);
    builder.addLine(`Turn: ${turn.prompt || "(empty prompt)"}`);
    builder.addLine(`File: ${file.path}`);
    builder.addLine(`Tool: ${hunk.toolName}`);
    builder.addLine(`Stats: +${hunk.additions} -${hunk.removals}`);
    builder.addLine();
    this.addSummaryLinesForHunk(builder, hunk);
    return builder.toString();
  }

  private addSummaryLinesForFile(
    builder: SummaryBodyBuilder,
    file: ReviewFile,
  ): void {
    builder.addLine(
      `File: ${file.path} (+${file.additions} -${file.removals}, ${file.hunks.length} hunk${file.hunks.length === 1 ? "" : "s"})`,
    );
    for (const hunk of file.hunks) {
      this.addSummaryLinesForHunk(builder, hunk);
    }
    builder.addLine();
  }

  private addSummaryLinesForHunk(
    builder: SummaryBodyBuilder,
    hunk: ReviewHunk,
  ): void {
    builder.addLine(
      `  Hunk: ${hunk.path}:${hunk.jumpLine} ${hunk.toolName} (+${hunk.additions} -${hunk.removals})`,
    );
    for (const line of hunk.bodyLines) {
      builder.addLine(`    ${line}`);
    }
  }

  private addUndoAction(
    items: ActionMenuItem[],
    id: string,
    label: string,
    description: string,
    hunks: readonly ReviewHunk[],
  ): void {
    const reversibleHunks = this.reversibleHunks(hunks);
    if (reversibleHunks.length === 0) return;

    items.push({
      id,
      label,
      description: `${description} · ${this.undoSummary(reversibleHunks)}`,
      run: () => this.showUndoConfirmation(label, reversibleHunks),
    });
  }

  private showUndoConfirmation(
    label: string,
    hunks: readonly ReviewHunk[],
  ): void {
    this.actionMenu = {
      title: `confirm ${label.toLowerCase()}`,
      prompt: this.actionMenu?.prompt ?? "",
      selectedIndex: 0,
      items: [
        {
          id: "confirm-undo",
          label: `Confirm ${label.toLowerCase()}`,
          description: `Reverse ${this.undoSummary(hunks)} in the working tree`,
          run: () => this.undoHunks(hunks, label),
        },
        {
          id: "cancel-undo",
          label: "Cancel",
          description: "Leave files unchanged",
          run: () => {},
        },
      ],
    };
  }

  private undoHunks(hunks: readonly ReviewHunk[], label: string): void {
    try {
      const result = undoEditHunks(this.cwd, hunks);
      this.notice = `${label}: reversed ${result.hunks} edit hunk${result.hunks === 1 ? "" : "s"} in ${result.files} file${result.files === 1 ? "" : "s"}.`;
    } catch (error) {
      this.notice = `Undo failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private reversibleHunks(hunks: readonly ReviewHunk[]): ReviewHunk[] {
    return hunks.filter((hunk) => hunk.toolName === "edit");
  }

  private undoSummary(hunks: readonly ReviewHunk[]): string {
    const paths = new Set(hunks.map((hunk) => hunk.path));
    return `${hunks.length} edit hunk${hunks.length === 1 ? "" : "s"} / ${paths.size} file${paths.size === 1 ? "" : "s"}`;
  }

  private hunksForTurn(turn: ReviewTurn): ReviewHunk[] {
    return turn.files.flatMap((file) => file.hunks);
  }

  private matchesConfirm(data: string): boolean {
    return (
      this.keybindings.matches(data, "tui.select.confirm") ||
      matchesKey(data, "enter")
    );
  }

  private matchesCancel(data: string): boolean {
    return (
      this.keybindings.matches(data, "tui.select.cancel") ||
      matchesKey(data, "escape") ||
      matchesKey(data, "ctrl+c")
    );
  }

  private matchesSelectUp(data: string): boolean {
    return (
      this.keybindings.matches(data, "tui.select.up") || matchesKey(data, "up")
    );
  }

  private matchesSelectDown(data: string): boolean {
    return (
      this.keybindings.matches(data, "tui.select.down") ||
      matchesKey(data, "down")
    );
  }

  private matchesPageUp(data: string): boolean {
    return (
      this.keybindings.matches(data, "tui.select.pageUp") ||
      matchesKey(data, "pageUp")
    );
  }

  private matchesPageDown(data: string): boolean {
    return (
      this.keybindings.matches(data, "tui.select.pageDown") ||
      matchesKey(data, "pageDown")
    );
  }

  private matchesExternalEditor(data: string): boolean {
    if (matchesKey(data, "enter")) return false;
    return (
      this.keybindings.matches(data, "app.editor.external") ||
      matchesKey(data, "ctrl+g")
    );
  }

  private matchesDeleteBackward(data: string): boolean {
    return (
      this.keybindings.matches(data, "tui.editor.deleteCharBackward") ||
      matchesKey(data, "backspace")
    );
  }

  private indexModel(): void {
    for (const turnId of this.model.activeTurnIds) {
      this.activeTurnIds.add(turnId);
    }
    for (const root of this.model.roots) {
      this.addTurnAndChildren(root, undefined);
    }
    for (const turn of this.model.turns) {
      if (!this.turnsById.has(turn.id)) {
        this.addTurnAndChildren(turn, undefined);
      }
    }
  }

  private foldDetailHunksByDefault(): void {}

  private expandDetailRowsForTurn(turnId: string | undefined): void {
    const turn = turnId ? this.turnsById.get(turnId) : undefined;
    if (!turn) return;

    for (const file of turn.files) {
      this.foldedDetailIds.delete(file.id);
    }
  }

  private addTurnAndChildren(
    turn: ReviewTurn,
    parentId: string | undefined,
  ): void {
    if (this.turnsById.has(turn.id)) return;
    this.turnsById.set(turn.id, turn);
    this.parentById.set(turn.id, parentId);
    this.childrenById.set(
      turn.id,
      turn.children.map((child) => child.id),
    );
    for (const child of turn.children) {
      this.addTurnAndChildren(child, turn.id);
    }
  }

  private preferredHeadTurnId(): string | undefined {
    return (
      this.model.activeTurnIds[this.model.activeTurnIds.length - 1] ??
      this.model.turns[this.model.turns.length - 1]?.id
    );
  }

  private firstReviewRowIdForTurn(turn: ReviewTurn): string {
    for (const file of turn.files) return this.firstReviewRowIdForFile(file);
    return turn.id;
  }

  private firstReviewRowIdForFile(file: ReviewFile): string {
    return file.hunks[0]?.id ?? file.id;
  }

  private firstReviewRowIdForHunk(hunk: ReviewHunk): string {
    return hunk.bodyLines.length > 0 ? diffLineRowId(hunk, 0) : hunk.id;
  }

  private getRows(): RenderRow[] {
    return this.getCurrentRowSet().rows;
  }

  private getAllRowSet(): RowSet {
    if (!this.cachedRowSet) {
      this.cachedRowSet = createRowSet(this.buildRows());
    }
    return this.cachedRowSet;
  }

  private getCurrentRowSet(): RowSet {
    const source = this.getAllRowSet();
    const selectedRow = this.selectedId
      ? source.rows.find((row) => row.id === this.selectedId)
      : undefined;
    if (!selectedRow || selectedRow.kind === "turn") return source;

    const scopeTurnId = selectedRow.turn.id;
    if (
      this.scopedRowSetCache?.source === source &&
      this.scopedRowSetCache.scopeTurnId === scopeTurnId
    ) {
      return this.scopedRowSetCache.rowSet;
    }

    const rowSet = createRowSet(
      source.rows.filter((row) => row.turn.id === scopeTurnId),
    );
    this.scopedRowSetCache = { source, scopeTurnId, rowSet };
    return rowSet;
  }

  private invalidateRows(): void {
    this.cachedRowSet = undefined;
    this.scopedRowSetCache = undefined;
    this.invalidateSearchCaches();
  }

  private invalidateSearchCaches(): void {
    this.searchTargetCache = undefined;
    this.searchMatchesCache = undefined;
  }

  private buildRows(): RenderRow[] {
    const rows: RenderRow[] = [];
    const rootIds = this.model.roots.map((root) => root.id);
    const orderedRootIds = this.sortActiveFirst(rootIds);
    this.visibleParentById = new Map<string, string | undefined>();
    this.visibleChildrenById = new Map<string | undefined, string[]>();
    this.visibleChildrenById.set(undefined, orderedRootIds);
    this.multipleVisibleRoots = orderedRootIds.length > 1;

    for (let index = 0; index < orderedRootIds.length; index++) {
      const rootId = orderedRootIds[index];
      if (!rootId) continue;
      this.addTurnRows(
        rows,
        rootId,
        this.multipleVisibleRoots ? 1 : 0,
        this.multipleVisibleRoots,
        this.multipleVisibleRoots,
        index === orderedRootIds.length - 1,
        [],
        this.multipleVisibleRoots,
        undefined,
      );
    }
    return rows;
  }

  private addTurnRows(
    rows: RenderRow[],
    turnId: string,
    indent: number,
    justBranched: boolean,
    showConnector: boolean,
    isLast: boolean,
    gutters: readonly Gutter[],
    isVirtualRootChild: boolean,
    visibleParentId: string | undefined,
  ): void {
    const turn = this.turnsById.get(turnId);
    if (!turn) return;

    this.visibleParentById.set(turnId, visibleParentId);
    const turnRow: TurnRow = {
      id: turn.id,
      kind: "turn",
      selectable: true,
      turn,
      indent,
      showConnector,
      isLast,
      gutters: [...gutters],
      isVirtualRootChild,
    };
    rows.push(turnRow);

    if (
      this.detailTurnId === turn.id ||
      this.model.mode.kind === "git-changes"
    ) {
      this.addDetailRows(rows, turn);
    }

    const childIds = this.sortActiveFirst(this.childrenById.get(turn.id) ?? []);
    this.visibleChildrenById.set(turnId, childIds);
    if (this.foldedBranchIds.has(turn.id)) return;

    const multipleChildren = childIds.length > 1;
    const childIndent = multipleChildren
      ? indent + 1
      : justBranched && indent > 0
        ? indent + 1
        : indent;
    const connectorDisplayed = showConnector && !isVirtualRootChild;
    const currentDisplayIndent = this.multipleVisibleRoots
      ? Math.max(0, indent - 1)
      : indent;
    const connectorPosition = Math.max(0, currentDisplayIndent - 1);
    const childGutters = connectorDisplayed
      ? [...gutters, { position: connectorPosition, show: !isLast }]
      : gutters;

    for (let index = 0; index < childIds.length; index++) {
      const childId = childIds[index];
      if (!childId) continue;
      this.addTurnRows(
        rows,
        childId,
        childIndent,
        multipleChildren,
        multipleChildren,
        index === childIds.length - 1,
        childGutters,
        false,
        turn.id,
      );
    }
  }

  private addDetailRows(rows: RenderRow[], turn: ReviewTurn): void {
    for (let fileIndex = 0; fileIndex < turn.files.length; fileIndex++) {
      const file = turn.files[fileIndex];
      if (!file) continue;

      const fileIsLast = fileIndex === turn.files.length - 1;
      const filePrefix = fileIsLast ? "└─ " : "├─ ";
      const fileChildPrefix = fileIsLast ? "   " : "│  ";
      rows.push({
        id: file.id,
        kind: "file",
        selectable: true,
        turn,
        prefix: filePrefix,
        file,
      });
      if (this.foldedDetailIds.has(file.id)) continue;

      for (const hunk of file.hunks) {
        rows.push({
          id: hunk.id,
          kind: "hunk",
          selectable: true,
          turn,
          prefix: fileChildPrefix,
          file,
          hunk,
        });
        for (let index = 0; index < hunk.bodyLines.length; index++) {
          rows.push({
            id: diffLineRowId(hunk, index),
            kind: "diff",
            selectable: true,
            turn,
            prefix: fileChildPrefix,
            file,
            hunk,
            text: hunk.bodyLines[index] ?? "",
          });
        }
      }
    }
  }

  private sortActiveFirst(ids: readonly string[]): string[] {
    if (this.model.mode.kind !== "session-turns") return [...ids];

    return [...ids].sort((left, right) => {
      const leftActive = this.subtreeContainsActiveTurn(left);
      const rightActive = this.subtreeContainsActiveTurn(right);
      return Number(rightActive) - Number(leftActive);
    });
  }

  private subtreeContainsActiveTurn(turnId: string): boolean {
    const cached = this.activeDescendantMemo.get(turnId);
    if (cached !== undefined) return cached;

    const contains =
      this.activeTurnIds.has(turnId) ||
      (this.childrenById.get(turnId) ?? []).some((childId) =>
        this.subtreeContainsActiveTurn(childId),
      );
    this.activeDescendantMemo.set(turnId, contains);
    return contains;
  }

  private renderRow(row: RenderRow, width: number): string {
    if (row.kind === "turn") return this.renderTurnRow(row, width);
    return this.renderDetailRow(row, width);
  }

  private renderTurnRow(row: TurnRow, width: number): string {
    const selected = row.id === this.selectedId;
    const cursor = selected ? this.theme.fg("accent", "› ") : "  ";
    const prefix = this.theme.fg("dim", this.prefixForTurnRow(row));
    const foldMarker = this.rootFoldMarker(row);
    const pathMarker =
      this.model.mode.kind === "session-turns" && this.activeTurnIds.has(row.id)
        ? this.theme.fg("accent", "• ")
        : "";
    const label = this.turnLabelParts(row.turn);
    const text = `${foldMarker}${pathMarker}${label.prefix ? this.theme.fg("accent", label.prefix) : ""}${this.theme.fg("text", label.prompt)} ${this.statText(row.turn)} ${this.fileHunkText(row.turn)}`;
    let line = cursor + prefix + (selected ? this.theme.bold(text) : text);
    if (selected) line = this.theme.bg("selectedBg", line);
    return truncateToWidth(line, width);
  }

  private prefixForTurnRow(row: TurnRow): string {
    const displayIndent = this.displayIndentForTurn(row);
    const connector = row.showConnector && !row.isVirtualRootChild;
    const connectorPosition = connector ? displayIndent - 1 : -1;
    const totalChars = displayIndent * 3;
    const prefixChars: string[] = [];
    const isFolded = this.foldedBranchIds.has(row.id);

    for (let index = 0; index < totalChars; index++) {
      const level = Math.floor(index / 3);
      const posInLevel = index % 3;
      const gutter = row.gutters.find(
        (candidate) => candidate.position === level,
      );

      if (gutter) {
        prefixChars.push(posInLevel === 0 && gutter.show ? "│" : " ");
      } else if (connector && level === connectorPosition) {
        if (posInLevel === 0) {
          prefixChars.push(row.isLast ? "└" : "├");
        } else if (posInLevel === 1) {
          prefixChars.push(
            isFolded ? "⊞" : this.isBranchFoldable(row.id) ? "⊟" : "─",
          );
        } else {
          prefixChars.push(" ");
        }
      } else {
        prefixChars.push(" ");
      }
    }

    return prefixChars.join("");
  }

  private displayIndentForTurn(row: TurnRow): number {
    return this.multipleVisibleRoots ? Math.max(0, row.indent - 1) : row.indent;
  }

  private rootFoldMarker(row: TurnRow): string {
    const showsFoldInConnector = row.showConnector && !row.isVirtualRootChild;
    if (!this.foldedBranchIds.has(row.id) || showsFoldInConnector) return "";
    return this.theme.fg("accent", "⊞ ");
  }

  private renderDetailRow(row: DetailRow, width: number): string {
    const selected = row.id === this.selectedId;
    const cursor = selected ? this.theme.fg("accent", "› ") : "  ";
    const prefix = this.theme.fg("dim", row.prefix);
    let content: string;
    if (row.kind === "file") {
      content = `${this.detailFoldMarker(row)}${this.theme.fg("toolTitle", row.file.path)} ${this.statText(row.file)} ${this.hunkCountText(row.file.hunks.length)}`;
    } else if (row.kind === "hunk") {
      content = this.formatHunkLabel(row.hunk);
    } else {
      content = `  ${this.renderDiffLine(row.text, row.hunk.path)}`;
    }

    let line = cursor + prefix + content;
    if (selected) line = this.theme.bg("selectedBg", line);
    return truncateToWidth(line, width);
  }

  private detailFoldMarker(row: FoldableDetailRow): string {
    if (!this.isDetailFoldable(row)) return "";
    return this.foldedDetailIds.has(row.id)
      ? this.theme.fg("accent", "▸ ")
      : this.theme.fg("accent", "▾ ");
  }

  private formatHunkLabel(hunk: ReviewHunk): string {
    return [
      `${this.theme.fg("muted", "@@")} ${this.formatHunkRegion(hunk)}`,
      this.theme.fg("warning", hunk.toolName),
      this.statText(hunk),
    ].join(" · ");
  }

  private formatHunkRegion(hunk: ReviewHunk): string {
    const { end, label, start } = this.hunkRegion(hunk);
    return end === start
      ? `${this.theme.fg("muted", `${label} `)}${this.theme.fg("borderAccent", String(start))}`
      : `${this.theme.fg("muted", `${label} `)}${this.theme.fg("borderAccent", String(start))}${this.theme.fg("muted", "-")}${this.theme.fg("borderAccent", String(end))}`;
  }

  private hunkRegionText(hunk: ReviewHunk): string {
    const { end, label, start } = this.hunkRegion(hunk);
    return end === start ? `${label} ${start}` : `${label} ${start}-${end}`;
  }

  private hunkRegion(hunk: ReviewHunk): {
    end: number;
    label: "line" | "lines";
    start: number;
  } {
    const start = hunk.jumpLine;
    const end =
      hunk.newLines && hunk.newLines > 1
        ? hunk.jumpLine + hunk.newLines - 1
        : hunk.jumpLine;
    return {
      end,
      label: end === start ? "line" : "lines",
      start,
    };
  }

  private renderDiffLine(line: string, filePath: string): string {
    const cacheKey = `${filePath}\0${line}`;
    const cached = this.highlightedDiffLineCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const parsed = parseDiffLine(line);
    if (!parsed) {
      const renderedLine = this.theme.fg("toolDiffContext", line);
      this.highlightedDiffLineCache.set(cacheKey, renderedLine);
      return renderedLine;
    }

    const prefixColor =
      parsed.marker === "+"
        ? "toolDiffAdded"
        : parsed.marker === "-"
          ? "toolDiffRemoved"
          : "toolDiffContext";
    const prefix = this.theme.fg(prefixColor, parsed.prefix);
    const highlightedContent = this.highlightDiffContent(
      parsed.content,
      filePath,
    );

    const renderedLine = highlightedContent
      ? `${prefix}${highlightedContent}`
      : prefix;
    this.highlightedDiffLineCache.set(cacheKey, renderedLine);
    return renderedLine;
  }

  private highlightDiffContent(content: string, filePath: string): string {
    if (!content) return "";

    const language = getLanguageFromPath(filePath);
    if (!language) return this.theme.fg("toolOutput", content);

    return (
      highlightCode(content, language)[0] ??
      this.theme.fg("toolOutput", content)
    );
  }

  private selectCurrentSearchMatch(): void {
    const match = this.findSearchMatch(1, true);
    if (match) this.selectSearchMatch(match);
  }

  private moveSearch(delta: 1 | -1): void {
    if (this.searchQuery.trim().length === 0) {
      this.notice = "No active search. Press / for visible rows or ? for grep.";
      return;
    }

    const match = this.findSearchMatch(delta, false);
    if (!match) {
      this.notice = `No ${this.searchMode === "grep" ? "grep " : ""}matches for "${this.searchQuery}".`;
      return;
    }

    this.selectSearchMatch(match);
  }

  private findSearchMatch(
    delta: 1 | -1,
    includeCurrent: boolean,
  ): SearchMatch | undefined {
    const matches = this.searchMatches();
    if (matches.length === 0) return undefined;

    const selectedIndex = matches.findIndex(
      (match) => match.id === this.selectedId,
    );
    const startIndex =
      selectedIndex !== -1
        ? selectedIndex
        : includeCurrent
          ? 0
          : delta > 0
            ? -1
            : 0;
    const firstStep = includeCurrent ? 0 : 1;

    for (let step = firstStep; step < matches.length + firstStep; step++) {
      const index = positiveModulo(startIndex + delta * step, matches.length);
      const match = matches[index];
      if (match) return match;
    }

    return undefined;
  }

  private selectSearchMatch(match: SearchMatch): void {
    if (this.searchMode === "grep") {
      this.revealSearchMatch(match);
      return;
    }

    this.selectRow(match.id);
  }

  private revealSearchMatch(match: SearchMatch): void {
    for (let parentId = this.parentById.get(match.turn.id); parentId; ) {
      this.foldedBranchIds.delete(parentId);
      parentId = this.parentById.get(parentId);
    }

    if (match.kind !== "turn") {
      this.detailTurnId = match.turn.id;
    }
    if ((match.kind === "hunk" || match.kind === "diff") && match.file) {
      this.foldedDetailIds.delete(match.file.id);
    }

    this.invalidateRows();
    this.selectRow(match.id);
  }

  private searchStatus(): { total: number; selectedIndex: number | undefined } {
    const matches = this.searchMatches();
    const selectedIndex = matches.findIndex(
      (match) => match.id === this.selectedId,
    );
    return {
      total: matches.length,
      selectedIndex: selectedIndex === -1 ? undefined : selectedIndex,
    };
  }

  private searchMatches(): SearchMatch[] {
    const tokens = searchTokens(this.searchQuery);
    if (tokens.length === 0) return [];
    const queryKey = tokens.join("\0");
    const targets = this.searchTargets();
    if (
      this.searchMatchesCache?.mode === this.searchMode &&
      this.searchMatchesCache.queryKey === queryKey &&
      this.searchMatchesCache.targets === targets
    ) {
      return this.searchMatchesCache.matches;
    }

    const matches = targets.filter((match) =>
      this.searchTextMatches(match, tokens),
    );
    this.searchMatchesCache = {
      mode: this.searchMode,
      queryKey,
      targets,
      matches,
    };
    return matches;
  }

  private searchTargets(): SearchMatch[] {
    if (this.searchMode === "grep") {
      if (
        this.searchTargetCache?.mode === "grep" &&
        this.searchTargetCache.rowSet === undefined
      ) {
        return this.searchTargetCache.targets;
      }

      const targets = this.grepSearchTargets();
      this.searchTargetCache = {
        mode: "grep",
        rowSet: undefined,
        targets,
      };
      return targets;
    }

    const rowSet = this.getCurrentRowSet();
    if (
      this.searchTargetCache?.mode === "tree" &&
      this.searchTargetCache.rowSet === rowSet
    ) {
      return this.searchTargetCache.targets;
    }

    const targets = rowSet.rows.map((row) => this.searchMatchForRow(row));
    this.searchTargetCache = {
      mode: "tree",
      rowSet,
      targets,
    };
    return targets;
  }

  private grepSearchTargets(): SearchMatch[] {
    const matches: SearchMatch[] = [];
    const visitedTurnIds = new Set<string>();
    const addTurn = (turnId: string): void => {
      if (visitedTurnIds.has(turnId)) return;
      const turn = this.turnsById.get(turnId);
      if (!turn) return;
      visitedTurnIds.add(turnId);

      matches.push(
        this.createSearchMatch({
          id: turn.id,
          kind: "turn",
          turn,
          text: this.turnPlainText(turn),
        }),
      );

      for (const file of turn.files) {
        matches.push(
          this.createSearchMatch({
            id: file.id,
            kind: "file",
            turn,
            file,
            text: this.filePlainText(file),
          }),
        );

        for (const hunk of file.hunks) {
          matches.push(
            this.createSearchMatch({
              id: hunk.id,
              kind: "hunk",
              turn,
              file,
              hunk,
              text: this.hunkPlainText(hunk),
            }),
          );

          for (let index = 0; index < hunk.bodyLines.length; index++) {
            matches.push(
              this.createSearchMatch({
                id: diffLineRowId(hunk, index),
                kind: "diff",
                turn,
                file,
                hunk,
                text: hunk.bodyLines[index] ?? "",
              }),
            );
          }
        }
      }

      for (const childId of this.sortActiveFirst(
        this.childrenById.get(turn.id) ?? [],
      )) {
        addTurn(childId);
      }
    };

    for (const rootId of this.sortActiveFirst(
      this.model.roots.map((root) => root.id),
    )) {
      addTurn(rootId);
    }
    for (const turn of this.model.turns) addTurn(turn.id);

    return matches;
  }

  private searchMatchForRow(row: RenderRow): SearchMatch {
    if (row.kind === "turn") {
      return this.createSearchMatch({
        id: row.id,
        kind: row.kind,
        turn: row.turn,
        text: this.turnPlainText(row.turn),
      });
    }

    if (row.kind === "file") {
      return this.createSearchMatch({
        id: row.id,
        kind: row.kind,
        turn: row.turn,
        file: row.file,
        text: this.filePlainText(row.file),
      });
    }

    if (row.kind === "hunk") {
      return this.createSearchMatch({
        id: row.id,
        kind: row.kind,
        turn: row.turn,
        file: row.file,
        hunk: row.hunk,
        text: this.hunkPlainText(row.hunk),
      });
    }

    return this.createSearchMatch({
      id: row.id,
      kind: row.kind,
      turn: row.turn,
      file: row.file,
      hunk: row.hunk,
      text: row.text,
    });
  }

  private createSearchMatch(
    match: Omit<SearchMatch, "normalizedText">,
  ): SearchMatch {
    return {
      ...match,
      normalizedText: match.text.toLowerCase(),
    };
  }

  private searchTextMatches(
    match: SearchMatch,
    tokens: readonly string[],
  ): boolean {
    return tokens.every((token) => match.normalizedText.includes(token));
  }

  private turnPlainText(turn: ReviewTurn): string {
    return [
      this.turnLabel(turn),
      this.statPlainText(turn),
      this.fileHunkPlainText(turn),
    ].join(" ");
  }

  private filePlainText(file: ReviewFile): string {
    return [
      file.path,
      this.statPlainText(file),
      this.hunkCountPlainText(file.hunks.length),
    ].join(" ");
  }

  private hunkPlainText(hunk: ReviewHunk): string {
    return [
      this.hunkRegionText(hunk),
      hunk.toolName,
      this.statPlainText(hunk),
      hunk.path,
    ].join(" ");
  }

  private moveSelection(delta: number): void {
    const rowSet = this.getCurrentRowSet();
    const rows = rowSet.rows;
    if (rows.length === 0) return;
    const currentIndex = Math.max(
      0,
      rows.findIndex((row) => row.id === this.selectedId),
    );
    const currentRow = rows[currentIndex];
    const nextIndex = clamp(currentIndex + delta, 0, rows.length - 1);
    const nextRow = rows[nextIndex];
    const preserveDetailTurn =
      currentRow !== undefined &&
      currentRow.kind !== "turn" &&
      nextRow?.kind === "turn" &&
      this.detailTurnId === currentRow.turn.id &&
      nextRow.turn.id !== currentRow.turn.id;
    this.selectRow(nextRow?.id, { preserveDetailTurn });
  }

  private moveToHunk(delta: number): void {
    const turn = this.getSelectedTurn();
    if (!turn) return;
    const hunks = this.getAllHunks(turn);
    if (hunks.length === 0) return;
    const selectedHunkId = this.findHunkForRow(this.getSelectedRow())?.id;
    const currentIndex = hunks.findIndex((hunk) => hunk.id === selectedHunkId);
    const nextIndex =
      currentIndex === -1
        ? delta > 0
          ? 0
          : hunks.length - 1
        : clamp(currentIndex + delta, 0, hunks.length - 1);
    const hunk = hunks[nextIndex];
    if (!hunk) return;
    this.detailTurnId = turn.id;
    this.foldedDetailIds.delete(hunk.fileId);
    this.selectedId = hunk.id;
    this.invalidateRows();
  }

  private moveToFile(delta: number): void {
    const turn = this.getSelectedTurn();
    if (!turn || turn.files.length === 0) return;

    const selectedRow = this.getSelectedRow();
    const selectedFileId =
      selectedRow && selectedRow.kind !== "turn"
        ? selectedRow.file.id
        : undefined;
    const currentIndex = turn.files.findIndex(
      (file) => file.id === selectedFileId,
    );
    const nextIndex =
      currentIndex === -1
        ? delta > 0
          ? 0
          : turn.files.length - 1
        : clamp(currentIndex + delta, 0, turn.files.length - 1);
    const file = turn.files[nextIndex];
    if (!file) return;
    this.detailTurnId = turn.id;
    this.selectedId = file.id;
    this.invalidateRows();
  }

  private moveParentOrCollapse(): void {
    const row = this.getSelectedRow();
    if (!row) return;

    if (row.kind === "diff") {
      this.selectRow(row.hunk.id);
      return;
    }

    if (row.kind === "hunk") {
      this.selectRow(row.turn.id);
      return;
    }

    if (row.kind === "file") {
      if (this.isDetailExpanded(row)) {
        this.foldedDetailIds.add(row.id);
        this.invalidateRows();
      } else {
        this.selectRow(row.turn.id);
      }
      return;
    }

    if (this.detailTurnId === row.id) {
      this.detailTurnId = undefined;
      this.invalidateRows();
      return;
    }

    if (this.isBranchFoldable(row.id) && !this.foldedBranchIds.has(row.id)) {
      this.foldedBranchIds.add(row.id);
      this.invalidateRows();
      return;
    }

    const parentId = this.parentById.get(row.id);
    if (parentId) this.selectRow(parentId);
  }

  private moveChildOrExpand(): void {
    const row = this.getSelectedRow();
    if (!row) return;

    if (row.kind === "turn") {
      const firstFile = row.turn.files[0];
      if (firstFile) {
        this.detailTurnId = row.turn.id;
        this.foldedDetailIds.delete(firstFile.id);
        this.selectedId = this.firstReviewRowIdForTurn(row.turn);
        this.invalidateRows();
        return;
      }

      if (this.foldedBranchIds.has(row.id)) {
        this.foldedBranchIds.delete(row.id);
        this.invalidateRows();
        return;
      }
      const childId = this.firstVisibleChildId(row.id);
      if (childId) this.selectRow(childId);
      return;
    }

    if (row.kind === "file") {
      this.detailTurnId = row.turn.id;
      this.foldedDetailIds.delete(row.id);
      this.selectedId = this.firstReviewRowIdForFile(row.file);
      this.invalidateRows();
      return;
    }

    if (row.kind === "hunk") {
      this.detailTurnId = row.turn.id;
      this.foldedDetailIds.delete(row.file.id);
      this.selectedId = this.firstReviewRowIdForHunk(row.hunk);
      this.invalidateRows();
    }
  }

  private collapseSelectedScope(): void {
    const row = this.getSelectedRow();
    if (!row) return;
    if (row.kind === "turn") {
      this.collapseTurnScope(row);
    } else if (row.kind === "file") {
      this.collapseFileLevel(row.turn);
    } else {
      this.selectRow(row.file.id);
      this.collapseFileLevel(row.turn);
    }
  }

  private expandSelectedScope(): void {
    const row = this.getSelectedRow();
    if (!row) return;
    if (row.kind === "turn") {
      this.expandTurnScope(row);
    } else {
      this.expandFileLevel(row.turn);
    }
  }

  private collapseTurnScope(row: TurnRow): void {
    let changed = false;
    if (this.detailTurnId === row.id) {
      this.detailTurnId = undefined;
      changed = true;
    }
    if (this.isBranchFoldable(row.id) && !this.foldedBranchIds.has(row.id)) {
      this.foldedBranchIds.add(row.id);
      changed = true;
    }
    if (changed) this.invalidateRows();
  }

  private expandTurnScope(row: TurnRow): void {
    let changed = false;
    if (this.foldedBranchIds.delete(row.id)) changed = true;
    if (row.turn.files.length > 0 && this.detailTurnId !== row.id) {
      this.detailTurnId = row.id;
      changed = true;
    }
    for (const file of row.turn.files) {
      if (this.foldedDetailIds.delete(file.id)) changed = true;
    }
    if (changed) this.invalidateRows();
  }

  private collapseFileLevel(turn: ReviewTurn): void {
    for (const file of turn.files) {
      this.foldedDetailIds.add(file.id);
    }
    this.invalidateRows();
  }

  private expandFileLevel(turn: ReviewTurn): void {
    this.detailTurnId = turn.id;
    for (const file of turn.files) {
      this.foldedDetailIds.delete(file.id);
    }
    this.invalidateRows();
  }

  private toggleTurnFileJump(): void {
    const row = this.getSelectedRow();
    if (!row) return;
    if (row.kind === "turn") {
      const firstFile = row.turn.files[0];
      if (!firstFile) return;
      this.detailTurnId = row.turn.id;
      this.selectedId = firstFile.id;
      this.invalidateRows();
      return;
    }
    this.selectRow(row.turn.id);
  }

  private selectFirst(): void {
    this.selectRow(this.getRows()[0]?.id);
  }

  private selectLast(): void {
    const rows = this.getRows();
    this.selectRow(rows[rows.length - 1]?.id);
  }

  private selectRow(
    id: string | undefined,
    options: { preserveDetailTurn?: boolean } = {},
  ): void {
    if (!id) return;
    const row = this.getAllRowSet().rows.find(
      (candidate) => candidate.id === id,
    );
    this.selectedId = id;
    if (!row) return;

    if (row.kind === "turn") {
      if (
        this.detailTurnId &&
        this.detailTurnId !== row.id &&
        !options.preserveDetailTurn
      ) {
        this.detailTurnId = undefined;
        this.invalidateRows();
      }
      return;
    }

    const nextDetailTurnId = row.turn.id;
    if (this.detailTurnId !== nextDetailTurnId) {
      this.detailTurnId = nextDetailTurnId;
      this.invalidateRows();
    }
  }

  private getSelectedRow(): RenderRow | undefined {
    if (!this.selectedId) return undefined;
    return this.getCurrentRowSet().rows.find(
      (row) => row.id === this.selectedId,
    );
  }

  private getSelectedTurn(): ReviewTurn | undefined {
    const selectedRow = this.getSelectedRow();
    if (selectedRow) return selectedRow.turn;
    if (this.detailTurnId) return this.turnsById.get(this.detailTurnId);
    const preferredHeadId = this.preferredHeadTurnId();
    return preferredHeadId ? this.turnsById.get(preferredHeadId) : undefined;
  }

  private isBranchFoldable(turnId: string): boolean {
    const children = this.visibleChildrenById.get(turnId);
    if (!children || children.length === 0) return false;
    if (children.length > 1) return true;

    const parentId = this.visibleParentById.get(turnId);
    if (parentId === undefined) return false;

    const siblings = this.visibleChildrenById.get(parentId);
    return siblings !== undefined && siblings.length > 1;
  }

  private firstVisibleChildId(turnId: string): string | undefined {
    return this.visibleChildrenById.get(turnId)?.[0];
  }

  private isDetailExpanded(row: FoldableDetailRow): boolean {
    return this.isDetailFoldable(row) && !this.foldedDetailIds.has(row.id);
  }

  private isDetailFoldable(row: FoldableDetailRow): boolean {
    return row.kind === "file" && row.file.hunks.length > 0;
  }

  private getAllHunks(turn: ReviewTurn): ReviewHunk[] {
    return turn.files.flatMap((file) => file.hunks);
  }

  private findHunkForRow(row: RenderRow | undefined): ReviewHunk | undefined {
    if (!row) return undefined;
    if (row.kind === "turn") return this.firstHunk(row.turn);
    if (row.kind === "file") return row.file.hunks[0];
    return row.hunk;
  }

  private firstHunk(turn: ReviewTurn | undefined): ReviewHunk | undefined {
    if (!turn) return undefined;
    for (const file of turn.files) {
      const hunk = file.hunks[0];
      if (hunk) return hunk;
    }
    return undefined;
  }

  private openSelectedHunk(): void {
    const row = this.getSelectedRow();
    const target = this.editorTargetForRow(row);
    if (!target) {
      this.notice = "Select a changed file, hunk, or diff line to open it.";
      return;
    }
    this.notice = openExternalEditor(
      this.tui,
      this.cwd,
      target.path,
      target.line,
    );
  }

  private editorTargetForRow(
    row: RenderRow | undefined,
  ): { path: string; line: number } | undefined {
    if (!row) return undefined;
    if (row.kind === "file") return { path: row.file.path, line: 1 };

    const hunk = this.findHunkForRow(row);
    if (!hunk) return undefined;

    return { path: hunk.path, line: hunk.jumpLine };
  }

  private summaryText(): string {
    const scopeText =
      this.model.mode.kind === "session-turns"
        ? `${this.model.turns.length} turn${this.model.turns.length === 1 ? "" : "s"} • `
        : "";
    return [
      this.theme.fg(
        "muted",
        `${scopeText}${this.model.totalFiles} file${this.model.totalFiles === 1 ? "" : "s"} • ${this.model.totalHunks} hunk${this.model.totalHunks === 1 ? "" : "s"} •`,
      ),
      this.statText(this.model),
    ].join(" ");
  }

  private statusText(): string {
    const rowSet = this.getCurrentRowSet();
    const selectedIndex = rowSet.rows.findIndex(
      (row) => row.id === this.selectedId,
    );
    const position = selectedIndex + 1;
    const selectedRow =
      selectedIndex === -1 ? undefined : rowSet.rows[selectedIndex];
    const scopeText = selectedRow ? this.scopeStatusText(selectedRow) : "";
    return `  (${Math.max(0, position)}/${rowSet.rows.length})${scopeText ? ` ${scopeText}` : ""}`;
  }

  private scopeStatusText(row: RenderRow): string {
    const parts = [this.turnScopeText(row.turn)];
    if (row.kind !== "turn") parts.push(this.fileScopeText(row.file));
    if (row.kind === "hunk" || row.kind === "diff") {
      parts.push(this.hunkScopeText(row.hunk, row.turn));
    }
    if (row.kind === "diff")
      parts.push(this.diffLineScopeText(row.hunk, row.id));
    return parts.join(" · ");
  }

  private turnScopeText(turn: ReviewTurn): string {
    const index = this.model.turns.findIndex(
      (candidate) => candidate.id === turn.id,
    );
    const label = this.model.mode.kind === "session-turns" ? "turn" : "section";
    return `${label} ${index === -1 ? "?" : index + 1}/${this.model.turns.length}`;
  }

  private fileScopeText(file: ReviewFile): string {
    const turn = this.turnsById.get(file.turnId);
    const index =
      turn?.files.findIndex((candidate) => candidate.id === file.id) ?? -1;
    return `file ${index === -1 ? "?" : index + 1}/${turn?.files.length ?? "?"}`;
  }

  private hunkScopeText(hunk: ReviewHunk, turn: ReviewTurn): string {
    const hunks = this.getAllHunks(turn);
    const index = hunks.findIndex((candidate) => candidate.id === hunk.id);
    return `hunk ${index === -1 ? "?" : index + 1}/${hunks.length}`;
  }

  private diffLineScopeText(hunk: ReviewHunk, rowId: string): string {
    const index = hunk.bodyLines.findIndex(
      (_line, candidateIndex) => diffLineRowId(hunk, candidateIndex) === rowId,
    );
    return `line ${index === -1 ? "?" : index + 1}/${hunk.bodyLines.length}`;
  }

  private statText(stats: { additions: number; removals: number }): string {
    const parts = this.statParts(stats);
    return `${this.theme.fg("toolDiffAdded", parts.additions)} ${this.theme.fg("toolDiffRemoved", parts.removals)}`;
  }

  private statPlainText(stats: {
    additions: number;
    removals: number;
  }): string {
    return this.statParts(stats).plain;
  }

  private statParts(stats: { additions: number; removals: number }): {
    additions: string;
    plain: string;
    removals: string;
  } {
    const additions = `+${stats.additions}`;
    const removals = `-${stats.removals}`;
    return {
      additions,
      plain: `${additions} ${removals}`,
      removals,
    };
  }

  private hunkCountText(hunkCount: number): string {
    const parts = this.countParts(hunkCount, "hunk");
    return `${this.theme.fg("warning", parts.count)} ${this.theme.fg("muted", parts.label)}`;
  }

  private hunkCountPlainText(hunkCount: number): string {
    return this.countParts(hunkCount, "hunk").plain;
  }

  private fileCountText(fileCount: number): string {
    const parts = this.countParts(fileCount, "file");
    return `${this.theme.fg("warning", parts.count)} ${this.theme.fg("muted", parts.label)}`;
  }

  private fileCountPlainText(fileCount: number): string {
    return this.countParts(fileCount, "file").plain;
  }

  private countParts(
    count: number,
    singular: string,
  ): {
    count: string;
    label: string;
    plain: string;
  } {
    const countText = String(count);
    const label = `${singular}${count === 1 ? "" : "s"}`;
    return {
      count: countText,
      label,
      plain: `${countText} ${label}`,
    };
  }

  private fileHunkText(turn: ReviewTurn): string {
    return `${this.fileCountText(turn.files.length)} ${this.hunkCountText(this.hunkCountForTurn(turn))}`;
  }

  private fileHunkPlainText(turn: ReviewTurn): string {
    return `${this.fileCountPlainText(turn.files.length)} ${this.hunkCountPlainText(this.hunkCountForTurn(turn))}`;
  }

  private hunkCountForTurn(turn: ReviewTurn): number {
    return turn.files.reduce((total, file) => total + file.hunks.length, 0);
  }

  private turnLabel(turn: ReviewTurn): string {
    return this.turnLabelParts(turn).plain;
  }

  private turnLabelParts(turn: ReviewTurn): {
    plain: string;
    prefix: string;
    prompt: string;
  } {
    const prefix = this.turnLabelPrefix();
    const prompt = turn.prompt || "(empty prompt)";
    return {
      plain: `${prefix}${prompt}`,
      prefix,
      prompt,
    };
  }

  private turnLabelPrefix(): string {
    return this.model.mode.kind === "session-turns" ? "user: " : "";
  }
}

interface ParsedDiffLine {
  marker: "+" | "-" | " ";
  prefix: string;
  content: string;
  lineNumber?: number;
}

class SummaryBodyBuilder {
  private readonly chunks: string[] = [];
  private length = 0;
  private truncated = false;

  constructor(private readonly maxChars: number) {}

  addLine(line = ""): void {
    this.append(`${this.chunks.length === 0 ? "" : "\n"}${line}`);
  }

  toString(): string {
    return this.chunks.join("");
  }

  private append(text: string): void {
    if (this.truncated) return;

    const remaining = this.maxChars - this.length;
    if (text.length <= remaining) {
      this.chunks.push(text);
      this.length += text.length;
      return;
    }

    if (remaining > 0) {
      this.chunks.push(text.slice(0, remaining));
      this.length += remaining;
    }
    this.chunks.push(
      `\n\n[BetterDiff summary context truncated at ${this.maxChars} characters]`,
    );
    this.truncated = true;
  }
}

function createRowSet(rows: RenderRow[]): RowSet {
  return { rows };
}

function diffLineRowId(hunk: ReviewHunk, index: number): string {
  return `${hunk.id}:line:${index}`;
}

function parseDiffLine(line: string): ParsedDiffLine | undefined {
  const match = /^([+\- ])(\s*\d*)\s?(.*)$/u.exec(line);
  if (!match?.[1]) return undefined;

  const marker = match[1];
  if (marker !== "+" && marker !== "-" && marker !== " ") return undefined;

  const lineNumber = match[2] ?? "";
  const content = match[3] ?? "";
  const parsedLine: ParsedDiffLine = {
    marker,
    prefix: `${marker}${lineNumber}${content ? " " : ""}`,
    content,
  };
  const parsedLineNumber = parseDiffLineNumber(lineNumber);
  return parsedLineNumber === undefined
    ? parsedLine
    : { ...parsedLine, lineNumber: parsedLineNumber };
}

function parseDiffLineNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

interface UndoEditResult {
  hunks: number;
  files: number;
}

interface ReverseHunkEdit {
  hunk: ReviewHunk;
  currentLines: string[];
  restoredLines: string[];
  currentStartLine: number;
}

function undoEditHunks(
  cwd: string,
  hunks: readonly ReviewHunk[],
): UndoEditResult {
  const editsByPath = new Map<string, ReverseHunkEdit[]>();

  for (const hunk of hunks) {
    if (hunk.toolName !== "edit") continue;
    const edit = reverseEditForHunk(hunk);
    const edits = editsByPath.get(hunk.path) ?? [];
    edits.push(edit);
    editsByPath.set(hunk.path, edits);
  }

  if (editsByPath.size === 0) {
    throw new Error("No reversible edit hunks in this scope.");
  }

  const nextContentByPath = new Map<string, string>();
  for (const [filePath, edits] of editsByPath) {
    const absolutePath = resolve(cwd, filePath);
    if (!existsSync(absolutePath)) {
      throw new Error(`File no longer exists: ${filePath}`);
    }

    const rawContent = readFileSync(absolutePath, "utf8");
    const lineEnding = detectLineEnding(rawContent);
    const normalizedLines = normalizeLineEndings(rawContent).split("\n");

    for (const edit of [...edits].sort(compareEditsFromBottom)) {
      replaceLineSequenceAtExpectedLocation(
        normalizedLines,
        edit.currentLines,
        edit.restoredLines,
        edit.hunk,
        edit.currentStartLine,
      );
    }

    const normalizedContent =
      normalizedLines.length === 1 && normalizedLines[0] === ""
        ? ""
        : normalizedLines.join("\n");
    nextContentByPath.set(
      absolutePath,
      restoreLineEndings(normalizedContent, lineEnding),
    );
  }

  for (const [absolutePath, content] of nextContentByPath) {
    writeFileSync(absolutePath, content, "utf8");
  }

  return {
    hunks: [...editsByPath.values()].reduce(
      (total, edits) => total + edits.length,
      0,
    ),
    files: editsByPath.size,
  };
}

function reverseEditForHunk(hunk: ReviewHunk): ReverseHunkEdit {
  const currentLines: string[] = [];
  const restoredLines: string[] = [];
  let currentStartLine: number | undefined;

  for (const line of hunk.bodyLines) {
    const parsed = parseDiffLine(line);
    if (!parsed) {
      throw new Error(
        `Cannot parse diff line in ${hunk.path}:${hunk.jumpLine}`,
      );
    }

    if (parsed.marker === "+") {
      currentStartLine ??= parsed.lineNumber;
      currentLines.push(parsed.content);
    } else if (parsed.marker === "-") {
      restoredLines.push(parsed.content);
    } else {
      currentStartLine ??= parsed.lineNumber;
      currentLines.push(parsed.content);
      restoredLines.push(parsed.content);
    }
  }

  if (currentLines.length === 0) {
    throw new Error(
      `Cannot undo ${hunk.path}:${hunk.jumpLine}; the current-side hunk is empty or lacks context.`,
    );
  }

  return {
    hunk,
    currentLines,
    restoredLines,
    currentStartLine: Math.max(
      1,
      currentStartLine ?? hunk.newStart ?? hunk.jumpLine,
    ),
  };
}

function compareEditsFromBottom(
  left: ReverseHunkEdit,
  right: ReverseHunkEdit,
): number {
  return right.currentStartLine - left.currentStartLine;
}

function replaceLineSequenceAtExpectedLocation(
  lines: string[],
  searchLines: readonly string[],
  replacementLines: readonly string[],
  hunk: ReviewHunk,
  expectedStartLine: number,
): void {
  const matchIndex = expectedStartLine - 1;

  if (!lineSequenceMatches(lines, searchLines, matchIndex)) {
    throw new Error(
      `Current text for ${hunk.path}:${hunk.jumpLine} was not found at expected line ${expectedStartLine}. The file may have changed after the edit.`,
    );
  }

  lines.splice(matchIndex, searchLines.length, ...replacementLines);
}

function lineSequenceMatches(
  lines: readonly string[],
  searchLines: readonly string[],
  startIndex: number,
): boolean {
  for (let index = 0; index < searchLines.length; index++) {
    if (lines[startIndex + index] !== searchLines[index]) return false;
  }
  return true;
}

function detectLineEnding(content: string): "\n" | "\r\n" {
  const crlfIndex = content.indexOf("\r\n");
  const lfIndex = content.indexOf("\n");
  if (lfIndex === -1) return "\n";
  if (crlfIndex === -1) return "\n";
  return crlfIndex <= lfIndex ? "\r\n" : "\n";
}

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
}

function restoreLineEndings(
  content: string,
  lineEnding: "\n" | "\r\n",
): string {
  return lineEnding === "\r\n" ? content.replace(/\n/gu, "\r\n") : content;
}

function openExternalEditor(
  tui: TUI,
  cwd: string,
  filePath: string,
  line: number,
): string {
  const absolutePath = resolve(cwd, filePath);
  if (!existsSync(absolutePath)) {
    return `File no longer exists: ${filePath}`;
  }

  const editorCommand =
    process.env.VISUAL || process.env.EDITOR || firstAvailableEditor() || "vi";
  const [editor, ...editorArgs] = splitCommandLine(editorCommand);
  if (!editor) return "No external editor configured.";

  const args = buildEditorArgs(editor, editorArgs, absolutePath, line);
  try {
    tui.stop();
    const result = spawnSync(editor, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    if (result.error) {
      return `Editor failed: ${result.error.message}`;
    }
    if (result.status && result.status !== 0) {
      return `Editor exited with status ${result.status}`;
    }
    return `Returned from ${editor} at ${filePath}:${line}`;
  } finally {
    tui.start();
    tui.requestRender(true);
  }
}

function firstAvailableEditor(): string | undefined {
  for (const candidate of ["nvim", "vim", "vi"] as const) {
    if (commandExists(candidate)) return candidate;
  }
  return undefined;
}

function commandExists(command: string): boolean {
  const result =
    process.platform === "win32"
      ? spawnSync("where", [command], { stdio: "ignore" })
      : spawnSync("sh", ["-lc", `command -v ${shellQuote(command)}`], {
          stdio: "ignore",
        });
  return result.status === 0;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function splitCommandLine(commandLine: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (const char of commandLine.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/u.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaped) current += "\\";
  if (current) parts.push(current);
  return parts;
}

function buildEditorArgs(
  editor: string,
  editorArgs: string[],
  filePath: string,
  line: number,
): string[] {
  const editorName = (editor.split(/[\\/]/u).pop() ?? editor).toLowerCase();
  if (
    editorName === "code" ||
    editorName === "code-insiders" ||
    editorName === "cursor"
  ) {
    return [...editorArgs, "--goto", `${filePath}:${line}:1`];
  }
  if (editorName === "hx" || editorName === "helix") {
    return [...editorArgs, `${filePath}:${line}:1`];
  }
  return [...editorArgs, `+${line}`, filePath];
}

function requestLabel(request: DiffReviewLoadRequest): string {
  if (request.kind === "git-branch-selected") {
    return `Current branch vs ${request.baseRef}`;
  }
  return (
    DIFF_MODE_CHOICES.find((choice) => choice.kind === request.kind)?.label ??
    request.kind
  );
}

function parseBracketCommand(data: string): BracketCommand | undefined {
  const chars = [...data];
  if (chars.length !== 2) return undefined;

  const [bracket, suffix] = chars;
  if (bracket !== "[" && bracket !== "]") return undefined;

  const normalizedSuffix = suffix?.toLowerCase();
  if (normalizedSuffix === "f") return { bracket, target: "file" };
  if (normalizedSuffix === "h") return { bracket, target: "hunk" };
  return undefined;
}

function searchTokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/u).filter(Boolean);
}

function isPrintableInput(data: string): boolean {
  if (data.length === 0) return false;
  return [...data].every((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code >= 32 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f);
  });
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

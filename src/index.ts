import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

import {
  gitBranchDiffArgs,
  gitDiffArgs,
  gitUntrackedDiffArgs,
  gitUntrackedFilesArgs,
  joinGitPatches,
  parseGitBranchReviewModel,
  parseGitChangesReviewModel,
  parseGitNulPathList,
} from "./diff/git.js";
import { buildReviewModelFromTree } from "./diff/model.js";
import type { ReviewModeKind, ReviewModel } from "./diff/model.js";
import {
  DiffReviewComponent,
  type DiffReviewAction,
  type DiffReviewLoadRequest,
  type DiffReviewSummaryRequest,
} from "./render/diff-review-ui.js";

export const BETTERDIFF_EXTENSION_STAGE = "ui-prototype" as const;

export const BETTERDIFF_NEXT_STEPS = [
  "Collect richer mutation history for write/overwrite operations.",
  "Refine split tree/detail rendering with golden tests.",
  "Add golden tests for renderer output and editor adapter targeting.",
] as const;

const UNTRACKED_DIFF_CONCURRENCY = 4;

export default function betterDiffExtension(pi: ExtensionAPI): void {
  async function openDiffReview(
    ctx: ExtensionCommandContext,
    initialRequest: DiffReviewLoadRequest,
  ): Promise<void> {
    if (!ctx.hasUI) {
      ctx.ui.notify("/diff requires interactive UI mode.", "warning");
      return;
    }

    await ctx.waitForIdle();

    let model: ReviewModel;
    try {
      model = await loadReviewModel(initialRequest, ctx);
    } catch (error) {
      ctx.ui.notify(
        `Failed to load diff: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
      return;
    }

    const action = await ctx.ui.custom<DiffReviewAction>(
      (tui, theme, keybindings, done) => {
        return new DiffReviewComponent(
          model,
          ctx.cwd,
          tui,
          theme,
          keybindings,
          done,
          (request) => loadReviewModel(request, ctx),
          () => loadGitBranchRefs(ctx),
        );
      },
    );

    if (!action || action.type === "close") return;
    await handleDiffReviewAction(action, ctx);
  }

  async function loadReviewModel(
    request: DiffReviewLoadRequest,
    ctx: ExtensionCommandContext,
  ): Promise<ReviewModel> {
    if (request.kind === "session-turns") {
      return buildReviewModelFromTree(
        ctx.sessionManager.getTree(),
        ctx.sessionManager.getLeafId(),
      );
    }

    if (request.kind === "git-changes") {
      return loadGitChangesReviewModel(ctx);
    }

    if (request.kind === "git-branch-main") {
      const baseRef = await findDefaultBaseRef(ctx);
      return loadGitBranchReviewModel(ctx, "git-branch-main", baseRef);
    }

    return loadGitBranchReviewModel(
      ctx,
      "git-branch-selected",
      request.baseRef,
    );
  }

  async function loadGitChangesReviewModel(
    ctx: ExtensionCommandContext,
  ): Promise<ReviewModel> {
    const [stagedResult, unstagedResult, untrackedFilesResult] =
      await Promise.all([
        pi.exec("git", gitDiffArgs("staged"), {
          cwd: ctx.cwd,
          timeout: 30_000,
        }),
        pi.exec("git", gitDiffArgs("unstaged"), {
          cwd: ctx.cwd,
          timeout: 30_000,
        }),
        pi.exec("git", gitUntrackedFilesArgs(), {
          cwd: ctx.cwd,
          timeout: 30_000,
        }),
      ]);

    if (stagedResult.code !== 0) {
      throw new Error(
        stagedResult.stderr.trim() ||
          `git staged diff exited with status ${stagedResult.code}`,
      );
    }
    if (unstagedResult.code !== 0) {
      throw new Error(
        unstagedResult.stderr.trim() ||
          `git unstaged diff exited with status ${unstagedResult.code}`,
      );
    }
    if (untrackedFilesResult.code !== 0) {
      throw new Error(
        untrackedFilesResult.stderr.trim() ||
          `git untracked file listing exited with status ${untrackedFilesResult.code}`,
      );
    }

    const untrackedPatch = await loadUntrackedGitPatch(
      ctx,
      parseGitNulPathList(untrackedFilesResult.stdout),
    );

    return parseGitChangesReviewModel(
      stagedResult.stdout,
      joinGitPatches([unstagedResult.stdout, untrackedPatch]),
    );
  }

  async function loadUntrackedGitPatch(
    ctx: ExtensionCommandContext,
    paths: readonly string[],
  ): Promise<string> {
    if (paths.length === 0) return "";

    const patches = Array<string>(paths.length).fill("");
    let nextIndex = 0;
    const workerCount = Math.min(UNTRACKED_DIFF_CONCURRENCY, paths.length);

    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        for (;;) {
          const index = nextIndex;
          nextIndex += 1;
          const path = paths[index];
          if (path === undefined) return;
          patches[index] = await loadSingleUntrackedGitPatch(ctx, path);
        }
      }),
    );

    return joinGitPatches(patches);
  }

  async function loadSingleUntrackedGitPatch(
    ctx: ExtensionCommandContext,
    path: string,
  ): Promise<string> {
    const result = await pi.exec("git", gitUntrackedDiffArgs(path), {
      cwd: ctx.cwd,
      timeout: 30_000,
    });
    if (result.code !== 0 && !(result.code === 1 && result.stdout.length > 0)) {
      throw new Error(
        result.stderr.trim() ||
          `git untracked diff for ${path} exited with status ${result.code}`,
      );
    }
    return result.stdout;
  }

  async function loadGitBranchReviewModel(
    ctx: ExtensionCommandContext,
    kind: Extract<ReviewModeKind, "git-branch-main" | "git-branch-selected">,
    baseRef: string,
  ): Promise<ReviewModel> {
    await verifyGitRef(ctx, baseRef);
    const currentRef = await getCurrentGitRef(ctx);
    await ensureMergeBase(ctx, baseRef, currentRef);

    const result = await pi.exec("git", gitBranchDiffArgs(baseRef), {
      cwd: ctx.cwd,
      timeout: 30_000,
    });
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim() ||
          `git branch diff exited with status ${result.code}`,
      );
    }

    return parseGitBranchReviewModel(result.stdout, {
      kind,
      baseRef,
      currentRef,
      range: `${baseRef}...${currentRef}`,
    });
  }

  async function loadGitBranchRefs(
    ctx: ExtensionCommandContext,
  ): Promise<string[]> {
    const result = await pi.exec(
      "git",
      [
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads",
        "refs/remotes",
        "refs/tags",
      ],
      { cwd: ctx.cwd, timeout: 10_000 },
    );
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim() ||
          `git for-each-ref exited with status ${result.code}`,
      );
    }

    return [...new Set(result.stdout.split("\n").map((ref) => ref.trim()))]
      .filter((ref) => ref.length > 0)
      .filter((ref) => !ref.endsWith("/HEAD"));
  }

  async function findDefaultBaseRef(
    ctx: ExtensionCommandContext,
  ): Promise<string> {
    const originHead = await tryGitStdout(ctx, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    const candidates = [
      originHead,
      "main",
      "master",
      "origin/main",
      "origin/master",
    ].filter((candidate): candidate is string => Boolean(candidate));

    for (const candidate of candidates) {
      if (await gitRefExists(ctx, candidate)) return candidate;
    }

    throw new Error(
      "Could not find main/master. Use 'Current branch vs selected branch…' instead.",
    );
  }

  async function getCurrentGitRef(
    ctx: ExtensionCommandContext,
  ): Promise<string> {
    const branch = (
      await gitStdout(ctx, ["rev-parse", "--abbrev-ref", "HEAD"])
    ).trim();
    if (branch && branch !== "HEAD") return branch;
    return (await gitStdout(ctx, ["rev-parse", "--short", "HEAD"])).trim();
  }

  async function verifyGitRef(
    ctx: ExtensionCommandContext,
    ref: string,
  ): Promise<void> {
    if (await gitRefExists(ctx, ref)) return;
    throw new Error(`Invalid git ref: ${ref}`);
  }

  async function ensureMergeBase(
    ctx: ExtensionCommandContext,
    baseRef: string,
    currentRef: string,
  ): Promise<void> {
    const result = await pi.exec("git", ["merge-base", baseRef, "HEAD"], {
      cwd: ctx.cwd,
      timeout: 10_000,
    });
    if (result.code === 0) return;
    throw new Error(`No common ancestor between ${baseRef} and ${currentRef}.`);
  }

  async function gitRefExists(
    ctx: ExtensionCommandContext,
    ref: string,
  ): Promise<boolean> {
    const result = await pi.exec(
      "git",
      ["rev-parse", "--verify", `${ref}^{commit}`],
      {
        cwd: ctx.cwd,
        timeout: 10_000,
      },
    );
    return result.code === 0;
  }

  async function tryGitStdout(
    ctx: ExtensionCommandContext,
    args: string[],
  ): Promise<string | undefined> {
    const result = await pi.exec("git", args, {
      cwd: ctx.cwd,
      timeout: 10_000,
    });
    if (result.code !== 0) return undefined;
    const stdout = result.stdout.trim();
    return stdout || undefined;
  }

  async function gitStdout(
    ctx: ExtensionCommandContext,
    args: string[],
  ): Promise<string> {
    const result = await pi.exec("git", args, {
      cwd: ctx.cwd,
      timeout: 10_000,
    });
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
    }
    return result.stdout;
  }

  function parseInitialDiffMode(
    args: string,
  ): DiffReviewLoadRequest | undefined {
    const raw = args.trim();
    const normalized = raw.toLowerCase();
    if (!normalized) return { kind: "session-turns" };
    if (
      [
        "git",
        "changes",
        "git-changes",
        "staged",
        "--staged",
        "cached",
        "--cached",
        "unstaged",
        "--unstaged",
        "worktree",
        "working",
      ].includes(normalized)
    ) {
      return { kind: "git-changes" };
    }
    if (
      [
        "branch",
        "branches",
        "branch-main",
        "default-branch",
        "main-master",
        "main/master",
        "main",
        "master",
        "pr",
      ].includes(normalized)
    ) {
      return { kind: "git-branch-main" };
    }

    const selectedBranchMatch = /^(?:branch|vs|base)\s+(.+)$/iu.exec(raw);
    const baseRef = selectedBranchMatch?.[1]?.trim();
    if (baseRef) return { kind: "git-branch-selected", baseRef };

    if (["session", "session-turns", "turns"].includes(normalized)) {
      return { kind: "session-turns" };
    }
    return undefined;
  }

  async function handleDiffReviewAction(
    action: DiffReviewAction,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    if (action.type === "summarize") {
      await sendSummaryRequest(action.summary, action.custom, ctx);
    }
  }

  async function sendSummaryRequest(
    summary: DiffReviewSummaryRequest,
    custom: boolean,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    let customInstructions: string | undefined;
    if (custom) {
      customInstructions = await ctx.ui.editor(
        "Custom BetterDiff summary instructions",
        "Focus on behavior changes, risks, and follow-up tests.",
      );
      if (customInstructions === undefined) {
        ctx.ui.notify("Summary cancelled", "info");
        return;
      }
    }

    await ctx.waitForIdle();
    pi.sendUserMessage(buildSummaryPrompt(summary, customInstructions));
  }

  function buildSummaryPrompt(
    summary: DiffReviewSummaryRequest,
    customInstructions: string | undefined,
  ): string {
    return [
      "Summarize this BetterDiff selection.",
      "Focus only on the supplied BetterDiff context. Do not modify files or run tools unless I explicitly ask later.",
      customInstructions?.trim()
        ? `\nAdditional summary instructions:\n${customInstructions.trim()}`
        : undefined,
      `\nSelection: ${summary.title}`,
      "\nDiff context:",
      "```diff",
      summary.body,
      "```",
    ]
      .filter((part): part is string => part !== undefined)
      .join("\n");
  }

  pi.registerCommand("diff", {
    description: "Review session or git file diffs",
    handler: async (args, ctx) => {
      const mode = parseInitialDiffMode(args);
      if (!mode) {
        ctx.ui.notify(
          "Usage: /diff [session|git|branch|branch <base-ref>]. You can also press m inside Better Diff to switch modes.",
          "warning",
        );
        return;
      }
      await openDiffReview(ctx, mode);
    },
  });
}

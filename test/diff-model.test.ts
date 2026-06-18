import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  buildReviewModel,
  buildReviewModelFromTree,
} from "../src/diff/model.js";

interface TestTreeNode {
  entry: SessionEntry;
  children: TestTreeNode[];
}

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

describe("buildReviewModel", () => {
  it("groups edit diffs by turn, file, and hunk", () => {
    const entries: SessionEntry[] = [
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-04-23T00:00:00.000Z",
        message: { role: "user", content: "change alpha", timestamp: 1 },
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-04-23T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-edit",
              name: "edit",
              arguments: { path: "src/a.ts" },
            },
          ],
          api: "test-api",
          provider: "test-provider",
          model: "test-model",
          usage,
          stopReason: "toolUse",
          timestamp: 2,
        },
      },
      {
        type: "message",
        id: "t1",
        parentId: "a1",
        timestamp: "2026-04-23T00:00:02.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-edit",
          toolName: "edit",
          isError: false,
          content: [{ type: "text", text: "ok" }],
          details: {
            diff: "  1 keep\n- 2 old\n+ 2 new\n   ...\n 10 keep\n-11 gone\n+11 added",
            firstChangedLine: 2,
          },
          timestamp: 3,
        },
      },
    ];

    const model = buildReviewModel(entries);

    expect(model.turns).toHaveLength(1);
    expect(model.totalFiles).toBe(1);
    expect(model.totalHunks).toBe(2);
    expect(model.additions).toBe(2);
    expect(model.removals).toBe(2);
    expect(model.turns[0]?.files[0]?.path).toBe("src/a.ts");
    expect(
      model.turns[0]?.files[0]?.hunks.map((hunk) => hunk.jumpLine),
    ).toEqual([2, 11]);
  });

  it("includes apply_patch file additions in session turn diffs", () => {
    const entries: SessionEntry[] = [
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-04-23T00:00:00.000Z",
        message: { role: "user", content: "add a poem", timestamp: 1 },
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-04-23T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-patch",
              name: "apply_patch",
              arguments: {
                input: [
                  "*** Begin Patch",
                  "*** Add File: PI_DIFF_TEST_POEM.txt",
                  "+Soft lines in a quiet diff,",
                  "+No wheels turn, no gears shift.",
                  "+Just a small verse left in view,",
                  "+To prove the change came gently through.",
                  "*** End Patch",
                ].join("\n"),
              },
            },
          ],
          api: "test-api",
          provider: "test-provider",
          model: "test-model",
          usage,
          stopReason: "toolUse",
          timestamp: 2,
        },
      },
      {
        type: "message",
        id: "t1",
        parentId: "a1",
        timestamp: "2026-04-23T00:00:02.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-patch",
          toolName: "apply_patch",
          isError: false,
          content: [{ type: "text", text: "Applied patch successfully." }],
          details: {
            status: "success",
            result: { changedFiles: ["PI_DIFF_TEST_POEM.txt"] },
          },
          timestamp: 3,
        },
      },
    ];

    const model = buildReviewModel(entries);

    expect(model.turns).toHaveLength(1);
    expect(model.totalFiles).toBe(1);
    expect(model.totalHunks).toBe(1);
    expect(model.additions).toBe(4);
    expect(model.removals).toBe(0);
    expect(model.turns[0]?.files[0]?.path).toBe("PI_DIFF_TEST_POEM.txt");
    expect(model.turns[0]?.files[0]?.hunks[0]).toMatchObject({
      toolName: "apply_patch",
      jumpLine: 1,
      additions: 4,
      removals: 0,
      bodyLines: [
        "+Soft lines in a quiet diff,",
        "+No wheels turn, no gears shift.",
        "+Just a small verse left in view,",
        "+To prove the change came gently through.",
      ],
    });
  });

  it("keeps the full normalized user prompt for expanded action views", () => {
    const longPrompt =
      `${"summarize these changes ".repeat(12)}final instruction`.trim();
    const entries: SessionEntry[] = [
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-04-23T00:00:00.000Z",
        message: { role: "user", content: longPrompt, timestamp: 1 },
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-04-23T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-edit",
              name: "edit",
              arguments: { path: "src/a.ts" },
            },
          ],
          api: "test-api",
          provider: "test-provider",
          model: "test-model",
          usage,
          stopReason: "toolUse",
          timestamp: 2,
        },
      },
      {
        type: "message",
        id: "t1",
        parentId: "a1",
        timestamp: "2026-04-23T00:00:02.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-edit",
          toolName: "edit",
          isError: false,
          content: [{ type: "text", text: "ok" }],
          details: { diff: " 1 keep\n+2 added", firstChangedLine: 2 },
          timestamp: 3,
        },
      },
    ];

    const model = buildReviewModel(entries);

    expect(longPrompt.length).toBeGreaterThan(200);
    expect(model.turns[0]?.prompt).toBe(longPrompt);
  });

  it("builds a compressed diff-producing turn tree from session branches", () => {
    const u1: SessionEntry = {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-04-23T00:00:00.000Z",
      message: { role: "user", content: "create base", timestamp: 1 },
    };
    const a1: SessionEntry = {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-04-23T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-base",
            name: "write",
            arguments: { path: "README.md", content: "# Base\n" },
          },
        ],
        api: "test-api",
        provider: "test-provider",
        model: "test-model",
        usage,
        stopReason: "toolUse",
        timestamp: 2,
      },
    };
    const t1: SessionEntry = {
      type: "message",
      id: "t1",
      parentId: "a1",
      timestamp: "2026-04-23T00:00:02.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call-base",
        toolName: "write",
        isError: false,
        content: [{ type: "text", text: "ok" }],
        timestamp: 3,
      },
    };
    const u2a: SessionEntry = {
      type: "message",
      id: "u2a",
      parentId: "t1",
      timestamp: "2026-04-23T00:00:03.000Z",
      message: { role: "user", content: "branch alpha", timestamp: 4 },
    };
    const a2a: SessionEntry = {
      type: "message",
      id: "a2a",
      parentId: "u2a",
      timestamp: "2026-04-23T00:00:04.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-alpha",
            name: "edit",
            arguments: { path: "src/a.ts" },
          },
        ],
        api: "test-api",
        provider: "test-provider",
        model: "test-model",
        usage,
        stopReason: "toolUse",
        timestamp: 5,
      },
    };
    const t2a: SessionEntry = {
      type: "message",
      id: "t2a",
      parentId: "a2a",
      timestamp: "2026-04-23T00:00:05.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call-alpha",
        toolName: "edit",
        isError: false,
        content: [{ type: "text", text: "ok" }],
        details: { diff: " 1 keep\n+2 alpha", firstChangedLine: 2 },
        timestamp: 6,
      },
    };
    const u2b: SessionEntry = {
      type: "message",
      id: "u2b",
      parentId: "t1",
      timestamp: "2026-04-23T00:00:06.000Z",
      message: { role: "user", content: "branch beta", timestamp: 7 },
    };
    const a2b: SessionEntry = {
      type: "message",
      id: "a2b",
      parentId: "u2b",
      timestamp: "2026-04-23T00:00:07.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-beta",
            name: "write",
            arguments: { path: "src/b.ts", content: "export const b = 1;\n" },
          },
        ],
        api: "test-api",
        provider: "test-provider",
        model: "test-model",
        usage,
        stopReason: "toolUse",
        timestamp: 8,
      },
    };
    const t2b: SessionEntry = {
      type: "message",
      id: "t2b",
      parentId: "a2b",
      timestamp: "2026-04-23T00:00:08.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call-beta",
        toolName: "write",
        isError: false,
        content: [{ type: "text", text: "ok" }],
        timestamp: 9,
      },
    };
    const tree: TestTreeNode[] = [
      {
        entry: u1,
        children: [
          {
            entry: a1,
            children: [
              {
                entry: t1,
                children: [
                  {
                    entry: u2a,
                    children: [
                      { entry: a2a, children: [{ entry: t2a, children: [] }] },
                    ],
                  },
                  {
                    entry: u2b,
                    children: [
                      { entry: a2b, children: [{ entry: t2b, children: [] }] },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    const model = buildReviewModelFromTree(tree, "t2b");

    expect(model.turns.map((turn) => turn.prompt)).toEqual([
      "create base",
      "branch alpha",
      "branch beta",
    ]);
    expect(model.roots).toHaveLength(1);
    expect(model.roots[0]?.prompt).toBe("create base");
    expect(model.roots[0]?.children.map((turn) => turn.prompt)).toEqual([
      "branch alpha",
      "branch beta",
    ]);
    expect(
      model.activeTurnIds.map(
        (turnId) => model.turns.find((turn) => turn.id === turnId)?.prompt,
      ),
    ).toEqual(["create base", "branch beta"]);
    expect(model.roots[0]?.children[0]?.children).toEqual([]);
  });

  it("creates a synthetic write hunk from tool call content", () => {
    const entries: SessionEntry[] = [
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-04-23T00:00:00.000Z",
        message: { role: "user", content: "write a file", timestamp: 1 },
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-04-23T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-write",
              name: "write",
              arguments: { path: "README.md", content: "# Title\nBody\n" },
            },
          ],
          api: "test-api",
          provider: "test-provider",
          model: "test-model",
          usage,
          stopReason: "toolUse",
          timestamp: 2,
        },
      },
      {
        type: "message",
        id: "t1",
        parentId: "a1",
        timestamp: "2026-04-23T00:00:02.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-write",
          toolName: "write",
          isError: false,
          content: [{ type: "text", text: "ok" }],
          timestamp: 3,
        },
      },
    ];

    const model = buildReviewModel(entries);
    const hunk = model.turns[0]?.files[0]?.hunks[0];

    expect(hunk?.toolName).toBe("write");
    expect(hunk?.jumpLine).toBe(1);
    expect(hunk?.additions).toBe(2);
    expect(hunk?.bodyLines).toEqual(["+1 # Title", "+2 Body"]);
  });
});

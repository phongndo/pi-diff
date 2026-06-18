# TODOs

Feature goals for future BetterDiff diff modes and navigation/search capabilities. This file tracks product/feature work only. Bug fixes, review findings, and cleanup issues belong in `ISSUES.md`.

## Open feature goals

### Diff type goals

- [ ] **Arbitrary git ref -> git ref diff**
  - **User goal:** Compare any two git refs, not necessarily involving the current branch.
  - **Primary command/use case:** User selects or enters both left/base and right/target refs.
  - **Data source:** Git diff between two validated refs.
  - **Comparison meaning:** Product still needs an advanced-mode decision or toggle for two-dot vs three-dot semantics:
    - two-dot: direct endpoint difference, `<left>..<right>`
    - three-dot: merge-base to right side, `<left>...<right>`
  - **UI label:** Make the selected refs and semantics explicit, e.g. `Git branch diff: <left>...<right>` or `Git branch diff: <left>..<right>`.
  - **Expected content:**
    - left/base ref label
    - right/target ref label
    - comparison semantics label
    - changed files between refs
    - hunks and diff body lines
    - additions/removals for the selected ref comparison
  - **Important edge cases:**
    - invalid ref names
    - refs with no common ancestor if three-dot semantics are used
    - renamed files
    - deleted files
    - binary files
    - very large diffs
  - **Definition of done:** The user can tell exactly which refs are being compared and what comparison semantics are being used.

### Possible future work

No open performance feature goals.

## Finished feature goals

### Diff type goals

- [x] **Session turn-by-turn diff**
  - **User goal:** Show what the agent changed, grouped by user turn.
  - **Primary command/use case:** Default `/diff` behavior.
  - **Data source:** pi session tree mutation history from `edit` and `write` tool results.
  - **Comparison meaning:** Not an endpoint comparison. This is a chronological/session-tree review of mutations produced by assistant responses.
  - **Grouping:** Diff-producing user turns, arranged by compressed pi session ancestry.
  - **UI label:** `Session turns`.
  - **Expected content:**
    - user prompt preview for each changed turn
    - changed files under the selected turn
    - hunks under each file
    - diff body lines under expanded hunks
    - additions/removals and hunk/file counts
  - **Important edge cases:**
    - multiple changed files in one turn
    - multiple hunks in one file
    - branch/fork siblings in the pi session tree
    - `write` previews that are truncated
    - turns with edits on inactive branches
  - **Definition of done:** The current session review remains usable as the default mode and clearly says it is reviewing session turns.

- [x] **Git changes diff: staged above unstaged**
  - **User goal:** Review all local git changes in one BetterDiff page while clearly separating what is staged from what is unstaged.
  - **Primary command/use case:** `/diff git`, `/diff changes`, or selecting `Git changes` from the in-UI mode menu.
  - **Data sources:**
    - staged section: `git diff --cached` / `git diff --staged`
    - unstaged section: `git diff`
  - **Comparison meaning:**
    - staged section: Git index compared against `HEAD`
    - unstaged section: working tree compared against the git index
  - **Grouping:** Two top-level tree rows, with `Staged changes — HEAD → index` above `Unstaged changes — index → working tree`.
  - **UI label:** `Git changes`.
  - **Expected content:**
    - staged files/hunks/diff body lines in the staged section only
    - unstaged files/hunks/diff body lines in the unstaged section only
    - additions/removals scoped to each section and totaled for the mode
    - clear empty state when neither staged nor unstaged changes exist
  - **Important edge cases:**
    - no staged changes but unstaged changes exist
    - staged changes but no unstaged changes exist
    - file has both staged and unstaged changes
    - newly added files
    - deleted tracked files
    - renamed files
    - mode-only changes
    - binary files
    - paths with spaces
  - **Definition of done:** Staged and unstaged changes are reviewed on one page, with staged changes clearly grouped above unstaged changes and no mixing with session mutation history.

- [x] **Current branch -> main/master diff**
  - **User goal:** Quickly review what the current branch introduces relative to the repository's default/main branch.
  - **Primary command/use case:** `/diff branch` or selecting `Current branch vs main/master` from the in-UI mode menu.
  - **Data source:** Git diff between an auto-detected base ref and `HEAD`.
  - **Base ref detection order:**
    - `origin/HEAD`
    - `main`
    - `master`
    - `origin/main`
    - `origin/master`
  - **Comparison meaning:** PR-style merge-base comparison, `<base>...HEAD`, i.e. `merge-base(base, current) -> current`.
  - **UI label:** `Current branch vs <base>` with `merge-base(<base>, <current>) → <current>`.
  - **Expected content:**
    - detected base ref label
    - current branch/ref label
    - changed files between merge-base and current branch
    - hunks and diff body lines
    - additions/removals for the selected ref comparison
  - **Important edge cases:**
    - no main/master/default base can be detected
    - base ref is invalid or unavailable locally
    - no common ancestor
    - renamed files
    - deleted files
    - binary files
    - very large diffs
  - **Definition of done:** The user can launch a one-step PR-style current-branch review against main/master and tell exactly which base/current refs and semantics are being used.

- [x] **Current branch -> selected branch/ref diff**
  - **User goal:** Compare the current branch against any selected base branch/ref.
  - **Primary command/use case:** Select `Current branch vs selected branch…` from the in-UI mode menu, or use `/diff branch <base-ref>`.
  - **Data source:** Git diff between the selected base ref and `HEAD`.
  - **Comparison meaning:** PR-style merge-base comparison, `<base>...HEAD`, i.e. `merge-base(base, current) -> current`.
  - **UI label:** `Current branch vs <base>` with `merge-base(<base>, <current>) → <current>`.
  - **Expected content:**
    - selectable base branch/ref list from local branches, remote branches, and tags
    - selected base ref label
    - current branch/ref label
    - changed files between merge-base and current branch
    - hunks and diff body lines
    - additions/removals for the selected ref comparison
  - **Important edge cases:**
    - invalid selected ref
    - no branches/refs are available to select
    - selected ref has no common ancestor with current branch
    - renamed files
    - deleted files
    - binary files
    - very large diffs
  - **Definition of done:** The user can choose a base branch/ref and review a clearly labeled PR-style diff against the current branch.

### Search and grep goals

- [x] **Cache BetterDiff search/grep targets for very large reviews**
  - **User goal:** Keep tree search and global grep responsive on very large git diffs or long session histories.
  - **Evidence:** Synthetic large-review profiling showed repeated target rebuilding was measurable for tree search and global grep.
  - **Implemented behavior:** BetterDiff caches search target lists by search mode and rendered-row scope, caches filtered match lists by tokenized query, stores normalized target text, and invalidates caches on model replacement or row invalidation.
  - **Definition of done:** Large BetterDiff reviews stay responsive during `/` search and `?` global grep, with cache invalidation tied to model replacement and row visibility changes.

- [x] **Tree-style search inside BetterDiff**
  - **User goal:** Quickly jump to a visible review item the same way users expect to search in pi's tree UI.
  - **Primary command/use case:** Search across rendered BetterDiff tree labels without leaving the diff review UI.
  - **Search target:** Tree rows, not raw file contents.
    - turn prompt labels
    - file paths
    - hunk labels/ranges/source labels
    - optionally visible diff body lines when hunks are expanded
  - **Expected behavior:**
    - search should move selection to matching rows
    - repeated next/previous search should cycle through matches
    - search should respect the current rendered tree shape so collapsed hidden rows do not produce confusing jumps unless the feature explicitly expands them
    - selected row should remain obvious after a match
  - **Relationship to grep:** This is for navigating tree rows by label. It is not a full content grep.
  - **Definition of done:** A user can search the BetterDiff tree similarly to tree search and land on matching turns/files/hunks predictably.

- [x] **Global BetterDiff grep**
  - **User goal:** Search all BetterDiff review content from inside the diff review UI, the same way repository grep is not limited by the currently selected file.
  - **Primary command/use case:** Press `?`, type a query, and jump through matching turns/files/hunks/diff lines with `n` / `N`.
  - **Scope:** Always global across the current BetterDiff review model, including content hidden by collapsed branches/files or unrendered turn details.
  - **Expected behavior:**
    - show match count and current match position
    - expand parent turn/file/branch rows as needed so the matched row is visible
    - cycle forward/backward through matches
  - **Definition of done:** A user can grep all review content and reveal hidden matches without leaving BetterDiff. Grep is intentionally not scoped to the selected row.

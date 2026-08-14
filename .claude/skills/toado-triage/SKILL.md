---
name: toado-triage
description: Fix bug tickets from a Toado kanban via the toado MCP. Use when the user references a ticket URL/id (e.g. "fix t-lIMPHR" or "/tickets/t-XXX"), asks to work a column ("fix everything in [project]" → process the To Do column), asks for a verification sweep ("review the In Review tickets in [project]"), asks to build tests for a tests-needed column, or wants the queue watched ("keep an eye on my Toado queue" → offer the 2-minute /loop poller). Handles single tickets, column-wide batches, and recurring auto-sweeps. Fetches the smallest context that lets you act — description + source URL first, code grep next, image/devtools only on demand. Moves tickets across columns to keep the kanban honest in real-time. Drafts the user hasn't marked ready are filtered server-side, so the skill only ever sees tickets the user explicitly handed off.
version: 2026-07-14
---

# Toado Ticket Triage

Toado (toado.dev) is a bug tracker. Tickets live on per-project kanban boards and carry a screenshot capture + DevTools snapshot from the moment the user filed them. The `toado` MCP server gives you read+write access to tickets, comments, columns, and capture assets — your job is to load each ticket, fix the bug in the user's codebase, and move the ticket forward.

Two hard skills here:
1. **Knowing how little context to load.** A full `get_ticket` is ~1.8 MB on a capture-rich ticket — and **omitting `include` returns that full payload** (backwards-compat default). Always pass an `include` list. Most tickets need only the description + source URL + a code grep.
2. **Keeping the kanban honest in real-time.** A ticket sitting in To Do while invisible work happens is bad UX. Move to In Progress when you start, Response Required when you're blocked, In Review when the fix lands.

## The kanban contract (read this twice)

Tickets move across columns to reflect *what is actually happening to them*. The user is watching the board — they trust column position to mean exactly one thing each. Never let a ticket sit in the wrong column.

| Column                | Means                                              | You move it here when…                                                                       |
| --------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **To Do**             | Available work, untouched                          | (never — this is the user's starting state; only return here for bounced verifies)           |
| **In Progress**       | You are *actively working this ticket right now*   | You commit to fixing it (after the already-fixed check, before any code edits)               |
| **Response Required** | Blocked on the user — needs decision, info, access | You hit a wall the user has to unblock (ambiguous description, missing access, design call)  |
| **In Review**         | Fix shipped, awaiting human verification           | Your commit lands and your fix-comment is posted                                             |
| **Done**              | Verified                                           | Only verify-mode and build-tests modes move things here, after explicit confirmation         |

The cardinal rule: **In Progress is a live signal**. If you start a ticket and pause to do something else, either keep it in In Progress (and come back) or move it back to To Do — never silently work on a ticket that's still showing as To Do, and never leave a ticket in In Progress after you've stopped.

Same rule for Response Required: if you're blocked, *move the ticket and post the question*. Don't leave it in In Progress and wait — the user can't see your status that way.

## Modes (infer from user phrasing)

- **Single ticket** — `fix t-XXX`, `fix /tickets/t-XXX`, a URL like `https://app.toado.dev/tickets/t-XXX`. Load, move to In Progress, fix, commit, comment, move to **In Review**, then stop.
- **Sweep To Do** — `fix everything in <project>`, `work the toado queue for <project>`, `process To Do for <project>`. Walk the To Do column oldest → newest, fix each, move to In Review. Re-list the column at the start of every iteration — the user may add bugs while you work. **Announce the count before starting** (see Sweep preamble below).
- **Verify In Review** — `review the In Review queue`, `sweep In Review for <project>`, `make sure In Review is good`. Re-check each ticket using the commit-SHA anchor in its fix comment (see step 5); confirm the commit is still in the branch and the diff still addresses the bug. Move passing tickets to **Done**, bounce failures back to **To Do** with a comment explaining what's missing.
- **Build tests** — `build tests for <project>`, `cover the needs-tests column`. Walk a column whose name matches `tests`, `needs tests`, `needs tests built`, or `tests needed`. For each ticket, write a test that would have caught the original bug (or covers the area the bug was in), run it, then move to **Done**.
- **Auto-sweep (poller mode)** — the skill is being invoked from a recurring cron set up via `/loop` (typically every 2 minutes). This is **the same as Sweep To Do, not a list-and-summarize mode**. If To Do has tickets, *work them* — start_work_on_ticket, In Progress, fix, commit with `(t-XXX)`, comment with SHA, move to In Review (or Response Required if blocked). If To Do is empty, say "no new tickets" and stop. Don't push to remote inside the cron run — let commits stack and push at natural pauses. See "First-run prompt" below for how to initially offer the poller setup.

If ambiguous, default to single-ticket mode if a ticket id/URL was given, otherwise ask.

## First-run prompt: offer the poller

When the user invokes this skill for the first time in a session (or asks something like "watch this project for tickets" / "keep an eye on my Toado queue" / "stay on top of the queue for me"), offer to set up a 2-minute auto-sweep poller before doing anything else:

> Want me to set up a 2-minute poller that auto-sweeps the To Do column for `<project>`? Anything you drop in there will be picked up and worked within ~2 min — moved to In Progress, fixed, committed with the ticket id, commented with the SHA, then moved to In Review. (Or Response Required if I get blocked.)

If yes, invoke `/loop 2m <sweep prompt for that specific project>` — the loop skill creates the cron, and from there each fire re-enters this skill in **Auto-sweep** mode. Ask the user how long the poller should run (default suggestion: 12 hours), then create a one-shot `CronCreate` with `recurring: false` to cancel the recurring job at that target time. Confirm both job IDs back to the user so they know how to stop sooner if they want.

If no, proceed with whatever single-ticket / sweep mode was actually requested. Don't push the poller offer again in the same session.

## Preconditions

- The `toado` MCP must be authenticated. If `mcp__toado__*` tools aren't available in this session, ask the user to add the Toado MCP to their Claude config and run the `mcp__toado__authenticate` flow. Don't try to fix tickets without it; you're guessing at that point.
- For sweeps, you need the `projectId`. See **Project disambiguation** below.

## Pre-pass: Project disambiguation (sweep modes only)

Before starting a sweep, resolve the project name to exactly one `projectId`:

1. Call `mcp__toado__list_projects` (across all companies the user belongs to).
2. Filter by name, case-insensitively, with simple substring match.
3. If exactly one match → proceed.
4. If zero matches → tell the user, list the closest alternatives, stop.
5. If multiple matches → tell the user the matches with their company names ("`marketing` in Acme Co. and `marketing` in Widget Co. — which one?"), stop and wait.

Do not silently pick one. Project mix-ups are silent failures — you'll move tickets in the wrong project.

## Pre-pass: Resolve columns once

At the start of every run, call `mcp__toado__list_columns(projectId)` once and stash the id → name map. You'll need it to move tickets across stages. Match columns by name, case-insensitively. Look up:

- **In Progress** — start-of-work parking
- **Response Required** (or `responded`, `blocked`, `waiting`, `needs input`) — for tickets that need user input before continuing
- **In Review** — fix complete, awaiting review
- **Done** — verified
- **Tests / Needs tests** — for build-tests mode

If a project's column scheme doesn't include the expected target for your mode (e.g. no "In Review"), ask the user where to move things before starting. Don't silently fall back to a wrong column.

**Response Required fallback**: if no column matches the response-required pattern, fall back to the legacy behavior — leave the ticket where it is and start the comment with `[BLOCKED]`. New projects get a "Response Required" column by default; older or hand-customized projects may not.

## Pre-pass: Sweep preamble (sweep modes only)

Before processing tickets one-by-one, tell the user what's about to happen:

```
Sweep starting: <project name> — <mode>
Tickets to process: <N> in <column>
```

If N > 5, also pause for a beat so the user can interrupt if it's more than they expected (e.g. "this will fix all 12 To Do items — go ahead?"). For small sweeps (≤5) just announce and proceed. **Exception: Auto-sweep (poller) mode never pauses** — there's no one watching the cron fire to answer; announce the count and work the queue.

## Pre-pass: Dedup detection (sweep To Do only)

Before processing tickets one-by-one, scan the column for duplicates so you don't fix the same bug 4× and post 4 redundant comments. Group tickets where:

- **Same source URL AND** description has heavy substring overlap (≥60% of the shorter description's tokens appear in the longer one), OR
- Both descriptions reference the same user-visible string (a button label, error text) AND the same source URL.

When in doubt, **don't dedup** — fixing twice is cheap; missing a real bug is not.

For grouped duplicates: fix the code once under the oldest ticket of the group ("primary"), then for each _other_ ticket in the group post a short comment pointing at the primary (`Addressed by fix for t-PRIMARY (commit <sha>): same root cause.`) and move it to In Review. The primary gets the full template comment.

## Per-ticket procedure

For each ticket, do these steps in order. The comment + the column moves are non-optional — a fixed ticket still in To Do looks identical to an untouched one.

### 0. Already-fixed check

Before doing anything else, see if a previous commit already addressed this ticket:

```bash
git log --all --oneline --grep="t-XXX"
```

If a commit references the ticket id and the diff still lands on the current branch (`git log --oneline <sha>..HEAD` returns nothing that reverts it), skip straight to step 5 — just post `Already fixed in <sha>; moving to In Review` and move the ticket. Saves context AND prevents duplicate commits when the skill is re-pointed at a ticket.

Also check for a previous skill-authored fix comment on the ticket itself (`mcp__toado__list_comments`). If you find one matching the `Fix in <sha>: ...` template, treat it like an already-fixed ticket — same skip path.

### 0b. Drafts are filtered server-side — nothing to do here

Tickets the user is still writing are stored with `is_draft = true`. The board, search, inbox, and MCP `list_tickets` / `search_tickets` already filter these out, so the skill never sees them in sweep mode. The user explicitly flips a ticket ready via "Save & return" on the capture flow (or Cmd/Ctrl+Enter, or "Mark ready" from the Drafts page). The instant that PATCH lands, the ticket becomes pickable.

No time-based heuristic, no five-minute wait. Speed matters: the user wants the AI on the bug the moment they say it's ready.

**Single-ticket mode**: if the user explicitly says "fix t-XXX" and the ticket happens to still be a draft, honor the explicit instruction. `get_ticket` returns drafts (unlike the list endpoints) so the skill can still load and work it.

### 1. Move ticket to In Progress

As soon as you've decided this is a real ticket to work (not a dedup, not already fixed), move it to the **In Progress** column. This is the workflow-visibility step: the user can glance at the kanban and see what's actively being worked on, especially during sweeps when 5+ tickets are in flight.

```
mcp__toado__move_ticket(ticket_id, target_column_id: <in-progress-id>)
```

For deduped non-primary tickets, skip this — they move directly to In Review with the dedup comment in step 5.

### 2. Load context cheaply, escalate only if needed

This is the part most worth getting right. **Fetch the smallest payload that lets you act.** The cardinal rule: TRY to fix from description + source URL alone before pulling image or devtools.

**2a. `get_ticket` with `include: ["capture"]`** — gives you title, description, source URL, columnId, creator, commentCount/assignees/hasAiActivity (always included), plus the small capture metadata block (screenshot dimensions, browser/viewport context, signed screenshot URLs for later). ~5–10 KB. **This is enough to fix maybe 60% of tickets.**

Never call `get_ticket` with `include` omitted — the server treats a missing filter as "return everything" for backwards compatibility, which pulls the multi-MB DevTools blobs you almost never need. The server only fetches + ships the sections you list (`capture`, `attachments`, `annotations`, `devtools`), so the filter saves real latency, not just parsing. Repeat fetches of an unchanged ticket are additionally served from an ETag cache in ~15 ms server-side, so re-loading a ticket you fetched earlier in the run (e.g. in verify mode) is cheap — but the body still lands in YOUR context either way, so include discipline is about your context budget too.

**2b. Extract acceptance criteria from the description.** A description like "the X button is broken AND the spinner doesn't stop on cancel" is two distinct claims. Mentally split into bullets, even if the user wrote one sentence. You'll address each and report on each in the comment (✓/✗). This catches half-fixes.

**2c. Read the source URL.** It tells you exactly which page in the user's app the bug was filed against. Map that URL back to a route file in the user's codebase (e.g. a URL ending in `/settings/billing` likely lives in a `Billing` route component). Combine with the description: if the description says "the X button is broken," grep for the button's user-visible string in that file. **Try the fix from this alone before pulling anything else.**

**2d. STOP. Can you fix it now?** If yes — go to step 3. If no — continue escalating, one tier at a time, smallest first:

**2e. Pull comments only if commentCount > 0.** `mcp__toado__list_comments`. Existing comments often have important context (a back-and-forth, a half-attempted fix, "this is actually the same bug as...").

**2f. Pull the annotated screenshot only if the description references something visual** ("the circled X", "where I drew", "in the highlighted area", "this layout", "this color", or the description is genuinely insufficient AND the bug is visual). The rule: if you can describe what's wrong in words, you don't need the image. Image bytes eat context fast.

To view a screenshot, call `mcp__toado__get_capture_asset` with the ticket id and `asset: "screenshot_with_annotations"` (or `"screenshot"` for the un-annotated original). It returns a short-TTL presigned URL — drop the bytes into `.tmp/toado/` (gitignored) and Read it back:

```bash
mkdir -p .tmp/toado
# After get_capture_asset returns { url: "https://..." }:
curl -sL "<presigned-url>" -o .tmp/toado/<tid>.png
```

Then `Read .tmp/toado/<tid>.png` to view it. **Don't manually clean up per-ticket** — the end-of-run cleanup step (see Reporting back) sweeps the whole directory.

**2g. Pull DevTools only when the description names a runtime error or you need network/console evidence** — call with `include: ["devtools"]` (add `"capture"` if you also still need the capture block; the include list is exhaustive — sections you don't name are omitted). This is the chunk that goes >1 MB. If you do pull it and it's too big to inline, the tool will save it to a temp file; delegate the read to a subagent to keep it out of your main context.

**2h. Pull `annotations` (the structured list) if the description references a specific shape and the image alone isn't decisive** — `include: ["annotations"]`. Often empty in practice — annotations may live only as raster on `annotation.png`.

**2i. Record the branch on the ticket** via `mcp__toado__start_work_on_ticket(ticket_ids: ["t-XXX"])`. The tool generates a slug (e.g. `t-xxx-fix-add-button`) and stores it on the ticket so collaborators see what's in flight; the chosen name comes back in the response. Optional follow-on: `git checkout -b <returned-name>` if the repo's "branch before code changes" rule applies in this run. For deduped tickets, only call this on the primary — non-primaries inherit the primary's branch via the dedup comment.

### 3. Fix the code

Anchor the search using whatever's most specific in the ticket:

- A user-visible string from the description (best for UI text bugs)
- The route in the source URL (best for "this page is broken")
- A function/file name from a console error stack
- A CSS class or component name visible in the screenshot (only if you pulled it)

Make the edit. **Address every acceptance-criteria bullet from step 2b.** Keep edits minimal and scoped — don't refactor neighboring code unless the user asked for cleanup.

For tests-built mode, write the test in the project's existing test layout (Vitest under each app's `src/test/`, or Playwright e2e in `apps/web/test/`). Run it once and confirm it passes (or fails for the right reason if you're testing a bug that's already fixed).

### 4. Verify the fix

- Typecheck the affected app: `npx tsc --noEmit` from `apps/<app>`. Pre-existing errors unrelated to your edit are fine — only flag new ones.
- For tests-built mode, the test passing IS the verification.
- For Verify In Review mode, see **Verify mode specifics** below.

### 5. Commit, comment, then move

**Commit BEFORE commenting** so the comment can carry the SHA. The SHA is the anchor verify-mode uses later — without it, future verification falls back to fragile grepping.

```bash
git add <files>
git commit -m "fix(<area>): <one-liner> (t-XXX)"
SHA=$(git rev-parse --short HEAD)
```

Then call `mcp__toado__add_comment` with this template (≤8 lines):

```
Fix in <commit-sha-short>: <files>

Acceptance criteria:
✓ <criterion 1, restated>
✓ <criterion 2, restated>
(or ✗ <criterion>: <why it wasn't addressed — turns the ticket into BLOCKED>)

[VISUAL] Reviewer: <what to look at, e.g. "open any project board in dark mode and click + Add ticket — Add button visible">
```

The `[VISUAL]` tag is **only** for fixes that genuinely need a human eye (CSS, layout, contrast, color, animation, copy placement). For behavioral fixes that typecheck/tests cover, omit the tag — the reviewer can trust the diff + checks. Don't [VISUAL]-tag everything; it teaches reviewers to ignore the tag.

For deduped tickets (non-primary), the comment is just one line:

```
Addressed by fix for t-PRIMARY (commit <sha>): same root cause as that ticket.
```

For BLOCKED tickets (no fix committed), start the comment with `[BLOCKED]` and explain what's missing — what answer / decision / access you need to keep going.

**Then move the ticket.** Mapping:

| Mode                              | From          | To                |
| --------------------------------- | ------------- | ----------------- |
| Single fix (success)              | In Progress   | In Review         |
| Single fix (blocked)              | In Progress   | Response Required |
| Sweep To Do (success)             | In Progress   | In Review         |
| Sweep To Do (blocked)             | In Progress   | Response Required |
| Verify In Review (ok)             | In Review     | Done              |
| Verify In Review (no)             | In Review     | To Do             |
| Build tests                       | Needs tests\* | Done              |

\*Match column name case-insensitively against `tests`, `needs tests`, `needs tests built`, or `tests needed`.

If Response Required doesn't exist on the project, fall back to leaving the ticket in In Progress with the `[BLOCKED]` comment — same legacy behavior as before. Don't move it back to To Do; it's not "available work" anymore.

When the move target is **Done** (verify-pass or build-tests modes), also call `mcp__toado__update_ticket(ticket_id, resolved: true)` so the ticket is flagged resolved alongside the column move. In Review, In Progress, To Do, and Response Required moves all stay unresolved — resolved is the verify-pass signal, not a triage-pass signal.

## Verify mode specifics

When sweeping In Review, the goal is to confirm each fix is real, not just claimed. Procedure per ticket:

1. **Load the ticket and its comments.** The fix comment should match the template above (`Fix in <sha>: ...` + acceptance criteria).
2. **If a SHA is present**: `git log --oneline <sha>..HEAD -- <files-from-comment>` to see whether anything has touched those files since the fix. `git show <sha>` to see the original fix. If subsequent commits reverted/rewrote it, flag and bounce.
3. **If no SHA is present** (older comments, or comment doesn't match the template): fall back to grepping the current code for the change described in the comment. Less reliable — note the lower confidence in your final report.
4. **Re-read each acceptance criterion from the original description** and confirm the current code addresses it. For [VISUAL] fixes, you genuinely cannot fully verify without a browser — say so explicitly in the move-to-Done comment ("typecheck + diff verified; visual confirmation deferred to user").
5. **Pass** → move to Done with a brief comment (`Verified: fix at <sha> still in branch; criteria all met.`).
6. **Fail** → move back to To Do with `[REOPENED] <reason>`. Don't try to re-fix in verify mode — that's a different intent and conflates the two passes.

## What to skip or escalate

Don't silently fail. Stop on these, comment with `[BLOCKED]`, move to **Response Required** (or stay in In Progress if no such column), and continue to the next:

- **Ambiguous** — description doesn't specify what to change, or could mean several things
- **Can't locate the code** — anchor search returns nothing after the cheap-context pass
- **Scope too large** — fix touches >3 files or needs architectural decisions
- **Needs a product/design decision** — not yours to make
- **Schema / migrations / auth changes** — flag for human review even if obvious
- **Cross-project** — bug references a different project's code
- **Already-resolved** — `resolved: true` on the ticket; just skip (the step-0 check should catch this)

## Resume semantics

Sweeps are idempotent. If the user CTRL+Cs (or you crash) midway through a batch:

- Already-fixed tickets are out of To Do (you moved them to In Review per ticket).
- In-flight tickets are visible in the In Progress column — pick up by re-running the sweep; the step-0 already-fixed check will skip ones whose fix landed but whose ticket move didn't happen.
- The commit history has each completed fix.
- Re-running the same command (`fix everything in <project>`) just picks up wherever the column currently is.
- The end-of-run cleanup of `.tmp/toado/` only fires on graceful completion, so partial runs leave screenshot files behind. The next clean run will sweep them.

## Reporting back

After finishing (single or batch), give a tight summary:

```
Toado triage — <project name> (<mode>)
✓ t-aaaaaa — Fixed Add-button contrast (ProjectViewsPage.tsx) → SHA abc1234
✓ t-bbbbbb — Renamed mislabeled column header → SHA def5678
↳ t-cccccc — Deduped under t-aaaaaa (same root cause)
⊘ t-ddddd0 — Already fixed in abc1234; moved to In Review
⚠ t-eeeee1 — Blocked: needs design call on empty-state copy → moved to Response Required
↩ t-fffff2 — Bounced from In Review back to To Do (description not addressed)
```

Then sweep `.tmp/toado/`:

```bash
rm -rf .tmp/toado
```

Don't paste diffs. The user can see them in commits + ticket comments.

## Cost discipline

The single biggest mistake on this skill is over-fetching. Concretely:

- **Always pass an `include` list to `get_ticket`.** Omitting it returns everything (the 1.8 MB worst case). `include: ["capture"]` is the standard first fetch.
- **Description + source URL is the primary signal.** Try to fix from those alone. Only escalate to image/devtools when you've genuinely tried and can't proceed.
- Avoid `include: ["devtools"]` unless the ticket explicitly needs it. Empirically a single full-payload `get_ticket` can be 1.8 MB.
- Don't pull screenshots speculatively. The description usually tells you whether it's needed; if it doesn't, the bug is probably describable without one.
- Re-fetching a ticket you already loaded this run is cheap server-side (ETag cache, ~15 ms) but still costs you the body in context — prefer remembering what you read.
- For a batch run of N tickets, skipping unnecessary fetches is the difference between a clean run and burning your context window on the third ticket.

## Commits

For batch sweeps, commit after each ticket (so a partial failure leaves the queue in a clean state) — this is also what gives each ticket its SHA anchor for future verify-mode runs. Use a tight message naming the ticket id:

```
fix(board): Add-button white-on-white in dark mode (t-lIMPHR)
```

Don't push between every ticket — push at the end of the batch (or on natural pauses, e.g. between sweep modes).

## Notes

- The MCP scopes for the authorizing user are `mcp.read mcp.comments mcp.tickets.write mcp.tickets.assign`. That covers everything this skill does. If a tool 403s on scope, ask the user to re-authenticate via the OAuth flow.
- The user's repo (the one your Claude Code session is running in) is the codebase you're fixing. The ticket's source URL tells you which route/page; map that to the matching file in the user's codebase.
- Multiple teammates can use this skill on the same Toado workspace as long as each authenticates the toado MCP under their own account.
- New projects get a "Response Required" column by default between In Progress and In Review. Projects created before this skill version may not have it — the fallback above handles that case.

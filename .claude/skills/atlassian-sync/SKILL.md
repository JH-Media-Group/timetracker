---
name: atlassian-sync
description: >
  Keep Jira + Confluence as the source of truth for every project. Use whenever work
  starts or ends, when docs/PRDs change, or when the user says "sync to Jira/Confluence",
  "log this as a task", "publish these docs", "update the session doc", "what's the working
  state", or moves between machines. Creates/updates/transitions/comments Jira issues as work
  happens (epics, sprints, tasks), mirrors docs & PRDs into Confluence with drift-safe
  reconcile (never blindly clobbers human edits), and writes a per-project Session Log page so
  work moves cleanly between computers. Needs the "Jira/Confluence" MCP connector authenticated.
---

# Atlassian Sync — Jira + Confluence as source of truth

Jira holds the **work** (epics, sprints, tasks, status). Confluence holds the **knowledge**
(docs, PRDs, runbooks, the session log). The local repo is the **working copy** — you sync it
outward, you do not let it silently diverge. Your job is to keep all three coherent without
clobbering anything a human edited.

This skill is global and project-agnostic (runs in any repo). What binds it to a specific
project is a `.atlassian-sync.json` file in the repo root — see `config.example.json` next to
this file. **Keep this skill generic.** Anything specific to one project — its space/project
keys, page ids, workstream taxonomy, label scheme, multi-repo layout, per-project policies —
lives in that config and, if it needs prose, a **project-level companion skill** in the repo's
own `skills/` (or `.claude/skills/`). Never hard-code a project's specifics here. Without a
config you are in **init mode** (see below); with it you operate normally.

## Preconditions (check these first, in order)

1. **Connector is authenticated.** The Jira/Confluence tools are exposed by the `claude.ai
   Jira/Confluence` MCP connector. They are deferred — discover the real, prefixed tool names
   at runtime with `ToolSearch` (e.g. `query: "jira confluence create page issue"`). If no
   such tools resolve, the connector needs auth: tell the user to run `/mcp` (or reconnect the
   connector on claude.ai) and stop. Do not fake it with the REST API.
2. **Config exists.** Look for `.atlassian-sync.json` in the repo root. If missing → init mode.
3. **cloudId is known.** It's in the config. If absent, call the resource-discovery tool
   (`getAccessibleAtlassianResources`) once, show the user the sites, write the chosen
   `cloudId`/`site` into config, then continue.

The canonical Atlassian MCP tools you'll use (names may be prefixed by the connector — discover
at runtime, don't hardcode the prefix):

- **Jira:** `getAccessibleAtlassianResources`, `getVisibleJiraProjects`,
  `getJiraProjectIssueTypesMetadata`, `searchJiraIssuesUsingJql`, `getJiraIssue`,
  `createJiraIssue`, `editJiraIssue`, `addCommentToJiraIssue`, `getTransitionsForJiraIssue`,
  `transitionJiraIssue`, `lookupJiraAccountId`.
- **Confluence:** `getConfluenceSpaces`, `getPagesInConfluenceSpace`, `searchConfluenceUsingCql`,
  `getConfluencePage`, `createConfluencePage`, `updateConfluencePage`,
  `createConfluenceFooterComment`.

## The sync manifest (how dedup + drift detection work)

State lives in `.atlassian-sync/manifest.json` in the repo (commit it — the mapping must travel
between machines). Shape:

```json
{
  "docs": {
    "docs/architecture.md": {
      "pageId": "98765",
      "localHash": "sha256 of the local file at last sync",
      "remoteHash": "sha256 of the Confluence body we last wrote",
      "lastSyncedAt": "2026-06-21T14:00:00Z"
    }
  },
  "issues": {
    "marker-or-slug": { "key": "CSU-42", "title": "...", "lastState": "Done" }
  }
}
```

The manifest is a cache, not the authority. **Always be able to recover it** by searching
Atlassian for the `syncLabel` (Jira) or by title/label under `rootPageId` (Confluence). If the
manifest and reality disagree, reality wins — re-link and rewrite the manifest.

## Modes (infer from phrasing; when ambiguous, ask)

| Trigger | Mode |
|---|---|
| No config, first run, "set up Jira/Confluence sync here" | **Init** |
| "what's the working state", session start, machine switch | **Resume** |
| "log this as a task", "make a ticket", starting a unit of work | **Task open** |
| finishing work, "mark that done", a commit closing a task | **Task close** |
| "publish/sync the docs", a docs/PRD file changed | **Doc sync** |
| "end the session", "write the session doc", wrapping up | **Finalize** |

### Init mode (once per repo)

1. List Jira projects (`getVisibleJiraProjects`) and Confluence spaces (`getConfluenceSpaces`);
   show them and let the user pick the project key + space key (or create — see note).
2. Detect epic strategy via `getJiraProjectIssueTypesMetadata` (team-managed → `parent`;
   company-managed → find the Epic Link customfield). Record `epicStrategy` in config.
3. Create (or locate) the Confluence **docs root page** and the **Session Log page**; record
   `rootPageId` and `session.handoffPageId`.
4. Write `.atlassian-sync.json` and an empty `.atlassian-sync/manifest.json`. Add
   `.atlassian-sync/manifest.json` is committed; nothing here holds secrets.
5. Do a first **Doc sync** dry run (report what *would* publish) before writing anything.

Don't invent projects/spaces unless the user explicitly asks — prefer binding to ones that
exist.

### Resume mode (start of a session / new machine)

Read the Session Log page (`getConfluencePage` on `session.handoffPageId`) and summarize the
**most recent entry** back to the user: goal, what's done, what's next, open blockers, and any
in-flight Jira keys (re-fetch their current status with one JQL call:
`project = <KEY> AND labels = <syncLabel> AND statusCategory != Done ORDER BY updated DESC`).
This is what makes work portable between computers — start here, don't re-derive state.

### Task open / Task close (Jira as you work)

The discipline: **a unit of work = a Jira issue**, opened when you start it and closed when it
lands. Don't batch-create a wall of tickets up front; create them as work becomes real.

**Search before create — always.** Before making an issue, JQL-search for an existing one:
`project = <KEY> AND labels = <syncLabel> AND summary ~ "<short title>"`. If found, reuse it.
This is what prevents duplicate tickets when the manifest is stale or you're on a second machine.

- **Open:** `createJiraIssue` with the project key, issue type, a tight summary, a description
  that links the relevant Confluence doc + the repo path/branch, and the `syncLabel`. For work
  under an epic, set the parent (or Epic Link field per `epicStrategy`). Record `key` in the
  manifest. Mention the key to the user.
- **Progress:** as you do the work, `transitionJiraIssue` into "In Progress" (resolve the real
  transition id via `getTransitionsForJiraIssue` — ids vary per workflow; never hardcode).
- **Close:** when the work lands, `addCommentToJiraIssue` with a short outcome + the commit SHA
  / PR link / Confluence link, then `transitionJiraIssue` to Done. The comment is the audit
  trail — keep it ≤6 lines, lead with the outcome.

**Epics & sprints:** an epic is just a parent issue you create once per initiative and link
children to. For sprints, if `boardId` is set you may read the active sprint and note it in the
issue; do **not** create or close sprints automatically — sprint boundaries are a human/ceremony
decision. Surface sprint state, don't manage it.

### Doc sync (local docs/PRDs → Confluence, drift-safe)

For each file matching `confluence.docGlobs` (minus `excludeGlobs`):

1. Compute `localHash` (sha256 of file contents). If it equals the manifest's `localHash`,
   the file is unchanged → skip.
2. Resolve the target page: manifest `pageId`, else CQL-search the space for a page titled like
   the file (see title convention) under `rootPageId`. If none, it's a **new** page.
3. **Drift check before overwriting an existing page:** fetch the live page, hash its body,
   compare to the manifest's `remoteHash`.
   - Live hash == stored `remoteHash` → safe, no human touched it since you. Overwrite.
   - Live hash != stored `remoteHash` → **someone edited it in Confluence.** Do NOT clobber.
     Show the user the divergence (what changed locally vs what changed remotely) and ask how to
     resolve: keep remote, force-push local, or merge. Default to **not** overwriting.
4. Convert Markdown → Confluence storage format. Prefer the MCP tool's native markdown handling
   if it accepts markdown; otherwise convert headings/lists/code/tables/links faithfully and
   wrap code blocks in `<ac:structured-macro ac:name="code">`. Keep it simple — don't lose
   content to fancy formatting.
5. Create (`createConfluencePage`, parent = the right node in the mirror tree) or update
   (`updateConfluencePage`, bump version). Stamp the top of the page with a **managed banner**:
   `> ⟳ Synced from \`<repo>/<path>\` · last sync <ISO date> · edits here may be overwritten —
   see the Session Log.` and add label `claude-sync`.
6. Write back `localHash`, `remoteHash` (hash of what you just wrote), `lastSyncedAt`.

**Connector WAF limitation (known).** The `claude.ai Jira/Confluence` connector routes through an
edge WAF (on the anthropic.com MCP edge) that **blocks request bodies containing attack-keyword
substrings** — shell pipelines (`| bash`, `&&`, `sudo rm`), SQL-like tokens, and XSS payloads
(`onclick=`, `alert(`). This is content-driven, not size-driven, and HTML-entity-encoding does NOT
help (the literal substring still appears). Runbooks, deploy docs, and security-review notes trip it.
Options when a page WAF-blocks: (a) publish a stub with the distilled facts + a prominent link to the
authoritative Git file (preferred for command-heavy runbooks — don't risk corrupting copyable
commands); (b) only if the user wants full rendered text, break the literal trigger substrings with a
zero-width space (U+200B) or `<wbr>` between characters so the request body no longer matches, noting
that copied commands may carry hidden chars. Always tell the user which pages were stubbed.

**Page tree mirrors the folder tree.** A file at `docs/api/auth.md` becomes a page titled
`auth` (or its H1) under a `docs / api` page under `rootPageId`. Create intermediate parent
pages as needed. Title convention: prefer the file's first H1; fall back to the filename
without extension. Keep titles stable — renaming a Confluence page orphans the link.

### Finalize mode (end of session → Session Log entry)

This is the cross-machine handoff. **Prepend** a new entry to the Session Log page (newest on
top — fetch current body, insert, `updateConfluencePage`). Entry template:

```
## <ISO date+time> · <user>@<machine> · <branch>
**Goal:** what this session set out to do
**Done:** outcome bullets, each linking its Jira key (CSU-42) and/or commit SHA
**In progress / next:** the very next concrete step for whoever picks this up
**Blockers / open questions:** anything that needs a decision
**Docs touched:** links to the Confluence pages synced this session
**Working notes:** anything non-obvious needed to resume (env state, half-done migration, etc.)
```

Before writing the entry: run **Doc sync** for anything touched, and make sure every Jira issue
you opened this session is either Done (with a closing comment) or has a comment explaining
where it stands. The Session Log entry should be a *true* snapshot — a teammate or your other
laptop should be able to continue from it alone.

## Safety, idempotency, cost

- **Never clobber human edits.** The drift check is the core safety rule. When in doubt, show
  the diff and ask — don't overwrite.
- **Search before create**, for both issues and pages. Idempotent re-runs must not duplicate.
- **Resolve ids at runtime** — transition ids, customfield ids, account ids, cloudId all vary
  per site/project. Discover them; don't hardcode.
- **Don't over-fetch.** Pull page bodies only for files that changed (hash gate first). One JQL
  roll-up beats N `getJiraIssue` calls. Confluence bodies are large — don't load the whole space.
- **Batch reporting.** After a sync, give a tight summary (✓ created, ↻ updated, ⏭ skipped
  unchanged, ⚠ drift/needs-decision) with the Jira keys and page links. Don't paste page bodies.
- **One project/space per run.** Each repo's `.atlassian-sync.json` binds it to a Jira project +
  Confluence space. Several repos MAY share one project/space — distinguish them with a `repoLabel`
  (Jira) and a per-repo docs-root page (Confluence). When they do, a project-level companion skill
  should document the shared layout; this global skill just reads the config.
- **No secrets in config or pages.** Pointers to where secrets live, never the values themselves.

## Recommended hook wiring (enable only AFTER a clean manual run)

The skill is the brain; hooks are just triggers. Once a manual `init` + dry-run works:

- **SessionStart hook** → injects a reminder to run **Resume mode** (read the Session Log) so
  every session boots with current working state. Low-risk; safe to enable first.
- **Stop hook** → triggers **Finalize mode** once per session (guard with a per-session flag to
  avoid loops). This is the "fully automatic" piece — enable last, because until the connector
  is authenticated it will fail on every session-end.

Wire these via the `update-config` skill (they belong in `settings.json`), not by hand. Keep
them lightweight: the hook injects an instruction to invoke this skill; it does not try to do
Atlassian work itself (a shell hook can't reason about which tickets to close).

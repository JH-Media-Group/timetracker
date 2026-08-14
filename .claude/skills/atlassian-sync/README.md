# atlassian-sync — install on a new machine

This folder is a portable copy of the **global** `atlassian-sync` skill (Jira + Confluence as
source of truth). It is project-agnostic — drop it on any machine and it works in any repo that
has a `.atlassian-sync.json`.

## Install (per machine)

1. **Copy the skill into your user skills dir** so it loads in every session:
   - Windows: `C:\Users\<you>\.claude\skills\atlassian-sync\`
   - macOS/Linux: `~/.claude/skills/atlassian-sync/`
   Copy `SKILL.md` + `config.example.json` (this `README.md` is optional).

2. **Authenticate the Jira/Confluence connector** once on this machine:
   run `/mcp` in Claude Code and connect **Jira/Confluence** (or add it at claude.ai → connectors).
   Until it's authenticated, the `mcp__claude_ai_Jira_Confluence__*` tools won't load.

3. **Allow the connector's tools** in this machine's settings (permissions are machine-local —
   they do NOT travel via git). Add to `~/.claude/settings.json` → `permissions.allow`:
   ```
   "mcp__claude_ai_Jira_Confluence__*",
   "Read(.atlassian-sync.json)", "Edit(.atlassian-sync.json)", "Write(.atlassian-sync.json)",
   "Read(.atlassian-sync/**)", "Edit(.atlassian-sync/**)", "Write(.atlassian-sync/**)",
   "Bash(sha256sum:*)", "Bash(shasum:*)"
   ```
   (Or just run the `update-config` skill and ask it to add the Jira/Confluence MCP wildcard.)

## What travels automatically (no per-machine setup)

- Each repo's **`.atlassian-sync.json`** binding (committed) — `git pull` brings it.
- Any **project-level companion skill** (e.g. `command-center-source-of-truth`) lives in the
  repo's own `skills/` — also via `git pull`.
- Working state moves via the **Session Log** Confluence page — start a session by asking for
  "the working state" (Resume mode).

## How it's organized

- **This skill (global):** the *how* — modes (init / resume / task / doc-sync / finalize),
  drift-safe reconcile, search-before-create, the connector WAF limitation.
- **Per-repo `.atlassian-sync.json`:** the binding (cloudId, project key, space, page ids, labels).
- **Project companion skill (in the repo):** the *what* for that specific project.

Keep this skill generic. Project specifics belong in the config + the project's own skill, never here.

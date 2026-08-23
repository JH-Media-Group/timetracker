# MCP connector

**Status: plan only. Nothing here is built.** Written 2026-08-23. Authority over
the MCP surface, its authentication, its authorization, and its change log.
Everything else defers to docs/BACKEND_PRD.md, which this does not restate.

---

## 1. What this is for

Three people want three different things, and one connector serves all of them
because they are the same connector at different capability levels.

**Somebody tracking time** wants to say "start a timer on Example Learning Example Client 40
plan", "what did I work on Tuesday", "make that entry 90 minutes instead of 45"
without opening a browser tab. This is the case that gets used every day.

**Somebody who manages projects** wants the same for the people they manage,
because a manager fixing a colleague's Friday is the most common correction in
the product and today it costs a trip to the approvals tray.

**An administrator** wants to set the system up: create clients, projects,
tasks, people, invoice configuration. Bulk work, from a description, without
forty form submissions. The stated goal is "pretty much everything in the
system via MCP", with two conditions attached, both of which are the point of
section 6: **there is a log, and there is a way back from a mistake.**

### What it is not

Not a public API. Not a second product surface with its own rules. **The MCP
server is a client of the same services the web app calls**, and if the two
ever disagree about what a Member may do, that is a defect in the MCP server
and not a policy decision.

---

## 2. The one architectural rule

**Every tool call goes through `src/server/services/`, with a real `Ctx`, in a
real transaction.** No tool touches Drizzle directly, and no tool re-implements
a rule.

This is not tidiness. Authorization in this product is applied by hand, one
service function at a time (`assertCan`, `assertWithinReach`, `visibleUserIds`),
and `src/server/http.ts` is what guarantees a mutation is audited, rate limited,
and idempotent. A tool that queried the database directly would inherit none of
it, and the failure would be silent: a Member reading a colleague's cost rate
through a tool that answers correctly on the web.

Concretely:

- A tool handler builds a `Ctx` from the token, calls one service function, and
  serializes the result. If a handler contains a `select` or an `if (capability)`
  it is written wrong.
- `tests/routes.test.ts` insists every HTTP route reaches a gate. **The
  equivalent test for tools ships in the same commit as the first tool**, or
  this file is describing a thing that does not hold. See section 8.

### Where it runs

A separate Node process on the same droplet, in the same container image,
speaking MCP over stdio for a local client and over streamable HTTP for a remote
one. It imports the services directly rather than calling the HTTP API over
localhost: same transaction semantics, same `runAfterCommit`, no second copy of
the envelope-unwrapping in `src/lib/api.ts`, and no second place for the API
contract to drift.

The trade is that the MCP process needs the database credentials. It is already
the same image and the same host, so this adds no reachable surface, but it does
mean **the MCP process must not be exposed to the internet without the token
check in section 3 in front of it.**

---

## 3. Authentication

### The table already exists and nothing writes to it

`api_tokens` is in `src/server/db/schema.ts` (id, userId, label, tokenHash,
prefix, scopes, lastUsedAt, expiresAt, revokedAt) and is read and written by
nothing at all. `ActorKind` in `src/server/ctx.ts` already includes `"api"`.
The substrate was designed and then never connected, which is the same shape of
orphan `tests/settings-consumed.test.ts` was written to catch. **Building this
is mostly connecting what is there.**

### The scheme

- A person creates a token from Settings. It is shown once, on that screen, and
  never again. Format `tally_<prefix>_<secret>`, where `prefix` is stored in
  clear so a token can be identified in a list and in an audit row without
  holding the secret.
- Stored as a sha256 of the secret, not argon2. **This is a deliberate
  departure from the password rule and needs saying out loud:** a token is 32
  bytes of `randomBytes`, not a human-chosen string, so it has no dictionary to
  attack and the slow hash buys nothing while costing 25ms of CPU on every tool
  call. The same reasoning is already written down in
  `src/app/api/v1/auth/reset/route.ts` for invite tokens.
- Expiry required, defaulting to 90 days, maximum one year. A token that never
  expires is a credential nobody remembers granting.
- Revocable from the same screen, effective immediately (the check is a query,
  not a cache).
- `lastUsedAt` written at most once a minute per token, so an active session
  does not turn every read into a write.

### The actor it builds

`actorFromToken()` produces exactly the `Actor` that `actorFromSession()`
produces for the same person: same `profileId`, same `capabilities`, same
`isOwner`, `kind: "api"`. **A token can never do more than the person who
created it**, and it does not carry its own permission set. `scopes` narrows,
never widens (section 4).

That single sentence is the whole authorization story, and it is why this
section is short: there is no second permission model to keep in step.

### What must not happen

- **No token may be created for another person.** Creating one is
  self-service only, even for an administrator, because a token is a credential
  that acts as you and an administrator handing themselves one for a colleague
  is impersonation with an audit trail that says the colleague did it.
- **The account owner flag is not conferrable by token** any more than by
  profile.
- Tokens are refused on the auth routes entirely: no signing in, no password
  reset, no session creation through a token.

---

## 4. Authorization: what each person can do

Nothing new is invented here. The rules below are the existing capability and
reach rules, restated as the tool surface makes them visible.

### The floor: everybody

Every person, whatever their profile, holds `time:create_own`, `time:edit_own`,
`time:delete_own`, `project:view`, `report:view_own` and the rest of `EVERYONE`
in `src/server/auth/capabilities.ts`. So every token can:

- start and stop their own timer
- list, create, edit and delete their own time entries
- see the projects they are a member of, and the tasks on them
- read their own week and its submission state, and submit it

**Money is absent.** A Member holds no `rates:view_billable`, so entry payloads
returned to that token carry no rate and no amount, exactly as
`src/server/serialize.ts` already decides for the web app. This is not a filter
applied by the tool layer; it is the serializer doing what it already does.

### Managers: `time:view_others` / `time:edit_others` with `team` reach

A Project Manager reaches the people in `user_managed_users` and the people on
projects where they are `project_members.is_manager`. That set is
`visibleUserIds(ctx)`, and it is the same predicate the web app uses.

So a manager's token can list and edit time for those people **and answer 404
for anybody else** (BACKEND_PRD: 404, not 403, so the API never confirms that a
record it will not show exists). A tool must not soften this into a friendlier
"you do not have permission to edit Sarah's time", because that sentence
confirms Sarah.

### Administrators: everything, including cost rates

`rates:view_cost` is Administrator-only among the base profiles, and it is what
separates "can see what a client is charged" from "can see what a colleague is
paid". A token whose owner lacks it gets no cost figures anywhere, including in
report tools, and the cost rows simply are not in the payload.

### `scopes`: narrowing, never widening

The `scopes` column is an intersection applied on top of the person's
capabilities. A token with `scopes: ["time"]` can do the time things its owner
can do and nothing else, so an administrator can hand a script a token that
cannot touch invoicing. **An empty array means "everything the owner can do",
which is the default**, and a scope naming a capability the owner does not hold
is dropped at creation with a message rather than stored and silently ignored.

Proposed scope groups, deliberately coarse: `time`, `expenses`, `projects`,
`people`, `invoices`, `reports`, `settings`.

---

## 5. The tool surface

Grouped by who reaches them. Names are `tally_<noun>_<verb>` so they sort
together in a client's tool list.

### Timers and time (the floor)

| Tool | Notes |
| --- | --- |
| `tally_timer_start` | project + task + optional note. Stops whatever was running first, and says which entry it stopped, because "one running timer per person" is enforced by a partial unique index and a silent stop is a surprise. |
| `tally_timer_stop` | Stops the running entry, returns the duration it landed on. |
| `tally_timer_current` | What is running, and for how long. |
| `tally_time_list` | A date range, defaulting to this week. Somebody else's only with reach. |
| `tally_time_log` | Create an entry with a duration, or with a start and end. Honours the clock rules in `src/lib/format.ts`: an end before its start is the next day. |
| `tally_time_edit` | Patch one entry. Refused inside an approved period, as the web app is. |
| `tally_time_delete` | Soft delete. Returns the token needed to restore it (section 6). |
| `tally_week_submit` | Submit a week for approval. |
| `tally_projects_mine` | The projects and tasks this person may book to. The list a model needs before it can call anything above. |

### Managing (reach required)

| Tool | Capability |
| --- | --- |
| `tally_time_list` for another person | `time:view_others`, within reach |
| `tally_time_edit` / `tally_time_log` for another person | `time:edit_others`, within reach |
| `tally_approvals_list` | `approval:review` |
| `tally_approvals_decide` | `approval:review`, approve or request changes |
| `tally_report_time` | `report:view_own` and up; money redacted by capability |

### Setting the system up (administrator)

Clients, projects, tasks, people, expense categories, invoice configuration. One
create and one update tool each, plus `tally_project_members` for who may book
to what.

**Two deliberate omissions.** Sending an invoice and issuing a payment are not
tools. They leave the building: a sent invoice reaches a client's inbox and
cannot be recalled, and no undo in section 6 reaches it. A model may draft an
invoice; a person presses send. Similarly `tally_people_invite` may create the
person and mint the link, but the queued mail is a separate deliberate action.

---

## 6. The log, and the way back

This is the section the request turns on: **"there is a log and backup unless
they make a mistake."** Three separate mechanisms, because they answer three
different questions.

### 6.1 Every change is already audited, and nothing needs to be added for that

`src/server/http.ts` commits audit rows in the same transaction as the change,
and `Ctx.audit()` is a closure a service cannot opt out of. Every row carries
`actorId`, `actorKind`, `action`, `entityType`, `entityId`, `entityLabel`,
`before`, `after`, `diffKeys`, `requestId`, and `createdAt`.

What the MCP work adds is only this: **`actorKind: "api"` and the token's
`prefix` in the audit row**, so "who changed this" distinguishes Jason at a
keyboard from a script holding Jason's token. Without that the log is true but
useless for the question people will actually ask after a bad bulk run.

The user's requirement that "there needs to be a log of what they edited, same
with everyone else" is therefore already met by the existing table for every
actor, and this connector must not introduce a path around it. Section 8 is how
that is asserted rather than asserted-in-prose.

### 6.2 Undo for a single change

Every destructive tool returns an **undo token**: an opaque handle naming the
audit row it wrote. `tally_undo` takes it and reverses that one change, by
applying `before` back through the same service, in a new transaction, writing
its own audit row (`action: "<entity>.undo"`). It is a compensating change, never a
row rewrite: the history keeps both.

Bounded on purpose:

- **Only the actor's own changes**, and only within 24 hours.
- **Refused if the record changed since**, comparing `updatedAt` to the audit
  row's. Blindly writing `before` back would silently discard whatever somebody
  else did in between, which is a worse outcome than refusing.
- **Refused for anything that left the building**: a sent invoice, a delivered
  email, a spent invite token.

### 6.3 A checkpoint for bulk work

Undo is for one mistake. Setting up an account is forty calls, and the mistake
is usually noticed at call thirty-nine.

`tally_checkpoint_create` takes a label and records a marker: a timestamp and
the current audit sequence. `tally_checkpoint_diff` lists everything that actor
changed since. `tally_checkpoint_revert` walks those changes newest-first and
undoes each by the rules in 6.2, stopping at the first refusal rather than
skipping past it, and reporting where it stopped.

**This is not a database backup and must not be described as one.** It reverses
changes made by one actor, through the services, with all their rules intact. It
cannot recover from a migration, a disk failure, or somebody else's concurrent
edit. Those need `pg_dump`, which belongs in
docs/DEPLOYMENT-AND-SERVER-HARDENING.md and is a separate piece of work that
should exist regardless of whether this connector is ever built.

A nightly `pg_dump` is a prerequisite for enabling the administrator tools, not
a nice-to-have alongside them.

### 6.4 Confirmation for the wide ones

A tool that would change more than **twenty-five** records, or delete anything
that is not the actor's own, is two-phase: the first call returns a plan and a
confirmation token, the second call executes it. The model cannot manufacture
the token, so an eager assistant cannot skip the step, and the person reading
the plan is the control.

Twenty-five because a week of time entries for one person is about ten and a
month is about forty: the threshold has to sit above routine and below "I did
not mean the whole account".

---

## 7. Rate limits, idempotency, and being a good client

- Every tool declares a `RouteClass` from `src/server/auth/rate-limit.ts`, the
  same six the routes use, keyed on the token rather than the IP. A model in a
  loop is the expected failure mode, not a hypothetical one.
- Every mutating tool takes an optional idempotency key and claims it before the
  handler runs, exactly as `src/server/http.ts` does. A retried tool call after
  a timeout must not log the time twice.
- Read tools return page-shaped results with an explicit cap. A model asking for
  "all my time" over ten years would otherwise pull [private record count] rows into a context
  window.
- Errors come back as the same `application/problem+json` codes the API uses,
  as text a model can act on: `period_approved` says the week is approved and
  who could reopen it.

---

## 8. What gets asserted, in the commit that builds it

The habit that has caught every defect worth catching in this repo is: a rule
stated in prose, asserted nowhere executable, drifts in the flattering
direction. So, in the same commits as the work:

1. **`tests/mcp-tools.test.ts`: every tool declares a capability or is exempted
   with a written reason.** The sibling of `tests/routes.test.ts`, and for the
   same reason: `projectSummary` and `projectChart` shipped with no `assertCan`
   because the rule was applied by hand and two functions were missed.
2. **Every tool handler calls a service.** A static check that no file under the
   tool directory imports the Drizzle schema or the database client.
3. **A Member token gets a Member's answers.** The MCP equivalent of
   `pnpm authz:scope`: create a Member, a manager, and an outsider; call every
   read tool with each token; assert the Member sees only their own rows, no
   money anywhere, and 404 rather than 403 for out-of-reach records.
4. **Undo is bounded.** Tests for each refusal in 6.2, each proven by mutation:
   revert the guard, watch a named test fail.
5. **The audit row names the token.** A tool call writes `actorKind: "api"` and
   the prefix, asserted on the row rather than on the code path.

---

## 9. Order of work

Each step is shippable and useful alone. **Nothing after step 2 should start
before step 1 has run against real data for a week**, because the read surface
is where the authorization mistakes are cheap to discover.

| Step | What | Why here |
| --- | --- | --- |
| 0 | `api_tokens` connected: creation UI in Settings, `actorFromToken`, revocation, the audit change in 6.1 | Nothing else can start. Useful on its own: it is also how a cron job stops needing the database. |
| 1 | Read-only tools: `tally_projects_mine`, `tally_time_list`, `tally_timer_current`, `tally_report_time` | The whole authorization surface, with nothing to undo if it is wrong. |
| 2 | Timers and own time: start, stop, log, edit, delete, with undo tokens | The daily case, and the first writes. |
| 3 | Manager tools: others' time within reach, approvals | The first reach-scoped writes. |
| 4 | Administrator setup tools, checkpoints, two-phase confirmation | Gated on a nightly `pg_dump` existing. |

## 10. Open questions for Jason

1. **Remote or local?** A local stdio server (Claude Desktop or Claude Code on
   one machine) needs no network exposure and is a much smaller security
   surface. A remote HTTP one is what makes it work from a phone. The plan
   supports both; picking one first changes step 0.
2. **Who may hold a token at all?** Everybody, or administrators only to begin
   with? Starting with administrators only makes step 1 an internal experiment.
3. **Is the twenty-five threshold in 6.4 right** for how you actually work?
4. **Does the nightly `pg_dump` exist yet?** If not it is a prerequisite for
   step 4 and probably should be done regardless.

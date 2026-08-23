# MCP connector

**Status: plan only. Nothing here is built.** Written 2026-08-23, revised the
same day against two working implementations (section 11). Authority over the
MCP surface, its authentication, its authorization, and its change log.
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
server is a client of the same API the web app calls**, and if the two ever
disagree about what a Member may do, that is a defect in the MCP server and not
a policy decision.

---

## 2. The one architectural rule

**The MCP server is an HTTP client of Tally's own API. It holds no database
credentials, imports no service, and is not an authority on anything.** A tool
handler extracts the caller's bearer, calls `/api/v1/...` with it forwarded
verbatim, and serializes what comes back.

### This section said the opposite, and the first draft was wrong

The first version had the MCP process importing `src/server/services/`
directly, on the grounds that this avoided a second copy of the
envelope-unwrapping in `src/lib/api.ts` and kept transaction semantics.

The draft claimed to be protecting that seam and proposed routing around it.
That argument does not survive contact with `src/server/http.ts`, though it is
worth being exact about how much it loses, because a first draft of this
paragraph overstated it. **Auditing survives**: `withTransaction` in ctx.ts
flushes the audit buffer inside the transaction, so a service called directly
is still audited. **Rate limiting and idempotency do not**: `enforce()` and the
idempotency claim live in the route wrapper and nowhere else, so a direct
caller has no bound on it at all and a retried call after a timeout logs the
time twice. So does the route-level `capability` declaration, which is the
backstop `tests/routes.test.ts` exists to keep honest.
Toado reached the opposite conclusion for the right reason, written into its own
deployment PRD:

> Every security change made to the REST API automatically protects the MCP
> surface. There's nothing MCP-specific to pen-test beyond "does the HTTP
> transport correctly extract and forward the bearer."

The cost is a small API client in the MCP process. Toado's is 192 lines. That is
the entire price of the property, and it is worth paying.

Concretely:

- A tool handler is `(input, ctx) => ctx.api.post(...)`. If it contains a
  `select`, an `assertCan`, or an `if (capability)`, it is written wrong: the
  API already did that, and a second copy will drift.
- The MCP process gets `TALLY_API_BASE_URL` and no `DATABASE_URL`. That is
  enforceable, and section 8 enforces it.
- `tests/routes.test.ts` insists every HTTP route reaches a gate. The tool layer
  needs no equivalent, because it has no gate of its own. What it needs instead
  is section 3.2.

---

## 3. Authentication

### 3.0 The table already exists and nothing writes to it

`api_tokens` is in `src/server/db/schema.ts` (id, userId, label, tokenHash,
prefix, scopes, lastUsedAt, expiresAt, revokedAt) and is read and written by
nothing at all. `ActorKind` in `src/server/ctx.ts` already includes `"api"`.
The substrate was designed and then never connected, which is the same shape of
orphan `tests/settings-consumed.test.ts` was written to catch. **Phase A is
mostly connecting what is there.**

### 3.1 Two phases, both shipping, neither replacing the other

**Phase A: a personal access token, pasted.** A person creates one in Settings,
copies it, and runs the one `claude mcp add` command the screen shows them. For
eleven people who all have a laptop, that is the entire connection story.

**Phase B: OAuth 2.1 with PKCE and dynamic client registration.** The client
discovers the authorization server, registers itself, opens a browser, the
person approves a consent screen naming the scopes, and a token comes back
without anybody copying anything. This is what makes a phone work.

Phase B is a real piece of work and is not required for the product to be
useful. **Phase A first, and stop there if the daily use does not materialise.**

### 3.2 The gap that matters: a bearer works on the REST API too

This is the finding worth the exercise of reading Toado's code, and the first
draft of this document missed it.

If `src/server/http.ts` accepts `api` tokens, then **the MCP server is not the
only way to use one.** A caller with a bearer can skip it and hit
`/api/v1/invoices` directly. So a scope check living in a tool handler is
decorative: enforcement has to be where the token is validated.

Toado solves this with a route permission table and, critically, a safe default:

> Mutation route with no explicit entry: reject MCP tokens by default. That's
> the safe failure mode.

Tally should copy that shape exactly:

- One table mapping method plus path pattern to the scope it needs.
- `GET` / `HEAD` / `OPTIONS` fall through to the read scope, so reads do not have
  to be enumerated one by one.
- **Any mutating route not named in the table refuses an `api` actor.** A new
  route is therefore closed to tokens until somebody decides otherwise, which is
  the opposite of how the two missing `assertCan` calls got shipped.
- A second, independent guard: a token whose granted scopes do not intersect the
  write set carries a derived `readOnly` flag, and the mutation guard rejects on
  that alone. Two things have to fail together for a read-only token to write.

### 3.3 The scheme

- Shown once, on the screen that made it. Format `tally_<prefix>_<secret>`, with
  `prefix` stored in clear so a token is identifiable in a list and in an audit
  row without holding the secret.
- Stored as sha256 of the secret, not argon2. **A deliberate departure from the
  password rule, worth saying out loud:** a token is 32 bytes of `randomBytes`
  with no dictionary to attack, so the slow hash buys nothing and costs 25ms of
  CPU on each of the 5 to 20 tool calls in a single model turn. The same
  reasoning is already written down in `src/app/api/v1/auth/reset/route.ts`.
- Expiry required, defaulting to 90 days, maximum one year.
- Revocable from the same screen, effective within the cache TTL in 3.5.

### 3.4 The actor it builds

`actorFromToken()` produces exactly the `Actor` that `actorFromSession()`
produces for the same person: same `profileId`, same `capabilities`, same
`isOwner`, `kind: "api"`. **A token can never do more than the person who
created it.** Scopes narrow, never widen.

There is no second permission model to keep in step, which is the point.

### 3.5 Validation is cached, and revocation still has to work

A model turn fires 5 to 20 tool calls, so validating the bearer on each one
multiplies the auth load by the same factor. Validation is cached for 60
seconds. Three details, all learned the expensive way in Toado's `auth.ts` and
all worth copying verbatim:

- **The cache key is a sha256 of the bearer, not the bearer.** The cache lives in
  the process heap and DigitalOcean can capture a core dump on crash, which would
  otherwise expose every live token in clear.
- **A 401 is never cached, and it deletes any existing entry for that bearer**,
  so a token revoked mid-TTL stops working on its next call rather than up to 60
  seconds later.
- **`lastUsedAt` is written at most once a minute per token**, so an active
  session does not turn every read into a write.

### 3.6 What must not happen

- **No token may be created for another person**, even by an administrator. A
  token acts as you, and an administrator minting one for a colleague is
  impersonation with an audit trail that names the colleague.
- **The account owner flag is not conferrable by token** any more than by
  profile.
- Tokens are refused on the auth routes entirely: no sign-in, no password reset,
  no session creation.

---

## 4. Authorization: what each person can do

Nothing new is invented here. These are the existing capability and reach rules,
restated as the tool surface makes them visible.

### The floor: everybody

Every person holds `time:create_own`, `time:edit_own`, `time:delete_own`,
`project:view`, `report:view_own` and the rest of `EVERYONE` in
`src/server/auth/capabilities.ts`. So every token can start and stop their own
timer, list and create and edit and delete their own entries, see the projects
they may book to, and submit their week.

**Money is absent.** A Member holds no `rates:view_billable`, so the payload
carries no rate and no amount, exactly as `src/server/serialize.ts` already
decides. Not a filter applied by the tool layer; the serializer doing what it
already does.

### Managers: `time:view_others` / `time:edit_others`, `team` reach

A Project Manager reaches `user_managed_users` plus the people on projects where
they are `project_members.is_manager`. That set is `visibleUserIds(ctx)`, the
same predicate the web app uses.

A manager's token lists and edits time for those people and **answers 404 for
anybody else**. A tool must not soften that into "you do not have permission to
edit Sarah's time", because that sentence confirms Sarah.

### Administrators: everything, including cost rates

`rates:view_cost` is Administrator-only among the base profiles, and it is what
separates "can see what a client is charged" from "can see what a colleague is
paid". A token whose owner lacks it gets no cost figures anywhere.

### Scopes

Coarse on purpose, and named for what a person would grant rather than for the
capabilities underneath: `tally.read`, `tally.time.write`, `tally.expenses`,
`tally.approvals`, `tally.admin`.

Each carries a title and a sentence for the Phase B consent screen, and they come
with presets, because a consent screen listing five checkboxes gets approved
without reading while one offering "Read only", "Read and log time", "Full
access" gets a decision. Toado's `SCOPE_LABELS` and `SCOPE_PRESETS` are the
model.

The scope set is **one exported constant** consumed by the token minting, the
route permission table, the consent UI, and the tool definitions, so adding a
scope is a compile error everywhere it needs handling rather than a thing to
remember in four files.

---

## 5. The tool surface

Names are `tally_<noun>_<verb>` so they sort together in a client's tool list.

### Timers and time (the floor)

| Tool | Notes |
| --- | --- |
| `tally_timer_start` | Stops whatever was running first, and says which entry it stopped, because "one running timer per person" is a partial unique index and a silent stop is a surprise. |
| `tally_timer_stop` | Returns the duration it landed on. |
| `tally_timer_current` | What is running, and for how long. |
| `tally_time_list` | A date range, defaulting to this week. Somebody else's only with reach. |
| `tally_time_log` | A duration, or a start and an end. Honours the clock rules in `src/lib/format.ts`: an end before its start is the next day. |
| `tally_time_edit` | Patch one entry. Refused inside an approved period. |
| `tally_time_delete` | Soft delete. Returns the undo token (section 6). |
| `tally_week_submit` | Submit a week for approval. |
| `tally_projects_mine` | The projects and tasks this person may book to. The list a model needs before it can call anything above. |

### Managing (reach required)

`tally_time_list` and `tally_time_edit` for another person, `tally_approvals_list`,
`tally_approvals_decide`, `tally_report_time`. Same tools, wider reach, money
redacted by capability.

### Setting the system up (administrator)

Clients, projects, tasks, people, expense categories, invoice configuration. One
create and one update each, plus `tally_project_members`.

**Two deliberate omissions.** Sending an invoice and recording a payment are not
tools. They leave the building: a sent invoice reaches a client's inbox and no
undo in section 6 reaches it. A model may draft an invoice; a person presses
send.

---

## 6. The log, and the way back

This is the section the request turns on: **"there is a log and backup unless
they make a mistake."** Three mechanisms, because there are three questions.

### 6.1 Every change is already audited

`src/server/http.ts` commits audit rows in the same transaction as the change,
and `Ctx.audit()` is a closure a service cannot opt out of. Every row carries
`actorId`, `actorKind`, `action`, `entityType`, `entityId`, `entityLabel`,
`before`, `after`, `diffKeys`, `requestId`, `createdAt`.

Because the MCP server goes through the API (section 2), **this needs no new
plumbing at all.** The only addition is the token's `prefix` on the row beside
`actorKind: "api"`, so "who changed this" distinguishes Jason at a keyboard from
a script holding Jason's token. Without it the log is true and useless for the
question people will actually ask after a bad bulk run.

### 6.2 Undo for a single change

Destructive tools return an **undo token** naming the audit row they wrote.
`tally_undo` reverses that one change by applying `before` back through the same
API, writing its own audit row. A compensating change, never a rewrite: the
history keeps both.

Bounded on purpose:

- **Only the actor's own changes**, within 24 hours.
- **Refused if the record moved since**, comparing `updatedAt` against the audit
  row. Writing `before` back blindly would discard whatever somebody else did in
  between, which is worse than refusing.
- **Refused for anything that left the building**: a sent invoice, a delivered
  email, a spent invite token.

### 6.3 A checkpoint for bulk work

Undo is for one mistake. Setting up an account is forty calls and the mistake is
noticed at call thirty-nine.

`tally_checkpoint_create` records a label, a timestamp, and the audit sequence.
`tally_checkpoint_diff` lists what that actor changed since.
`tally_checkpoint_revert` walks them newest-first under the 6.2 rules, stopping
at the first refusal rather than skipping it, and reporting where it stopped.

**This is not a database backup and must not be described as one.** It reverses
one actor's changes through the API with all their rules intact. It cannot
recover from a migration, a disk failure, or somebody else's concurrent edit.
A nightly `pg_dump` is a prerequisite for enabling the administrator tools, not
a nice-to-have beside them.

### 6.4 Confirmation for the wide ones

A tool that would change more than **twenty-five** records, or delete anything
that is not the actor's own, is two-phase: the first call returns a plan and a
confirmation token, the second executes it. The model cannot manufacture the
token, so an eager assistant cannot skip the step, and the person reading the
plan is the control.

Twenty-five because a week of one person's entries is about ten and a month is
about forty: the threshold sits above routine and below "I did not mean the whole
account".

---

## 7. Being a good client

- **Request-scoped, never module-scoped.** The bearer, the API client, and the
  identity are built per request and handed to the handler. Toado's deployment
  PRD calls this out because their client read the token once at module load,
  which is fine for one stdio user and wrong the moment two people share a
  process. Tally starts multi-user, so it starts request-scoped.
- **Rate limits keyed on the token**, using the same six `RouteClass` values in
  `src/server/auth/rate-limit.ts`. A model in a loop is the expected failure
  mode, not a hypothetical.
- **Idempotency keys on mutating tools**, claimed before the handler runs, as
  `src/server/http.ts` already does. A retried call after a timeout must not log
  the time twice.
- **Paged reads with an explicit cap.** "All my time" over ten years is [private record count]
  rows and would arrive in a context window.
- **ETag caching on reads**, which Toado has and which matters more here: a model
  re-reads the same project list constantly.
- **Errors as `application/problem+json` codes, in text a model can act on.**
  `period_approved` should say the week is approved and who can reopen it.

---

## 8. What gets asserted, in the commit that builds it

The habit that has caught every defect worth catching in this repo: a rule stated
in prose and asserted nowhere executable drifts in the flattering direction. So,
in the same commits:

1. **The MCP process cannot reach the database.** A check that nothing under the
   MCP app imports the Drizzle schema or the db client, or reads `DATABASE_URL`.
   Section 2 made enforceable, and it is one grep.
2. **Every mutating route is in the permission table or refuses tokens.** The
   sibling of `tests/routes.test.ts`, and for the same reason: `projectSummary`
   and `projectChart` shipped with no `assertCan` because the rule was applied by
   hand and two functions were missed.
3. **A Member token gets a Member's answers.** The MCP equivalent of
   `pnpm authz:scope`: a Member, a manager, and an outsider; every read tool with
   each token; assert the Member sees only their own rows, no money anywhere, and
   404 rather than 403 out of reach.
4. **A read-only token cannot write**, proven with the per-tool scope check
   disabled, because the derived `readOnly` flag is supposed to be the
   independent second guard and an untested second guard is one guard.
5. **Revocation takes effect on the next call**, not at the end of the cache TTL.
6. **Undo is bounded.** A test per refusal in 6.2, each proven by mutation:
   revert the guard, watch a named test fail.
7. **The audit row names the token.** Asserted on the row, not on the code path.

---

## 9. Order of work

| Phase | What | Sessions |
| --- | --- | --- |
| A0 | `api_tokens` connected: Settings UI, `actorFromToken`, revocation, the route permission table with default-deny, the audit change in 6.1 | ~1 |
| A1 | The MCP process: streamable HTTP, request-scoped context, the API client, read-only tools | ~1 |
| A2 | Timers and own time, with undo tokens | 1 to 1.5 |
| A3 | Manager tools: others' time within reach, approvals | ~0.5 |
| A4 | Administrator setup tools, checkpoints, two-phase confirmation | 1.5 to 2 |
| B | OAuth 2.1, PKCE, dynamic client registration, consent screen | 1.5 to 2 |

**A0 through A2 is about half the work and most of the benefit.** If nobody
reaches for it, you stop there having spent half. A4 is gated on a nightly
`pg_dump` that does not exist yet. B is only worth it if connecting from a phone,
or without copy and paste, actually matters.

---

## 10. Open questions for Jason

1. **Own subdomain or a path?** Toado is `mcp.toado.dev` as its own service. The
   Twenty connector is a path on an existing domain, `crm.jhmediagroup.com/mcp`,
   which needed no new certificate or DNS. Tally is joining a shared droplet, so
   the path is probably right, but it depends on question 5.
2. **Who may hold a token to begin with?** Everybody, or administrators only?
   Administrators only makes A1 an internal experiment.
3. **Is the twenty-five threshold in 6.4 right** for how you actually work?
4. **Does a nightly `pg_dump` exist?** Prerequisite for A4, and worth doing
   regardless of whether this is ever built.
5. **nginx or Caddy on the target droplet?** The Twenty connector's deployment
   files use nginx; Confluence documents the Tally droplet as Caddy. One of those
   is out of date, and it changes A1.

---

## 11. Prior art, and what to take from it

Two working implementations sit in the same GitHub folder, both Jason's.

### `visual-debugger` (Toado): the close analogue

Same author, same stack shape, a product with real users and its own permission
model, and a live MCP that part of this document was written through. `apps/mcp`
is 1,669 lines across ten files, plus scopes in
`packages/types/src/mcp-scopes.ts`, token management in
`apps/web/src/routes/settings/tabs/McpTokensTab.tsx`, and PRDs in `docs/prds/`.

**Take:** the architecture in section 2 and the reason for it; the route
permission table with default-deny; the derived `readOnly` second guard; the
token-info cache and its three details in 3.5; request-scoped context; the
consent labels and presets; the two-phase PAT-then-OAuth shape.

**Read the code as authoritative over its own PRD.** That PRD says the MCP server
should not validate the token and should let the first REST call 401. The shipped
`auth.ts` validates up front through `/auth/token-info`, because the scopes are
needed before the first call and failing fast gives a better error. The code is
right and the plan was not, which is a useful thing to remember about this
document too.

### `twenty-crm-mcp-for-cowork`: the deployment reference

A fork of MIT-licensed `jezweb/twenty-mcp`, 29 tools, deployed to a DigitalOcean
droplet behind nginx with a hardened systemd unit.

**Take:** the systemd unit and its hardening flags, the proxy location block, the
path-on-an-existing-domain approach.

**Leave:** the auth model, which is Clerk OAuth with encrypted key storage and
has nothing to do with Tally's `api_tokens`.

**Note the bug its own notes record:** the upstream HTTP server registered four
of seven tool categories while the stdio server registered all seven. That is a
better argument for check 2 in section 8 than anything written above it, because
it is the same defect shape, in the same place, in a shipped product.

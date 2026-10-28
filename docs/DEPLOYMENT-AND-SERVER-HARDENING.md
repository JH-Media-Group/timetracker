# Tally deployment and shared-server hardening

**Prepared:** 2026-08-16

**Staging deployed:** 2026-08-24

**Staging last updated:** 2026-10-28 01:23 UTC

**Production droplet:** `165.245.130.130`

**Hostname:** `tally.jhmediagroup.com`

This is the operating plan produced from a read-only inspection of the shared
DigitalOcean droplet. Tally is joining a sensitive server that already runs
Caddy, PostgreSQL, Redis, Twenty CRM, Lead Orchestrator, Process Server,
Twenty MCP, and IdeaFlow. Changes must be narrow, reversible, and must not
restart unrelated services.

The repeatable operating procedure now lives in
`docs/DEPLOYMENT-RUNBOOK.md`. This file retains the deployment evidence and
the broader shared-server maintenance plan.

## Staging update: grouping-independent time-report totals, 2026-10-28

Tally staging runs source commit `affae49ee72be6006a3ee8295422fbcf33b3f530`
as `tally:affae49`, image ID
`sha256:6395d981d3cef0fb925d8e74f97c51f4fc5bc507f4ed30f179f31f328599eb62`.
The update completed at 01:23 UTC on October 28 (October 27 locally).
The subsequent documentation-only commit is separate from the application image.

This fixes `t-PaBDg3`. The time report previously summed independently rounded
group values for its grand total, allowing the total to change when grouping
changed. A SQL window now sums the unrounded products within the same scoped
query and rounds the full total once. Group rows keep their independent rounding,
so their displayed sum may differ slightly from the correctly rounded grand
total. Money visibility, filters, response shape and stored records are unchanged.

Release evidence:

- The two fractional-cent regressions failed against the original code, then
  all 24 report tests passed. The exact merged source passed 69 files and 1,024
  tests, TypeScript, palette checks and a clean-archive Linux production build.
  Tests cover all five service groupings, project/client/user filters, member
  money masking and empty results.
- Codex's independent adversarial review found no concrete issues. Claude's
  fresh review attempt was blocked by the account usage limit; that limitation
  was disclosed and no completed Claude review is claimed for this patch.
- The 101,608,960-byte image transfer matched SHA-256
  `a66c07ff8744f21ee1628ab41ce1c5fbf8f9f0aa8b7c2c4bbd9721014a2bd6ec`
  on the server. The loaded image matches the local build and runs as `node`.
- Pre-update dump `/var/backups/tally/tally-20261028T011553Z.dump`, SHA-256
  `387794814faa7b402184ed6e86eaa59cf1e1e396161cc27f63b5b553d49667b6`;
  post-update dump `/var/backups/tally/tally-20261028T012337Z.dump`, SHA-256
  `a50bc3f6fb2b8c961c19bb802453bd7e607fc8fc5d940b92b5b09c0debc6610d`.
  Both passed 329-line catalog checks and full owner-preserving scratch restores
  with matching counts; both exact scratch databases were removed.
- The isolated, unproxied candidate passed health and database readiness with
  the live limits, no published port and no production alias. Migrations were
  a no-op with ten Drizzle and five manual records and unchanged ledger rows;
  base profiles were already current. Database counts are unchanged.
- Only the environment image line changed, proven by normalized comparison.
  Web was replaced and verified before MCP, both using `--no-deps`. Both are
  healthy on the exact new image, with no restarts or OOM events. Original
  limits and isolation are preserved.
- Live liveness, readiness and OAuth discovery return 200; MCP GET returns
  405 and unauthenticated POST returns 401 with the resource challenge.
  Security headers, environment/Compose permissions, listeners, all four timers
  and root SSH are preserved. Compose and Caddy hashes are unchanged, host and
  container Caddyfile hashes agree, unrelated container images/start times/
  restarts/OOM state are unchanged, and recent application logs have no errors.
- Authenticated read-only browser checks compared Client, Project, Task and
  Person grouping for the same custom dates. Every summary KPI, pinned total
  and freshly downloaded CSV grand total matched the independent unrounded
  database aggregate. Person grouping also passed a full refresh, and no browser
  console errors were captured. No live business records were changed for QA.
- The scheduled mail run at 01:25:21 UTC succeeded after the new web became
  healthy, with `--no-reminders` retained. Its result, log and queue counts are
  saved in the protected evidence bundle.

Protected server evidence is `/opt/tally/artifacts/deploy-affae49`; private
browser/CSV artifacts remain outside Git. The prior `tally:ac5b3d0` image and
configuration are retained for application-only rollback. No schema change,
historical-data backfill or invoice rewrite was applied.

The remaining audit findings are tracked separately: capped list-page aggregates
(`t-pAwUtQ`), destination-date validation for entry moves (`t-SFiXCS`), clearing
editor notes (`t-rW27Ea`), a billing-classification decision (`t-AbnZpo`), and the
explicitly separate QuickBooks integration backlog (`t-U_LBU1`). The old
`t-cWM-yo` day-view report is an incomplete draft needing reproduction; it is not
evidence of a currently reproduced failure.

## Staging update: timers, custom report dates and historical snapshots, 2026-10-28

Tally staging runs source commit `ac5b3d08a2722d8c5a588b47d25dc4cf2a3fdd50`
as `tally:ac5b3d0`, image ID
`sha256:97000a230dad28a5c304f832c11382a9d5795950b7ec4e57ea758c5ebd021db5`.
The deployment completed at 01:00 UTC on October 28 (October 27 locally).
The application revision is distinct from the subsequent documentation-only
commit recording this evidence.

The release fixes retrospective timer elapsed time, preserves running timer
edits, adds inclusive custom report ranges with URL persistence, retrieves all
drilldown pages for grids and CSV, and preserves historical rate snapshots on
note edits. The five working Toado tickets are `t-BR2arf`, `t-y7KLD1`,
`t-CGYdX5`, `t-S5guAF` and `t-W23yB1`. QuickBooks integration remains separate
backlog work.

Verification and deployment evidence:

- The exact merged and pushed source passed 69 test files and 1,021 tests,
  TypeScript and palette validation. The production image was built locally
  from a clean Git archive of that commit, excluding local operational data
  and environment files.
- Earlier production-build browser and API checks used fictional fixtures:
  retrospective create/refresh/edit/stop, manual duration, teammate timer
  isolation, report/tab date persistence, matching drilldown and CSV totals,
  person rate saving, historical rate preservation and invoice preview grouping.
  Project-chart units were inspected in source. These checks do not establish
  acceptance of any specific real business record. No live business-data test
  mutation was performed.
- After the owner signed in, authenticated read-only browser checks passed on
  the deployed site: reversed custom dates were rejected, valid dates survived
  refresh and all four tabs, Task-to-Profitability cleared incompatible grouping,
  client and person drilldown hours matched their report rows, and a fresh CSV
  contained all nine columns with matching row hours and monetary totals. Team
  and Invoicing loaded their real report data; no browser console errors were
  captured. Timer and rate write workflows remain verified on fictional local
  fixtures rather than through mutations of live business records.
- This browser pass also found a pre-existing one-cent grand-total difference
  when changing the time-report grouping. The unchanged report service sums
  rounded group amounts instead of rounding the complete aggregate once.
  Separate follow-up `t-PaBDg3` records the evidence and a fictional regression
  fixture. This release does not claim that grouping-wide rounding issue fixed.
- Codex completed iterative adversarial reviews and final rechecks. Claude
  completed two rounds and the actionable findings were addressed. A final
  Claude recheck was unavailable because of the account usage limit; this
  limitation was disclosed before deployment authorization.
- The 101,606,400-byte transfer archive matched SHA-256
  `2b2ef60567e5cfaa49254dd945fb2e7f6ca458895629a1c83e6ec691127b6a6f`
  on the server. The loaded image ID matches the local build and runs as `node`.
- Pre-update dump `/var/backups/tally/tally-20261028T005437Z.dump`, SHA-256
  `492b7c51c52edfbe027d8feb27cae1eecef65de021b276e4962db7389c890a0b`;
  post-update dump `/var/backups/tally/tally-20261028T010023Z.dump`, SHA-256
  `321fe87f7f416ae9f25e72445fd3d0cb23deadf7b3c03f45b14581d28da5f352`.
  Both passed 329-line catalog checks and full scratch restores with matching
  user, project, active-entry, running-timer, invoice and migration counts and
  the original database owner. Both exact scratch databases were removed.
- An unproxied candidate with the live runtime controls and no host port or
  production alias passed liveness, database readiness and Docker health before
  replacement. The migration runner was a no-op: ten Drizzle and five manual
  migrations, unchanged ledger rows and counts, base profiles up to date.
- Only the environment image line changed, proven by normalized hashes. Web
  was replaced with `--no-deps` and proved healthy and ready while MCP remained
  on the old image, then MCP was replaced separately. Both use the exact new
  image with zero restarts and no OOM events; original limits and isolation
  are preserved.
- Public liveness, readiness and both OAuth discovery documents return 200.
  MCP GET returns 405 and unauthenticated POST returns 401 with the protected
  resource challenge. Sign-in security headers remain present. Logs contain no
  deployment error, database counts are unchanged, and mail states are captured.
- Every unrelated container retained its image, start time, restart count and
  OOM state. No container is unhealthy. Listeners, Compose and Caddy hashes
  are unchanged, host/container Caddyfile hashes agree, all four timers are
  active, environment and Compose remain mode 0600, and root SSH remains enabled.
  The scheduled mail run at 01:00:07 UTC succeeded with `--no-reminders` retained.

Protected server evidence is `/opt/tally/artifacts/deploy-ac5b3d0`, directory
mode 0700 and files mode 0600. The previous `tally:85ec973` image and saved
configuration remain available for application-only rollback. No schema change,
historical time correction, rate backfill or invoice rewrite was part of this
release.

## Staging update: rate check speed and imported history, 2026-10-12

Tally staging now runs source commit `85ec973` as `tally:85ec973` (image ID
`sha256:2c3c6fd1210bf4f1989a87d854d727615539f5ec925f447492ba7f052e4498f7`),
an hour after `c5ffabe`. The follow-up came from running the released image
locally against a restored staging backup and driving it headlessly: the
project-page rate check took about five seconds per load on large projects,
the banner outlived the apply that cleared it, and it offered to price
imported $0 history. All three are fixed; the check now takes about 50 ms on
the same data.

Update evidence, by the same runbook as the release above:

- 67 test files and 984 tests passed, TypeScript clean, Linux production
  Docker build clean. The day-dependent rate cache and the imported-history
  guard are mutation-tested.
- The transferred 101,562,880-byte tar has SHA-256
  `ec097122fab86547d450ab877bd1744295c417405a3b4da5d34ba6fc43bc5dfa`, matched on
  the server, with the loaded image ID matching the local build.
- Pre-update dump `/var/backups/tally/tally-20261012T172908Z.dump`, SHA-256
  `5d6130e5143eed15a75687e80e0db63fe9990213698311482a545feefac251e5`; post-update
  dump `/var/backups/tally/tally-20261012T173240Z.dump`, SHA-256
  `224a3de627a04367d88c95ec645546b4f97f391a1e4f1c21776a4143c6a71d3d`. Both passed
  329-line catalog checks and owner-preserving scratch restores matching live
  counts; both scratch databases were dropped.
- An isolated candidate was healthy and ready before the live update, and
  migrations stayed at 10 Drizzle and five manual.
- The environment file changed by one line, proven by identical normalized
  hashes. Web then MCP were replaced with `--no-deps`; both run the exact image
  with zero restarts and no OOM events.
- Readiness, OAuth discovery, MCP 405 and 401 behaviour and security headers
  are as before. Counts are identical before and after, unrelated containers
  unchanged, nothing unhealthy, listeners unchanged, Compose and Caddy hashes
  unchanged, four timers active, a mail run succeeded, no log errors, and root
  SSH remains enabled.

Evidence is under `/opt/tally/artifacts/deploy-85ec973`. The previous
`tally:c5ffabe` image remains loaded for rollback.

## Staging update: rates fill, never reprice, 2026-10-12

Tally staging now runs source commit `c5ffabe` as `tally:c5ffabe` (image ID
`sha256:ffdc079c965b877ea4a44713ae9b12f85eaaebd2d22e3957a8873ca5e438ecd7`).

The release fixes the code behind four teammate tickets that shared one cause:
project rates were never carried over from the old system, so time logged here
saved at $0. The data was corrected before the release, as its own change with
its own backups; this section covers the release.

Update evidence:

- The exact pushed source passed 67 test files and 982 tests and TypeScript.
  The re-rate guard and both non-billable guards are mutation-tested. The
  Linux production Docker build compiled cleanly.
- Since the deployed `0ce1e90` the only risk-path change is `package.json`
  (two script entries). No Drizzle, Compose, Dockerfile, ops, systemd or schema
  change.
- The transferred 101,561,856-byte image tar has SHA-256
  `c530b687caf474eaf14ea4d15c044aaa4d4855a3ac8445ed24ccc0264eaea467`, verified
  for exact size and hash on the server, with the loaded image ID matching the
  local build.
- Preflight recorded 17 containers with zero restarts and no OOM events, 70 GB
  free disk, 2.2 GB available memory, load 0.06, and public listeners of 22, 80
  and 443 plus loopback DNS.
- An isolated, unproxied candidate reached healthy state, returned 200 from
  liveness and database readiness, kept every live security and resource
  control, published no host port, and was removed before the live update.
- No schema changes. All manual migrations, including `0001_constraints.sql`,
  reported already applied, which confirms the line-ending explanation for its
  re-apply in the previous release.
- The pre-update dump is `/var/backups/tally/tally-20261012T162543Z.dump`,
  SHA-256 `db987acd84a8062737410674a3183db05d071f7ebd1bc522a7cd374a123a4958`.
- The post-update dump is `/var/backups/tally/tally-20261012T162944Z.dump`,
  SHA-256 `e4052eba778309423c8ddd6e5052063de47f90b9dc65807d83cd4a09cdf6cf03`.
- Both dumps passed 329-line catalog checks and complete owner-preserving
  scratch restores reconciling users, projects, time entries, running timers,
  invoices, 10 Drizzle and five manual migrations and the `tally_staging`
  owner. Both scratch databases were dropped and confirmed gone.
- The environment file changed by exactly one line, proven by identical
  normalized SHA-256 values.
- Web and MCP were replaced separately with `--no-deps`; web was proven healthy
  while MCP still ran `tally:0ce1e90`. Both now run the exact local image ID
  with zero restarts, no OOM events, read-only root filesystems and their
  original limits.
- External liveness, readiness and both OAuth discovery documents return 200,
  MCP GET returns 405 and an unauthenticated POST 401 with the
  protected-resource challenge, and the security headers remain present.
- Database counts before and after are identical. Compose and Caddy hashes are
  unchanged, the container diff shows only the two Tally lines, nothing is
  unhealthy, listeners are unchanged, all four timers are active, a manual mail
  run succeeded, neither log has an error line since the deployment, and root
  SSH remains enabled.
- The new screens were not checked in a browser during the release: the
  browser connection was unavailable. The tickets carry a visual check for a
  reviewer.

Rollback and evidence material, including the data correction's statement
hash and backups, is under `/opt/tally/artifacts/deploy-c5ffabe`. The previous
`tally:0ce1e90` image remains loaded. This application-only update requires no
database restore for rollback.

## Staging update: the invite dialog and twelve rounds of review, 2026-09-11

Tally staging now runs source commit `0ce1e90` as `tally:0ce1e90` (image ID
`sha256:a407c1ec7f0a35ce6273df6bc78f4b1875b05e6c0906ae4e93b0f103c8f302da`).

The release is the invitation dialog (send the email, take a one-time link, or
both, in one request and one token) and the twelve adversarial rounds that
followed it. Those rounds are summarised in `CLAUDE.md`; the short version is
that they were all one rule from different sides, which is that minting a
credential is an interactive act and a bearer token is not a person. Four of
the fixes are guards a token now meets: it cannot create another token, take a
magic link, give itself OAuth consent, or move the address an invitation is
delivered to.

Update evidence:

- The exact pushed source passed 67 test files and 967 tests, TypeScript, and
  palette validation. Each of the two security guards in this release is
  mutation-tested: removing either one fails its own test and nothing else.
- The Linux production Docker build succeeded and is the build authority here.
  A native Windows `pnpm build` compiles and generates all 85 pages, then fails
  creating standalone symlinks, which is a Windows permission limit rather than
  a code fault.
- `git diff` against the deployed commit was impossible: `cb82dab` no longer
  exists after the repository history rewrite. The comparison was taken against
  `d7818f4`, the last recorded deployment that survives in current history,
  which is a superset of what `cb82dab` carried. It shows no Drizzle, Compose,
  Dockerfile, ops, systemd or schema change, only application source, tests and
  two `package.json` script entries.
- The transferred 101,643,776-byte image tar has SHA-256
  `73a7da0bc06cbf6caab8136e70d7cb43e1b42366df8800ccb1fb5515baa7b7a6`, verified
  for exact size and hash on the server before loading, with the loaded image
  ID matching the local build.
- Preflight recorded 17 containers, none unhealthy, zero restarts and no OOM
  events anywhere, 73 GB free disk, 2.8 GB available memory, load 0.04, and
  public listeners of 22, 80 and 443 plus loopback DNS.
- An isolated, unproxied candidate container reached healthy state, returned
  200 from liveness and database readiness, kept every live security and
  resource control, published no host port, carried no production network
  alias, and was removed before the live update.
- No schema changes: the isolated migration run left all 10 Drizzle and five
  manual migrations unchanged. It did re-apply `0001_constraints.sql`, whose
  stored hash no longer matches the file. The file has not changed in Git since
  the schema was built, so this is a line-ending difference between the
  checkout that produced the deployed image and this one. Every statement in
  those files is written to be idempotent for exactly this case, it ran inside
  a transaction, and the row count is unchanged. Subsequent deployments from
  this checkout will report it as already applied.
- The immediate pre-update dump is
  `/var/backups/tally/tally-20260911T173304Z.dump`, SHA-256
  `7814569ba33f4648c9ce4c7a129961f436a235b822614f141678a52cfa59c9e4`.
- The post-update dump is
  `/var/backups/tally/tally-20260911T174009Z.dump`, SHA-256
  `d05067f21e496ebea3bc312b683e283a5edd6b336dbfa503b03cc506ad21787d`.
- Both dumps passed 329-line catalog checks and complete owner-preserving
  scratch restores reconciling 58 users, 365 projects, the full time entry
  count, three running timers, the full invoice count, 10 Drizzle migrations,
  five manual migrations and the `tally_staging` owner. Both scratch databases
  were dropped and confirmed gone.
- The environment file changed by exactly one line, proven by identical
  normalized SHA-256 values
  (`23f3c489d254d4831fbc68727db0bc8a0879af8e22e04544565a0e980da086e8`).
- Web and MCP were replaced separately with `--no-deps`, web proven healthy on
  the new image while MCP still ran `tally:cb82dab`. Both now run the exact
  local image ID with zero restarts, no OOM events, read-only root filesystems
  and their original limits.
- External liveness, readiness and both OAuth discovery documents return 200,
  MCP GET returns 405 and an unauthenticated POST returns 401 with the
  protected-resource challenge, and the security headers remain present.
- Database counts before and after are identical, including the three running
  timers, and the mail queue is empty in both directions.
- `/opt/tally/compose.yml` and `/opt/Caddyfile` retained their pre-deploy
  hashes, the host and container Caddyfiles match, and Caddy was not reloaded.
  A container diff against the pre-deploy baseline showed the two Tally lines
  changed and nothing else across 17 containers, with public listeners
  unchanged.
- All four Tally timers remain active, a manual mail run succeeded with
  `--no-reminders`, web and MCP logs contain no error line since the
  deployment, and root SSH remains enabled with effective
  `permitrootlogin yes`.
- The mail run reports two messages that have exhausted their attempts and will
  not be retried. They pre-date this release. Read `outbound_messages.last_error`
  before configuring a real transport.

Rollback and evidence material is under `/opt/tally/artifacts/deploy-0ce1e90`,
the image tar is `/opt/tally/artifacts/tally-0ce1e90.tar`, and the previous
`tally:cb82dab` image remains loaded. This application-only update requires no
database restore for rollback.

## Staging update: password reset and the handler harness, 2026-09-10

Tally staging now runs source commit `cb82dab` as `tally:cb82dab` (image ID
`sha256:c7f33f80f3dfbc1a606f67a334f0b1852fb7b4377a7a76396bceb57829a566ea`).

Two things. `POST /api/v1/auth/forgot` had existed since auth was built, with
constant-time responses, no enumeration channel and IP-keyed rate limiting, and
nothing had ever called it: nobody could ask for a password reset link, and
with Google SSO unconfigured a password is the only way in. `/forgot-password`
is that screen, added to `ANONYMOUS_PAGES`, which is the one list the
middleware, the layout, the shell and the timer all read.

And `tests/support/route-harness.ts`, which calls a real route handler with a
real session cookie and Origin, closing the seam `tests/route-reachability.test.ts`
cannot see: a route that is called and ignores what it was sent.

Update evidence:

- The exact pushed source passed 62 test files and 866 tests, TypeScript,
  palette validation, and a complete Linux production Docker build. The harness
  is mutation-tested against the stop-route defect it was written for.
- The live `auth/forgot` endpoint was verified before the screen was built: an
  unknown address answers 200 with the neutral message in 0.30s and a malformed
  one 422 in 0.28s, both above the 250ms floor that hides the difference.
- The transferred 101,645,312-byte image tar has SHA-256
  `4f4377b2540adb87bc35f88799937a7b53ce7da86b5a7bc0b1baaff3e7482823`, verified
  for exact size and hash on the server before loading, with the loaded image
  ID matching the local build.
- Preflight recorded 17 containers, none unhealthy, 74 GB free disk and 2.8 GB
  available memory, with external liveness and readiness at 200.
- An isolated, unproxied candidate container reached healthy state, returned
  200 from liveness and database readiness, kept every live security and
  resource control, published no host port, carried no production network
  alias, and was removed before the live update.
- No schema changes. The isolated migration run left all 10 Drizzle and five
  manual migrations unchanged.
- The immediate pre-update dump is
  `/var/backups/tally/tally-20260910T001123Z.dump`, SHA-256
  `607f0235f52e7ddf84213ebdffd3753e63463d62f783aa3561a470fbd6ff1dd4`.
- The post-update dump is
  `/var/backups/tally/tally-20260910T001348Z.dump`, SHA-256
  `04b18bb59b7fab0ef6bca0c6f571b0c07be34bfd00cf609168fdd7ff3ff8dd1a`.
- Both dumps passed 329-line catalog checks and complete owner-preserving
  scratch restores reconciling 58 users, 365 projects, [private record count] active time
  entries, 10 Drizzle migrations, five manual migrations and the
  `tally_staging` owner. Both scratch databases were removed and confirmed
  gone.
- The environment file changed by exactly one line, proven by identical
  normalized SHA-256 values
  (`23f3c489d254d4831fbc68727db0bc8a0879af8e22e04544565a0e980da086e8`).
- Web and MCP were replaced separately with `--no-deps`, web proven healthy on
  the new image while MCP still ran `tally:94342ca`. Both now run the exact
  local image ID with zero restarts and no OOM events.
- `/forgot-password` returns 200 without a session, confirming the middleware
  took it from `ANONYMOUS_PAGES`, and the sign-in page carries the link.
  External liveness, readiness and both OAuth discovery documents return 200,
  MCP GET returns 405 and an unauthenticated POST 401, and all five security
  headers remain present.
- `/opt/tally/compose.yml` and `/opt/Caddyfile` retained their pre-deploy
  hashes, the host and container Caddyfiles match, and Caddy was not reloaded.
  A container diff against the pre-deploy baseline showed the two Tally lines
  changed and nothing else across 17 containers, none unhealthy, with public
  listeners unchanged.
- All four Tally timers remain active, a manual mail run succeeded, web and MCP
  logs contain no error line since the deployment, and root SSH remains enabled
  with effective `permitrootlogin yes`.

Rollback and evidence material is under `/opt/tally/artifacts/deploy-cb82dab`,
the image tar is `/opt/tally/artifacts/tally-cb82dab.tar`, and the previous
`tally:94342ca` image remains loaded. This application-only update requires no
database restore for rollback.

## Staging update: the route-reachability guard, 2026-09-09

Tally staging now runs source commit `94342ca` as `tally:94342ca` (image ID
`sha256:879af6e2cdbff26196589003963ca44ae37571aabe5f870a056ad76ba74b3118`).

Mostly a test release, carrying one production fix that the test found. The new
`tests/route-reachability.test.ts` asserts that every one of the 139 route
methods is reached by `src/lib/api.ts` or the MCP server, or carries a written
reason in an exact ledger. On its first run it found that
`POST /time-entries/:id/stop` had always accepted a user id in its body and
always discarded it, which silently undid the previous day's fix for t-DVQ2qW:
the timesheet passed the row owner's id, the client sent it, and the route
stopped the actor's own timer regardless. The service tests never caught it
because they call `stopTimer` directly. The route reads the body now.

Update evidence:

- The exact pushed source passed 61 test files and 859 tests, TypeScript,
  palette validation, and a complete Linux production Docker build. The guard
  itself is mutation-tested three ways: a new uncalled route, a client call
  pointed at a path no route answers, and the restored state.
- The transferred 101,622,272-byte image tar has SHA-256
  `3accb2ad203a4665bd4f522461c39c924be4c5d0c06dddef42173c0a6147e0a3`, verified
  for exact size and hash on the server before loading, with the loaded image
  ID matching the local build.
- Preflight recorded 17 containers, none unhealthy, 74 GB free disk and 2.8 GB
  available memory, with external liveness and readiness at 200.
- An isolated, unproxied candidate container reached healthy state, returned
  200 from liveness and database readiness, kept every live security and
  resource control, published no host port, carried no production network
  alias, and was removed before the live update.
- No schema changes. The isolated migration run left all 10 Drizzle and five
  manual migrations unchanged.
- The immediate pre-update dump is
  `/var/backups/tally/tally-20260909T230902Z.dump`, SHA-256
  `b4adb74da721d34079930f87ecb2de64e611c8e914e753134f0d51e3ceb03855`.
- The post-update dump is
  `/var/backups/tally/tally-20260909T231142Z.dump`, SHA-256
  `047dd1a5254e0783e5d16ad1f9a4545c026fe216598149029080bfe849813b6f`.
- Both dumps passed 329-line catalog checks and complete owner-preserving
  scratch restores reconciling 58 users, 365 projects, [private record count] active time
  entries, 10 Drizzle migrations, five manual migrations and the
  `tally_staging` owner. Both scratch databases were removed and confirmed
  gone.
- The environment file changed by exactly one line, proven by identical
  normalized SHA-256 values
  (`23f3c489d254d4831fbc68727db0bc8a0879af8e22e04544565a0e980da086e8`).
- Web and MCP were replaced separately with `--no-deps`, web proven healthy on
  the new image while MCP still ran `tally:da915d2`. Both now run the exact
  local image ID with zero restarts and no OOM events.
- External liveness, readiness and both OAuth discovery documents return 200.
  MCP GET returns 405 and an unauthenticated POST returns 401 with its
  protected-resource challenge. All five security headers remain present, and
  the stop route's compiled bundle contains the body handling that was added.
- `/opt/tally/compose.yml` and `/opt/Caddyfile` retained their pre-deploy
  hashes, the host and container Caddyfiles match, and Caddy was not reloaded.
  A container diff against the pre-deploy baseline showed the two Tally lines
  changed and nothing else across 17 containers, none unhealthy, with public
  listeners unchanged.
- All four Tally timers remain active, a manual mail run succeeded, web and MCP
  logs contain no error line since the deployment, and root SSH remains enabled
  with effective `permitrootlogin yes`.

Rollback and evidence material is under `/opt/tally/artifacts/deploy-94342ca`,
the image tar is `/opt/tally/artifacts/tally-94342ca.tar`, and the previous
`tally:da915d2` image remains loaded. This application-only update requires no
database restore for rollback.

## Staging update: personal time zones, 2026-09-09

Tally staging now runs source commit `da915d2` as `tally:da915d2` (image ID
`sha256:18a763ecc31a3f2f9ec6769876b6627769680e3e1e37b6f454f48503f2b7bdcd`).

Personal time zones must be confirmed with each person. Keep account-specific locations and corrections in private operational records.

Settings now carries a "Yours alone" card with the theme and a personal time
zone using the searchable worldwide picker. The company field's help text was
also corrected: it claimed to decide the calendar day a timer belongs to, which
stopped being true when day resolution moved to the entry owner's zone.

Update evidence:

- The exact pushed source passed 60 test files and 855 tests, TypeScript,
  palette validation, and a complete Linux production Docker build.
- The transferred 101,622,272-byte image tar has SHA-256
  `d427d1f236841b597710de93811efb78fce1005d361540648a953edfb0eaa536`, verified
  for exact size and hash on the server before loading, with the loaded image
  ID matching the local build.
- Preflight recorded 17 containers, none unhealthy, 74 GB free disk and 2.8 GB
  available memory, with external liveness and readiness at 200.
- An isolated, unproxied candidate container reached healthy state, returned
  200 from liveness and database readiness, kept every live security and
  resource control, published no host port, carried no production network
  alias, and was removed before the live update.
- No schema changes. The isolated migration run left all 10 Drizzle and five
  manual migrations unchanged.
- The immediate pre-update dump is
  `/var/backups/tally/tally-20260909T221354Z.dump`, SHA-256
  `c068a6914cf227f0a3c367493187b0969a4b9bdb7fab1354161dee42fbdc53f1`.
- The post-update dump is
  `/var/backups/tally/tally-20260909T221704Z.dump`, SHA-256
  `de5460a1a5d2ef3876d4a22ee6fb54d7f6690b3841e8bad71ef3efc6c6e9f11a`.
- Both dumps passed 329-line catalog checks and complete owner-preserving
  scratch restores reconciling 58 users, 365 projects, [private record count] active time
  entries, 10 Drizzle migrations, five manual migrations and the
  `tally_staging` owner. Both scratch databases were removed and confirmed
  gone.
- The environment file changed by exactly one line, proven by identical
  normalized SHA-256 values
  (`23f3c489d254d4831fbc68727db0bc8a0879af8e22e04544565a0e980da086e8`) over
  seven lines each.
- Web and MCP were replaced separately with `--no-deps`, web proven healthy on
  the new image while MCP still ran `tally:2b5656a`. Both now run the exact
  local image ID with zero restarts and no OOM events.
- External liveness, readiness and both OAuth discovery documents return 200.
  MCP GET returns 405 and an unauthenticated POST returns 401 with its
  protected-resource challenge. All five security headers remain present, and
  the personal time zone control appears in the running container's server and
  client bundles.
- `/opt/tally/compose.yml` and `/opt/Caddyfile` retained their pre-deploy
  hashes, the host and container Caddyfiles match, and Caddy was not reloaded.
  A container diff against the pre-deploy baseline showed the two Tally lines
  changed and nothing else across 17 containers, none unhealthy, with public
  listeners unchanged.
- All four Tally timers remain active, a manual mail run succeeded, web and MCP
  logs contain no error line since the deployment, and root SSH remains enabled
  with effective `permitrootlogin yes`.

Rollback and evidence material is under `/opt/tally/artifacts/deploy-da915d2`,
the image tar is `/opt/tally/artifacts/tally-da915d2.tar`, and the previous
`tally:2b5656a` image remains loaded. This application-only update requires no
database restore for rollback.

## Staging update: the re-rate action, 2026-09-09

Tally staging now runs source commit `2b5656a` as `tally:2b5656a` (image ID
`sha256:2f785c4195299ed226b96bfd2e165ce36290b6c02b43bd751a6b21176003fcc1`).
This release fixes Toado tickets `t-zNfxik`, `t-9Uli4l`, `t-VFx9pa` and
`t-o-itKE`.

The substantial part is `reRateProject`. An entry keeps the rates it was
written with, so setting an hourly rate on a project correctly changes nothing
already logged, and the documented exception to that rule had never been built.
Example Client 07 carried 876 entries snapshotted at zero from the Harvest import and
exactly one at the new rate, logged after it was set, so the project read $0
uninvoiced with real work behind it and nothing in the product could correct
it. The action re-resolves through the same `resolveForEntry` the write path
uses, refuses anything invoiced, billed externally, rate-locked or running,
counts each refusal, previews with the same call under `dryRun`, and audits the
entries it rewrote rather than only how many.

Update evidence:

- The exact pushed source passed 60 test files and 855 tests, TypeScript,
  palette validation, and a complete Linux production Docker build. The seven
  new re-rate tests are mostly refusals, because an action that rewrites money
  on existing rows has to be provably unable to touch billed work.
- The transferred 101,615,616-byte image tar has SHA-256
  `52c9e042383a4294d5d4a52f4c7634f991c0485dda3996a0843225d8aaa2c33f`. The
  server verified its exact size and hash before loading it, and the loaded
  image ID matched the local build.
- Preflight recorded 17 containers, none unhealthy, 74 GB free disk and 2.8 GB
  available memory, with external liveness and readiness at 200.
- An isolated, unproxied candidate container reached healthy state and returned
  200 from liveness and database readiness, kept every live security and
  resource control, published no host port, carried no production network
  alias, and was removed before the live update.
- There were no schema changes. The new route is application code; the isolated
  migration run left all 10 Drizzle and five manual migrations unchanged.
- The immediate pre-update dump is
  `/var/backups/tally/tally-20260909T205026Z.dump`, SHA-256
  `d6955a6690007227f5f18d33e165b261bc3e418505f7bc4e853a09ea704e17f5`.
- The post-update dump is
  `/var/backups/tally/tally-20260909T205313Z.dump`, SHA-256
  `71b0054c4f0e06a751bc35a09b29979a2e0d852219f447591b81222cb9919d10`.
- Both dumps passed 329-line catalog checks and complete owner-preserving
  scratch restores reconciling 58 users, 365 projects, [private record count] active time
  entries, 10 Drizzle migrations, five manual migrations and the
  `tally_staging` owner. Both scratch databases were removed and confirmed
  gone.
- The environment file changed by exactly one line, proven by identical
  normalized SHA-256 values
  (`23f3c489d254d4831fbc68727db0bc8a0879af8e22e04544565a0e980da086e8`).
- Web and MCP were replaced separately with `--no-deps`, web proven healthy on
  the new image while MCP still ran `tally:fabd137`. Both now run the exact
  local image ID with zero restarts and no OOM events.
- External liveness, readiness and both OAuth discovery documents return 200.
  MCP GET returns 405 and an unauthenticated POST returns 401 with its
  protected-resource challenge. All five security headers remain present, and
  the re-rate control appears in the running container's server and client
  bundles.
- `/opt/tally/compose.yml` and `/opt/Caddyfile` retained their pre-deploy
  hashes and Caddy was not reloaded. A full container diff against the
  pre-deploy baseline showed the two Tally lines changed and nothing else: all
  15 unrelated containers kept the same image, image ID, restart count and OOM
  state, none is unhealthy, and public listeners did not change.
- All four Tally timers remain active, a manual mail run succeeded, web and MCP
  logs contain no error line since the deployment, and root SSH remains enabled
  with effective `permitrootlogin yes`.

Rollback and evidence material is under `/opt/tally/artifacts/deploy-2b5656a`,
the image tar is `/opt/tally/artifacts/tally-2b5656a.tar`, and the previous
`tally:fabd137` image remains loaded. This application-only update requires no
database restore for rollback.

## Staging update: per-row timer controls, 2026-09-09

Tally staging now runs source commit `fabd137` as `tally:fabd137` (image ID
`sha256:f5eb0bb84dd1dd443922968569e8a61b98df57fee0f69cda90d7517b0b795627`).
This release fixes Toado tickets `t-DVQ2qW` and `t-QANtWe`, both reported
against a timesheet pointed at another person.

The timer context knows one timer, the signed-in person's. The day view's rows
read `elapsed` and called `stop()` from it whatever entry the row was, so on a
teammate's timesheet the Stop button stopped the wrong timer and printed the
wrong elapsed value. `stopTimer` had always accepted a user id and every caller
omitted it; the id is required now, so reintroducing the defect is a type
error. The entry dialog computed its total on blur rather than on input, and
used the presence of that total to decide which of Save and Start timer was the
primary button, so the same gesture saved or started a timer depending on a
field that had not been filled in.

Update evidence:

- The exact pushed source passed 59 test files and 848 tests, TypeScript,
  palette validation, and a complete Linux production Docker build. Requiring
  the stop target was verified by reintroducing the original call and
  confirming it fails to compile.
- The transferred 101,622,272-byte image tar has SHA-256
  `db37ac9a9c2f755a5ef23e48d7b356bc73fd82e7ee6f6e69f9199b821772e1a1`. The
  server verified its exact size and hash before loading it, and the loaded
  image ID matched the local build.
- Preflight recorded 17 containers, all with zero restarts and no OOM events,
  75 GB free disk, 2.7 GB available memory, and a 0.28 load average. Public
  listeners were limited to 22, 80 and 443, with port 53 on loopback only.
- An isolated, unproxied candidate container reached healthy state and returned
  200 from liveness and database readiness, kept every live security and
  resource control, published no host port, carried no production network
  alias, and was removed before the live update.
- There were no schema or infrastructure changes. The isolated migration run
  left all 10 Drizzle and five manual migrations unchanged.
- The immediate pre-update dump is
  `/var/backups/tally/tally-20260909T202124Z.dump`, SHA-256
  `a35b49adc942077e58ca6420d001f2911ddf1774618a7a2d44bb7bb5c112afc5`.
- The post-update dump is
  `/var/backups/tally/tally-20260909T202401Z.dump`, SHA-256
  `0f5f0a04eb58d67c35b8ce128d9bce54eae87f173bdd090d455665d455c876f4`.
- Both 2,991,825-byte dumps passed 329-line catalog checks and complete
  owner-preserving scratch restores. Each restored copy matched 58 users, 365
  projects, [private record count] active time entries, two running timers, 10 Drizzle
  migrations, five manual migrations, and the `tally_staging` owner. Both
  scratch databases were removed and confirmed gone.
- The environment file changed by exactly one line. Normalizing `TALLY_IMAGE=`
  in the old and candidate files produced identical SHA-256 values
  (`23f3c489d254d4831fbc68727db0bc8a0879af8e22e04544565a0e980da086e8`).
- Web and MCP were replaced separately with `--no-deps`, web proven healthy on
  the new image while MCP still ran `tally:e798939`. Both now run the exact
  local image ID, are healthy, and retain a read-only root filesystem, no host
  ports, their existing limits, zero restarts and zero OOM events.
- External liveness, readiness and both OAuth discovery documents return 200.
  MCP GET returns 405 and an unauthenticated POST returns 401 with its
  protected-resource challenge. All five security headers remain present, and
  the new release's strings appear in the running container's server and client
  bundles.
- `/opt/tally/compose.yml` and `/opt/Caddyfile` retained their pre-deploy
  hashes, the host and container Caddyfiles match, and Caddy was not reloaded.
  A full container diff against the pre-deploy baseline showed the two Tally
  lines changed and nothing else: all 15 unrelated containers kept the same
  image, image ID, restart count and OOM state, no container is unhealthy, and
  public listeners did not change.
- All four Tally timers remain active. A manual mail run succeeded with
  `--no-reminders`, reporting zero sent, zero queued and zero in flight. Web
  and MCP logs contain no error line since the deployment. Root SSH remains
  enabled with effective `permitrootlogin yes`.

Rollback and evidence material is under `/opt/tally/artifacts/deploy-fabd137`,
the image tar is `/opt/tally/artifacts/tally-fabd137.tar`, and the previous
`tally:e798939` image remains loaded. This application-only update requires no
database restore for rollback.

## Staging update: timer clock authority and the Toado batch, 2026-09-08

Tally staging now runs source commit `e798939` as `tally:e798939` (image ID
`sha256:f3a56664534cf110b2adcc730c27656d1c86ff2dd918ae5a26bb33f96497fdcb`).
This release carries every fix made on 7 and 8 September: Toado tickets
`t-qXAssj`, `t-4Sct76`, `t-E-CsIL`, `t-XqXK3W`, `t-I856MO`, `t-wjV2jO`,
`t-lCxUn5`, `t-ZbqtuF`, `t-Fg-4v7`, `t-iqTVyw` and `t-ox1U_u`.

The defect worth recording is the timer one. The quick timer sent `started_at`
from the person's own browser while `stopRunning` writes `ended_at` from the
server, and the database checks that the end is not before the start. A client
clock running ahead therefore produced entries that could not be stopped until
real time caught up with the skew, so short timers failed and long ones
succeeded. Because starting any timer stops the running one first, a single
unstoppable entry then made every later play button fail as well, and none of
it was visible: the timer mutations had no error handler, so a rejected write
surfaced only as an uncaught promise rejection in the console. The server names
both ends of the interval now, refuses a start in the future, and ends an entry
no earlier than it started.

Update evidence:

- The exact pushed source passed 59 test files and 846 tests, TypeScript,
  palette validation, and a complete Linux production Docker build. Both timer
  guarantees are mutation-tested: reverting either one fails the test written
  for it.
- The transferred 101,621,248-byte image tar has SHA-256
  `20d0320a3cf3b81d5369336ef064a6b4f7227e5e013c0112c870931b3478c638`. The
  server verified its exact size and hash before loading it, and the loaded
  image ID matched the local build exactly.
- Preflight recorded 17 containers, all with zero restarts and no OOM events,
  75 GB free disk, 2.5 GB available memory, and a 0.05 load average. Public
  listeners were limited to 22, 80 and 443, with port 53 on loopback only.
- An isolated, unproxied candidate container reached healthy state and returned
  200 from liveness and database readiness. It retained the read-only root
  filesystem, dropped capabilities, `no-new-privileges`, the 768 MB memory
  limit and the 128 PID limit, published no host port, carried no production
  network alias, and was removed before the live update.
- There were no schema or infrastructure changes. The isolated migration run
  left all 10 Drizzle and five manual migrations unchanged.
- The immediate pre-update dump is
  `/var/backups/tally/tally-20260908T170256Z.dump`, SHA-256
  `8c9ceaa7b349b842f584e1e92717ad7119bb299f38c67d85cb01f27e1b9b2b7e`.
- The post-update dump is
  `/var/backups/tally/tally-20260908T170915Z.dump`, SHA-256
  `88884145c50fb90f85c1ea540deedcae45ab88a2b40406d30dd7b991c1c76ba2`.
- Both 2,985,203-byte dumps passed 329-line catalog checks and complete
  owner-preserving scratch restores. Each restored copy matched 58 users, 364
  projects, [private record count] active time entries, two running timers, 10 Drizzle
  migrations, five manual migrations, and the `tally_staging` owner. Both exact
  scratch databases were removed and confirmed gone.
- The environment file changed by exactly one line. Normalizing `TALLY_IMAGE=`
  in the old and candidate files produced identical SHA-256 values
  (`23f3c489d254d4831fbc68727db0bc8a0879af8e22e04544565a0e980da086e8`), proving
  no secret or other setting moved. Both files were mode 0600 with seven lines.
- Web and MCP were replaced separately with `--no-deps`. Web was proven healthy
  on the new image, internally and externally, while MCP was still running
  `tally:833f65f`. Both now run the exact local image ID, are healthy, and
  retain a read-only root filesystem, no host ports, their existing limits,
  zero restarts and zero OOM events.
- External liveness, readiness, and both OAuth discovery documents return 200.
  MCP GET returns 405 internally and externally, and an unauthenticated POST
  returns 401 with its protected-resource challenge. All five security headers
  remain present.
- The release is confirmed to be the code actually serving: strings introduced
  by this batch appear in both the server and client bundles inside the running
  container, including the timer failure message, the sign-out wording, the
  QuickBooks button, and the twelve-hour warning.
- `/opt/tally/compose.yml` retained hash
  `6c4898a9407c0bb5c02a2cdbb3d726223ff8261d835591b5805006d0092c1d21` and
  `/opt/Caddyfile` retained `d897dfdaefb943dba2cce2837f23310f88129ccdba0f8be155f4f784b85824ce`,
  matching the container's copy. Caddy was not reloaded. A full container diff
  against the pre-deploy baseline showed the two Tally lines changed and
  nothing else: all 15 unrelated containers kept the same image, image ID,
  restart count and OOM state, and no container is unhealthy. Public listeners
  did not change.
- All four Tally timers remain active. A manual mail run succeeded with
  `--no-reminders`, reporting zero sent, zero queued and zero in flight. Two
  messages remain permanently exhausted from before a transport existed, which
  predates this release. Recent web and MCP logs contain no error. Root SSH
  remains enabled with effective `permitrootlogin yes`.

Rollback and evidence material is under `/opt/tally/artifacts/deploy-e798939`,
the image tar is `/opt/tally/artifacts/tally-e798939.tar`, and the previous
`tally:833f65f` image remains loaded. This application-only update requires no
database restore for rollback.

## Staging update: timesheet duration correction, 2026-08-26

Tally staging now runs source commit `833f65f` as `tally:833f65f` (image ID
`sha256:ca9f6de07ba99dbb973ccb50b1d94c982efb385cc78af541ae87f33adeab9564`).
This release fixes Toado ticket `t-nUUknJ`. A long-lived timesheet tab now
refreshes "today" in the selected person's IANA timezone, and an unrelated
entry edit no longer rewrites unchanged start and end timestamps from a stale
calendar day. Timer fallback dates and the calendar's current-time marker use
the same owner timezone.

Update evidence:

- The exact pushed source passed 56 test files and 813 tests, TypeScript,
  repository hygiene, palette validation, and a complete Linux production
  Docker build. Regression coverage includes the reported 8:37am to 9:15am
  span, notes-only edits to a running entry, Cancun midnight, and a New York
  daylight-saving transition.
- The transferred 101,596,160-byte image tar has SHA-256
  `2b09690af53e38c42c35ebc4cd719450b21559549b2da519facddadda1526cca`.
  The server verified its exact size and hash before loading it.
- An isolated, unproxied candidate container reached healthy state and
  returned 200 from liveness and database readiness. It retained the live
  security and resource controls, published no host port, had no production
  network alias, and was removed before the live update.
- There were no schema or infrastructure changes. The isolated migration run
  left all 10 Drizzle and five manual migrations unchanged.
- The immediate pre-update dump is
  `/var/backups/tally/tally-20260826T144706Z.dump`, SHA-256
  `f99325549314a781c04aebdadab26f128a6f72c0fc012f62b52a2b5f91935ba7`.
- The post-update dump is
  `/var/backups/tally/tally-20260826T145134Z.dump`, SHA-256
  `a998a958b6eddf2fb14deef6579b388726969dad904775ba92626e68ef3e96e3`.
- Both 2,977,270-byte dumps passed 329-line catalog checks and complete
  owner-preserving scratch restores. Each restored copy matched 57 users, 364
  projects, [private record count] active time entries, zero running timers, 10 Drizzle
  migrations, five manual migrations, and the `tally_staging` owner. Both
  exact scratch databases were removed.
- Web and MCP were replaced separately with `--no-deps`. Both run the exact
  local image, are healthy, and retain a read-only root filesystem, no host
  ports, their existing limits, zero restarts, and zero OOM events.
- External liveness, readiness, and both OAuth discovery documents return
  200. MCP GET returns 405, and an unauthenticated MCP request returns 401 with
  its protected-resource challenge. Security headers remain present.
- A fresh signed-in browser load identified Wednesday, August 26 as Today in
  the account timezone. The affected August 25 entry renders 8:37am to 9:15am
  as 0.63 hours, neither inflated value appears, and the application console
  is clean. The user's existing tab and open editor were not changed.
- `/opt/tally/compose.yml` and the host and container Caddyfiles retained their
  pre-deploy hashes. Caddy was not reloaded. PostgreSQL, Redis, Caddy, and all
  15 unrelated containers retained the same image, image ID, restart count,
  OOM state, health state, and host-port exposure. Public listeners remain
  limited to ports 22, 80, and 443.
- All four Tally timers remain active. The naturally scheduled 14:50 UTC mail
  run succeeded with `--no-reminders`; queued and in-flight mail remain at
  zero. Root SSH remains enabled with effective `permitrootlogin yes`.

Rollback and evidence material is under
`/opt/tally/artifacts/deploy-833f65f`, the image tar is
`/opt/tally/artifacts/tally-833f65f.tar`, and the previous `tally:f46d506`
image remains loaded. This application-only update requires no database
restore for rollback.

## Staging update: worldwide timezone picker, 2026-08-26

Tally staging now runs `tally:f46d506` (image ID
`sha256:43ce79bffeceac73a9b1ad44c036d075a9ec26b02902f2dd5ef125a1bec15e23`).
This release replaces the person timezone text field with a searchable
worldwide IANA timezone picker. It keeps regional identifiers, displays the
current UTC offset, and identifies zones whose offset changes during the
current year.

Update evidence:

- The exact pushed source passed 55 test files and 807 tests, TypeScript,
  palette validation, and a complete Linux production Docker build.
- The transferred 101,593,088-byte image tar has SHA-256
  `8893136df08f53da6632bf791ea8729bc5f243acf51497843210ac8b92b99910`.
  The server verified both values before loading it.
- An isolated, unproxied candidate container reached healthy state and
  returned 200 from liveness and database readiness before live configuration
  changed. It had the live security and resource controls, no host port, and
  no production network alias.
- There were no schema or infrastructure changes. The migration runner found
  all 10 Drizzle and five manual migrations already applied, with permission
  profiles up to date.
- The immediate pre-update dump is
  `/var/backups/tally/tally-20260826T003255Z.dump`, SHA-256
  `12fade980220a0a8631c613807097532b5608e78435babf4d573c706ca65405d`.
- The post-update dump is
  `/var/backups/tally/tally-20260826T003713Z.dump`, SHA-256
  `d63c1ecde84488792a3e6f9e6f35f360f25f1488d92f6d17fbd5983d70fe8c90`.
- Both 2,975,613-byte dumps passed catalog verification and full
  owner-preserving scratch restores. Each restored copy matched 57 users, 364
  projects, [private record count] active time entries, zero running timers, 10 Drizzle
  migrations, five manual migrations, and the `tally_staging` owner. Both
  scratch databases were removed.
- Web and MCP were replaced separately with `--no-deps`. Each became healthy
  before the next service moved. Both report zero restarts, zero OOM events, a
  read-only root filesystem, no host ports, the existing resource limits, and
  the exact new image.
- External liveness, readiness, and both OAuth discovery documents return 200.
  MCP GET returns 405, and an unauthenticated MCP request returns 401 with its
  protected-resource challenge. Security headers remain present.
- A signed-in, read-only browser smoke verified the requested person editor.
  The picker exposed 419 timezones, showed Cancun at `UTC-05:00` with no 2026
  offset change, and showed New York at `UTC-04:00` with a 2026 offset change.
  The page was closed without selecting or saving anything.
- `/opt/tally/compose.yml` and the host and container Caddyfiles retained their
  pre-deploy hashes. Caddy was not reloaded. PostgreSQL, Redis, Caddy, and all
  15 unrelated containers retained the same image, restart count, OOM state,
  health state, and host-port exposure. Public listeners remain limited to
  ports 22, 80, and 443.
- All four Tally timers remain active. The naturally scheduled 00:40 UTC mail
  run succeeded against the new release with `--no-reminders`; queued and
  in-flight mail remain at zero. Root SSH remains enabled with effective
  `permitrootlogin yes`.

Rollback and evidence material is under
`/opt/tally/artifacts/deploy-f46d506`, the image tar is
`/opt/tally/artifacts/tally-f46d506.tar`, and the previous `tally:0d5aa95`
image remains loaded. This application-only update requires no database
restore for rollback.

## Staging update: neutral person-page hierarchy, 2026-08-24

Tally staging now runs `tally:0d5aa95` (image ID
`sha256:09aca09ac87906ef95237a1563b618803c2f5a36d3ab9fff88e2257e646cf565`).
This release restores the neutral styling for View Timesheet and Send Invite,
keeps the person-page actions in one coherent hierarchy, and removes the
one-off colored icon chips from the person-page KPI area.

Update evidence:

- The source passed 54 test files and 803 tests, TypeScript, palette
  validation, a complete Linux production Docker build, and a constrained
  local image liveness test.
- The transferred 101,585,920-byte image tar has SHA-256
  `d1751fb591ced03fb4c11ad0fd2a30c4584adf28733151ecc211e1dfea98db56`.
  The server verified both values before loading it.
- An isolated, unproxied candidate container reached healthy state and
  returned 200 from liveness and database readiness before live configuration
  changed.
- There were no schema or infrastructure changes. The migration runner found
  all 10 Drizzle and five manual migrations already applied, with permission
  profiles up to date.
- The immediate pre-update dump is
  `/var/backups/tally/tally-20260824T221418Z.dump`, SHA-256
  `9df2e589d3081b76365abb07531d32b29b89c127ac04f7824ddca64814827af2`.
- The post-update dump is
  `/var/backups/tally/tally-20260824T221915Z.dump`, SHA-256
  `193119fec18d2266dde997e31651c92177304af496dea195d455222a4548bc63`.
- Both 2,971,067-byte dumps passed catalog verification and full
  owner-preserving scratch restores. Each restored copy matched 57 users, 364
  projects, [private record count] active time entries, zero running timers, 10 Drizzle
  migrations, five manual migrations, and the `tally_staging` owner. Both
  scratch databases were removed.
- Web and MCP were replaced separately. Each became healthy before the next
  service moved. Both report zero restarts, zero OOM events, a read-only root
  filesystem, no host ports, the existing resource limits, and the new image.
- External liveness, readiness, and both OAuth discovery documents return 200.
  MCP GET returns 405, and an unauthenticated MCP request returns 401 with its
  authentication challenge. Security headers remain present.
- A signed-in, read-only browser smoke verified Sample colleague's deployed person
  page. View Timesheet, Send Invite, and Edit Person share the restored neutral
  action style, and the KPI area no longer has the colored icon chips. No form
  was submitted and no data changed.
- `/opt/tally/compose.yml` and the host and container Caddyfiles retained their
  pre-deploy hashes. Caddy was not reloaded. PostgreSQL, Redis, Caddy, and all
  15 unrelated containers retained the same image, restart count, OOM state,
  and health state. Public listeners remain limited to ports 22, 80, and 443.
- All four Tally timers remain active and staging mail retains the
  `--no-reminders` override. The 22:20 UTC scheduled mail run completed against
  the new release with zero queued or in-flight messages. The two previously
  exhausted mail records remain failed and are not retried. Root SSH remains
  enabled with effective `permitrootlogin yes`.

Rollback and evidence material is under
`/opt/tally/artifacts/deploy-0d5aa95`, the image tar is
`/opt/tally/artifacts/tally-0d5aa95.tar`, and the previous `tally:4d2d928`
image remains loaded. This application-only update requires no database
restore for rollback.

## Staging update: timer and usability batch, 2026-08-24

Tally staging now runs `tally:4d2d928` (image ID
`sha256:9f39dbffc6ee26af146e51666ef7411c0569b385fa0d7e7ec9ca859a090c5301`).
The image contains the running-timer correction in `cf100f9` and the first
staging usability batch in `4d2d928`.

Update evidence:

- The source passed 54 test files and 803 tests, TypeScript, palette
  validation, focused repository hygiene checks, a complete Linux production
  Docker build, and a constrained local image liveness test.
- The transferred 101,586,944-byte image tar has SHA-256
  `da49c53650cda6f308740764ae919b79525bdb630358dc8448130de19245246e`.
  The server verified both values before loading it.
- An isolated, unproxied candidate container reached healthy state and returned
  200 from both liveness and database readiness before the live image tag was
  changed.
- There were no schema or infrastructure changes. The migration runner found
  all 10 Drizzle migrations and all five manual migrations already applied,
  with permission profiles up to date.
- The immediate pre-update dump is
  `/var/backups/tally/tally-20260824T214247Z.dump`, SHA-256
  `0095ff7f58cdeb08c6c10ad95dde889e9fd837f4b4e89d1d0795b740f80a9cb0`.
- The post-update dump is
  `/var/backups/tally/tally-20260824T214807Z.dump`, SHA-256
  `29a981ddbbc72a8409ec7fe0fb6d4cb8bbae7370abd70235ef2b3683db9316f7`.
- Both 2,971,064-byte dumps passed catalog verification and full
  owner-preserving scratch restores. Each restored copy matched 57 users, 364
  projects, [private record count] active time entries, zero running timers, 10 Drizzle
  migrations, and five manual migrations. Each scratch database was removed.
- Web and MCP were replaced separately. Each became healthy before the next
  container moved. Both report zero restarts, zero OOM events, a read-only root
  filesystem, no host ports, the existing resource limits, and the new image.
- External liveness, readiness, and both OAuth discovery documents return 200.
  MCP GET returns 405, and an unauthenticated MCP request returns 401 with the
  expected protected-resource challenge.
- A signed-in, read-only browser smoke test verified the populated timesheet's
  separated New Entry and date controls, start and stop indicators, the report
  metric icons and Billable Share help control, and the differentiated person
  actions. No form was submitted and no data was changed.
- `/opt/tally/compose.yml` and both host and container Caddyfiles retained their
  pre-deploy hashes. Caddy was not reloaded. PostgreSQL, Redis, Caddy, and every
  unrelated application retained the same image, restart count, and OOM state.
- All four Tally timers remain active and staging mail retains the
  `--no-reminders` override. The 21:50 UTC scheduled mail run completed against
  the new image with zero queued or in-flight messages. Root SSH remains
  enabled with effective `permitrootlogin yes`.

Rollback material is under `/opt/tally/artifacts/deploy-4d2d928`, the image tar
is `/opt/tally/artifacts/tally-4d2d928.tar`, and the previous
`tally:46ae1b4` image remains loaded. This application-only update requires no
database restore for rollback.

## Staging update: TALLY-78, 2026-08-24

Tally staging now runs `tally:46ae1b4` (image ID
`sha256:9847a8f94a94af55cdea4c68381fefc9d2a4d7d74b8ea6d8d7016d71fd574beb`).
The application changes are commit `91eeb53`; `46ae1b4` adds the Atlassian
sync record and is the exact pushed `main` revision used for the immutable
image tag.

Update evidence:

- The source passed 53 test files and 796 tests, TypeScript, palette and
  repository hygiene checks, and a complete Linux production Docker build.
- The transferred 101,577,728-byte image tar has SHA-256
  `ef9a759b251555e776c3ec8a824abf86be590c6b23b40f05903b0f81de6c0e9a`.
  The server verified both its size and hash before loading it.
- There were no schema changes. The isolated migration runner reported all
  manual migrations already applied, permission profiles up to date, and 10
  Drizzle migrations.
- The immediate pre-update dump is
  `/var/backups/tally/tally-20260824T054040Z.dump`, SHA-256
  `aadff44d83911b4b7c359be96cd3e5c31c7ec57efbd03a8d3e117254d519a257`.
- The post-update dump is
  `/var/backups/tally/tally-20260824T055028Z.dump`, SHA-256
  `6e4c9c43c15903e7c40e0486c634aa29851be71fb50d285f9ec016dd98c37507`.
- Both new dumps passed catalog verification and a full owner-preserving
  scratch restore. Each restored copy matched 57 users, 364 projects, [private record count]
  active time entries, zero running timers, and 10 migrations. Each uniquely
  named scratch database was then removed.
- Web and MCP were replaced separately. Each became healthy before the next
  container moved. Both now report zero restarts, zero OOM events, a read-only
  root filesystem, the existing resource limits, and the new immutable image.
- External liveness and readiness return 200. Both OAuth discovery documents
  return 200, MCP GET returns 405, and an unauthenticated MCP request returns
  401 with the correct protected-resource challenge. All security headers are
  present.
- A signed-in, read-only browser smoke test verified the TALLY-78 project
  money formatting, Common-task explanation, rates editor, avatar centering,
  access-tag alignment, and dark-theme switch contrast. No form was saved.
- Caddy was not changed or reloaded. Its host and container configuration
  hashes remain identical. PostgreSQL, Redis, Caddy, and every unrelated
  application stayed running with zero restarts and zero OOM events. Public
  listeners remain limited to ports 22, 80, and 443.
- The 05:50 UTC scheduled mail job completed against the updated deployment
  with zero queued or in-flight messages. All four timers remain active.
- Root SSH remains enabled with effective `permitrootlogin yes`.

Rollback material is under `/opt/tally/artifacts/deploy-46ae1b4`, the new image
tar is `/opt/tally/artifacts/tally-46ae1b4.tar`, and the previous
`tally:8f476e5` image remains loaded. A rollback changes only Tally's image tag
and recreates the Tally web and MCP containers.

## Staging deployment record: 2026-08-24

Tally staging is live at `https://tally.jhmediagroup.com` on image
`tally:8f476e5` (image ID
`sha256:8a3cbc37aae84d60049d74462373510ec572faa3b202f249f88ed9998985dbce`).
The deployed source passed 52 test files and 784 tests, TypeScript, repository
hygiene, and a production Next build before transfer. The image transfer and
every candidate file were checked by SHA-256 before use.

Deployment evidence:

- The owner confirmed DigitalOcean backups and a completed droplet snapshot
  before deployment.
- The immediate pre-deployment custom-format dump is
  `/var/backups/tally/tally-pre-b5ca348-20260824T033702Z.dump`. Its SHA-256 is
  `1ab23a89b1246f073cce04cca8db809ff31235e1ce4ab5f3dfb754e33f5ca6aa`.
- The post-deployment backup service produced
  `/var/backups/tally/tally-20260824T040015Z.dump`. Its SHA-256 is
  `c3241c0118187bf466cfcb02be5cad2807ee45703886b57db9fe13c89cc83fee`.
- Both dumps passed `pg_restore --list`. Each was restored as the
  `tally_staging` owner into a uniquely named scratch database, reconciled,
  and removed. The post-deployment restore matched 57 users, 364 projects,
  [private record count] active time entries, zero running timers, and 10 migrations.
- `tally-staging-web` and `tally-staging-mcp` run the same immutable image.
  Both are healthy, unexposed on the host, read-only, capability-free,
  protected by `no-new-privileges`, resource-limited, and configured for
  three 10 MiB Docker log files.
- External checks return `200` for readiness and OAuth discovery, `405` for
  MCP liveness, and `401` plus the protected-resource metadata challenge for
  an unauthenticated MCP request.
- Caddy was reloaded without a restart. PostgreSQL, Redis, Caddy, and every
  unrelated application stayed running with zero restarts and zero OOM events.
- The mail, recurring, sweep, and backup systemd timers are enabled. Manual
  runs passed, and the first automatic mail run completed successfully at
  04:05:16 UTC with an empty queue.
- Staging has `/etc/systemd/system/tally-mail.service.d/staging-no-reminders.conf`.
  It adds `--no-reminders`, so invitation and password-reset mail can drain
  without automatic dunning mail reaching imported client contacts. Remove
  this override only during the controlled production cutover.
- No external failure webhook is configured. Failed jobs write a priority
  `err` journal entry and the notifier exits successfully after noting that no
  external alert was sent.
- Root SSH remains enabled. Effective `sshd` configuration reported
  `permitrootlogin yes` after deployment. Only ports 22, 80, and 443 listen
  publicly.

Rollback material remains under `/opt/tally/artifacts`, including the prior
image tar, environment, Compose file, server Caddyfile, and both transferred
candidate images. Do not prune these until staging has completed its test
period and a separate cutover rollback set exists.

The Caddyfile is mounted as a single file. Replacing `/opt/Caddyfile` changes
the host inode while the running container continues seeing the mounted inode.
For a reload without restarting Caddy, update the complete validated file at
both `/opt/Caddyfile` and `/etc/caddy/Caddyfile` inside `opt-caddy-1`, verify
their hashes match, validate, and then reload. The deployment rollback tested
this behavior before the final successful reload.

## What Redis means for Tally

Tally does not store time entries, running timers, or edits in Redis. Those are
written transactionally to PostgreSQL. Redis is currently only an optional
rate-limit store. Three to eight people logging time simultaneously is a small
PostgreSQL workload and does not require Redis for correctness or durability.

The initial deployment will therefore omit Redis. Authentication rate limits
will use Tally's single-process in-memory implementation. Those counters reset
when the web container restarts, but no time or invoice data is lost. Redis can
be added later if persistent rate-limit counters become important.

## Agreed order of work

1. Deploy Tally with its own PostgreSQL role and database.
2. Apply container resource, privilege, and log limits to Tally from its first
   start.
3. Configure server-wide Docker log rotation this week.
4. Verify the server backup can restore PostgreSQL this week.
5. Address broader network segmentation and SSH restructuring separately.

Only item 2's Tally-specific controls are part of today's deployment. The
server-wide maintenance work below is planned for this week, not today.

## Launch gates found by the final preflight

Do not modify the droplet or begin deployment until the DigitalOcean snapshot
reports **Completed/Available**. DigitalOcean backups have now been enabled and
a manual snapshot was started on 2026-08-17. The application-consistent backup
made before that snapshot is at
`/opt/shared/backups/pre-tally-deploy-20260817T045958Z` and passed its checksum
and archive checks. These safeguards supplement one another; the weekly restore
test below is still required.

The production database will be new. **Do not restore or clone the local Tally
database.** It contains the real Harvest history, but it also contains eleven
accounts with the published development password and thirteen development
sessions. Instead, migrate an empty production database and import the approved
Harvest CSV source without `--dev-password`. A new production `SESSION_SECRET`
also ensures that no local session can work in production.

Four gates remain before the application can be made public:

1. Add the Harvest import and reconciliation commands to a production-capable
   one-off image or other reviewed deployment artifact. They are TypeScript
   development commands today and are not present in the runtime image.
2. Choose the historical billing cutoff for `--billed-before YYYY-MM-DD`, or
   explicitly accept the literal Harvest `Invoiced?` mapping. Without a cutoff,
   the Uninvoiced screen includes approximately $[private total removed] of historical work,
   much of which was billed outside Harvest. Import and reconciliation must use
   the same choice.
3. Establish the first owner's credential without using
   `tally-dev-password`. The preferred path is a real SendGrid-backed password
   reset for the imported owner. If email is not ready, build and review a
   single-use owner bootstrap command that reads the password without placing it
   in command-line arguments, logs, the image, or shell history. Do not edit a
   password hash manually in PostgreSQL.
4. Decide the cutover source and time. If people continue entering time in
   Harvest after the 2026-08-14 export, take a fresh complete export during a
   short Harvest write freeze and run a clean import into the still-private
   production database. CSV exports contain no Harvest IDs, so this is a full
   re-import, not an API delta.

The repository changes must also be committed, and the tested commit SHA must
be the image tag recorded in deployment metadata, before that image is moved to
production.

## Approved Harvest source and production import

The currently reviewed source is
`C:\Users\jason\Downloads\harvest exports`. It contains all seven CSVs expected
by the importer. The prior reconciliation against these files passed every
The available reconciliation checks passed; keep the account totals in private operational records. The separate invoice pack contains 2,136 PDFs. Those
PDFs are archive material; the current importer does not turn them into Tally
invoice records.

Pin the seven CSV SHA-256 values in the deployment record before transfer:

| File | SHA-256 |
| --- | --- |
| `harvest_client_list.csv` | `D21FACBAA3693D472656FB51C3AFE5ADCFDDEB9248A827C91AA5B1F7E1B9EC8F` |
| `harvest_contact_list.csv` | `21F613686A66B9474556217E9A4D6BFFBB0B70593415B4F72A121D62434374BF` |
| `harvest_expense_report.csv` | `1C55DBEF9D04257F4AD438F704DFE397C836A90F936A212B6E230994DDCB7D92` |
| `harvest_people_list.csv` | `80E537C4C20F13B5C39B42DF451597F1AA92AA0A78693E5B01AF02AF5516F566` |
| `harvest_project_list.csv` | `6D9EE350AB9FF7F5B22D9E69F6A984827D332EFE22ADDC7F60200F0D4BEA3567` |
| `harvest_task_list.csv` | `B7DF356BE7EED6D3FE018AC0A38B3B06219F19AED49EA1B95AAB1C9BA787D982` |
| `harvest_time_report.csv` | `673E6D5907787E127B77620AD030FBC4CFB834EDB965F755F35E8C0305D47913` |

Production import order:

1. Create the restricted role and empty database, then run migrations.
2. Keep the web service and Caddy route offline.
3. Transfer only the approved export through a root-readable staging directory;
   verify all seven hashes before use.
4. Run the import in a one-off container on the private Docker network, without
   `--dev-password`, and with the agreed billing cutoff if one is chosen.
5. Run reconciliation independently with the same source and cutoff. Save the
   report outside the container and require every runnable check to pass.
6. Confirm exactly one owner, zero password hashes, zero sessions, zero auth
   tokens, and no queued outbound mail immediately after import.
7. Take a custom-format `pg_dump` of the new Tally database before credential
   bootstrap or public traffic, checksum it, and verify `pg_restore --list`.
8. Bootstrap the owner through the approved path, verify sign-in privately,
   invite other active users, and only then enable Caddy.
9. Remove the plaintext CSV staging copy after the verified database dump and
   deployment record exist. Retain the original export in its controlled source
   location and do not place it in Git or the application image.

## Deployment architecture

Tally will live in its own directory and Compose project:

```text
/opt/tally/
|-- compose.yml
|-- .env
`-- deployment metadata and scripts
```

The Compose project contains one long-running service, `tally-web`. It joins
the existing external `opt_default` network so Caddy and the shared PostgreSQL
container can reach it. It publishes no host port. Caddy is the only public
path to the application.

Tally receives:

- A dedicated `tally` PostgreSQL database.
- A dedicated non-superuser login/owner with no role-creation or
  database-creation privilege.
- An immutable application image tagged with the Git commit SHA.
- A mode-600 production environment file.
- `NODE_ENV=production`.
- `APP_URL=https://tally.jhmediagroup.com`.
- `TRUST_PROXY=1` because Caddy is the only public route to the container.
- A unique network alias such as `tally-web`.
- No `REDIS_URL` initially.

## Tally container controls applied at launch

These controls are item 10 of the server review and are approved for today's
Tally deployment:

- Run as the image's non-root `node` user.
- Publish no host ports.
- Use a read-only root filesystem.
- Provide temporary storage only through a small `/tmp` tmpfs.
- Drop all Linux capabilities.
- Set `no-new-privileges:true`.
- Limit memory to approximately 768 MiB.
- Limit CPU to approximately one core.
- Limit processes to approximately 128 PIDs.
- Rotate Tally's Docker logs at 10 MiB with three retained files.
- Use the image's liveness health check.
- Use `restart: unless-stopped`.

The scheduled mail, recurring-invoice, and housekeeping commands run as
short-lived containers from the exact same image tag as the web service.
`ops/systemd/` contains the reviewed units. `ops/backup-postgres.sh` creates a
custom-format Tally-only dump, verifies its catalog before publishing it, and
retains 14 daily files under `/var/backups/tally`. DigitalOcean server backups
then retain those files outside the live droplet disk.

Create `/opt/tally/ops/alert.env` from `ops/alert.env.example`, set only
`TALLY_FAILURE_WEBHOOK_URL`, and protect it with mode `0600`. The notifier
refuses non-HTTPS, loopback, link-local, and private-network destinations. If
no webhook is configured, it records the original failure locally without
creating a second failed unit.

## Deployment procedure

1. Confirm the DNS A record resolves `tally.jhmediagroup.com` to
   `165.245.130.130`.
2. Build, test, and tag the production image locally. Do not build it on the
   two-core production server during normal activity.
3. Transfer the immutable image through a registry or `docker save` and
   `docker load`.
4. Create `/opt/tally` and its mode-600 `.env` file.
5. Create the dedicated PostgreSQL role and database without changing existing
   application roles or databases.
6. Run `node ops/migrate.mjs` in a one-off container.
7. Complete the private Harvest import, independent reconciliation, clean-state
   checks, and pre-traffic Tally database dump described above.
8. Start `tally-web` without publishing a host port.
9. Check `/api/health/live` and `/api/health/ready` from the Docker network.
10. Add the following site to `/opt/Caddyfile`:

   ```caddy
   tally.jhmediagroup.com {
       encode zstd gzip
       handle /mcp {
           reverse_proxy tally-staging-mcp:3201
       }
       handle {
           reverse_proxy tally-staging-web:3000
       }
   }
   ```

11. Validate the Caddy configuration before reloading it.
12. Reload Caddy without restarting the other containers.
13. Verify HTTPS, security headers, forwarded client addresses, sign-in, and
    readiness externally.
14. Install isolated systemd services and timers for:
    - queued mail every five minutes;
    - recurring invoices daily;
    - expired-session and idempotency housekeeping nightly;
    - a verified Tally-only PostgreSQL dump nightly.
15. Run the backup service once, restore that dump into a scratch database, and
    compare the migration level and table counts before dropping the scratch
    database.
16. Perform a controlled Tally-only restart and rollback test.

## Rollback

Keep the previous application image tag. If readiness fails:

1. Stop only the Tally container.
2. Restore the previous image tag.
3. Start Tally and poll readiness.
4. Do not restart shared PostgreSQL, Caddy, Redis, or unrelated projects.

Migrations must remain backward-compatible with the previous image. Destructive
schema changes ship separately after older application versions no longer need
the removed structure.

## Shared-server maintenance planned for this week

### 1. Configure server-wide Docker log rotation

All current containers use unlimited `json-file` logging. One Twenty worker log
is already approximately 3.5 GB. Configure a daemon default such as 20 MiB with
five retained files, then recreate existing containers in controlled groups so
the setting takes effect. Do not restart every project at once.

### 2. Verify PostgreSQL recovery

Confirm that server-level backups capture PostgreSQL consistently. Perform and
document an actual restore into a disposable environment. Verify that the
restored databases start and contain expected row counts. The presence of the
PostgreSQL volume in a snapshot is not by itself proof of recovery.

### 3. Replace shared PostgreSQL superuser use

The shared PostgreSQL instance currently has only the `postgres` login role.
Create a separate non-superuser owner/login for each application and migrate
credentials one application at a time. Tally starts with a restricted role and
does not inherit this debt.

### 4. Add resource limits to existing containers

Several existing services have no memory, CPU, or PID ceilings. Measure their
normal peaks first, then apply limits incrementally. Avoid speculative low
limits and avoid changing every service in one maintenance event.

### 5. Review the unused public port 3001 rule

UFW permits TCP port 3001 from anywhere, but no process currently listens on
it. Confirm that no owner still needs it, then remove the rule in a separate
change.

### 6. Keep root SSH access and optionally add a routine deploy identity

Root SSH access must remain enabled. Do not disable it, remove its authorized
keys, or change its authentication path; previous attempts caused severe
recovery problems. Password authentication is already disabled and fail2ban is
active. The existing `deploy` account may be used for routine deployment if
that improves auditability, but it is additive and never replaces root access.
Docker group membership is effectively root and should not be treated as
meaningful privilege separation.

### 7. Add host and service monitoring

Alert on:

- disk use above 80 percent;
- sustained memory pressure or swap growth;
- container restart loops;
- PostgreSQL unavailability;
- Tally readiness failure;
- failed Tally systemd jobs;
- stale or failed backups and restore verification;
- TLS renewal failure.

### 8. Review pending operating-system updates

The server reported 42 upgradeable packages during inspection. Review them and
apply them in a planned maintenance window. Confirm whether a reboot is needed
afterward.

### 9. Segment Docker networks

The existing `opt_default` network connects Caddy, PostgreSQL, Redis, CRM,
Orchestrator, Process Server, Twenty MCP, and parts of IdeaFlow. Plan a later
migration toward proxy networks containing Caddy and each web service, plus
application-specific backend networks. This reduces lateral reach after a
container compromise but is too invasive to combine with the Tally launch.

## Server facts observed during the read-only inspection

- Ubuntu 24.04, 2 vCPU, 7.8 GiB RAM, and 2 GiB swap.
- Approximately 2.5 GiB RAM and 83 GiB disk were available.
- PostgreSQL and Redis publish no host ports.
- Caddy is the only container publishing ports 80 and 443.
- UFW defaults to denying inbound traffic and permits 22, 80, 443, and 3001.
- SSH password authentication is disabled; root key login remains enabled.
- Fail2ban and unattended upgrades are active.
- Shared PostgreSQL allows 100 connections and current use is low enough for
  Tally's maximum pool of 12.
- Server-level backups are reported as managed outside this repository; their
  PostgreSQL restore behavior remains to be verified.

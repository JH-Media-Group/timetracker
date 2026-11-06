# MCP connection verification

TALLY-86 and children TALLY-87 through TALLY-91. Local work on 2026-11-05.
This document distinguishes implementation from deployment and client acceptance.

## Implementation checklist

- [x] Separate introspection quota and preserve throttling errors.
- [x] Route bearer API requests through the real API authenticator.
- [x] Shared discovery scopes, resource/client binding and native callback matching.
- [x] Expired-session consent recovery, account binding and capture isolation.
- [x] URL-first Settings guidance and per-credential scope/expiry/revocation.
- [x] Additive migration preserving existing PAT and legacy OAuth credentials.
- [x] Real HTTP transport regression including more than ten requests.
- [x] Independent Codex and Claude review with material findings resolved.
- [x] Full local suite, typecheck, palette and production Docker build.
- [x] Production-image HTTPS API and MCP transport verification.
- [ ] Production-image browser interaction verification.
- [ ] Actual Claude Code, Claude Desktop and Codex client acceptance.
- [x] Separately authorized deployment and scoped live bearer verification.

## Required scenarios

For OAuth and PAT, initialize, list tools, read projects and current timer, then
make at least 20 sequential reads. Test concurrent users, no browser cookies,
revocation and reconnect, expired credentials, disabled users and permission
changes. Tokens cannot grant consent or mint other tokens. Invalid bearer plus
valid cookie fails. Confirm quotas are separate from sign-in, explicit 429
includes Retry-After, and upstream outages do not become authentication errors.

For OAuth, test fresh registration, signed-in and signed-out consent, stale
cookies, decline, wrong resource/client/redirect/verifier, one-use codes,
concurrent exchange and expired code. Unknown scopes fail closed. A client's
requested financial access is separately labelled; ordinary read never grants it.
Inspect narrow/desktop layouts and keyboard navigation in the production image.
Use fictional local fixtures for writes and verify existing confirmation, audit,
idempotency and undo checks. Production acceptance performs scoped reads only.

Next.js upgrades must repeat the real HTTPS consent and exchange check with an
IP loopback callback and a public or internal non-loopback server hostname.
`skipMiddlewareUrlNormalize: true` preserves the exact callback and opaque
state in `req.url`; `req.nextUrl` still normalizes loopback text. The unit test
emulates Next's compiled flag, so only the rebuilt-image test proves the build
wires that flag correctly.

## Client evidence

| Surface | Status | Required evidence |
| --- | --- | --- |
| Claude Code 2.1.314 | Pending interactive acceptance | Isolated CLI setup succeeded; headless login refused piped stdin because it requires a terminal |
| Claude Desktop | Pending | Version/account eligibility, remote connector, sign-in and actual reads |
| Codex desktop | Pending | Version, MCP settings, authenticate, actual reads |
| Codex CLI 0.162.1 | OAuth login passed locally; actual tool use pending | Isolated configuration, URL only, default registration, no-browser login; fictional consent approved through HTTP |
| Codex IDE | Pending | Version, URL setup/login, actual reads and reconnect |

A client unavailable in the test environment remains pending. A library client
or a successful metadata fetch does not establish actual desktop compatibility.
Do not record tokens, callback codes or business records in this file.

## Official setup references

- [Claude Code MCP](https://code.claude.com/docs/en/mcp)
- [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)

CLI setup uses `claude mcp add --transport http tally <URL>` followed by the
interactive `/mcp` authentication action, or `codex mcp add tally --url <URL>`
and `codex mcp login tally`. Existing explicit Authorization headers must be
removed from the selected connection before switching to OAuth. Keep other
servers and client configurations intact. GUI labels and account access must
be confirmed in the exact installed version during acceptance.

## Local evidence, 2026-11-05

- Full suite: 76 files, 1,068 tests passed. Typecheck and palette checks passed;
  the existing light-palette contrast warnings still require visible labels.
- Independent Codex reviews and five Claude review rounds covered security,
  correctness, maintainability and code quality. Material findings were fixed;
  the final narrow reviews found no remaining material issue.
- Seven deliberate regressions were detected by failing assertions: cookie-only
  middleware, sign-in quota used for introspection, Next callback normalization,
  omitted note clear, missing destination protection, unscoped rollups and legacy
  blank-note undo. Source was restored byte-for-byte after each mutation.
- Linux production image `tally:mcp-review`, image ID
  `sha256:e57a660c8da9abfb308acc244b60ce2e760ecf4c210c82811909ac6ed26fab5b`.
  An isolated PostgreSQL database and local Caddy HTTPS origin used fictional
  fixtures and a process-scoped test CA, with TLS verification enabled.
- Real HTTPS checks passed for discovery/challenge, registration, consent,
  S256 exchange, OAuth and PAT initialization, tool listing, project reads,
  20 consecutive timer reads per credential, three rollup routes and revocation.
  These used the SDK HTTP client and do not establish Claude Desktop acceptance.
- The board fixes have service and transport regressions for note clearing and
  required-note policy, MCP undo, approved/locked/future destination dates,
  owner timezone and override audit, and scoped totals across 60,001 entries.
- Browser-test automation was rejected by automatic approval review with
  `blocked by policy`. The computer-use fallback had no available browser host.
  Rendering, narrow/desktop layouts and keyboard interactions remain unverified.
- This initial local pass preceded the authorized deployment below.

## Deployment evidence, November 5, 2026 (America/Cancun)

Source `98cf2032e96634fd6a421534d715a500099deddc` was committed, fast-forwarded
to main and pushed. Both live services now run `tally:98cf203`, built from a
clean archive of that exact commit. The full 1,068-test suite passed again.

Before rollout, the old image issued OAuth and PAT credentials against its old
schema in an isolated fictional database. After migration, both credentials
passed initialization, listing, projects and 20 timer reads with new web plus
old MCP, then with both new services. New OAuth and PAT flows also passed on
the exact release image, including PKCE exchange and revocation.

The pre- and post-deploy backups passed full owner-preserving scratch restores.
Migration 0010 added one migration record without changing business counts.
The candidate passed readiness before live replacement. Web and MCP were
replaced separately with `--no-deps`. Existing public URL and proxy settings
were already correct; only the environment image tag changed.

Live verification used the existing bearer credential configured in Claude,
without copying it into logs or Git. Initialization, tool listing,
`tally_projects_mine`, 20 consecutive `tally_timer_current` reads and all three
rollup routes passed. No business records were written. This is real HTTPS SDK
verification using that credential, not a claim of interactive Claude use.

The browser host was still unavailable on the deployment turn. Jason authorized
deployment after the pending browser and client acceptance checks were
disclosed. Actual Claude Code/Desktop sign-in and tool use, Codex tool use,
and browser layout/keyboard acceptance remain open. Live browser OAuth consent
was not exercised; OAuth was exercised against the exact local release image.
See DEPLOYMENT-AND-SERVER-HARDENING.md for operational evidence and rollback.

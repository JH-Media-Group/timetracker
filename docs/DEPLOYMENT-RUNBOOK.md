# Tally deployment runbook

Read this file before changing staging or production. Tally shares one
DigitalOcean droplet with several sensitive applications. A Tally release must
never become a server-wide maintenance event.

## Fixed deployment facts

- Host: `root@165.245.130.130`
- Public URL: `https://tally.jhmediagroup.com`
- Compose project: `tally-staging`
- Compose file: `/opt/tally/compose.yml`
- Environment file: `/opt/tally/.env`, mode 0600
- Web container: `tally-staging-web`
- MCP container: `tally-staging-mcp`
- Shared private network: `opt_default`
- Shared PostgreSQL container: `opt-db-1`
- Tally database and owner: `tally_staging`
- Shared proxy: `opt-caddy-1`
- Image convention: `tally:<seven-character-git-sha>`
- Image transfer directory: `/opt/tally/artifacts`
- Database backups: `/var/backups/tally`

The current deployed release and its evidence are recorded at the top of
`docs/DEPLOYMENT-AND-SERVER-HARDENING.md`.

## Safety rules

1. Re-read this runbook and `CLAUDE.md` on every deployment turn.
2. Begin with a fresh read-only inventory. Never trust an earlier session's
   container names, health, ports, image tag, or available capacity.
3. Never print, copy into Git, or include `/opt/tally/.env` contents in command
   output. It contains production credentials.
4. Never run `docker compose down`, `docker system prune`, a global Docker
   restart, or a host reboot as part of a Tally deployment.
5. Never restart PostgreSQL, Redis, Caddy, Docker, or another application for a
   Tally image update.
6. Never reload Caddy for an application-only release. Validate and reload it
   only when the reviewed Caddy configuration itself changes.
7. Never disable root SSH. Verify effective `permitrootlogin yes` after the
   deployment.
8. Build locally. Do not consume the two-core production server with a normal
   application build.
9. Keep the previous image, environment file, Compose file, Caddyfile, and
   verified database dump until the release has completed its test period.
10. Replace web and MCP separately. Prove web health and readiness before
    touching MCP.
11. Use `--no-deps` on live Compose updates so shared or adjacent services are
    never pulled into the operation.
12. When a remote script is sent through standard input, use `docker compose
    run -T`. Without `-T`, the one-off container may consume the remaining
    deployment script from standard input.

## 1. Establish the release

The working tree must be clean, `main` must equal `origin/main`, and the target
must be the exact pushed commit.

```powershell
git status --short --branch
git fetch origin
git rev-parse HEAD
git rev-parse origin/main
git diff --name-status <currently-deployed-sha>..HEAD
```

Stop if the release contains an unexpected migration, Compose, Caddy, systemd,
Dockerfile, or operational-script change. Review those changes as their own
deployment risk rather than treating them as an ordinary image update.

Run the full local verification before building:

```powershell
pnpm test
pnpm typecheck
pnpm validate:palette
docker build --pull --tag tally:<sha> .
```

The Docker build is the production build authority on Windows. A native
`pnpm build` may finish compilation and then fail while creating standalone
symlinks because Windows denies the operation.

## 2. Read-only server preflight

Before any write, verify all of the following:

- DNS resolves the Tally hostname to `165.245.130.130`.
- Both Tally containers are healthy and use the documented current image.
- Every running container's image, restart count, and OOM state is captured as
  the comparison baseline.
- Disk, memory, swap, and load leave room for one additional 100 MB image and a
  temporary candidate container.
- Caddy, PostgreSQL, Redis, and the unrelated applications are healthy.
- Only expected public ports are listening. At the time of this runbook, those
  are 22, 80, and 443. Port 53 is loopback DNS, not a public listener.
- External Tally liveness and readiness return 200.
- `/opt/tally/.env` and `/opt/tally/compose.yml` remain mode 0600.
- The four Tally systemd timers are active.
- Staging mail still contains `--no-reminders`.
- `sshd -T` reports `permitrootlogin yes`.
- The current database counts and number of running timers are recorded.

Do not continue if an unrelated service is unhealthy, disk pressure is high,
the backup timer is failed, the current Tally release is unhealthy, or the
observed topology differs from this file.

## 3. Create and prove the pre-deploy backup

Run only the installed Tally backup unit:

```bash
systemctl start tally-backup.service
systemctl show tally-backup.service -p Result -p ActiveState -p SubState
```

Identify the newly created `/var/backups/tally/tally-*.dump`, record its size
and SHA-256, and verify its catalog through `pg_restore --list` inside
`opt-db-1`.

Catalog verification is necessary but not sufficient. Create a uniquely named
scratch database owned by `tally_staging`, restore the dump with `--no-owner
--no-acl`, and compare at least:

- users;
- projects;
- active time entries;
- running timers;
- `drizzle.__drizzle_migrations`;
- `drizzle.manual_migrations`;
- database owner.

Drop only that exact scratch database after verification. Confirm it no longer
exists. Never use a broad database-name pattern in a drop command.

## 4. Package, transfer, and load the immutable image

Create the transfer artifact without overwriting an existing one:

```powershell
docker save --output .deploy-tally-<sha>.tar tally:<sha>
Get-Item .deploy-tally-<sha>.tar | Select-Object Length
Get-FileHash -Algorithm SHA256 .deploy-tally-<sha>.tar
```

Before transfer, create `/opt/tally/artifacts/deploy-<sha>` with mode 0700.
Copy the current environment, Compose file, and server Caddyfile into it with
mode 0600. Capture the Tally container inspection and the all-container restart
baseline there.

Transfer to a new `.incoming` path:

```powershell
scp .deploy-tally-<sha>.tar root@165.245.130.130:/opt/tally/artifacts/tally-<sha>.tar.incoming
```

On the server, compare the exact byte count and SHA-256 with the local values.
Only after both match, set mode 0600, rename it atomically to
`tally-<sha>.tar`, and run `docker load`. Verify the loaded image ID, tag,
non-root `node` user, and health check.

## 5. Prove the candidate before changing live configuration

Start a uniquely named, unproxied candidate web container from the new image.
Give it the production environment and `opt_default` network, but no host port
and no production network alias. Apply the same read-only filesystem,
capability, privilege, memory, CPU, PID, and tmpfs controls as the live service.

Require all of the following before continuing:

- Docker health becomes `healthy`;
- `/api/health/live` returns 200 inside the container;
- `/api/health/ready` returns 200 against the real database;
- no restart or OOM event occurs;
- the candidate publishes no host port.

Remove only the exact candidate container and confirm it is gone.

## 6. Validate and run migrations

Override `TALLY_IMAGE` in the remote shell and validate the fully resolved
Compose configuration before changing `/opt/tally/.env`:

```bash
export TALLY_IMAGE=tally:<sha>
docker compose --env-file /opt/tally/.env -f /opt/tally/compose.yml config --quiet
docker compose --env-file /opt/tally/.env -f /opt/tally/compose.yml config --images
docker compose --env-file /opt/tally/.env -f /opt/tally/compose.yml run -T --rm --no-deps web node ops/migrate.mjs
```

Record migration counts before and after. For a schema-neutral release they
must not change. For a release with migrations, confirm the exact expected
increase and that the previous application image remains compatible before
live replacement.

## 7. Change only the image tag

Build a mode-0600 candidate environment file by replacing the single
`TALLY_IMAGE=` line. Normalize that line in both old and candidate files and
compare their SHA-256 values. Equal normalized hashes prove no secret or other
setting changed.

Validate Compose with the candidate environment, confirm every resolved Tally
service uses only `tally:<sha>`, then atomically move the candidate over
`/opt/tally/.env`.

## 8. Replace web, then MCP

Replace only web:

```bash
docker compose --env-file /opt/tally/.env -f /opt/tally/compose.yml up -d --no-deps web
```

Poll Docker health, internal liveness, internal readiness, and external
readiness. Confirm the exact image ID, no host port, original limits, read-only
root filesystem, zero restarts, and zero OOM events. Confirm MCP is still
healthy on the previous image.

Only after web passes, replace only MCP:

```bash
docker compose --env-file /opt/tally/.env -f /opt/tally/compose.yml up -d --no-deps mcp
```

Require MCP Docker health, internal GET 405, external GET 405, and an
unauthenticated POST 401 with the protected-resource challenge. Confirm web
remained healthy throughout.

## 9. Post-deploy verification

Verify and record:

- web and MCP use the exact new image and remain healthy;
- liveness, readiness, and both OAuth discovery documents return 200;
- MCP behavior is 405 for GET and 401 for unauthenticated POST;
- security headers remain present;
- database counts and migration counts are coherent;
- queued and in-flight mail counts are known;
- every unrelated container has the same image, restart count, and OOM state as
  the pre-deploy baseline;
- no container is unhealthy;
- the Compose and Caddy hashes are unchanged for an application-only release;
- host and container Caddyfile hashes match;
- public listeners did not change;
- all four Tally timers remain active;
- the next mail run succeeds with `--no-reminders`;
- recent web and MCP logs contain no deployment error;
- effective root SSH remains enabled.

Run the Tally backup service again. Catalog-verify and fully restore the new
dump into another uniquely named, owner-preserving scratch database, reconcile
the same counts, and remove it.

Save the after-state, log excerpt, backup path, backup hash, image ID, transfer
hash, and timestamps under `/opt/tally/artifacts/deploy-<sha>` with mode 0600.

## 10. Rollback

For an application-only update, do not restore PostgreSQL. Restore the saved
environment file and replace the Tally containers separately:

```bash
install -m 0600 /opt/tally/artifacts/deploy-<failed-sha>/env.before /opt/tally/.env
docker compose --env-file /opt/tally/.env -f /opt/tally/compose.yml up -d --no-deps web
# Prove web health and readiness before continuing.
docker compose --env-file /opt/tally/.env -f /opt/tally/compose.yml up -d --no-deps mcp
```

If only MCP fails, leave the healthy new web container in place and invoke the
MCP update with the saved old environment file. Do not roll back a healthy web
service merely because MCP failed.

A database restore is an incident decision, not a normal image rollback. Stop
and assess if a migration was not backward-compatible or if post-migration
data checks fail.

After rollback, repeat all endpoint, unrelated-container, timer, proxy, log,
database, backup, and root-SSH checks.

## 11. Recordkeeping

Update all three locations after a successful deployment:

1. The current status and deployment note in `CLAUDE.md`.
2. A dated evidence section in
   `docs/DEPLOYMENT-AND-SERVER-HARDENING.md`.
3. The protected server bundle under `/opt/tally/artifacts/deploy-<sha>`.

Commit and push the documentation separately. That documentation-only commit
is not the deployed image revision, so record both values clearly.

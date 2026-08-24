# Tally deployment and shared-server hardening

**Prepared:** 2026-08-16

**Staging deployed:** 2026-08-24

**Production droplet:** `165.245.130.130`

**Hostname:** `tally.jhmediagroup.com`

This is the operating plan produced from a read-only inspection of the shared
DigitalOcean droplet. Tally is joining a sensitive server that already runs
Caddy, PostgreSQL, Redis, Twenty CRM, Lead Orchestrator, Process Server,
Twenty MCP, and IdeaFlow. Changes must be narrow, reversible, and must not
restart unrelated services.

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

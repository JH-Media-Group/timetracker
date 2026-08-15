# What Tally needs from you

> **Do not paste a real key into this file.** It is committed, so a key written
> here is in git history for good, and it is inside the Confluence sync globs, so
> the next doc sync publishes it to a page every licensed user of the Atlassian
> site can read, and into that page's version history, where deleting the line
> here afterwards will not reach it.
>
> Real values go in `.env.local`, which is gitignored. This file describes the
> shape of each one and says where to get it. `tests/repo-hygiene.test.ts` scans
> every tracked file for credential shapes and fails the suite if one lands, so
> this is a rule with something behind it rather than a request.

Everything on this list was skipped during the build because it needs a
credential, an account, or a decision that is not mine to make. Nothing here
blocks running the app locally: `pnpm db:setup && pnpm dev -p 3200` works today
with none of it.

Each item says what is missing, what does not work until it arrives, and what
I will do once I have it.

**Last updated:** 2026-08-14. SendGrid chosen for email; everything else still open.

---

## 1. Google Workspace SSO

**What is missing:** an OAuth client in the JH Media Group Google Cloud project.

**Where it goes:**

```
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_HOSTED_DOMAIN=jhmediagroup.com
```

**How to get it:** Google Cloud Console, APIs and Services, Credentials, Create
credentials, OAuth client ID, Web application. Authorised redirect URI:

```
https://<the droplet's hostname>/api/v1/auth/google/callback
http://localhost:3200/api/v1/auth/google/callback   (for development)
```

**What does not work until then:** email and password is the only way in. That
is fine for now, and it is the route external contractors will keep using
regardless, but it means everybody has a password to look after.

**What I will do with it:** build the two routes (`/api/v1/auth/google` and its
callback), pin the hosted domain so a personal Gmail account cannot sign in, and
turn the "Continue with Google" button on. The button is currently suppressed
even when the variables are set, because a button that leads to a 404 is worse
than no button.

**Decision needed alongside it:** whether contractors keep password sign-in or
everybody ends up in Workspace. The permission model supports either.

---

## 2. Outbound email: SendGrid

**Decided.** SendGrid, confirmed 2026-08-14.

That is a good fit for the way this is already built: Tally sends through plain
SMTP, and SendGrid publishes an SMTP relay, so it drops into the existing
`SMTP_URL` with no new dependency, no vendor SDK, and nothing to unpick if we
ever move.

**What I need:**

```
SMTP_URL=smtps://apikey:<the API key>@smtp.sendgrid.net:465
MAIL_FROM=billing@jhmediagroup.com
```

The username is the literal word `apikey`. The password is the key itself, which
starts `SG.` and is shown exactly once, at creation. If the key contains a
character that is awkward in a URL, percent-encode it; the rest of the string is
already safe.

**Two things to set up in SendGrid, in this order:**

1. **Domain authentication for `jhmediagroup.com`.** Settings, Sender
   Authentication, Authenticate Your Domain. It gives you three CNAME records to
   add at your DNS host, and SendGrid verifies them once they propagate.

   **Start this first.** It is the only item on this whole list with a waiting
   period attached, and it is the one that decides whether an invoice lands in
   an inbox or a spam folder. An unauthenticated sender can technically send;
   invoices from one get filtered, and a client who says "I never received it"
   is not lying.

2. **An API key with Mail Send permission only.** Settings, API Keys, Create API
   Key, Restricted Access, and grant nothing but Mail Send. A full-access key in
   an environment file is a key that can also read every message the account has
   ever sent.

**Worth knowing before you pick a plan:** the free tier is capped per day, and
that cap is low enough to matter on a day somebody sends reminders to every
outstanding invoice at once. Check the current numbers when you sign up; at this
volume the smallest paid tier is likely to be right, and the failure mode of
being wrong is silent for exactly as long as nobody looks at the invoice
timeline.

**What does not work until it arrives:** sending an invoice, chasing one with a
reminder, emailing a statement, and the "your timesheet is not submitted"
nudges. Every one of these is *recorded* today with a delivery state of
`not_configured`, and the UI says so in as many words rather than claiming the
mail went out. The invoice timeline is honest; it just has nothing to show yet.

**What I will do with it:**

- Add the transport and the templates behind the `env.smtp` check that already
  guards every send site, so the same code paths light up rather than new ones
  appearing.
- Add the outbox topics for the sends that do not have one yet. The outbox
  currently carries `invoice.sent`, `invoice.paid`, `timesheet.submitted` and
  `timesheet.approved`; the reminders and statements are recorded on the invoice
  timeline but do not raise an event, so there is nothing for a worker to pick
  up.
- Wire SendGrid's Event Webhook so a bounce or a spam report comes back as a
  delivery state on the message rather than as silence. This matters more than
  it sounds: an invoice that bounced looks identical to one that was ignored,
  and the difference is whether you chase the client or fix the address.

None of that needs the key to be written, only to be tested end to end. Say the
word and I will build it against a local SMTP capture so it is ready to switch
on the day the key lands.

---

## 3. Object storage for receipts, logos, and invoice PDFs

**What is missing:** a DigitalOcean Space (or any S3-compatible bucket) and a
key pair.

**Where it goes:**

```
SPACES_ENDPOINT=https://nyc3.digitaloceanspaces.com
SPACES_REGION=nyc3
SPACES_BUCKET=tally-jhmg
SPACES_KEY=
SPACES_SECRET=
```

**How to get it:** DigitalOcean control panel, Spaces, Create. Then API, Spaces
Keys, Generate New Key. The Space should be **private**; Tally will hand out
time-limited signed URLs rather than making anything public.

**What does not work until then:** attaching a receipt to an expense, the
company logo on an invoice, and storing a rendered invoice PDF. Expenses can be
entered with a receipt *filename* today, which is enough for the migration to
carry Harvest's data across, but the file itself has nowhere to live.

**Cost:** $5 a month for 250 GB, which is far more than a decade of receipts.

---

## 4. The droplet

**What is missing:** the droplet itself, and a decision about its size.

**What I proposed:** 4 vCPU, 8 GB, which runs Postgres, Redis, and the app
comfortably with room for the import to run alongside normal use. That is $48 a
month. A 2 vCPU / 4 GB box at $24 would also work and would be tight only during
the migration.

**Also needed:**

- A hostname and a DNS record pointing at it.
- A TLS certificate. Caddy will get one from Let's Encrypt automatically; that
  is the reason to prefer Caddy over nginx here.
- A decision on backups: DigitalOcean's droplet snapshots are $4.80 a month for
  weekly, which is not enough on its own for a system of record. I would add a
  nightly `pg_dump` to the Space, which costs nothing extra.

**What does not work until then:** nothing local, but nobody else can use it.

---

## 5. The Harvest export: arrived, imported, reconciled

The CSV importer and reconciliation scripts are implemented. Keep all source exports, account totals, personnel decisions, and reconciliation reports outside Git. Confirm the billing cutoff privately before import. Invoice checks requiring records absent from the source must be reported as skipped.

## 6. Decisions, not credentials

These need an answer from you rather than a secret.

| Question | Why it matters | My suggestion |
|---|---|---|
| **The product name.** "Tally" is a placeholder. | It is in the UI, the page titles, the emails, and the invoice footer. Changing it later is cheap but touches a lot of copy. | Tally is fine. It is short, it is what the thing does, and nobody has to explain it. |
| **Droplet size.** | See above. | 4 vCPU / 8 GB. The difference is $24 a month and the larger one will not need thinking about again. |
| **Contractors: password or Workspace?** | Decides whether we maintain password sign-in permanently. | Keep password auth for contractors. Adding external people to Workspace costs a seat each and gives them a mailbox they do not need. |
| **Invoice numbering.** The pattern is configurable and currently `{seq}-{client_code}-{seq}`, which is what Harvest was producing. | The first invoice after the migration should continue the sequence, not restart it. | Keep Harvest's format through the changeover, then simplify to `{year}-{seq:4}` at the start of the next financial year. |
| **Who is the account owner?** Currently your account, seeded as owner. | The owner is the one profile that cannot be locked out or demoted. | You. Add a second administrator so a lost laptop is not an outage. |

---

## 7. What was skipped for lack of permission, and nothing else

For completeness, this is the whole list of things I did not do because I could
not, rather than because they were out of scope:

- Google OAuth routes (needs item 1).
- The email queue processor (needs item 2).
- Receipt upload and the invoice PDF renderer (needs item 3).
- The deployment itself: Caddy config, systemd units, the backup cron (needs
  item 4).
- Bringing the Harvest *invoice* history across. The export holds invoices only
  as PDFs, so there is nothing structured to import (item 5).

Everything else in the plan is built, tested, and running against Postgres.

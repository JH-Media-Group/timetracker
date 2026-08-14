# Testing Tally

Written for the morning after the build. It says how to start it, what to poke
at, what will already be wrong, and what is deliberately not there.

---

## Starting it

```powershell
pnpm install
pnpm db:setup      # Docker Postgres on 5434 and Redis on 6382, migrate, seed
pnpm dev -p 3200
```

Then open `http://localhost:3200`. Every seeded account uses the same password:

| Sign in as | Profile | Good for |
|---|---|---|
| `person01@example.com` | Administrator, account owner | Everything |
| `person08@example.com` | Project Manager | Approvals, team scoping |
| `person05@example.com` | Member | What a normal person sees |

Password: `tally-dev-password`

If something goes wrong and you want to start clean:

```powershell
pnpm db:seed --force    # drops every record and rebuilds the sample set
```

---

## The half hour that will tell you the most

In this order, because each step sets up the next.

1. **Track an hour.** `/timesheet`, start a timer from the top bar, let it run,
   stop it. Then add an entry by hand, edit it, delete it, and press Undo on the
   toast. Switch to Week and type into cells; the grid saves on blur, one cell at
   a time, and the rest of the row should not move.

2. **Submit and approve.** Submit the week from `/timesheet`, then sign in as
   Person08 and approve it from `/approvals`. Go back to your own timesheet and
   try to edit an approved day: it should refuse and say why. Request changes
   instead of approving and check the entry unlocks.

3. **Bill something.** `/invoices`, New invoice, pick a client. The lines that
   appear are the uninvoiced billable time and expenses for that client. **Check
   the total against the invoice you create**, because that is the one number in
   the system that has to be exactly right, and it was wrong twice during the
   build. Then mark it sent, record a payment, and watch the state move.

4. **Check the money agrees with itself.** `/reports` with the same period,
   grouped four different ways, should give the same total every time. A project
   page's "uninvoiced" should match what the invoice preview offers for that
   project. If any two of those disagree, that is the most important bug you can
   find and I want to know about it before anything else.

5. **Look at it as Alex.** Sign in as a Member. Money should be absent
   everywhere, not zero: no rates on the team page, no value on the time report,
   no profitability tab. Try `/invoices` directly; it should not be in the
   navigation and the API refuses it.

---

## What will already be wrong

Being straight about this so you do not waste time reporting it.

- **The sample data is synthetic.** The numbers are plausible but they are not
  your numbers, and none of it reconciles against Harvest yet. That happens when
  the real export arrives.
- **Nothing sends email.** Sending an invoice, chasing one, and the submission
  reminders all record what would have happened and say plainly that no mail
  went out. The invoice timeline shows the attempt.
- **No receipts and no PDF file.** An expense can carry a receipt filename but
  the file has nowhere to live. "Print or save as PDF" on an invoice uses the
  browser's own dialog, which produces a correct document; there is no stored
  PDF and no download endpoint.
- **Google sign-in is not offered.** Password only, deliberately, until the
  OAuth credentials exist.
- **Three controls are disabled on purpose,** with the reason on them: the full
  account export, the CSV import, and the integration connect buttons. Per-grid
  Export does work and writes what is on screen to a CSV.

---

## What I would look at with suspicion

Places where the design is right but the implementation has had the least
exercise:

- **The week grid with a lock in the middle of it.** One approved day inside an
  otherwise editable week is the case that has been rewritten twice.
- **Timezones.** Everything resolves calendar days in the person's timezone,
  which is right, but every seeded account is on `America/New_York`. If you set
  somebody to a different zone, "today" should still be their today.
- **Retainers.** The ledger and the balance are kept in step by a row lock, and
  a retainer that fully covers an invoice settles it at send. Both are tested,
  neither has been used in anger.
- **A client with several projects on one invoice.** Revenue is attributed to
  each project by its share of the lines. This is the calculation most likely to
  surprise you.

---

## Reporting something

The most useful bug report here is a number and where you saw it. "The project
page says $4,120 uninvoiced and the invoice preview offers $4,095" is
immediately actionable; "the invoice screen looks wrong" is a morning of
guessing.

Every API response carries an `X-Request-Id`, and every error shown in the UI
includes it. Quoting that id finds the exact request in the server log.

---

## Running the checks yourself

```powershell
pnpm test           # 235 tests, needs the test database from db:setup
pnpm typecheck
pnpm build
pnpm authz:sweep    # the profile-by-endpoint permission matrix
pnpm authz:scope    # proves a Member gets only their own rows and no money
```

The last two create their own accounts and delete them afterwards.

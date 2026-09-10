# Repository data policy

Use fictional people, clients, contact details, invoices, rates, and budgets in
mock data, tests, examples, and screenshots. Use reserved example domains for
fixture email addresses and URLs. Preserve parser edge cases and arithmetic
when changing fixtures.

Keep raw exports, source PDFs, financial reconciliation results, personnel
locations, and account-specific operational records outside this repository.
This includes documentation, code comments, commit messages, and attachments.
Secret scanning alone does not detect business or personnel information.

Reconciliation reports generated under `docs/migration/` are ignored local
artifacts. Review staged files before committing; never force-add private data.

## Working after the history cleanup

All shared Git history was rewritten to remove private operational data.
Existing external clones must be replaced or carefully cleaned before use.
Never merge or push a branch based on the old history. Preserve unfinished
work separately and reapply only reviewed changes onto a fresh clone.

Deployment documents retain the revision identifiers of already-built images
and backups. Those identifiers describe historical deployment artifacts and
may no longer resolve in the cleaned Git history. This cleanup does not deploy
code or change live application data.

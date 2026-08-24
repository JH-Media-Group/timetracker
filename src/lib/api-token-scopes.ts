export const TOKEN_SCOPES = ["tally.read", "tally.financial.read", "tally.time.write", "tally.expenses", "tally.approvals", "tally.admin"] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];
export const SCOPE_LABELS: Record<TokenScope, { title: string; description: string }> = {
  "tally.read": { title: "Read non-financial records", description: "View the non-financial Tally records you can already see." },
  "tally.financial.read": { title: "Sensitive financial data", description: "View invoices, financial reports, billable rates, payroll cost rates, and audit history allowed by your Tally permissions." },
  "tally.time.write": { title: "Log time", description: "Start timers and create, edit, or remove time within your reach." },
  "tally.expenses": { title: "Manage expenses", description: "Create and update expenses within your reach." },
  "tally.approvals": { title: "Review time", description: "Submit and review timesheets within your reach." },
  "tally.admin": { title: "Administer Tally", description: "Change account setup with confirmation. Financial reading requires separate consent." },
};

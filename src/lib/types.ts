/** Domain types. Mirrors the schema in docs/BACKEND_PRD.md section 3.
 *  Money is integer cents. Durations are integer seconds. Never floats. */

export type ID = string;

export type PermissionProfile =
  | "member" | "project_manager" | "people_admin"
  | "accounting" | "executive_manager" | "administrator";

export type Capability =
  | "time:create_own" | "time:edit_own" | "time:view_others" | "time:edit_others"
  | "expense:manage" | "approval:review" | "project:manage" | "client:manage"
  | "task:manage" | "people:manage" | "rates:view_billable" | "rates:view_cost"
  | "rates:manage" | "invoice:manage" | "report:view_financial" | "settings:manage"
  | "audit:view" | "bulk:execute";

export interface User {
  id: ID;
  firstName: string;
  lastName: string;
  email: string;
  photo?: string;          // data URI in the mock; an object key in the real app
  employmentType: "employee" | "contractor";
  profile: PermissionProfile;
  isOwner?: boolean;
  roles: string[];
  departments: string[];
  weeklyCapacitySeconds: number;
  timezone: string;
  /** Absent means "you may not see this", which is not the same as zero. */
  billableRateCents?: number;
  costRateCents?: number;
  archivedAt?: string;
  startedOn?: string;
}

export interface Client {
  id: ID;
  name: string;
  address?: string;
  currency: string;
  paymentTerm: "upon_receipt" | "net_15" | "net_30" | "net_45" | "net_60";
  taxPercent?: number;
  discountPercent?: number;
  archivedAt?: string;
  contacts: ClientContact[];
}

export interface ClientContact {
  id: ID; clientId: ID; firstName: string; lastName: string;
  title?: string; email?: string; phone?: string; isPrimary?: boolean;
}

export type BillingType = "time_and_materials" | "fixed_fee" | "non_billable";
export type BillBy = "project" | "tasks" | "people" | "none";
export type BudgetBy =
  | "project_hours" | "project_fees" | "task_hours"
  | "task_fees" | "person_hours" | "none";

export interface Project {
  id: ID;
  clientId: ID;
  name: string;
  code?: string;
  billingType: BillingType;
  billBy: BillBy;
  hourlyRateCents?: number;
  feeCents?: number;
  feeCadence?: "single" | "monthly";
  budgetBy: BudgetBy;
  budgetSeconds?: number;
  budgetFeeCents?: number;
  budgetResetsMonthly: boolean;
  budgetAlertPercent?: number;
  notes?: string;
  tags: string[];
  startsOn?: string;
  endsOn?: string;
  colorIndex: number;
  archivedAt?: string;
  taskIds: ID[];
  memberIds: ID[];
  managerIds: ID[];
}

export interface Task {
  id: ID;
  name: string;
  defaultBillable: boolean;
  isCommon: boolean;
  defaultRateCents?: number;
  archivedAt?: string;
}

export interface TimeEntry {
  id: ID;
  userId: ID;
  projectId: ID;
  taskId: ID;
  spentOn: string;              // YYYY-MM-DD
  startedAt?: string;           // ISO, when the account tracks clock times
  endedAt?: string;
  durationSeconds: number;
  timerStartedAt?: string;      // non-null means running
  notes?: string;
  isBillable: boolean;
  /** Absent means "you may not see this", which is not the same as zero. */
  billableRateCents?: number;
  costRateCents?: number;
  invoiceId?: ID;
  billedExternally?: boolean;
  approvalId?: ID;
}

export interface ExpenseCategory {
  id: ID; name: string; unitName?: string; unitPriceCents?: number; archivedAt?: string;
}

export interface Expense {
  id: ID;
  userId: ID;
  projectId: ID;
  categoryId: ID;
  spentOn: string;
  units?: number;
  totalCents: number;
  notes?: string;
  isBillable: boolean;
  isReimbursable: boolean;
  reimbursementState?: "pending" | "approved" | "paid";
  receiptName?: string;
  invoiceId?: ID;
}

export type SubmissionState = "draft" | "submitted" | "approved" | "changes_requested";

export interface TimesheetSubmission {
  id: ID;
  userId: ID;
  periodStart: string;
  periodEnd: string;
  state: SubmissionState;
  submittedAt?: string;
  reviewedBy?: ID;
  reviewedAt?: string;
  reviewNote?: string;
  totalSeconds: number;
  flags: string[];
}

export type InvoiceState = "draft" | "sent" | "partial" | "late" | "paid" | "written_off";

export interface InvoiceLineItem {
  id: ID; invoiceId: ID; position: number; itemType: string;
  projectId?: ID; description: string; quantity: number;
  unitPriceCents: number; amountCents: number; isTaxed: boolean;
}

export interface InvoicePayment {
  id: ID; invoiceId: ID; amountCents: number; paidAt: string;
  method?: string; reference?: string; recordedBy: ID;
}

export interface InvoiceEvent {
  id: ID; invoiceId: ID; kind: string; label: string;
  actorId?: ID; at: string; amountCents?: number;
}

export interface Invoice {
  id: ID;
  clientId: ID;
  number: string;
  subject?: string;
  notes?: string;
  poNumber?: string;
  currency: string;
  issueDate: string;
  dueDate: string;
  state: InvoiceState;
  subtotalCents: number;
  taxPercent?: number;
  taxCents: number;
  discountPercent?: number;
  discountCents: number;
  totalCents: number;
  paidCents: number;
  sentAt?: string;
  paidAt?: string;
  projectIds: ID[];
  lineItems: InvoiceLineItem[];
  payments: InvoicePayment[];
  events: InvoiceEvent[];
}

export interface RecurringInvoice {
  id: ID; clientId: ID; subject: string; frequency: "monthly" | "quarterly" | "yearly";
  intervalMonths: number; nextIssueOn?: string; amountCents: number;
  state: "active" | "paused" | "completed";
}

export interface Retainer {
  id: ID; clientId: ID; projectId?: ID; balanceCents: number;
  transactions: { id: ID; kind: "add" | "draw" | "adjust"; amountCents: number; at: string; note?: string; invoiceId?: ID }[];
}

export interface Settings {
  companyName: string;
  companyAddress: string;
  baseCurrency: string;
  timezone: string;
  weekStartsOn: 0 | 1;
  timerMode: "duration" | "start_end";
  timeDisplay: "decimal" | "hours_minutes";
  roundingMinutes: number;
  requireNotes: "never" | "always" | "non_billable";
  allowFutureDates: boolean;
  flagMissingBelowSeconds?: number;
  modules: Record<string, boolean>;
}

/** A row in a grouped grid response: either a group header or a data row. */
export type GridKind = "group" | "data";

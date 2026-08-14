/**
 * Request schemas.
 *
 * Kept out of the route files because a Next.js route module may only export
 * route handlers and a small fixed set of config names. Exporting a schema from
 * one and importing it in another compiles locally and then fails the build
 * with a type error about an index signature, which is a confusing way to learn
 * a framework rule.
 *
 * One schema per operation. Unknown keys are stripped rather than accepted, so
 * a client cannot set a column by guessing its name.
 */

import { z } from "zod";

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

/** A query-string boolean. `?invoiced=false` has to mean false, not "truthy". */
export const queryBool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1")
  .optional();

/* --------------------------------------------------------------- clients */

export const contactSchema = z.object({
  id: z.string().optional(),
  firstName: z.string().nullable().optional(),
  lastName: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  email: z.union([z.string().email(), z.literal("")]).nullable().optional(),
  phone: z.string().nullable().optional(),
  isPrimary: z.boolean().optional(),
});

export const clientSchema = z.object({
  name: z.string().trim().min(1, "A client needs a name.").max(200),
  address: z.string().max(1000).nullable().optional(),
  currency: z.string().length(3).default("USD"),
  paymentTerm: z
    .enum(["upon_receipt", "net_15", "net_30", "net_45", "net_60", "custom"])
    .default("net_30"),
  paymentTermDays: z.number().int().min(0).max(365).nullable().optional(),
  taxPercent: z.number().min(0).max(100).nullable().optional(),
  discountPercent: z.number().min(0).max(100).nullable().optional(),
  invoicePrefix: z.string().max(20).nullable().optional(),
  contacts: z.array(contactSchema).max(50).optional(),
});

export const clientPatchSchema = clientSchema.partial();

/* -------------------------------------------------------------- projects */

export const projectSchema = z.object({
  clientId: z.string().uuid("Choose a client."),
  name: z.string().trim().min(1, "A project needs a name.").max(200),
  code: z.string().max(50).nullable().optional(),
  billingType: z.enum(["time_and_materials", "fixed_fee", "non_billable"]),
  billBy: z.enum(["project", "tasks", "people", "none"]).optional(),
  hourlyRateCents: z.number().int().min(0).nullable().optional(),
  feeCents: z.number().int().min(0).nullable().optional(),
  feeCadence: z.enum(["single", "monthly"]).nullable().optional(),
  budgetBy: z
    .enum(["project_hours", "project_fees", "task_hours", "task_fees", "person_hours", "none"])
    .optional(),
  budgetSeconds: z.number().int().min(0).nullable().optional(),
  budgetFeeCents: z.number().int().min(0).nullable().optional(),
  budgetResetsMonthly: z.boolean().optional(),
  budgetAlertPercent: z.number().min(0).max(999).nullable().optional(),
  startsOn: isoDate.nullable().optional(),
  endsOn: isoDate.nullable().optional(),
  notes: z.string().max(10000).nullable().optional(),
  reportVisibility: z.enum(["managers", "everyone"]).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  taskIds: z.array(z.string().uuid()).max(200).optional(),
  memberIds: z.array(z.string().uuid()).max(200).optional(),
  managerIds: z.array(z.string().uuid()).max(200).optional(),
});

export const projectPatchSchema = projectSchema.partial();

/* ----------------------------------------------------------------- tasks */

export const taskSchema = z.object({
  name: z.string().trim().min(1, "A task needs a name.").max(120),
  defaultBillable: z.boolean().optional(),
  isCommon: z.boolean().optional(),
  defaultHourlyRateCents: z.number().int().min(0).nullable().optional(),
});

export const taskPatchSchema = taskSchema.partial().extend({ archived: z.boolean().optional() });

/* ------------------------------------------------------------------ time */

export const timeEntrySchema = z.object({
  userId: z.string().uuid().optional(),
  projectId: z.string().uuid("Choose a project."),
  taskId: z.string().uuid("Choose a task."),
  spentOn: isoDate.optional(),
  durationSeconds: z.number().int().min(0).max(24 * 3600).optional(),
  startedAt: z.string().datetime().nullable().optional(),
  endedAt: z.string().datetime().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  isBillable: z.boolean().optional(),
  start: z.boolean().optional(),
});

export const timeEntryPatchSchema = z.object({
  projectId: z.string().uuid().optional(),
  taskId: z.string().uuid().optional(),
  spentOn: isoDate.optional(),
  durationSeconds: z.number().int().min(0).max(24 * 3600).optional(),
  startedAt: z.string().datetime().nullable().optional(),
  endedAt: z.string().datetime().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  isBillable: z.boolean().optional(),
});

/* -------------------------------------------------------------- expenses */

export const expenseSchema = z.object({
  userId: z.string().uuid().optional(),
  projectId: z.string().uuid("Choose a project."),
  categoryId: z.string().uuid("Choose a category."),
  spentOn: isoDate,
  units: z.number().min(0).nullable().optional(),
  totalCents: z.number().int().min(0),
  notes: z.string().max(2000).nullable().optional(),
  isBillable: z.boolean().optional(),
  isReimbursable: z.boolean().optional(),
  receiptFilename: z.string().max(255).nullable().optional(),
});

export const expensePatchSchema = expenseSchema.partial().omit({ userId: true });

/* --------------------------------------------------------------- people */

export const userPatchSchema = z.object({
  firstName: z.string().trim().min(1).max(100).optional(),
  lastName: z.string().trim().min(1).max(100).optional(),
  email: z.string().email().optional(),
  timezone: z
    .string()
    .max(64)
    .refine(
      (v) => {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: v });
          return true;
        } catch {
          return false;
        }
      },
      { message: "That is not a timezone this system knows." }
    )
    .optional(),
  weeklyCapacitySeconds: z.number().int().min(0).max(168 * 3600).optional(),
  employmentType: z.enum(["employee", "contractor"]).optional(),
  profileId: z.string().uuid().optional(),
  startedOn: isoDate.nullable().optional(),
  endedOn: isoDate.nullable().optional(),
  roles: z.array(z.string().max(60)).max(20).optional(),
  departments: z.array(z.string().max(60)).max(20).optional(),
});

export const rateSchema = z.object({
  kind: z.enum(["billable", "cost"]),
  amountCents: z.number().int().min(0),
  startsOn: isoDate.nullable().default(null),
  endsOn: isoDate.nullable().default(null),
});

/* ------------------------------------------------------------- invoices */

export const invoiceLineSchema = z.object({
  id: z.string().uuid().optional(),
  projectId: z.string().uuid().nullable().optional(),
  description: z.string().min(1).max(500),
  quantity: z.number().min(0),
  unitPriceCents: z.number().int(),
  /**
   * The line's exact value, when the caller has it.
   *
   * A time line is worth `sum(seconds x rate) / 3600`, which is not
   * `hours x rate` once the hours have been rounded to two decimals for the
   * document. Dropping this field is how the preview and the invoice it
   * produced came out a couple of dollars apart.
   */
  amountCents: z.number().int().optional(),
  isTaxed: z.boolean().default(true),
  itemType: z.string().max(60).optional(),
});

export const invoiceSchema = z.object({
  clientId: z.string().uuid("Choose a client."),
  subject: z.string().max(200).nullable().optional(),
  notes: z.string().max(10000).nullable().optional(),
  poNumber: z.string().max(60).nullable().optional(),
  issueDate: isoDate,
  dueDate: isoDate,
  taxPercent: z.number().min(0).max(100).nullable().optional(),
  discountPercent: z.number().min(0).max(100).nullable().optional(),
  number: z.string().max(60).optional(),
  lines: z.array(invoiceLineSchema).max(500).default([]),
  projectIds: z.array(z.string().uuid()).max(100).optional(),
  /** Entries and expenses to attach, so the same hour cannot be billed twice. */
  timeEntryIds: z.array(z.string().uuid()).max(10000).optional(),
  expenseIds: z.array(z.string().uuid()).max(10000).optional(),
});

export const invoicePatchSchema = invoiceSchema.partial().omit({ clientId: true });

export const paymentSchema = z.object({
  amountCents: z.number().int().positive("A payment has to be more than nothing."),
  paidAt: z.string().datetime(),
  method: z.string().max(40).nullable().optional(),
  reference: z.string().max(120).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
});

export const previewLinesSchema = z.object({
  clientId: z.string().uuid(),
  projectIds: z.array(z.string().uuid()).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  grouping: z.enum(["project", "task", "person"]).default("project"),
});

/* ------------------------------------------------------------ approvals */

export const submitSchema = z.object({
  periodStart: isoDate,
  userId: z.string().uuid().optional(),
});

export const reviewSchema = z.object({
  note: z.string().max(2000).optional(),
});

export { z };

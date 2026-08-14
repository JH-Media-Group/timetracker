/**
 * Serializers.
 *
 * Layer three of the authorization model: field redaction on the way out. The
 * capability gate and the scope filter both have to be right for a request to
 * reach here; this layer means that if either of them is ever wrong, money data
 * still does not leave the building.
 *
 * The rule is that a DTO is built by naming fields, never by spreading a row.
 * `{ ...row }` is how a column added next year silently joins every payload.
 *
 * Specification: docs/BACKEND_PRD.md sections 5 and 7.3.
 */

import type { Ctx } from "./ctx";
import type * as s from "./db/schema";

export const canSeeCost = (ctx: Ctx): boolean =>
  ctx.actor.kind === "system" || ctx.actor.capabilities.has("rates:view_cost");

export const canSeeBillable = (ctx: Ctx): boolean =>
  ctx.actor.kind === "system" ||
  ctx.actor.capabilities.has("rates:view_billable") ||
  ctx.actor.capabilities.has("invoice:manage") ||
  ctx.actor.capabilities.has("report:view_financial");

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/* ------------------------------------------------------------------- user */

export interface UserDto {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  avatarKey: string | null;
  employmentType: string;
  isOwner: boolean;
  profileId: string;
  timezone: string;
  weeklyCapacitySeconds: number;
  startedOn: string | null;
  archivedAt: string | null;
  roles: string[];
  departments: string[];
  billableRateCents?: number;
  costRateCents?: number;
}

export function serializeUser(
  ctx: Ctx,
  row: s.UserRow,
  extra: { roles?: string[]; departments?: string[]; billableRateCents?: number; costRateCents?: number } = {}
): UserDto {
  const dto: UserDto = {
    id: row.id,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    avatarKey: row.avatarKey,
    employmentType: row.employmentType,
    isOwner: row.isOwner,
    profileId: row.profileId,
    timezone: row.timezone,
    weeklyCapacitySeconds: row.weeklyCapacitySeconds,
    startedOn: row.startedOn,
    archivedAt: iso(row.archivedAt),
    roles: extra.roles ?? [],
    departments: extra.departments ?? [],
  };

  // A person always sees their own rates; everyone else needs the capability.
  const own = ctx.actor.userId === row.id;
  if (extra.billableRateCents != null && (own || canSeeBillable(ctx))) {
    dto.billableRateCents = extra.billableRateCents;
  }
  if (extra.costRateCents != null && canSeeCost(ctx)) {
    dto.costRateCents = extra.costRateCents;
  }
  return dto;
}

/* ------------------------------------------------------------- time entry */

export interface TimeEntryDto {
  id: string;
  userId: string;
  projectId: string;
  projectTaskId: string;
  taskId: string | null;
  spentOn: string;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number;
  timerStartedAt: string | null;
  notes: string | null;
  isBillable: boolean;
  invoiceId: string | null;
  approvalId: string | null;
  billedExternally: boolean;
  needsReview: boolean;
  locked: boolean;
  lockReasons: string[];
  billableRateCents?: number;
  costRateCents?: number;
}

export function serializeTimeEntry(
  ctx: Ctx,
  row: s.TimeEntryRow & { taskId?: string | null },
  extra: { locked?: boolean; lockReasons?: string[] } = {}
): TimeEntryDto {
  const dto: TimeEntryDto = {
    id: row.id,
    userId: row.userId,
    projectId: row.projectId,
    projectTaskId: row.projectTaskId,
    taskId: row.taskId ?? null,
    spentOn: row.spentOn,
    startedAt: iso(row.startedAt),
    endedAt: iso(row.endedAt),
    durationSeconds: row.durationSeconds,
    timerStartedAt: iso(row.timerStartedAt),
    notes: row.notes,
    isBillable: row.isBillable,
    invoiceId: row.invoiceId,
    approvalId: row.approvalId,
    billedExternally: row.billedExternally,
    needsReview: row.needsReview,
    locked: extra.locked ?? false,
    lockReasons: extra.lockReasons ?? [],
  };

  const own = ctx.actor.userId === row.userId;
  if (own || canSeeBillable(ctx)) dto.billableRateCents = row.billableRateCents;
  if (canSeeCost(ctx)) dto.costRateCents = row.costRateCents;
  return dto;
}

/* ----------------------------------------------------------------- client */

export interface ClientDto {
  id: string;
  name: string;
  address: string | null;
  currency: string;
  paymentTerm: string;
  paymentTermDays: number | null;
  taxPercent: number | null;
  discountPercent: number | null;
  invoicePrefix: string | null;
  archivedAt: string | null;
  contacts: ClientContactDto[];
}

export interface ClientContactDto {
  id: string;
  clientId: string;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  isPrimary: boolean;
}

const num = (v: string | null): number | null => (v == null ? null : Number(v));

export function serializeClient(row: s.ClientRow, contacts: (typeof s.clientContacts.$inferSelect)[] = []): ClientDto {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    currency: row.currency,
    paymentTerm: row.paymentTerm,
    paymentTermDays: row.paymentTermDays,
    taxPercent: num(row.taxPercent),
    discountPercent: num(row.discountPercent),
    invoicePrefix: row.invoicePrefix,
    archivedAt: iso(row.archivedAt),
    contacts: contacts.map(serializeContact),
  };
}

export const serializeContact = (c: typeof s.clientContacts.$inferSelect): ClientContactDto => ({
  id: c.id,
  clientId: c.clientId,
  firstName: c.firstName,
  lastName: c.lastName,
  title: c.title,
  email: c.email,
  phone: c.phoneMobile ?? c.phoneOffice,
  isPrimary: c.isPrimary,
});

/* ---------------------------------------------------------------- project */

export interface ProjectDto {
  id: string;
  clientId: string;
  name: string;
  code: string | null;
  billingType: string;
  billBy: string;
  budgetBy: string;
  budgetSeconds: number | null;
  budgetResetsMonthly: boolean;
  budgetAlertPercent: number | null;
  startsOn: string | null;
  endsOn: string | null;
  notes: string | null;
  reportVisibility: string;
  archivedAt: string | null;
  tags: string[];
  taskIds: string[];
  memberIds: string[];
  managerIds: string[];
  hourlyRateCents?: number;
  feeCents?: number;
  feeCadence?: string | null;
  budgetFeeCents?: number | null;
}

export function serializeProject(
  ctx: Ctx,
  row: s.ProjectRow,
  extra: { tags?: string[]; taskIds?: string[]; memberIds?: string[]; managerIds?: string[] } = {}
): ProjectDto {
  const dto: ProjectDto = {
    id: row.id,
    clientId: row.clientId,
    name: row.name,
    code: row.code,
    billingType: row.billingType,
    billBy: row.billBy,
    budgetBy: row.budgetBy,
    budgetSeconds: row.budgetSeconds,
    budgetResetsMonthly: row.budgetResetsMonthly,
    budgetAlertPercent: num(row.budgetAlertPercent),
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    notes: row.notes,
    reportVisibility: row.reportVisibility,
    archivedAt: iso(row.archivedAt),
    tags: extra.tags ?? [],
    taskIds: extra.taskIds ?? [],
    memberIds: extra.memberIds ?? [],
    managerIds: extra.managerIds ?? [],
  };

  // Rates and fees are money. A member without the billable capability sees the
  // project but not what it is worth.
  if (canSeeBillable(ctx)) {
    dto.hourlyRateCents = row.hourlyRateCents ?? undefined;
    dto.feeCents = row.feeCents ?? undefined;
    dto.feeCadence = row.feeCadence;
    dto.budgetFeeCents = row.budgetFeeCents;
  }
  return dto;
}

/* ---------------------------------------------------------------- invoice */

export interface InvoiceDto {
  id: string;
  clientId: string;
  number: string;
  subject: string | null;
  notes: string | null;
  poNumber: string | null;
  currency: string;
  issueDate: string;
  dueDate: string;
  state: string;
  displayState: string;
  subtotalCents: number;
  discountPercent: number | null;
  discountCents: number;
  taxPercent: number | null;
  taxCents: number;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  retainerDrawCents: number;
  sentAt: string | null;
  paidAt: string | null;
  projectIds: string[];
}

export function serializeInvoice(
  row: s.InvoiceRow,
  extra: { displayState: string; projectIds?: string[] }
): InvoiceDto {
  return {
    id: row.id,
    clientId: row.clientId,
    number: row.number,
    subject: row.subject,
    notes: row.notes,
    poNumber: row.poNumber,
    currency: row.currency,
    issueDate: row.issueDate,
    dueDate: row.dueDate,
    state: row.state,
    displayState: extra.displayState,
    subtotalCents: row.subtotalCents,
    discountPercent: num(row.discountPercent),
    discountCents: row.discountCents,
    taxPercent: num(row.taxPercent),
    taxCents: row.taxCents,
    totalCents: row.totalCents,
    paidCents: row.paidCents,
    balanceCents: row.totalCents - row.paidCents - row.retainerDrawCents,
    retainerDrawCents: row.retainerDrawCents,
    sentAt: iso(row.sentAt),
    paidAt: iso(row.paidAt),
    projectIds: extra.projectIds ?? [],
  };
}

/* --------------------------------------------------------------- settings */

export function serializeSettings(row: s.SettingsRow) {
  return {
    companyName: row.companyName,
    companyAddress: row.companyAddress,
    baseCurrency: row.baseCurrency,
    timezone: row.timezone,
    weekStartsOn: row.weekStartsOn,
    fiscalYearStartMonth: row.fiscalYearStartMonth,
    timerMode: row.timerMode,
    timeDisplay: row.timeDisplay,
    roundingMinutes: row.roundingMinutes,
    roundingMode: row.roundingMode,
    requireNotes: row.requireNotes,
    allowFutureDates: row.allowFutureDates,
    flagMissingBelowSeconds: row.flagMissingBelowSeconds,
    lockTimesheetsAfterDays: row.lockTimesheetsAfterDays,
    projectNotesVisibility: row.projectNotesVisibility,
    modules: row.modules as Record<string, boolean>,
    invoiceNumberPattern: row.invoiceNumberPattern,
  };
}

/* ------------------------------------------------------------ open report */

/**
 * The money-free project report a member sees when
 * `report_visibility = 'everyone'`.
 *
 * Built from the constant in capabilities.ts, so the promise the UI makes in
 * its "What will people see?" popover and what the server actually sends
 * cannot drift apart.
 */
export interface OpenProjectReportDto {
  totalHours: number;
  billableHours: number;
  nonBillableHours: number;
  hoursByTask: { taskId: string; name: string; hours: number }[];
  hoursByPerson: { userId: string; name: string; hours: number }[];
  budgetPercentUsed: number | null;
}

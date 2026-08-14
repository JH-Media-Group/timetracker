/** Human labels for the enums in types.ts. One place, so a rename lands
 *  everywhere at once and nothing drifts between a table and its detail page. */

import type { BillingType, Client, PermissionProfile, SubmissionState } from "@/lib/types";

export const PROFILE_LABEL: Record<PermissionProfile, string> = {
  member: "Member",
  project_manager: "Project manager",
  people_admin: "People admin",
  accounting: "Accounting",
  executive_manager: "Executive manager",
  administrator: "Administrator",
};

export const TERM_LABEL: Record<Client["paymentTerm"], string> = {
  custom: "Custom",
  upon_receipt: "Due upon receipt",
  net_15: "Net 15",
  net_30: "Net 30",
  net_45: "Net 45",
  net_60: "Net 60",
};

/** Days added to the issue date to get the due date. */
export const TERM_DAYS: Record<Client["paymentTerm"], number> = {
  // Overridden by `paymentTermDays` on the client; this is only the fallback.
  custom: 30,
  upon_receipt: 0, net_15: 15, net_30: 30, net_45: 45, net_60: 60,
};

export const BILLING_TYPE_LABEL: Record<BillingType, string> = {
  time_and_materials: "Time & Materials",
  fixed_fee: "Fixed Fee",
  non_billable: "Non-Billable",
};

export const SUBMISSION_LABEL: Record<SubmissionState, string> = {
  draft: "Not submitted",
  submitted: "Awaiting approval",
  approved: "Approved",
  changes_requested: "Changes requested",
};

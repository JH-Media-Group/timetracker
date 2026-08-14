/**
 * Capabilities.
 *
 * Authorization is capability-based, never role-name-based. Code asks
 * `assertCan(ctx, "invoice:manage")`; it never asks "is this person Accounting".
 * The difference matters the first time somebody needs a custom profile: with
 * capabilities that is a data change, with role names it is a code change in
 * forty places.
 *
 * This file is imported by the client too, for the capability-driven UI, so it
 * stays free of server-only imports.
 */

export const CAPABILITIES = [
  "time:create_own",
  "time:edit_own",
  "time:delete_own",
  "time:view_others",
  "time:edit_others",
  "time:delete_others",
  "expense:create_own",
  "expense:edit_own",
  "expense:delete_own",
  "expense:view_others",
  "expense:edit_others",
  "expense:delete_others",
  "expense:manage",
  "approval:submit",
  "approval:review",
  "approval:review_all",
  "project:view",
  "project:manage",
  // Reserved by BACKEND_PRD 7.2 for a narrower project role than Project
  // Manager. No base profile grants it; a custom profile may.
  "project:manage_own",
  "project:archive",
  "client:view",
  "client:manage",
  "task:manage",
  "people:view",
  "people:manage",
  "people:invite",
  "rates:view_billable",
  "rates:view_cost",
  "rates:manage",
  "invoice:view",
  "invoice:manage",
  "invoice:send",
  "invoice:delete",
  "report:view_own",
  "report:view_team",
  "report:view_all",
  "report:view_financial",
  "settings:manage",
  "integrations:manage",
  "audit:view",
  "bulk:execute",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export const isCapability = (v: string): v is Capability => (CAPABILITIES as readonly string[]).includes(v);

/* ------------------------------------------------------------- profiles */

/** Everyone can do these, whatever their profile. */
const EVERYONE: Capability[] = [
  "time:create_own",
  "time:edit_own",
  "time:delete_own",
  "expense:create_own",
  "expense:edit_own",
  "expense:delete_own",
  "approval:submit",
  "project:view",
  "client:view",
  "people:view",
  "report:view_own",
];

export type BaseProfileKey =
  | "member"
  | "project_manager"
  | "people_admin"
  | "accounting"
  | "executive_manager"
  | "administrator";

export interface ProfileDefinition {
  name: string;
  description: string;
  capabilities: readonly Capability[];
  /**
   * How far "others" reaches. `team` means through user_managed_users and
   * project_members.is_manager; `all` means the whole account.
   */
  othersScope: "none" | "team" | "all";
}

export const BASE_PROFILES: Record<BaseProfileKey, ProfileDefinition> = {
  member: {
    name: "Member",
    description: "Tracks their own time and expenses. Sees nobody else's money.",
    othersScope: "none",
    capabilities: [...EVERYONE],
  },

  project_manager: {
    name: "Project Manager",
    description: "Runs projects and clients, and reviews time for the people they manage.",
    othersScope: "team",
    capabilities: [
      ...EVERYONE,
      // "team" reach over the whole time-others group, per the 7.2 matrix.
      "time:view_others",
      "time:edit_others",
      "time:delete_others",
      "expense:view_others",
      "expense:edit_others",
      "expense:delete_others",
      "expense:manage",
      "approval:review",
      "project:manage",
      "project:archive",
      "client:manage",
      "task:manage",
      "report:view_team",
      "bulk:execute",
    ],
  },

  people_admin: {
    name: "People Admin",
    description: "Manages people, capacity, and approvals across the whole account.",
    othersScope: "all",
    capabilities: [
      ...EVERYONE,
      "time:view_others",
      "time:edit_others",
      "time:delete_others",
      "expense:view_others",
      "expense:edit_others",
      "expense:delete_others",
      "expense:manage",
      "approval:review",
      "approval:review_all",
      "people:manage",
      "people:invite",
      "report:view_team",
      "bulk:execute",
    ],
  },

  accounting: {
    name: "Accounting",
    description: "Invoices, payments, and the financial reports. No cost rates.",
    // Account-wide for the money they own, but the matrix in BACKEND_PRD 7.2
    // deliberately gives Accounting no "time others" reach: invoicing works from
    // aggregated uninvoiced value under invoice:manage and report:view_financial,
    // not from reading individual people's timesheets.
    othersScope: "all",
    capabilities: [
      ...EVERYONE,
      "expense:manage",
      "client:manage",
      "rates:view_billable",
      "invoice:view",
      "invoice:manage",
      "invoice:send",
      "invoice:delete",
      "report:view_all",
      "report:view_financial",
      "bulk:execute",
    ],
  },

  executive_manager: {
    name: "Executive Manager",
    description: "Everything except account settings, cost rates, and the audit log.",
    othersScope: "all",
    capabilities: [
      ...EVERYONE,
      "time:view_others",
      "time:edit_others",
      "time:delete_others",
      "expense:view_others",
      "expense:edit_others",
      "expense:delete_others",
      "expense:manage",
      "approval:review",
      "approval:review_all",
      "project:manage",
      "project:archive",
      "client:manage",
      "task:manage",
      "people:manage",
      "people:invite",
      "rates:view_billable",
      "invoice:view",
      "invoice:manage",
      "invoice:send",
      "invoice:delete",
      "report:view_all",
      "report:view_financial",
      "bulk:execute",
    ],
  },

  administrator: {
    name: "Administrator",
    description: "Everything, including cost rates, settings, and the audit log.",
    othersScope: "all",
    capabilities: [...CAPABILITIES],
  },
};

export const BASE_PROFILE_KEYS = Object.keys(BASE_PROFILES) as BaseProfileKey[];

/** The reach of "others" for a profile, used to build scope predicates. */
export function othersScopeFor(baseKey: string | null | undefined): "none" | "team" | "all" {
  if (!baseKey) return "none";
  return BASE_PROFILES[baseKey as BaseProfileKey]?.othersScope ?? "none";
}

/**
 * The exact field list a project with `report_visibility = 'everyone'` exposes
 * to an assigned person who would otherwise see nothing (BACKEND_PRD 7.4).
 *
 * Exported so the serializer and the frontend's "What will people see?" popover
 * render from one constant. If the promise and the enforcement can drift, they
 * will.
 */
export const OPEN_PROJECT_REPORT_FIELDS = [
  "total_hours",
  "billable_hours",
  "non_billable_hours",
  "hours_by_task",
  "hours_by_person",
  "budget_percent_used",
] as const;

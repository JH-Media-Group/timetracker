/**
 * Every setting is read by something (TALLY-33).
 *
 * THE BUG THIS EXISTS FOR
 *
 * A setting that is stored, editable, serialized to the browser, and consulted
 * by nothing. It saves. It reloads showing the new value. It changes nothing.
 * No test fails, because there is no code to test, and the screen is a promise
 * the product does not keep.
 *
 * Three of these were found in this codebase, and the third was found while
 * reviewing the ticket written about the second:
 *
 *   1. `budgetAlertPercent`  editable on the project editor, alerts nobody
 *   2. `invoiceDefaults`, `invoiceAppearance`, `invoiceMessages`,
 *      `invoiceFieldLabels`  four jsonb columns read only by their own writer
 *   3. `invoice_item_types`  a designed table, a foreign key into it, no rows
 *
 * Prose did not stop it. `tests/routes.test.ts` proved the shape that does:
 * enumerate the thing structurally, require each entry to be either satisfied
 * or exempted **with a written reason**, and make adding an exemption an
 * uncomfortable enough edit that connecting the setting is easier.
 *
 * HOW "CONSUMED" IS DECIDED
 *
 * A setting is consumed when its name appears somewhere that is not plumbing.
 * Plumbing is the fixed list below: the schema that declares it, the serializer
 * that ships it, the services that read and write the settings row, the request
 * schemas, the seam, and the screens that edit it. Every one of those files
 * mentions a setting without doing anything with it.
 *
 * That is a coarse test. It cannot tell a real use from a mention, and it does
 * not try to: it answers "is this key spoken of anywhere except the machinery
 * for editing it", which is the exact question all three failures got wrong.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { FIELD_LABELS, INVOICE_APPEARANCE, INVOICE_DEFAULTS, INVOICE_MESSAGES } from "@/domain/invoice-config";

const root = process.cwd();
const src = join(root, "src");

/**
 * Files that mention settings without consuming them.
 *
 * Deliberately a list of paths rather than a pattern: a new file that reads a
 * setting should count as a consumer by default, and a new piece of plumbing is
 * rare enough to be worth adding by hand.
 */
const PLUMBING = new Set([
  "src/server/db/schema.ts",
  "src/server/serialize.ts",
  "src/server/schemas.ts",
  "src/server/services/settings.ts",
  "src/server/services/invoice-config.ts",
  "src/domain/invoice-config.ts",
  "src/lib/api.ts",
  "src/lib/types.ts",
  "src/mock/seed.ts",
  "src/app/settings/page.tsx",
  "src/app/api/v1/settings/route.ts",
  "src/app/api/v1/settings/invoice-config/route.ts",
  "src/components/app/providers.tsx",
]);

/**
 * Settings that are stored on purpose and read by nothing yet.
 *
 * Each needs a reason, and the reason has to name what would consume it. An
 * entry here is a debt that is written down, which is the whole difference
 * between this and the three failures above.
 */
const EXEMPT: Record<string, string> = {
  qboIncomeAccountId:
    "Maps an item type to a QuickBooks income account. Nothing reads it until the " +
    "QuickBooks integration exists (TALLY-4). The Harvest import may carry values " +
    "into it before then, which is why the column stays.",
  logoKey:
    "The object-storage key for the invoice logo. Uploads need Spaces credentials " +
    "(TALLY-21); until then there is no key to read and the Appearance section says so.",
  fiscalYearStartMonth:
    "Reporting periods are calendar-year today. The fiscal-year report grouping in " +
    "FRONTEND_PRD section 11 is the consumer, and it is not built.",
  projectNotesVisibility:
    "Found by this check on its first run, and it is a fourth instance of exactly the " +
    "pattern the check was written for: the setting chooses who may see project notes, " +
    "and project notes do not exist. There is no column on `projects` and nothing " +
    "renders them. Either the feature gets built or the setting comes out, and both " +
    "are outside the invoicing epic.",
  invoiceMessages:
    "The send, reminder and thank-you email bodies. Stored and editable now so the " +
    "wording is ready and reviewable, but nothing sends mail until SendGrid " +
    "credentials arrive (TALLY-19). The Messages screen says so on the screen rather " +
    "than implying the mail goes out.",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts)$/.test(entry)) out.push(full);
  }
  return out;
}

const files = walk(src).map((f) => ({
  path: relative(root, f).replaceAll("\\", "/"),
  text: readFileSync(f, "utf8"),
}));

/**
 * Settings reached through a named accessor rather than by their column name.
 *
 * `roundingMinutes` is never mentioned outside the settings service, because
 * `roundingRule()` exists so callers take the whole rule instead of assembling
 * it from two columns. Searching for the column name would call that unconsumed,
 * which is wrong, and would push somebody to inline the column purely to satisfy
 * a test. That is a worse codebase for a greener test.
 *
 * The indirection is allowed; the accessor still has to be **called** somewhere
 * outside the plumbing. What stays banned is a setting nothing reaches by either
 * route.
 */
const ACCESSORS: Record<string, string> = {
  roundingMinutes: "roundingRule",
  roundingMode: "roundingRule",
  timezone: "accountTimezone",
  weekStartsOn: "weekStartsOn",
  modules: "moduleEnabled",
  invoiceFieldLabels: "invoiceLabels",
  invoiceAppearance: "invoiceAppearance",
  invoiceDefaults: "invoiceDefaults",
};

const consumers = (key: string) => {
  const names = [key, ACCESSORS[key]].filter((n): n is string => Boolean(n));
  return files
    .filter((f) => !PLUMBING.has(f.path))
    .filter((f) => names.some((n) => new RegExp(`\\b${n}\\b`).test(f.text)))
    .map((f) => f.path);
};

/**
 * The settings columns, read off the schema rather than listed here.
 *
 * A list would be a fourth place to forget something. Parsing the table means a
 * column added tomorrow is checked tomorrow, without anybody remembering to.
 */
function settingsColumns(): string[] {
  const schema = readFileSync(join(src, "server/db/schema.ts"), "utf8");
  const table = schema.slice(
    schema.indexOf('export const settings = pgTable("settings"'),
    schema.indexOf("export const auditLog")
  );
  const structural = new Set(["id", "updatedAt", "updatedBy"]);

  return [...table.matchAll(/^\s{2}(\w+):/gm)]
    .map((m) => m[1]!)
    .filter((name) => !structural.has(name));
}

describe("every setting is read by something", () => {
  const columns = settingsColumns();

  it("is actually reading the settings table", () => {
    // A parse that returned nothing would make every assertion below vacuous.
    expect(columns.length).toBeGreaterThan(15);
    expect(columns).toContain("invoiceFieldLabels");
    expect(columns).toContain("roundingMinutes");
  });

  it.each(columns)("%s", (column) => {
    if (EXEMPT[column]) {
      expect(EXEMPT[column].length, `${column} is exempt with an empty reason`).toBeGreaterThan(40);
      return;
    }

    expect(
      consumers(column),
      `\`${column}\` is stored and editable and nothing outside the settings plumbing ` +
        "reads it, so changing it changes nothing. Either connect it in this commit, or " +
        "add it to EXEMPT with a reason naming what would consume it."
    ).not.toEqual([]);
  });
});

describe("every invoice configuration key is read by something", () => {
  /**
   * The jsonb columns hold keys, and a key can rot the same way a column can.
   * `invoiceAppearance` being consumed says nothing about whether
   * `showUnitPrice` inside it is.
   */
  const keys = [
    ...FIELD_LABELS.map((f) => `labels.${f.key}`),
    ...Object.keys(INVOICE_DEFAULTS).map((k) => `defaults.${k}`),
    ...Object.keys(INVOICE_APPEARANCE).map((k) => `appearance.${k}`),
    ...Object.keys(INVOICE_MESSAGES).map((k) => `messages.${k}`),
  ];

  /**
   * Labels and messages are consumed as a set, not one by one.
   *
   * The document reads `labels.description`, and the emails will read every
   * message body when TALLY-19 gives them somewhere to go. Requiring an
   * individual consumer for each of twenty-nine labels would mean twenty-nine
   * exemptions, which is a list nobody reads. So the group is checked instead:
   * if the document stops reading labels at all, this fails.
   */
  const GROUP_CONSUMERS: Record<string, string> = {
    labels: "settings.invoiceLabels",
    appearance: "settings.invoiceAppearance",
    defaults: "invoiceDefaults",
    // Messages are absent on purpose. They have no consumer until something can
    // send mail, and `invoiceMessages` is exempted above with that reason. Adding
    // a fake consumer here to make the row green is the exact dishonesty this
    // file exists to prevent.
  };

  it.each(Object.entries(GROUP_CONSUMERS))("%s reaches a screen", (group, marker) => {
    const found = files
      .filter((f) => !PLUMBING.has(f.path))
      .filter((f) => f.text.includes(marker))
      .map((f) => f.path);

    expect(
      found,
      `Nothing outside the settings plumbing reads \`${marker}\`, so the ${group} ` +
        "section edits a value no invoice, PDF or email consults."
    ).not.toEqual([]);
  });

  it("names every key it is responsible for", () => {
    // Guards the lists above against silently emptying.
    expect(keys.length).toBeGreaterThan(35);
  });

  /**
   * The individually-consumed keys: the ones that switch behaviour rather than
   * text. Each of these has to be read somewhere specific, because each is a
   * separate promise.
   */
  const BEHAVIOURAL = [
    "showTotalHours",
    "showItemType",
    "showQuantity",
    "showUnitPrice",
    "showProject",
  ];

  it.each(BEHAVIOURAL)("%s changes something", (key) => {
    expect(
      consumers(key),
      `\`${key}\` is a switch that nothing reads, so turning it off changes no invoice.`
    ).not.toEqual([]);
  });
});

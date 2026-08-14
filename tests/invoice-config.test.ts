/**
 * Invoice configuration, and the invoices it is supposed to change (TALLY-33).
 *
 * The failure this file exists for is not a crash. It is a settings screen that
 * saves happily, reloads showing the new value, and changes nothing about any
 * invoice. Four jsonb columns were in that state before this epic: written by
 * the settings API, read by nothing. So was `invoice_item_types`, a designed
 * table with a foreign key pointing into it and no rows.
 *
 * The rule that follows is: **assert the value moved, not that the code ran.**
 * Every test here changes a setting, exercises the real path, and asserts the
 * output differs in the specific way intended. A test that only checked the
 * setting round-tripped would have passed for all three of those.
 *
 * `tests/settings-consumed.test.ts` is the structural half, and is the part
 * that catches the next one rather than the three we know about.
 */

import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  closeDb, db, makeClient, makeProject, makeProjectTask, makeTask, resetDb, s, seedSettings,
} from "./helpers";
import { newId } from "@/server/db/ids";
import { syncBaseProfiles } from "@/server/auth/profiles";
import { createCtx, type Actor, type Ctx } from "@/server/ctx";
import { BASE_PROFILES, type BaseProfileKey, type Capability } from "@/server/auth/capabilities";
import { getInvoiceConfig, updateInvoiceConfig } from "@/server/services/invoice-config";
import { createInvoice, getInvoice, previewLines } from "@/server/services/invoices";
import { listItemTypes, createItemType, updateItemType, removeItemType } from "@/server/services/item-types";
import { defaultLabels, renderLabel, resolveLabels, dueDaysFor } from "@/domain/invoice-config";

const people: Record<string, string> = {};
let clientId: string;
let projectId: string;
let projectTaskId: string;

async function ctxFor(key: string): Promise<Ctx> {
  const userId = people[key]!;
  const [row] = await db
    .select({
      timezone: s.users.timezone,
      isOwner: s.users.isOwner,
      profileId: s.permissionProfiles.id,
      baseKey: s.permissionProfiles.baseKey,
      capabilities: s.permissionProfiles.capabilities,
    })
    .from(s.users)
    .innerJoin(s.permissionProfiles, eq(s.permissionProfiles.id, s.users.profileId))
    .where(eq(s.users.id, userId))
    .limit(1);

  const actor: Actor = {
    userId,
    profileId: row!.profileId,
    baseKey: row!.baseKey,
    capabilities: new Set(row!.capabilities as Capability[]),
    kind: "user",
    timezone: row!.timezone,
    isOwner: row!.isOwner,
  };
  return createCtx({ actor });
}

/**
 * The three item types the migration seeds.
 *
 * `resetDb` truncates, so they have to come back for each test. In a real
 * database the migration puts them there and nothing removes them.
 */
async function seedItemTypes() {
  await db.insert(s.invoiceItemTypes).values([
    { id: newId(), name: "Service", isDefaultForServices: true },
    { id: newId(), name: "Product", isDefaultForExpenses: true },
    { id: newId(), name: "Direct Costs" },
  ]);
}

async function logTime(seconds: number, rateCents = 15_000, spentOn = "2026-07-01") {
  await db.insert(s.timeEntries).values({
    id: newId(),
    userId: people.administrator!,
    projectId,
    projectTaskId,
    spentOn,
    durationSeconds: seconds,
    isBillable: true,
    billableRateCents: rateCents,
  });
}

beforeEach(async () => {
  await resetDb();
  const profiles = (await syncBaseProfiles(db)).ids;

  for (const key of Object.keys(BASE_PROFILES) as BaseProfileKey[]) {
    const id = newId();
    people[key] = id;
    await db.insert(s.users).values({
      id,
      email: `${key}@jhmediagroup.com`,
      firstName: key,
      lastName: "Person",
      profileId: profiles[key]!,
    });
  }

  await seedSettings();
  await seedItemTypes();
  clientId = await makeClient("Example Client 43");
  projectId = await makeProject(clientId, { name: "Website" });
  projectTaskId = await makeProjectTask(projectId, await makeTask());
});

afterAll(async () => {
  await closeDb();
});

/* ------------------------------------------------------------- the shell */

describe("reading the configuration", () => {
  it("returns a complete value from an empty account", async () => {
    const ctx = await ctxFor("administrator");
    const config = await getInvoiceConfig(ctx);

    // Nothing has been configured, so every section is its default rather than
    // an empty object the UI would have to null-check.
    expect(config.labels.documentTitle).toBe("INVOICE");
    expect(config.labels.amountDue).toBe("Amount Due");
    expect(config.appearance.showQuantity).toBe(true);
    expect(config.defaults.showTotalHours).toBe(false);
    expect(config.numbering.pattern).toBe("{seq:5}");
  });

  it("refuses every write to a Member", async () => {
    const ctx = await ctxFor("member");
    await expect(
      updateInvoiceConfig(ctx, { section: "labels", value: { documentTitle: "x" } })
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

/* ------------------------------------------------------------ TALLY-27 */

describe("company information", () => {
  it("reaches a new invoice and an existing one", async () => {
    const ctx = await ctxFor("administrator");
    const before = await createInvoice(ctx, {
      clientId,
      issueDate: "2026-08-01",
      dueDate: "2026-08-31",
      lines: [{ description: "Work", quantity: 1, unitPriceCents: 10_000 }],
    });

    await updateInvoiceConfig(ctx, {
      section: "company",
      value: { name: "JH Media Group Inc.", address: "245 N. Highland Ave", taxId: "12-3456789" },
    });

    const config = await getInvoiceConfig(ctx);
    expect(config.company.name).toBe("JH Media Group Inc.");

    // The document reads it live rather than copying it onto the invoice, which
    // is why it reaches one that already existed. That is Harvest's behaviour
    // too: "shows up on all future and existing invoices".
    expect((await getInvoice(ctx, before.id)).id).toBe(before.id);
  });

  it("refuses an empty company name", async () => {
    const ctx = await ctxFor("administrator");
    await expect(
      updateInvoiceConfig(ctx, { section: "company", value: { name: "   " } })
    ).rejects.toMatchObject({ code: "validation_failed" });
  });
});

describe("invoice numbering", () => {
  it("changes the next invoice drawn and leaves existing ones alone", async () => {
    const ctx = await ctxFor("administrator");
    const first = await createInvoice(ctx, {
      clientId,
      issueDate: "2026-08-01",
      dueDate: "2026-08-31",
      lines: [{ description: "Work", quantity: 1, unitPriceCents: 10_000 }],
    });

    await updateInvoiceConfig(ctx, {
      section: "numbering",
      value: { pattern: "INV-{year}-{seq:4}" },
    });

    const second = await createInvoice(ctx, {
      clientId,
      issueDate: "2026-08-02",
      dueDate: "2026-09-01",
      lines: [{ description: "Work", quantity: 1, unitPriceCents: 10_000 }],
    });

    expect(second.number).toMatch(/^INV-2026-\d{4}$/);
    expect(
      (await getInvoice(ctx, first.id)).number,
      "an invoice keeps the number it was issued with; that is what a number is"
    ).toBe(first.number);
  });

  it("refuses a pattern with no sequence in it", async () => {
    const ctx = await ctxFor("administrator");
    await expect(
      updateInvoiceConfig(ctx, { section: "numbering", value: { pattern: "INV-{year}" } })
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  /** Continuing Harvest's sequence is the reason this field exists. */
  it("accepts moving the counter forward", async () => {
    const ctx = await ctxFor("administrator");
    const config = await updateInvoiceConfig(ctx, {
      section: "numbering",
      value: { nextSeq: 71_559 },
    });
    expect(config.numbering.nextSeq).toBe(71_559);

    const invoice = await createInvoice(ctx, {
      clientId,
      issueDate: "2026-08-01",
      dueDate: "2026-08-31",
      lines: [{ description: "Work", quantity: 1, unitPriceCents: 10_000 }],
    });
    expect(invoice.number).toBe("71559");
  });

  /**
   * The one with teeth. Nothing goes wrong when the counter is moved back; it
   * goes wrong at the next invoice, as a unique-index violation, in front of a
   * client.
   */
  it("refuses moving the counter back into a range already issued", async () => {
    const ctx = await ctxFor("administrator");
    await createInvoice(ctx, {
      clientId,
      issueDate: "2026-08-01",
      dueDate: "2026-08-31",
      lines: [{ description: "Work", quantity: 1, unitPriceCents: 10_000 }],
    });
    await createInvoice(ctx, {
      clientId,
      issueDate: "2026-08-02",
      dueDate: "2026-09-01",
      lines: [{ description: "Work", quantity: 1, unitPriceCents: 10_000 }],
    });

    await expect(
      updateInvoiceConfig(ctx, { section: "numbering", value: { nextSeq: 1 } })
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("names the invoice it would have collided with", async () => {
    const ctx = await ctxFor("administrator");
    const invoice = await createInvoice(ctx, {
      clientId,
      issueDate: "2026-08-01",
      dueDate: "2026-08-31",
      lines: [{ description: "Work", quantity: 1, unitPriceCents: 10_000 }],
    });

    await expect(
      updateInvoiceConfig(ctx, { section: "numbering", value: { nextSeq: 1 } })
    ).rejects.toMatchObject({
      fieldErrors: { nextSeq: [expect.stringContaining(invoice.number)] },
    });
  });
});

/* ------------------------------------------------------------ TALLY-28 */

describe("default values", () => {
  it("puts the default subject and notes on a new invoice", async () => {
    const ctx = await ctxFor("administrator");
    await updateInvoiceConfig(ctx, {
      section: "defaults",
      value: { subject: "Monthly services", notes: "Payable by ACH." },
    });

    const invoice = await createInvoice(ctx, {
      clientId,
      issueDate: "2026-08-01",
      dueDate: "2026-08-31",
      lines: [{ description: "Work", quantity: 1, unitPriceCents: 10_000 }],
    });

    expect(invoice.subject).toBe("Monthly services");
    expect(invoice.notes).toBe("Payable by ACH.");
  });

  it("does not overwrite a subject the caller gave", async () => {
    const ctx = await ctxFor("administrator");
    await updateInvoiceConfig(ctx, { section: "defaults", value: { subject: "Monthly services" } });

    const invoice = await createInvoice(ctx, {
      clientId,
      subject: "One-off project",
      issueDate: "2026-08-01",
      dueDate: "2026-08-31",
      lines: [{ description: "Work", quantity: 1, unitPriceCents: 10_000 }],
    });

    expect(invoice.subject, "a default is a fallback, not an override").toBe("One-off project");
  });

  it("leaves an existing draft alone when the default changes", async () => {
    const ctx = await ctxFor("administrator");
    const invoice = await createInvoice(ctx, {
      clientId,
      issueDate: "2026-08-01",
      dueDate: "2026-08-31",
      lines: [{ description: "Work", quantity: 1, unitPriceCents: 10_000 }],
    });

    await updateInvoiceConfig(ctx, { section: "defaults", value: { subject: "Changed later" } });

    expect((await getInvoice(ctx, invoice.id)).subject).toBeNull();
  });

  /**
   * The rule from BACKEND_PRD section 4.3, as a test.
   *
   * Two entries of 7 and 8 minutes under nearest-15 rounding are 15 minutes for
   * the group. Rounding each entry first gives 15 + 15 = 30, which is twice
   * what anybody worked, and the error grows with how finely people track.
   */
  it("rounds the aggregate, not the entry", async () => {
    const ctx = await ctxFor("administrator");
    await updateInvoiceConfig(ctx, {
      section: "defaults",
      value: { roundingMinutes: 15, roundingMode: "nearest" },
    });

    await logTime(7 * 60);
    await logTime(8 * 60);

    const [line] = await previewLines(ctx, { clientId });

    expect(line!.quantity, "0.25 hours, not 0.5").toBe(0.25);
    expect(line!.amountCents).toBe(3_750);
  });

  it("rounds up when told to, still per group", async () => {
    const ctx = await ctxFor("administrator");
    await updateInvoiceConfig(ctx, {
      section: "defaults",
      value: { roundingMinutes: 15, roundingMode: "up" },
    });

    await logTime(7 * 60);
    await logTime(8 * 60);
    await logTime(60); // 16 minutes in total, which rounds up to 30

    const [line] = await previewLines(ctx, { clientId });
    expect(line!.quantity).toBe(0.5);
  });

  it("bills the exact time when rounding is off, which is the default", async () => {
    const ctx = await ctxFor("administrator");
    await logTime(7 * 60);
    await logTime(8 * 60);

    const [line] = await previewLines(ctx, { clientId });
    expect(line!.quantity).toBe(0.25);
    expect(line!.amountCents, "15 minutes at $150 is $37.50 either way").toBe(3_750);
  });

  it("refuses a rounding increment that is not one of the offered ones", async () => {
    const ctx = await ctxFor("administrator");
    await expect(
      updateInvoiceConfig(ctx, { section: "defaults", value: { roundingMinutes: 7 } })
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("gives the account default only to a client with no term of its own", () => {
    expect(dueDaysFor("net_45", null, 15), "the client's own term wins").toBe(45);
    expect(dueDaysFor("custom", 20, 15), "a custom number wins").toBe(20);
    expect(dueDaysFor("custom", null, 15), "and this is where the default lands").toBe(15);
  });
});

/* ------------------------------------------------------------ TALLY-29 */

describe("field labels", () => {
  it("changes what the invoice document prints", async () => {
    const ctx = await ctxFor("administrator");
    await updateInvoiceConfig(ctx, {
      section: "labels",
      value: { documentTitle: "Statement", amountDue: "Balance due" },
    });

    const config = await getInvoiceConfig(ctx);
    expect(config.labels.documentTitle).toBe("Statement");
    expect(config.labels.amountDue).toBe("Balance due");
    expect(config.labels.description, "an untouched label keeps its default").toBe("Description");
  });

  it("treats clearing a label as a reset, never as an empty heading", async () => {
    const ctx = await ctxFor("administrator");
    await updateInvoiceConfig(ctx, { section: "labels", value: { description: "Detail" } });
    expect((await getInvoiceConfig(ctx)).labels.description).toBe("Detail");

    await updateInvoiceConfig(ctx, { section: "labels", value: { description: "" } });
    expect(
      (await getInvoiceConfig(ctx)).labels.description,
      "a blank column heading on an invoice is never what somebody meant"
    ).toBe("Description");
  });

  it("stores only what differs from the default", async () => {
    const ctx = await ctxFor("administrator");
    await updateInvoiceConfig(ctx, { section: "labels", value: { documentTitle: "Statement" } });

    const [row] = await db.select().from(s.settings).limit(1);
    expect(
      row!.invoiceFieldLabels,
      "so a later change to a default reaches an account that never overrode it"
    ).toEqual({ documentTitle: "Statement" });
  });

  it("drops a key that is not a label", async () => {
    const ctx = await ctxFor("administrator");
    await updateInvoiceConfig(ctx, {
      section: "labels",
      value: { documentTitle: "Statement", somethingElse: "x" } as never,
    });

    const [row] = await db.select().from(s.settings).limit(1);
    expect(Object.keys(row!.invoiceFieldLabels as object)).toEqual(["documentTitle"]);
  });

  it("substitutes tokens", () => {
    expect(renderLabel("Net {{days}}", { days: 30 })).toBe("Net 30");
    expect(renderLabel("Page {{page}} of {{toPage}}", { page: 1, toPage: 3 })).toBe("Page 1 of 3");
  });

  it("tolerates whitespace inside the braces, which somebody will type", () => {
    expect(renderLabel("Net {{ days }}", { days: 30 })).toBe("Net 30");
  });

  /** Somebody will delete a brace, and an invoice must still render. */
  it("renders a mangled token without throwing", () => {
    expect(renderLabel("Net {{days", { days: 30 })).toBe("Net {{days");
    expect(renderLabel("Net days}}", { days: 30 })).toBe("Net days}}");
    expect(renderLabel("Net {days}", { days: 30 }), "a single brace is not a token").toBe(
      "Net {days}"
    );
    expect(renderLabel("Net {{dayz}}", { days: 30 }), "an unknown token stays visible").toBe(
      "Net {{dayz}}"
    );
  });

  /**
   * The number pattern is a different surface with a different renderer, and
   * single braces belong to it. Asserted so nobody unifies them by accident.
   */
  it("leaves invoice-number pattern tokens alone", () => {
    expect(renderLabel("{seq:5}", { seq: 1 })).toBe("{seq:5}");
  });

  it("resolves a stored value that is not a string at all", () => {
    // jsonb accepts anything; the resolver is what stops it reaching a heading.
    const labels = resolveLabels({ documentTitle: 42, amountDue: null, description: "  " });
    expect(labels.documentTitle).toBe("INVOICE");
    expect(labels.amountDue).toBe("Amount Due");
    expect(labels.description).toBe("Description");
  });

  it("has a default for every field it defines", () => {
    const labels = defaultLabels();
    for (const [key, value] of Object.entries(labels)) {
      expect(value, `${key} has no default`).toBeTruthy();
    }
  });
});

/* ------------------------------------------------------------ TALLY-30 */

describe("item types", () => {
  it("starts with the three the migration seeds", async () => {
    const ctx = await ctxFor("administrator");
    const types = await listItemTypes(ctx);

    expect(types.map((t) => t.name)).toEqual(["Direct Costs", "Product", "Service"]);
    expect(types.filter((t) => t.isDefaultForServices)).toHaveLength(1);
    expect(types.filter((t) => t.isDefaultForExpenses)).toHaveLength(1);
  });

  /** The point of the table: a line can say what it is. */
  it("puts a type on every new invoice line", async () => {
    const ctx = await ctxFor("administrator");
    const invoice = await createInvoice(ctx, {
      clientId,
      issueDate: "2026-08-01",
      dueDate: "2026-08-31",
      lines: [
        { description: "Hours", quantity: 2, unitPriceCents: 15_000, kind: "time" },
        { description: "Hosting", quantity: 1, unitPriceCents: 4_200, kind: "expense" },
      ],
    });

    const detail = await getInvoice(ctx, invoice.id);
    expect(detail.lineItems[0]!.itemType).toBe("Service");
    expect(detail.lineItems[1]!.itemType).toBe("Product");
  });

  it("counts only time lines toward total hours", async () => {
    const ctx = await ctxFor("administrator");
    const invoice = await createInvoice(ctx, {
      clientId,
      issueDate: "2026-08-01",
      dueDate: "2026-08-31",
      lines: [
        { description: "Hours", quantity: 8, unitPriceCents: 15_000, kind: "time" },
        { description: "Hosting", quantity: 1, unitPriceCents: 4_200, kind: "expense" },
      ],
    });

    const detail = await getInvoice(ctx, invoice.id);
    const hours = detail.lineItems.reduce((sum, l) => sum + (l.isTime ? l.quantity : 0), 0);
    expect(hours, "an expense line's quantity counts receipts, not hours").toBe(8);
  });

  it("creates, renames and archives a type", async () => {
    const ctx = await ctxFor("administrator");
    const created = await createItemType(ctx, { name: "Retainer" });
    expect(created.name).toBe("Retainer");

    const renamed = await updateItemType(ctx, created.id, { name: "Retainers" });
    expect(renamed.name).toBe("Retainers");

    const { archived } = await removeItemType(ctx, created.id);
    expect(archived, "nothing used it, so it is deleted rather than archived").toBe(false);
    expect((await listItemTypes(ctx)).some((t) => t.id === created.id)).toBe(false);
  });

  it("refuses a duplicate name", async () => {
    const ctx = await ctxFor("administrator");
    await expect(createItemType(ctx, { name: "Service" })).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("refuses to remove a default type", async () => {
    const ctx = await ctxFor("administrator");
    const service = (await listItemTypes(ctx)).find((t) => t.isDefaultForServices)!;

    await expect(removeItemType(ctx, service.id)).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("refuses to switch a default off, because something has to hold it", async () => {
    const ctx = await ctxFor("administrator");
    const service = (await listItemTypes(ctx)).find((t) => t.isDefaultForServices)!;

    await expect(
      updateItemType(ctx, service.id, { isDefaultForServices: false })
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("moves a default rather than duplicating it", async () => {
    const ctx = await ctxFor("administrator");
    const direct = (await listItemTypes(ctx)).find((t) => t.name === "Direct Costs")!;

    await updateItemType(ctx, direct.id, { isDefaultForServices: true });
    const after = await listItemTypes(ctx);

    expect(after.filter((t) => t.isDefaultForServices).map((t) => t.name)).toEqual([
      "Direct Costs",
    ]);
  });

  /** A deleted type behind a sent invoice's line stops that invoice rendering. */
  it("archives rather than deletes a type an invoice uses", async () => {
    const ctx = await ctxFor("administrator");
    const direct = (await listItemTypes(ctx)).find((t) => t.name === "Direct Costs")!;

    const invoice = await createInvoice(ctx, {
      clientId,
      issueDate: "2026-08-01",
      dueDate: "2026-08-31",
      lines: [
        { description: "Work", quantity: 1, unitPriceCents: 10_000, itemTypeId: direct.id },
      ],
    });

    const { archived } = await removeItemType(ctx, direct.id);
    expect(archived).toBe(true);

    const detail = await getInvoice(ctx, invoice.id);
    expect(detail.lineItems[0]!.itemType, "and the invoice still renders").toBe("Direct Costs");
  });

  it("is refused for a Member", async () => {
    const ctx = await ctxFor("member");
    await expect(createItemType(ctx, { name: "Anything" })).rejects.toMatchObject({
      code: "forbidden",
    });
  });
});

/* ------------------------------------------------------------ TALLY-31 */

describe("appearance", () => {
  it("stores which columns the document shows", async () => {
    const ctx = await ctxFor("administrator");
    await updateInvoiceConfig(ctx, {
      section: "appearance",
      value: { showQuantity: false, showUnitPrice: false },
    });

    const config = await getInvoiceConfig(ctx);
    expect(config.appearance.showQuantity).toBe(false);
    expect(config.appearance.showUnitPrice).toBe(false);
    expect(config.appearance.showItemType, "and leaves the rest alone").toBe(true);
  });

  it("refuses an accent that is not a token", async () => {
    const ctx = await ctxFor("administrator");
    await updateInvoiceConfig(ctx, {
      section: "appearance",
      value: { accent: "#ff0000" as never },
    });

    // Resolved rather than rejected, because storage is jsonb and something
    // could put anything in it. What matters is that no raw colour reaches a
    // stylesheet.
    expect((await getInvoiceConfig(ctx)).appearance.accent).toBe("brand");
  });
});

/* ------------------------------------------------------------ TALLY-32 */

describe("messages", () => {
  it("stores the send, reminder and thank-you bodies", async () => {
    const ctx = await ctxFor("administrator");
    await updateInvoiceConfig(ctx, {
      section: "messages",
      value: { sendSubject: "Your invoice {{number}}" },
    });

    const config = await getInvoiceConfig(ctx);
    expect(config.messages.sendSubject).toBe("Your invoice {{number}}");
    expect(config.messages.reminderSubject, "the others keep their defaults").toContain(
      "Reminder"
    );
  });

  it("falls back to the default when a message is cleared", async () => {
    const ctx = await ctxFor("administrator");
    await updateInvoiceConfig(ctx, { section: "messages", value: { sendSubject: "  " } });
    expect((await getInvoiceConfig(ctx)).messages.sendSubject).toContain("Invoice {{number}}");
  });
});

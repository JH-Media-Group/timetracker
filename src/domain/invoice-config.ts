/**
 * How invoices are configured: labels, defaults, appearance and messages.
 *
 * One module, because the alternative is three copies. The invoice document,
 * the PDF and the payment emails all need the same labels, and the PDF is the
 * document by design, so a second list of defaults would be a second place to
 * forget a field.
 *
 * Pure. Nothing here reads the database or renders anything: it turns what is
 * stored, which is partial and untrusted, into a complete value the callers can
 * use without null checks. That is the whole job, and it is worth its own file
 * because the resolution rules are where the bugs live:
 *
 *   - **Empty is not default-shaped, it IS the default.** Clearing a label
 *     falls back to the default text, never to nothing. A blank string in
 *     storage would otherwise put an empty column heading on an invoice.
 *   - **Unknown keys are dropped, not carried.** Storage is jsonb, so anything
 *     could be in there; only the keys defined here survive resolution.
 *   - **A mangled token renders as it stands.** Somebody will delete a brace
 *     from `Net {{days}}`. That should print what is left rather than throw on
 *     an invoice a client is waiting for.
 *
 * TOKEN SYNTAX
 *
 * `{{name}}`, which is Handlebars and Mustache and what most people have seen
 * before. Harvest uses `%name%` and an earlier draft here used `[name]`; both
 * work and neither is recognisable on sight. Since these templates are read and
 * edited by people rather than parsed by anything else, the familiar spelling
 * wins.
 *
 * One collision worth naming: the invoice **number** pattern uses single braces
 * (`{seq}`, `{year}`). That is a different surface with a different renderer
 * (`renderInvoiceNumber` in `domain/invoices.ts`) and the two never meet, but
 * doubling up here rather than there keeps them visually distinct as well.
 */

/* ------------------------------------------------------------ field labels */

/**
 * The labels, their defaults, and where each is used.
 *
 * Read off the Harvest screenshots, casing included. "upon receipt" and
 * "Total hours" are lowercase where their neighbours are title case, which is
 * Harvest's inconsistency rather than a transcription error, and copying it
 * keeps invoices looking the way clients have been seeing them.
 */
export const FIELD_LABELS = [
  { key: "documentTitle", name: "Document title", default: "INVOICE" },
  { key: "from", name: "From", default: "From" },
  { key: "for", name: "For", default: "Invoice For" },
  { key: "invoiceId", name: "Invoice ID", default: "Invoice ID" },
  { key: "poNumber", name: "PO number", default: "PO Number" },
  { key: "issueDate", name: "Issue date", default: "Issue Date" },
  { key: "dueDate", name: "Due date", default: "Due Date" },
  { key: "uponReceipt", name: "Upon receipt", default: "upon receipt" },
  {
    key: "netDays",
    name: "Net days",
    default: "Net {{days}}",
    hint: "Use {{days}} for the number of days.",
  },
  { key: "tax", name: "Tax", default: "Tax" },
  { key: "tax2", name: "Tax 2", default: "Tax 2" },
  { key: "discount", name: "Discount", default: "Discount" },
  { key: "subject", name: "Subject", default: "Subject" },
  { key: "itemType", name: "Item type", default: "Item Type" },
  { key: "description", name: "Description", default: "Description" },
  { key: "quantity", name: "Quantity", default: "Quantity" },
  { key: "unitPrice", name: "Unit price", default: "Unit Price" },
  { key: "amount", name: "Amount", default: "Amount" },
  { key: "subtotal", name: "Subtotal", default: "Subtotal" },
  { key: "amountDue", name: "Amount due", default: "Amount Due" },
  { key: "totalHours", name: "Total hours", default: "Total hours" },
  { key: "notes", name: "Notes", default: "Notes" },
  {
    key: "pdfPageNumbering",
    name: "PDF page numbering",
    default: "Page {{page}} of {{toPage}}",
    hint: "Use {{page}} for the current page and {{toPage}} for the total.",
  },
  { key: "fileAttachments", name: "File attachments", default: "File Attachments" },
  { key: "payments", name: "Payments", default: "Payments" },
  { key: "retainerPayments", name: "Retainer payments", default: "Retainer Payments" },
  {
    key: "invoiceLink",
    name: "Invoice link",
    default: "View and Pay Invoice Online",
    hint: "Used when linking to the invoice from an email.",
  },
  { key: "paid", name: "Paid", default: "PAID" },
  {
    key: "clientMessage",
    name: "Client message",
    default: "Thank you for your payment!",
    hint: "What the client sees after paying online.",
  },
] as const satisfies readonly { key: string; name: string; default: string; hint?: string }[];

export type FieldLabelKey = (typeof FIELD_LABELS)[number]["key"];
export type FieldLabels = Record<FieldLabelKey, string>;

const LABEL_DEFAULTS = Object.fromEntries(
  FIELD_LABELS.map((f) => [f.key, f.default])
) as FieldLabels;

/**
 * Turn what is stored into a complete set of labels.
 *
 * A key that is absent, empty, or whitespace takes its default. That last case
 * is the one worth spelling out: a person who clears the Description field
 * means "put it back", not "print nothing above the descriptions".
 */
export function resolveLabels(stored: unknown): FieldLabels {
  const raw = (stored ?? {}) as Record<string, unknown>;
  const out = { ...LABEL_DEFAULTS };

  for (const field of FIELD_LABELS) {
    const value = raw[field.key];
    if (typeof value === "string" && value.trim() !== "") out[field.key] = value;
  }
  return out;
}

/** The defaults on their own, for a Reset action and for tests. */
export const defaultLabels = (): FieldLabels => ({ ...LABEL_DEFAULTS });

/**
 * Substitute `{{token}}` placeholders in a label or a message.
 *
 * Whitespace inside the braces is tolerated, because somebody will type
 * `{{ days }}`. Unknown tokens are left alone rather than blanked, so a typo
 * stays visible and fixable instead of silently producing "Net ". An unclosed
 * brace simply does not match and the text renders as written: this must never
 * throw, because it runs while somebody is looking at an invoice.
 */
export function renderLabel(template: string, tokens: Record<string, string | number>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, token: string) =>
    token in tokens ? String(tokens[token]) : whole
  );
}

/** The payment-term label a client's terms produce: "upon receipt" or "Net 30". */
export function paymentTermLabel(labels: FieldLabels, days: number | null | undefined): string {
  if (days == null || days <= 0) return labels.uponReceipt;
  return renderLabel(labels.netDays, { days });
}

/* --------------------------------------------------------------- defaults */

/**
 * Note what is NOT here: time rounding.
 *
 * Harvest files it on this screen, and its own hint says it "controls rounding
 * in summary time reports and invoices" - one rule, two consumers. We already
 * have that rule as `settings.roundingMinutes` and `settings.roundingMode`,
 * which the summary reports read. Adding a second copy here would leave two
 * rounding settings where only one is consulted, which is precisely the failure
 * TALLY-33 exists to stop, reintroduced in a new place.
 *
 * So the Default values screen edits those columns, and this type does not
 * carry them.
 */
export interface InvoiceDefaults {
  showTotalHours: boolean;
  /** Days after issue an invoice is due, when the client has no term of its own. */
  paymentTermDays: number;
  subject: string;
  notes: string;
}

export const INVOICE_DEFAULTS: InvoiceDefaults = {
  showTotalHours: false,
  paymentTermDays: 15,
  subject: "",
  notes: "",
};

/** The rounding increments Harvest offers, which are the ones people expect. */
export const ROUNDING_MINUTES = [0, 1, 5, 6, 10, 15, 30, 60] as const;

export function resolveDefaults(stored: unknown): InvoiceDefaults {
  const raw = (stored ?? {}) as Partial<InvoiceDefaults>;

  return {
    showTotalHours: raw.showTotalHours === true,
    paymentTermDays:
      Number.isInteger(raw.paymentTermDays) &&
      raw.paymentTermDays! >= 0 &&
      raw.paymentTermDays! <= 365
        ? raw.paymentTermDays!
        : INVOICE_DEFAULTS.paymentTermDays,
    subject: typeof raw.subject === "string" ? raw.subject : "",
    notes: typeof raw.notes === "string" ? raw.notes : "",
  };
}

/* ------------------------------------------------------------- appearance */

/** Which optional columns the invoice document shows. */
export interface InvoiceAppearance {
  showItemType: boolean;
  showQuantity: boolean;
  showUnitPrice: boolean;
  showProject: boolean;
  /** Accent colour for the document. A token name, never a raw hex. */
  accent: "brand" | "ink" | "success" | "warning";
}

export const INVOICE_APPEARANCE: InvoiceAppearance = {
  showItemType: true,
  showQuantity: true,
  showUnitPrice: true,
  showProject: true,
  accent: "brand",
};

const ACCENTS = ["brand", "ink", "success", "warning"] as const;

export function resolveAppearance(stored: unknown): InvoiceAppearance {
  const raw = (stored ?? {}) as Partial<InvoiceAppearance>;
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);

  return {
    showItemType: bool(raw.showItemType, INVOICE_APPEARANCE.showItemType),
    showQuantity: bool(raw.showQuantity, INVOICE_APPEARANCE.showQuantity),
    showUnitPrice: bool(raw.showUnitPrice, INVOICE_APPEARANCE.showUnitPrice),
    showProject: bool(raw.showProject, INVOICE_APPEARANCE.showProject),
    accent: (ACCENTS as readonly string[]).includes(raw.accent as string)
      ? (raw.accent as InvoiceAppearance["accent"])
      : "brand",
  };
}

/* --------------------------------------------------------------- messages */

/**
 * The bodies of the emails that go with an invoice.
 *
 * Stored and editable now; delivery is TALLY-19 and needs a credential. The
 * subjects and bodies take the same `[token]` substitution as labels do.
 */
export interface InvoiceMessages {
  sendSubject: string;
  sendBody: string;
  reminderSubject: string;
  reminderBody: string;
  thanksSubject: string;
  thanksBody: string;
}

export const INVOICE_MESSAGES: InvoiceMessages = {
  sendSubject: "Invoice {{number}} from {{company}}",
  sendBody:
    "Hello {{client}},\n\nPlease find invoice {{number}} for {{amount}}, due {{dueDate}}.\n\nThank you,\n{{company}}",
  reminderSubject: "Reminder: invoice {{number}} is due {{dueDate}}",
  reminderBody:
    "Hello {{client}},\n\nThis is a reminder that invoice {{number}} for {{amount}} is due {{dueDate}}.\n\nThank you,\n{{company}}",
  thanksSubject: "Payment received for invoice {{number}}",
  thanksBody:
    "Hello {{client}},\n\nThank you for your payment of {{amount}} against invoice {{number}}.\n\n{{company}}",
};

/**
 * The tokens the message editor offers, so the screen and the sender agree.
 *
 * `link` was here and nothing filled it, so a template using it sent a client
 * the literal text `{{link}}`. It points at a client-facing pay page that does
 * not exist yet (BACKEND_PRD 3.5, Stripe). Put it back in the same change that
 * builds that page, not before: the editor offering a token is a promise that
 * the sender will substitute it, and `renderInvoiceMessage` now refuses to send
 * a message with anything left unsubstituted.
 */
export const MESSAGE_TOKENS = [
  "number",
  "client",
  "company",
  "amount",
  "dueDate",
  "issueDate",
] as const;

export function resolveMessages(stored: unknown): InvoiceMessages {
  const raw = (stored ?? {}) as Partial<InvoiceMessages>;
  const out = { ...INVOICE_MESSAGES };

  for (const key of Object.keys(INVOICE_MESSAGES) as (keyof InvoiceMessages)[]) {
    const value = raw[key];
    if (typeof value === "string" && value.trim() !== "") out[key] = value;
  }
  return out;
}

/* --------------------------------------------------------------- sections */

/**
 * The configuration sections, which the left nav and the router both read.
 *
 * E-invoicing is Harvest's eighth and PRD-OVERVIEW section 4.2 rules it out, so
 * it is absent rather than present and disabled.
 */
export const CONFIG_SECTIONS = [
  { key: "company", name: "Company information" },
  { key: "defaults", name: "Default values" },
  { key: "numbering", name: "Invoice numbering" },
  { key: "appearance", name: "Appearance" },
  { key: "messages", name: "Messages" },
  { key: "labels", name: "Field labels" },
  { key: "item-types", name: "Item types" },
] as const;

export type ConfigSection = (typeof CONFIG_SECTIONS)[number]["key"];

export const isConfigSection = (v: string): v is ConfigSection =>
  CONFIG_SECTIONS.some((s) => s.key === v);

/* ---------------------------------------------------------- payment terms */

/** How many days each named term means. `custom` defers to the client's own number. */
export const TERM_DAYS: Record<string, number> = {
  upon_receipt: 0,
  net_15: 15,
  net_30: 30,
  net_45: 45,
  net_60: 60,
};

/**
 * How many days after issue an invoice for this client is due.
 *
 * Precedence, which the Default values screen states out loud because it is not
 * guessable: **the client's own term wins, and the account default is only the
 * fallback.** A client set to Net 45 stays Net 45 when somebody changes the
 * account default to Net 15, or the setting would silently rewrite terms that
 * were agreed individually.
 *
 * The default applies where the client genuinely says nothing: a custom term
 * with no number behind it. That case used to fall through to a hard-coded 30.
 */
export function dueDaysFor(
  term: string | null | undefined,
  clientDays: number | null | undefined,
  accountDefault: number
): number {
  if (term === "custom" || term == null) {
    return clientDays != null && clientDays >= 0 ? clientDays : accountDefault;
  }
  return TERM_DAYS[term] ?? accountDefault;
}

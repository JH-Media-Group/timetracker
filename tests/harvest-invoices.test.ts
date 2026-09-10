/**
 * The invoice converter, tested against the shapes that fooled it.
 *
 * `scripts/harvest-invoices.mts` produces the only machine-readable copy of a
 * decade of invoicing that will exist once the source system is switched off.
 * Nobody is going to read a few thousand invoices to check a parser.
 *
 * Every case below is a defect that shipped, and they all share one property:
 * the run reported success. A dropped row still produced an invoice, a missed
 * discount still produced a total, and the summary said the same thing either
 * way. That is the argument for the self-checks, and this is the argument for
 * testing them: the money was only ever found because the arithmetic was made
 * to disagree out loud.
 *
 * Two of these cannot be caught by arithmetic at all, and they are the ones
 * worth guarding hardest. A client name resolved to the wrong string still
 * adds up. A write-off filed as a broken parse still adds up.
 *
 * The fixtures are `pdftotext -table` output with the spacing preserved,
 * because the column gaps are the grammar. Do not tidy the whitespace in them.
 * They are synthetic: real client names, invoice numbers and amounts stay out
 * of the repository.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { firstFields, parse, problems, setKnownClients } from "../scripts/harvest-invoices.mts";

beforeEach(() => setKnownClients([]));

/** A one-page invoice with the totals block Harvest prints when it has one. */
const SIMPLE = [
  "Invoice For  Example Client 27                       Invoice ID  90011",
  "                                                          Issue Date  01/15/2024",
  "                                                          Due Date    01/15/2024 (Net 15)",
  "Subject      Example Client 37 Research",
  "Item Type    Description                                  Quantity           Unit Price    Amount",
  "Service      Research                                     8.00               $125.00       $1,000.00",
  "Service      Reporting                                    2.56               $125.00       $320.00",
  "                                                                             Subtotal      $1,320.00",
  "                                                                             Payments      -$1,320.00",
  "                                                                      Amount Due           $0.00",
  "                                             Page 1 of 1",
].join("\n");

describe("the Harvest invoice converter", () => {
  it("reads a plain invoice and finds it consistent", () => {
    const inv = parse("90011.pdf", SIMPLE);
    expect(inv.number).toBe("90011");
    expect(inv.client).toBe("Example Client 27");
    expect(inv.terms).toBe("Net 15");
    expect(inv.lines).toHaveLength(2);
    expect(inv.subtotalCents).toBe(132_000);
    expect(inv.paymentsCents).toBe(-132_000);
    expect(inv.amountDueCents).toBe(0);
    expect(problems(inv)).toEqual([]);
  });

  it("treats a form feed as a line break", () => {
    /*
      A form feed separates pages and JavaScript does not break a line on it,
      so the first row of every continuation page arrived with the page
      marker glued to its front, failed to match at column 0, and was appended
      to the description above it. Its money vanished with it, one row per page
      break, across the whole pack.
    */
    const paged = SIMPLE.replace(
      [
        "                                                                             Subtotal      $1,320.00",
        "                                                                             Payments      -$1,320.00",
      ].join("\n"),
      [
        "\fService      Work carried over the page break                8.00               $125.00       $1,000.00",
        "                                                                             Subtotal      $2,320.00",
        "                                                                             Payments      -$2,320.00",
      ].join("\n")
    );

    const inv = parse("paged.pdf", paged);
    expect(inv.lines).toHaveLength(3);
    expect(inv.lines[2]!.description).toBe("Work carried over the page break");
    expect(inv.pages).toBe(2);
    expect(problems(inv)).toEqual([]);
  });

  it("reads Direct Costs, which is a real item type and carries the discounts", () => {
    /*
      "Direct Costs" is a real item type and the list first written for this
      parser left it out, because the list came from reading a few documents
      rather than counting the pack. It is the type that carries discounts and
      credits, so the invoices using it read high by the value of the credit.
    */
    const withDiscount = [
      "Invoice For  Example Client 16                              Invoice ID  90016-EXAMPLE",
      "                                                          Issue Date  01/15/2024",
      "Item Type     Description                                Quantity           Unit Price    Amount",
      "Service       Hosting Example Client 15              1.00               $50.00        $50.00",
      "Service       Hosting Example Client 48                       1.00               $50.00        $50.00",
      "Service       Hosting Example Client 20               1.00               $50.00        $50.00",
      "Direct Costs  Hosting Discount                           -1.00              $10.00        -$10.00",
      "                                                                            Subtotal      $140.00",
      "                                                                            Payments      -$140.00",
      "                                                                     Amount Due           $0.00",
    ].join("\n");

    const inv = parse("90016.pdf", withDiscount);
    expect(inv.lines).toHaveLength(4);
    expect(inv.lines[3]!.itemType).toBe("Direct Costs");
    expect(inv.lines[3]!.amountCents).toBe(-1_000);
    expect(problems(inv)).toEqual([]);
  });

  it("refuses an item type it does not recognise instead of swallowing it", () => {
    /*
      The guard that would have caught Direct Costs on the first run. A
      row-shaped line with an unknown type used to fall through to the
      continuation branch, where it became part of the description above it and
      took its money with it. Now it is a named rejection.
    */
    const unknown = SIMPLE.replace(
      "Service      Reporting                                    2.56               $125.00       $320.00",
      "Retainer     Drawdown                                     2.56               $125.00       $320.00"
    );

    const inv = parse("unknown.pdf", unknown);
    expect(inv.unknownTypes).toEqual(["Retainer"]);
    expect(problems(inv).join("; ")).toMatch(/unrecognised item type: Retainer/);
    // And it must not have been absorbed into the row above.
    expect(inv.lines[0]!.description).toBe("Research");
  });

  /**
   * The "Invoice For" block, which is the one field that has to match
   * something outside the PDF for the data to be loadable.
   *
   * A wrapped client name and a contact person sit in exactly the same place
   * with exactly the same shape. These two fixtures differ only in which of
   * them is a real client, so the layout cannot decide it and the client list
   * has to.
   */
  const wrapped = [
    "Invoice For  Example County Economic                      Invoice ID  1",
    "             Development                                 Issue Date  01/15/2024",
    "Item Type    Description                                 Quantity           Unit Price    Amount",
    "Service      Retainer                                    1.00               $7,500.00     $7,500.00",
    "                                                                            Subtotal      $7,500.00",
    "                                                                            Payments      -$7,500.00",
    "                                                                     Amount Due           $0.00",
  ].join("\n");

  const withContact = [
    "Invoice For  Example Health                              Invoice ID  90012",
    "             Sample Person 07                              Issue Date  01/15/2024",
    "Item Type    Description                                 Quantity           Unit Price    Amount",
    "Service      Example Service - January                           1.00               $7,500.00     $7,500.00",
    "                                                                            Subtotal      $7,500.00",
    "                                                                            Payments      -$7,500.00",
    "                                                                     Amount Due           $0.00",
  ].join("\n");

  it("joins a client name that wraps, and stops at a contact name that does not", () => {
    setKnownClients(["Example County Economic Development", "Example Health"]);
    expect(parse("1.pdf", wrapped).client).toBe("Example County Economic Development");
    expect(parse("90012.pdf", withContact).client).toBe("Example Health");
  });

  it("takes the longest prefix that is a real client, not merely the first", () => {
    // Both are in the list. The two-line name must not be truncated to the
    // one-line name that also happens to match.
    setKnownClients(["Example County", "Example County Economic Development"]);
    expect(parse("1.pdf", wrapped).client).toBe("Example County Economic Development");
  });

  it("says so when it could not settle a client name against the list", () => {
    setKnownClients(["Somebody Else"]);
    const inv = parse("90012.pdf", withContact);
    expect(inv.clientSource).toBe("first line");
    expect(inv.client).toBe("Example Health");

    setKnownClients(["Example Health"]);
    expect(parse("90012.pdf", withContact).clientSource).toBe("client list");
  });

  it("reads a total whose label carries its own rate in brackets", () => {
    /*
      Harvest prints "Discount (0.9415%)", so a pattern that wanted the money
      to follow the word itself read the discount as absent. An absent discount
      does not announce itself: the invoice simply failed its identity check by
      exactly the amount that had gone missing.
    */
    const discounted = [
      "Invoice For  Example Client 14                           Invoice ID  90013",
      "Item Type    Description                                 Quantity           Unit Price    Amount",
      "Service      Development                                 100.00             $110.00       $11,000.00",
      "                                                                            Subtotal      $11,000.00",
      "                                                                     Discount (0.9415%)   -$110.00",
      "                                                                            Payments      -$10,890.00",
      "                                                                     Amount Due           $0.00",
    ].join("\n");

    const inv = parse("90013.pdf", discounted);
    expect(inv.discountCents).toBe(-11_000);
    expect(problems(inv)).toEqual([]);
  });

  it("checks an invoice that prints no subtotal, rather than skipping it", () => {
    /*
      The source system prints a Subtotal row only when a payment exists, so a
      large minority of invoices carry none. Both self-checks were conditional
      on a subtotal being present, so those invoices were published unverified
      while the run reported nothing wrong. An invoice that cannot be checked
      has not passed.
    */
    const noSubtotal = [
      "Invoice For  Example Client 32                                       Invoice ID  90014-1",
      "Item Type    Description                                 Quantity           Unit Price    Amount",
      "Service      Website health and maintenance              1.00                 $175.00     $175.00",
      "                                                                     Amount Due           $175.00",
    ].join("\n");

    const inv = parse("90014.pdf", noSubtotal);
    expect(inv.subtotalCents).toBeNull();
    expect(problems(inv)).toEqual([]);

    // The check is real, not merely satisfied by the absence of a subtotal.
    const broken = noSubtotal.replace("$175.00     $175.00", "$175.00     $125.00");
    expect(problems(parse("broken.pdf", broken)).join("; ")).toMatch(/lines total 125\.00/);
  });

  it("catches lines that do not add up to the subtotal", () => {
    const wrong = SIMPLE.replace("Subtotal      $1,320.00", "Subtotal      $1,400.00");
    expect(problems(parse("wrong.pdf", wrong)).join("; ")).toMatch(
      /lines total 1320\.00 but subtotal says 1400\.00/
    );
  });

  it("catches a totals block that does not reach the amount due", () => {
    const wrong = SIMPLE.replace("Amount Due           $0.00", "Amount Due           $100.00");
    expect(problems(parse("wrong.pdf", wrong)).join("; ")).toMatch(
      /subtotal and payments imply 0\.00 but amount due says 100\.00/
    );
  });

  it("does not let a repeated page header become part of a description", () => {
    const repeated = SIMPLE.replace(
      "Service      Reporting                                    2.56               $125.00       $320.00",
      [
        "Service      Reporting                                    2.56               $125.00       $320.00",
        "Item Type    Description                                  Quantity           Unit Price    Amount",
      ].join("\n")
    );

    expect(parse("repeated.pdf", repeated).lines[1]!.description).toBe("Reporting");
  });

  it("stops reading line items at the totals, and keeps the notes apart", () => {
    /*
      The item loop used to run to the end of the document, so the Notes block
      fell into the continuation branch and was appended to the last line item.
      A quarter of the pack carried a description with somebody's bookkeeping
      note stuck on the end, and every one of them still passed both totals
      checks, because notes have no money in them.

      The notes are worth keeping rather than merely excluding: they are the
      only record of why several of these invoices look wrong.
    */
    const noted = [
      SIMPLE,
      "Notes",
      "Sample note with a date and a billing explanation",
      "continued on a separate line",
    ].join("\n");

    const inv = parse("noted.pdf", noted);
    expect(inv.lines).toHaveLength(2);
    expect(inv.lines[1]!.description).toBe("Reporting");
    expect(inv.notes).toBe(
      "Sample note with a date and a billing explanation continued on a separate line"
    );
    expect(problems(inv)).toEqual([]);
  });

  it("reads a client list whose quoted fields contain newlines", () => {
    /*
      The client export is "Client Name,Address" and the addresses are quoted
      and multi-line. Splitting the file on newlines invented several clients
      out of address fragments. They matched nothing, so nothing looked wrong;
      had one of them equalled the opening words of a real client, invoices
      would have been attached to the wrong account with no sign of it.
    */
    const csv = [
      "Client Name,Address",
      '"Example Client 09","Sample Person 08',
      'Sample Person 02',
      'Sample Person 11"',
      '"Example Client 24","123 Example Avenue',
      'Example City, ZZ 00000"',
      "Example Health,",
    ].join("\n");

    expect(firstFields(csv).slice(1)).toEqual([
      "Example Client 09",
      "Example Client 24",
      "Example Health",
    ]);
  });

  /*
    The three shapes the totals block can take, which is how state is derived.

    Harvest prints Subtotal and Payments only when a payment exists. With none
    it prints the line items and jumps to Amount Due, so an unpaid invoice and
    a written-off one look identical apart from the figure: the unpaid one
    still asks for the line total, the written-off one asks for nothing.

    This was read the wrong way round at first. "No subtotal, no payment,
    nothing due" was treated as a broken parse, which rejected every write-off
    in the pack, and the guess about the cause was wrong too. The source system
    settled it, and the rule is worth pinning down here because nothing in the
    arithmetic can catch getting it wrong: a misfiled write-off still adds up.
  */
  const unpaid = [
    "Invoice For  Example Client 27                       Invoice ID  90014",
    "Item Type    Description                                 Quantity           Unit Price    Amount",
    "Service      Consulting                                  4.00               $125.00       $500.00",
    "                                                                     Amount Due           $500.00",
  ].join("\n");

  const writtenOff = unpaid.replace(
    "                                                                     Amount Due           $500.00",
    "                                                                     Amount Due           $0.00"
  );

  it("calls an invoice with money still owed open", () => {
    const inv = parse("90014.pdf", unpaid);
    expect(inv.state).toBe("open");
    expect(inv.amountDueCents).toBe(50_000);
    expect(problems(inv)).toEqual([]);
  });

  it("calls a settled invoice paid", () => {
    expect(parse("90011.pdf", SIMPLE).state).toBe("paid");
  });

  it("calls a cleared invoice with no payment written off, and keeps it", () => {
    const inv = parse("90015.pdf", writtenOff);
    expect(inv.state).toBe("written off");
    // Kept, not rejected. Rejecting these lost every write-off in the pack.
    expect(problems(inv)).toEqual([]);
    // Its own line items are the only total the document offers.
    expect(inv.lines.reduce((a, l) => a + (l.amountCents ?? 0), 0)).toBe(50_000);
  });

  it("does not hold a write-off to an identity the document cannot show", () => {
    /*
      What cleared the balance was a decision, not a payment, and the invoice
      records no trace of it. Subtotal plus payments will never reach an amount
      due of zero, so applying the identity would fail every write-off for
      having been written off.
    */
    const inv = parse("90015.pdf", writtenOff);
    expect(problems(inv).join("; ")).not.toMatch(/imply/);
  });

  it("holds money as integer cents, never as a float", () => {
    // Aggregate first, divide last: the rule this repository runs on. Two
    // thousand invoices parsed as floats is how a reconciliation ends up
    // eleven cents out with nobody able to say where.
    const inv = parse("90011.pdf", SIMPLE);
    for (const line of inv.lines) {
      expect(Number.isInteger(line.amountCents)).toBe(true);
      expect(Number.isInteger(line.unitPriceCents)).toBe(true);
    }
    expect(Number.isInteger(inv.subtotalCents)).toBe(true);
  });
});

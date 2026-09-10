/* Synthetic invoice fixtures preserve parser edge cases; keep source invoices and operational results outside Git. */

import { describe, expect, it } from "vitest";
import { parse, problems } from "../scripts/harvest-invoices.mts";

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
    /* Synthetic invoice fixtures preserve parser edge cases; keep source invoices and operational results outside Git. */
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
    /* Synthetic invoice fixtures preserve parser edge cases; keep source invoices and operational results outside Git. */
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

  it("keeps a client name that wraps onto a second line", () => {
    /*
      "Example County Economic / Development" arrived as "Example County Economic". The right-hand column was stripped after the wrapped remainder
      had been appended, so the strip deleted from "Invoice ID" to the end of
      the string and took the appended half with it.
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

    expect(parse("1.pdf", wrapped).client).toBe("Example County Economic Development");
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
    /* Synthetic invoice fixtures preserve parser edge cases; keep source invoices and operational results outside Git. */
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

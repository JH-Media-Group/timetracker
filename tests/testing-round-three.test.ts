/** Regression guards for TALLY-78, Jason's third staging walkthrough. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatMoneyInput, parseMoney } from "@/lib/format";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("money inputs", () => {
  const editor = read("src/app/projects/project-editor.tsx");

  it("formats grouped dollars on blur and parses them back to the same cents", () => {
    const formatted = formatMoneyInput("5000");
    expect(formatted).toBe("5,000.00");
    expect(parseMoney(formatted)).toBe(500_000);
  });

  it("keeps empty and incomplete input honest", () => {
    expect(formatMoneyInput("")).toBe("");
    expect(formatMoneyInput("not money")).toBe("not money");
  });

  it("does not right-align any project money field", () => {
    for (const value of ["form.hourlyRate", "form.fee", "form.budgetValue"]) {
      expect(editor).not.toContain(`<Input align="right" value={${value}}`);
    }
  });
});

describe("project shortcuts and defaults", () => {
  const detail = read("src/app/projects/[id]/page.tsx");
  const editor = read("src/app/projects/project-editor.tsx");

  it("takes both project invoice actions straight to a client-prefilled draft", () => {
    expect(detail.match(/\/invoices\/new\?client=\$\{project\.clientId\}/g)).toHaveLength(2);
    expect(detail).not.toContain("/invoices?project=");
  });

  it("explains where a new project's default tasks are managed", () => {
    expect(editor).toContain("New projects start with tasks marked Common");
    expect(editor).toContain('href="/tasks"');
  });
});

describe("visual recipes", () => {
  const ratesPanel = read("src/components/app/rates-panel.tsx");
  const primitives = read("src/components/ui/primitives.tsx");
  const recipes = read("src/components/ui/recipes.ts");
  const canonicalRecipes = read("design system/recipes/recipes.ts");
  const personEditor = read("src/app/team/person-editor.tsx");

  it("contrasts the switch thumb against both track states with tokens", () => {
    expect(primitives).toContain("data-[state=unchecked]:bg-accent");
    expect(primitives).toContain("data-[state=checked]:bg-accent-ink");
  });

  it("puts the two administrator rate fields side by side at the real first breakpoint", () => {
    expect(ratesPanel).toContain("md:grid-cols-2");
    expect(ratesPanel).not.toContain("sm:grid-cols-2");
  });

  it("centres avatar initials independently of an inherited grid line-height", () => {
    expect(recipes).toContain("place-items-center");
    expect(recipes).toContain("text-[10px] leading-(--lh-none)");
    expect(recipes.replace(/\r\n/g, "\n")).toBe(canonicalRecipes.replace(/\r\n/g, "\n"));
  });

  it("aligns access badges in a labelled control-height row", () => {
    expect(personEditor).toContain('<Field label="Current access">');
    expect(personEditor).toContain('className="flex h-9 items-center gap-2"');
    expect(personEditor).not.toContain("items-end gap-2 pb-1");
  });
});

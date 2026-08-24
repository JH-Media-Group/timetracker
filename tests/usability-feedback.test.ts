/**
 * Regression coverage for the first staging usability review.
 *
 * These are presentation contracts, so the useful failure is at the source
 * boundary: labels, semantic tokens, icons, and layout classes must remain in
 * the components that own them. Browser review still checks the finished page.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8").replace(/\r\n/g, "\n");

describe("timesheet usability feedback", () => {
  const page = read("src/app/timesheet/page.tsx");
  const day = read("src/app/timesheet/day-view.tsx");

  it("separates and labels the new-entry action from trailing date navigation", () => {
    expect(page).toContain('aria-label="New entry"');
    expect(page).toContain("<Plus className=\"size-4\" />\n            New entry");
    expect(page).toContain('className="ml-auto flex flex-wrap items-center justify-end gap-2"');
    expect(page.indexOf('aria-label="New entry"')).toBeLessThan(page.indexOf('aria-label="Previous"'));
  });

  it("keeps the first-entry action at the far edge of the empty-state row", () => {
    expect(day).toContain('<Button className="ml-auto" variant="primary"');
    expect(day).toContain("Add your first entry");
  });

  it("marks start and stop times with recognizable icons", () => {
    expect(day).toContain("Play, Square");
    expect(day).toContain('fill-current text-success');
    expect(day).toContain('isRunning ? "fill-current text-live" : "text-ink-tertiary"');
  });
});

describe("live color and person-page hierarchy", () => {
  const tokens = read("src/styles/tokens.css");
  const canonicalTokens = read("design system/tokens/tokens.css");
  const recipes = read("src/components/ui/recipes.ts");
  const canonicalRecipes = read("design system/recipes/recipes.ts");
  const person = read("src/app/team/[id]/page.tsx");
  const kpi = read("src/components/app/kpi.tsx");
  const timeReport = read("src/app/reports/time-report.tsx");
  const teamReport = read("src/app/reports/team-report.tsx");

  it("uses green live-state tokens and keeps the canonical copy synchronized", () => {
    expect(tokens).toContain("--live:        light-dark(#16A34A, #4ADE80)");
    const liveLines = (source: string) => source.split("\n").filter((line) => line.trim().startsWith("--live"));
    expect(liveLines(tokens)).toEqual(liveLines(canonicalTokens));
  });

  it("keeps adjacent person actions in the standard button hierarchy", () => {
    const buttonRecipe = recipes.slice(
      recipes.indexOf("export const buttonVariants"),
      recipes.indexOf("export type ButtonVariants")
    );
    expect(buttonRecipe).not.toMatch(/\n\s+(info|success):/);
    expect(recipes.replace(/\r\n/g, "\n")).toBe(canonicalRecipes.replace(/\r\n/g, "\n"));
    expect(person).toContain('<Button variant="secondary" onClick={() => router.push(`/timesheet?user=${person.id}`)}>');
    expect(person).toContain('<Button variant="secondary" loading={invite.isPending}');
    expect(person).toContain("<Pencil");
  });

  it("keeps person metrics neutral while explaining billable share", () => {
    expect(person).not.toContain("icon={<");
    expect(kpi).toContain('aria-label={`What does ${label.toLowerCase()} mean?`}');
    expect(person).toContain('<KpiHelpLabel label="Billable share"');
    expect(timeReport).toContain('<KpiHelpLabel label="Billable share"');
    expect(teamReport).toContain('<KpiHelpLabel label="Billable share"');
    expect(timeReport).toContain('icon={<Clock');
    expect(teamReport).toContain('icon={<Gauge');
  });
});

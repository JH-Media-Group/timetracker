import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("anonymous application pages", () => {
  it.each([
    "src/components/app/providers.tsx",
    "src/components/app/timer.tsx",
    "src/components/app/shell.tsx",
  ])("keeps set-password out of authenticated client behavior in %s", (file) => {
    expect(readFileSync(file, "utf8")).toContain('"/set-password"');
  });
});

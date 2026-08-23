/**
 * A popover inside a modal Dialog must not portal to the document root.
 *
 * The rule: a modal Dialog traps focus and blocks pointer events outside its
 * own DOM subtree, so a portalled popover is dismissed the instant it opens.
 * In the product that read as "clicking on project doesn't do anything" in the
 * new time entry dialog, which is the most used dialog there is.
 *
 * The rule was already written down, twice, in careful prose on `PopoverContent`
 * and on `ProjectPicker`. Prose is not a control. It is now a default derived
 * from React context, and this file is what stops somebody passing the old
 * value back in and undoing it.
 *
 * Static, because the repo has no DOM test environment and adding jsdom to
 * assert three lines of wiring would cost more than it proves. What it can
 * check is exactly the wiring: the provider exists, the consumer reads it, and
 * nothing overrides it back to true.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");
const PRIMITIVES = join(SRC, "components/ui/primitives.tsx");

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) tsxFiles(full, out);
    else if (name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("the dialog portal rule", () => {
  const primitives = readFileSync(PRIMITIVES, "utf8");

  it("DialogContent tells its subtree that it is inside a modal dialog", () => {
    expect(primitives).toContain("const InsideDialogContext = React.createContext(false)");
    expect(primitives).toContain("<InsideDialogContext.Provider value={true}>");
  });

  it("PopoverContent decides from that rather than from a hard-coded default", () => {
    // The specific thing that must not come back is `portal = true` in the
    // parameter list, which is what shipped the bug.
    expect(primitives).not.toMatch(/PopoverContent\([^)]*portal = true/s);
    expect(primitives).toContain("const shouldPortal = portal ?? !insideDialog;");
  });

  it("Tray does not provide the context, because it traps nothing", () => {
    // A tray is modal={false} and its body scrolls, so a portalled popover is
    // both harmless and necessary there. If this ever changes, the popovers in
    // the approvals tray stop escaping the scroll container.
    const tray = primitives.slice(primitives.indexOf("function Tray"));
    expect(tray).not.toContain("InsideDialogContext.Provider");
    expect(primitives).toContain("modal={false}");
  });

  it("nobody hard-codes the portal decision at a call site", () => {
    /*
      A literal `portal={true}` or `portal={false}` in JSX, which is the shape
      that shipped the bug and the shape that would put it back. Forwarding a
      variable (`portal={portal}`) is not this: undefined forwards as unset and
      the context still decides, which is what `ProjectPicker` does so that an
      override stays possible.

      A previous version of this test matched the bare word "portal" followed
      by a space, which meant it was reading the doc comments. It passed
      because a sentence had been reworded, not because the rule held.
    */
    const offenders: string[] = [];
    for (const file of tsxFiles(SRC)) {
      if (file === PRIMITIVES) continue;
      const body = readFileSync(file, "utf8");
      if (body.includes("portal={true}") || body.includes("portal={false}")) {
        offenders.push(relative(process.cwd(), file).split(sep).join("/"));
      }
    }
    expect(offenders, "these hard-code `portal`; let the dialog context decide").toEqual([]);
  });
});

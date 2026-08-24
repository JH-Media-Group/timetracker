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
    /*
      A tray is modal={false} and its body scrolls, so a portalled popover is
      both harmless and necessary there.

      The slice is taken from a located index rather than a raw `indexOf`,
      because `indexOf` returns -1 when the name changes and `slice(-1)` is then
      the last character of the file, which contains no provider and passes.
      A reviewer pointed out that renaming Tray disarmed this silently. It also
      no longer asserts a property of file ordering: only the Tray function
      body is examined, not everything after it.
    */
    const at = primitives.indexOf("export function Tray(");
    expect(at, "Tray was renamed; this check was reading the wrong text").toBeGreaterThan(-1);

    const after = primitives.slice(at);
    const end = after.indexOf(String.fromCharCode(10) + "export ", 1);
    const tray = end === -1 ? after : after.slice(0, end);

    expect(tray).toContain("modal={false}");
    expect(tray).not.toContain("InsideDialogContext.Provider");
  });

  it("nobody hard-codes the portal decision at a call site", () => {
    /*
      Any `portal=` attribute at a call site.

      Two earlier versions of this were weaker. The first matched the bare word
      "portal" followed by a space, so it was reading the doc comments and
      passed because a sentence had been reworded. The second matched only the
      literals `portal={true}` and `portal={false}`, and a reviewer pointed out
      that `portal={force}` or `portal={Boolean(1)}` walked straight past it.

      No regex, because a backslash in this file has now been eaten three times
      by the tooling that writes it. `includes` cannot be mangled.

      One legitimate forwarder: ProjectPicker passes its own optional prop
      through, so an override stays possible. It is named rather than pattern
      matched, so a second forwarder has to be somebody's decision.
    */
    const offenders: string[] = [];
    for (const file of tsxFiles(SRC)) {
      if (file === PRIMITIVES) continue;
      if (file.endsWith("project-picker.tsx")) continue;
      if (readFileSync(file, "utf8").includes("portal={")) {
        offenders.push(relative(process.cwd(), file).split(sep).join("/"));
      }
    }
    expect(offenders, "these hard-code `portal`; let the dialog context decide").toEqual([]);
  });
});

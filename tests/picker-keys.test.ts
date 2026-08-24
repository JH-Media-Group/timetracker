/**
 * What a keystroke in the project picker does.
 *
 * This file exists because of the worst defect in the commit it was written
 * for. The handler returned early when nothing matched the search, before
 * calling `preventDefault`, and un-portalling the popover had just made the
 * search box a real descendant of the time entry form. So typing something that
 * matched no project and pressing Enter submitted the form from inside the
 * picker: an error if no project was chosen, and a saved time entry if one was.
 *
 * Neither the component nor the DOM is testable here, so the decision lives in
 * a pure function and this asserts the decision. A rule that exists only inside
 * an event handler is a rule nothing can check.
 */

import { describe, expect, it } from "vitest";
import { pickerKeyAction } from "@/lib/picker-keys";

describe("pickerKeyAction", () => {
  it("owns Enter even when nothing matches, so the form never sees it", () => {
    const action = pickerKeyAction("Enter", 0, 0);
    expect(action.handled, "an unhandled Enter submits the surrounding form").toBe(true);
    expect(action.choose, "there is nothing to choose").toBeNull();
  });

  it("chooses the highlighted row on Enter when there is one", () => {
    expect(pickerKeyAction("Enter", 5, 3)).toEqual({ handled: true, cursor: null, choose: 3 });
  });

  it("walks the list and wraps at both ends", () => {
    expect(pickerKeyAction("ArrowDown", 3, 0).cursor).toBe(1);
    expect(pickerKeyAction("ArrowDown", 3, 2).cursor).toBe(0);
    expect(pickerKeyAction("ArrowUp", 3, 0).cursor).toBe(2);
    expect(pickerKeyAction("ArrowUp", 3, 1).cursor).toBe(0);
  });

  it("leaves the arrows alone when there is no list to walk", () => {
    expect(pickerKeyAction("ArrowDown", 0, 0).handled).toBe(false);
    expect(pickerKeyAction("ArrowUp", 0, 0).handled).toBe(false);
  });

  it("does not touch any other key, so typing still reaches the search box", () => {
    for (const key of ["a", "Backspace", "Escape", "Tab", " ", "ArrowLeft"]) {
      expect(pickerKeyAction(key, 5, 0).handled, key).toBe(false);
    }
  });

  it("never returns a cursor outside the list", () => {
    for (let count = 1; count <= 6; count++) {
      for (let cursor = 0; cursor < count; cursor++) {
        for (const key of ["ArrowDown", "ArrowUp"]) {
          const next = pickerKeyAction(key, count, cursor).cursor!;
          expect(next, `${key} ${count} ${cursor}`).toBeGreaterThanOrEqual(0);
          expect(next, `${key} ${count} ${cursor}`).toBeLessThan(count);
        }
      }
    }
  });
});

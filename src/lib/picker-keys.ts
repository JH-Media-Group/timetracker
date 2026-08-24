/**
 * What a keystroke in the project picker's search box should do.
 *
 * A plain module, not part of the component, for two reasons. It is a decision
 * rather than a rendering concern. And vitest cannot parse a `.tsx` file while
 * `tsconfig.json` sets `jsx: "preserve"`, which Next requires, so a rule living
 * beside the JSX is a rule no test can reach.
 *
 * This exists because of the worst defect in the commit it was written for: the
 * handler returned early when the search matched nothing, before calling
 * `preventDefault`, and the popover had just stopped being portalled, so the
 * search box was a real descendant of the time entry form. Enter on an empty
 * result submitted that form from inside the picker.
 */

export function pickerKeyAction(
  key: string,
  count: number,
  cursor: number
): { handled: boolean; cursor: number | null; choose: number | null } {
  if (key === "Enter") {
    // Handled even with an empty list. See the note above.
    return { handled: true, cursor: null, choose: count > 0 ? cursor : null };
  }
  if (count === 0) return { handled: false, cursor: null, choose: null };
  if (key === "ArrowDown") {
    return { handled: true, cursor: (cursor + 1) % count, choose: null };
  }
  if (key === "ArrowUp") {
    return { handled: true, cursor: (cursor - 1 + count) % count, choose: null };
  }
  return { handled: false, cursor: null, choose: null };
}


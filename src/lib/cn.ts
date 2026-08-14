/**
 * Tally - class name helper
 *
 * Ships verbatim into the app at `src/lib/cn.ts`.
 *
 * `clsx` handles conditionals; `tailwind-merge` resolves conflicts so a caller's
 * `className` always wins over a recipe's default. Without the merge step,
 * `<Button className="bg-danger">` would emit both `bg-accent` and `bg-danger`
 * and the winner would depend on stylesheet order rather than on intent.
 *
 *   pnpm add clsx tailwind-merge
 */

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

"use client";

/**
 * Brand mark.
 *
 * Two files, one for each theme, swapped with the `dark:` variant rather than
 * with JavaScript. That matters: a JS swap would flash the wrong logo on first
 * paint, and the whole point of the head theme script is that nothing flashes.
 *
 * The variant is defined in theme.css and covers both the explicit
 * `data-theme="dark"` attribute and OS dark with no override, so this is correct
 * in all three theme states.
 */

import Image from "next/image";
import { cn } from "@/lib/cn";

/**
 * Full wordmark. Used in the top bar and on the sign-in screen.
 *
 * The ratio is the artwork's own viewBox, 307 by 143. It is passed to `Image`
 * so Next reserves the right box before the file arrives; getting it wrong
 * shifts the top bar as the logo loads, which is the layout shift the priority
 * flag exists to avoid. Changing the artwork means changing this number.
 */
export function Logo({ className, height = 24 }: { className?: string; height?: number }) {
  const width = Math.round(height * (307 / 143));
  return (
    <span className={cn("inline-flex shrink-0 items-center", className)} aria-label="Tally">
      <Image src="/tally-logo.svg" alt="Tally" width={width} height={height}
        priority className="block dark:hidden" style={{ height, width: "auto" }} />
      <Image src="/tally-logo-white.svg" alt="Tally" width={width} height={height}
        priority className="hidden dark:block" style={{ height, width: "auto" }} />
    </span>
  );
}

/** Square mark, for tight spaces where the wordmark will not fit. */
export function LogoMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <Image src="/tally-mark.svg" alt="Tally" width={size} height={size}
      className={cn("block shrink-0 rounded-[5px]", className)} priority />
  );
}

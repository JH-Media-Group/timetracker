/**
 * The wordmark's ratio matches the artwork, and the two files are the same
 * artwork.
 *
 * `Logo` computes its width from a hard-coded ratio because `Image` needs the
 * box before the file arrives. That number is a copy of something that lives in
 * the SVG, and a copy of a number in another file is the shape of every drift
 * problem in this repository. Swap the artwork, forget the ratio, and the top
 * bar reflows as the logo loads: a small, intermittent, hard-to-attribute jump.
 *
 * The second assertion is about the theme swap. Two files exist so the browser
 * can pick one with a CSS variant rather than JavaScript, which is what stops
 * the wrong logo flashing on first paint. That only works while they are the
 * same drawing in two colours; if they ever diverge, the app shows a different
 * logo in dark mode and nothing says so.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const LIGHT = "public/tally-logo.svg";
const DARK = "public/tally-logo-white.svg";

function viewBox(svg: string): { width: number; height: number } {
  const match = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  if (!match) throw new Error("no viewBox found");
  return { width: Number(match[1]), height: Number(match[2]) };
}

/**
 * The drawing, with the fills and the export noise taken out.
 *
 * Exporting the same artwork twice does not produce identical text: the two
 * files here differ by `12.1893` against `12.1892`, and by one coordinate
 * written as `3.72529e-06` in one and `-1.15335e-05` in the other. Both are
 * zero to any purpose, on a canvas 307 units wide. So numbers are rounded to a
 * hundredth of a unit before comparing, which is far below a pixel at any size
 * this is displayed, and comfortably above the noise.
 */
const shape = (svg: string) =>
  svg
    .replace(/fill="[^"]*"/g, "")
    .replace(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi, (n) => {
      const rounded = Math.round(Number(n) * 100) / 100;
      return String(rounded === 0 ? 0 : rounded); // normalises -0
    })
    .replace(/\s+/g, " ")
    .trim();

describe("the wordmark", () => {
  it("is drawn at the ratio the component reserves space for", () => {
    const box = viewBox(read(LIGHT));
    const component = read("src/components/app/logo.tsx");

    const ratio = component.match(/height \* \((\d+) \/ (\d+)\)/);
    expect(ratio, "Logo should compute its width from an explicit ratio").not.toBeNull();

    expect(
      [Number(ratio![1]), Number(ratio![2])],
      `the component reserves ${ratio![1]}/${ratio![2]} and the artwork is ` +
        `${box.width}/${box.height}. A mismatch reflows the top bar as the logo loads.`
    ).toEqual([box.width, box.height]);
  });

  it("ships the same drawing in both colourways", () => {
    expect(
      shape(read(DARK)),
      "the light and dark files must differ only in colour, or the app shows a " +
        "different logo in one theme"
    ).toBe(shape(read(LIGHT)));
  });

  it("is actually light-on-dark and dark-on-light", () => {
    const light = read(LIGHT);
    const dark = read(DARK);

    // The file used in the light theme carries dark ink, and vice versa. Naming
    // these the wrong way round renders the logo invisible against its own
    // background, which is the kind of thing nobody notices in review.
    expect(light, `${LIGHT} is shown on a light surface, so it needs dark ink`).not.toMatch(
      /fill="(white|#fff(fff)?)"/i
    );
    expect(dark, `${DARK} is shown on a dark surface, so it needs light ink`).toMatch(
      /fill="(white|#fff(fff)?)"/i
    );
  });

  it("is swapped by CSS rather than by JavaScript", () => {
    const component = read("src/components/app/logo.tsx");
    // A JS swap reads the theme after hydration and flashes the wrong logo on
    // first paint, which is the whole reason the theme script is render
    // blocking in the first place.
    expect(component).toContain("dark:hidden");
    expect(component).toContain("hidden dark:block");
  });
});

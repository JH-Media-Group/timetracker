/**
 * No Date reaches a raw `sql` template.
 *
 * A JS `Date` interpolated into drizzle's `sql` tag arrives at the postgres
 * driver as an object it cannot serialise, and the query throws
 * `ERR_INVALID_ARG_TYPE` at runtime. It is not a type error, so TypeScript is
 * happy; it is not a syntax error, so the build is happy; and it only fires
 * when that particular line runs. `${value.toISOString()}::timestamptz` is the
 * correct form: text, with an explicit cast so Postgres knows what it received.
 *
 * The bug has been written four times:
 *
 *   - `stopTimer`, found immediately, because stopping a timer is constant.
 *   - `purgeDeadSessions`, which nothing called, so nothing found it until the
 *     nightly sweep gave it a caller.
 *   - the rolling session touch, which runs at most once an hour per session,
 *     so every session in every test was too fresh to reach it. It survived
 *     three adversarial reviews and a production build, then 500ed every
 *     authenticated request the first time somebody stayed signed in for an
 *     hour.
 *
 * WHY THIS IS A COMPILER PASS AND NOT A REGEX
 *
 * The first version of this guard matched `new Date(` against source text to
 * guess which locals held a Date. A review took it apart: it constructed
 * fourteen evasions and verified thirteen, including a verbatim reintroduction
 * of the `purgeDeadSessions` bug into this very codebase. Function parameters,
 * object properties, destructured bindings, imported constants, `var`, values
 * from date-fns helpers, and anything inside a nested `sql` fragment all walked
 * straight past it. Worse, it deleted a name from its watch list if *any* line
 * in the file assigned that name from `.toISOString()`, so each correct fix
 * widened the hole, and its canary could not tell that the detector had died:
 * breaking both patterns deliberately still produced a green run.
 *
 * A guard that reports success while missing the cases the bug actually favours
 * is worse than no guard, because it converts "nobody has checked" into
 * "something checks this". Text matching cannot decide which values are Dates.
 * The compiler can, so ask it.
 *
 * TWO HALVES, DELIBERATELY
 *
 *   1. This file: a real TypeScript program over `src/` and `scripts/`, finding
 *      every `sql` tagged template and asking the type checker what each
 *      interpolated expression actually is. There is no pattern to evade. It
 *      covers code no test ever executes, which is where two of the four
 *      instances lived.
 *
 *   2. `src/server/db/client.ts`: under test the driver itself refuses a `Date`
 *      bind parameter, so any code path a test touches fails loudly regardless
 *      of how the value got there. Static analysis proves things about code
 *      that never runs; the runtime assertion proves things about code that
 *      does. Neither subsumes the other.
 *
 * UNPROVEN IS NOT SAFE
 *
 * An earlier version of this header said `any` and `unknown` were an
 * unclosable hole and left them passing. A reviewer pointed out that this is
 * the shape the bug most plausibly arrives in, since a value out of
 * `req.json()` or `JSON.parse` is `any`, and demonstrated `const d: any = new
 * Date()` reproducing the production failure exactly. Reporting "no Dates
 * found" when the honest answer was "no idea" is the same flattering drift this
 * file exists to stop, so `any`, `unknown`, and a generic constrained to `Date`
 * are now offences. Putting one in a query means giving it a real type first.
 *
 * WHAT IS LEFT, STATED PLAINLY
 *
 * A deliberate lie to the compiler (`d as unknown as string`) still passes
 * here, and so does `sql.raw` string concatenation, which is a different bug
 * (injection, not serialisation) and belongs to a different check. Both are
 * caught by half 2 the moment a test executes them, so the residue is code that
 * lies about its types *and* is never executed by any test.
 */

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd().replace(/\\/g, "/");

/**
 * Everywhere a query can be written.
 *
 * `scripts/` matters as much as `src/`: `purgeDeadSessions` hid because the only
 * path to it was a maintenance script, and the scripts are still where the
 * rarely-run queries live. `.mts` counts, which the previous version's
 * `endsWith(".ts")` quietly did not.
 */
const SOURCE_DIRS = ["src", "scripts"];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx|mts)$/.test(name) && !name.endsWith(".d.ts")) {
      out.push(full.replace(/\\/g, "/"));
    }
  }
  return out;
}

const roots = SOURCE_DIRS.flatMap((dir) => sourceFiles(join(ROOT, dir)));

/**
 * Built from an explicit file list rather than from tsconfig.json.
 *
 * The repository tsconfig pulls in `.next/types`, which only exists after a
 * build, so a test reading it would pass or fail depending on whether somebody
 * had run `next build` first.
 */
const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  esModuleInterop: true,
  resolveJsonModule: true,
  allowImportingTsExtensions: true,
  jsx: ts.JsxEmit.Preserve,
  baseUrl: ROOT,
  paths: { "@/*": ["./src/*"] },
};

interface Offence {
  file: string;
  line: number;
  expression: string;
}

interface Scan {
  offences: Offence[];
  templates: number;
  interpolations: number;
}

/**
 * `Date`, any union containing one, or a type that could be hiding one.
 *
 * `Date | null` is just as fatal as `Date`, so unions are flattened.
 *
 * `any` and `unknown` are treated as offences rather than waved through, which
 * is the change a reviewer's evasion list forced. It demonstrated that
 * `const d: any = new Date()` in a template reproduces the exact production
 * failure, and that `any` is how the value most plausibly arrives: out of
 * `req.json()`, out of `JSON.parse`, out of any untyped helper. Passing those
 * because the compiler could not prove anything would be reporting "no Dates
 * found" when the honest answer is "no idea".
 *
 * The cost is that an unavoidable `any` has to be given a real type or a cast
 * before it can go in a query, which is a fair price and usually an improvement
 * on its own.
 */
function mentionsDate(checker: ts.TypeChecker, type: ts.Type): boolean {
  const parts = type.isUnion() ? type.types : [type];
  return parts.some((part) => {
    if (part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;

    const symbol = part.getSymbol() ?? part.aliasSymbol;
    if (symbol?.getName() === "Date") return true;

    // A generic parameter constrained to Date is a Date at every call site.
    if (part.flags & ts.TypeFlags.TypeParameter) {
      const constraint = checker.getBaseConstraintOfType(part);
      if (constraint && mentionsDate(checker, constraint)) return true;
    }

    // An intersection is a Date if any member is (`Date & { brand }`).
    if (part.isIntersection()) return part.types.some((m) => mentionsDate(checker, m));

    // A Date behind a type alias still prints as Date.
    return checker.typeToString(part) === "Date";
  });
}

/**
 * Every interpolation into a `sql` template, with the checker's verdict on it.
 *
 * Walking the AST rather than the text is what closes the nested-fragment hole:
 * `sql`${sql`1 = 1`} AND x > ${cutoff}`` is two template nodes to the parser and
 * was a truncated regex match to the previous version, which never saw the
 * second interpolation at all.
 */
function scan(program: ts.Program, include: (fileName: string) => boolean): Scan {
  const checker = program.getTypeChecker();
  const offences: Offence[] = [];
  let templates = 0;
  let interpolations = 0;

  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || !include(file.fileName)) continue;

    const visit = (node: ts.Node): void => {
      if (ts.isTaggedTemplateExpression(node)) {
        /**
         * Every tagged template, without looking at the tag.
         *
         * An earlier version matched the tag text against `sql` and `sql.*`,
         * which a reviewer evaded with `const q = sql; q\`...\`` and with a
         * re-export under another name. Resolving the tag properly through the
         * checker is possible but fiddly, and it turns out to be unnecessary:
         * this codebase contains exactly three tag names across 191 tagged
         * templates, and all three are database tags. `sql` is drizzle's, `tx`
         * is postgres.js's inside the migration runner, and `raw` is the
         * destructured `sql.raw` in the seed. There is no styled-components, no
         * graphql tag, nothing that legitimately takes a Date.
         *
         * So the question "is this the sql tag" is dropped entirely. A Date in
         * any tagged template here is wrong, and a tag that does not exist
         * cannot be aliased into.
         */
        templates++;
        if (ts.isTemplateExpression(node.template)) {
          for (const span of node.template.templateSpans) {
            interpolations++;
            if (mentionsDate(checker, checker.getTypeAtLocation(span.expression))) {
              offences.push({
                file: relative(ROOT, file.fileName).replace(/\\/g, "/"),
                line: file.getLineAndCharacterOfPosition(span.expression.getStart(file)).line + 1,
                expression: span.expression.getText(file),
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(file);
  }

  return { offences, templates, interpolations };
}

const program = ts.createProgram(roots, COMPILER_OPTIONS);
const result = scan(program, (fileName) => roots.includes(fileName));

describe("raw sql templates", () => {
  /**
   * The positive control.
   *
   * The previous guard's canary only counted files containing the substring
   * "sql`", which stays true forever whether or not the detector works: a
   * reviewer broke both of its patterns deliberately and the suite stayed
   * green. So this runs the real pipeline over a known-bad fixture and insists
   * it catches it. If this passes and the file below is empty, the emptiness
   * means something.
   *
   * The fixture deliberately uses the shapes that evaded the regex, so this
   * also documents what the guard is now expected to cover.
   */
  it("catches the shapes it claims to, on a known-bad fixture", () => {
    const fixture = `
      // The tag returns a concrete fragment type, as drizzle's does. Declaring
      // it as returning unknown would make every nested fragment an offence
      // under the any/unknown rule, which is a property of the fixture rather
      // than of the codebase.
      interface Fragment { readonly sqlFragment: true }
      declare const sql: (s: TemplateStringsArray, ...v: unknown[]) => Fragment;
      declare const column: Fragment;
      interface Range { from: Date }
      export function byParameter(cutoff: Date) { return sql\`\${column} < \${cutoff}\`; }
      export function byProperty(range: Range) { return sql\`\${column} < \${range.from}\`; }
      export function byDestructuring({ from }: Range) { return sql\`\${column} < \${from}\`; }
      export function byVar() { var d = new Date(); return sql\`\${column} < \${d}\`; }
      export function byNesting(d: Date) { return sql\`\${sql\`1 = 1\`} AND \${column} < \${d}\`; }
      export function byMaybe(d: Date | null) { return sql\`\${column} < \${d}\`; }
      export function byAlias(d: Date) { const q = sql; return q\`\${column} < \${d}\`; }
      export function byAny(d: any) { return sql\`\${column} < \${d}\`; }
      export function byUnknown(d: unknown) { return sql\`\${column} < \${d}\`; }
      export function byGeneric<T extends Date>(d: T) { return sql\`\${column} < \${d}\`; }
      export function correct(d: Date) { return sql\`\${column} < \${d.toISOString()}::timestamptz\`; }
      export function alsoCorrect() { const ms = Date.now(); return sql\`\${column} < \${ms}\`; }
    `;

    const name = `${ROOT}/__sql_guard_fixture__.ts`;
    const host = ts.createCompilerHost(COMPILER_OPTIONS);
    const original = host.getSourceFile.bind(host);
    host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) =>
      fileName === name
        ? ts.createSourceFile(fileName, fixture, languageVersion, true)
        : original(fileName, languageVersion, onError, shouldCreate);
    host.fileExists = (fileName) => fileName === name || ts.sys.fileExists(fileName);
    host.readFile = (fileName) => (fileName === name ? fixture : ts.sys.readFile(fileName));

    const fixtureProgram = ts.createProgram([name], COMPILER_OPTIONS, host);
    const caught = scan(fixtureProgram, (fileName) => fileName === name);
    const lines = caught.offences.map((o) => o.expression).sort();

    // Ten bad shapes, and neither of the two correct ones. The last three are
    // the ones the type checker cannot prove: they are reported because
    // "unproven" is not "safe".
    expect(lines, "the detector has stopped detecting; every other assertion here is now vacuous").toEqual([
      "cutoff",
      "d",
      "d",
      "d",
      "d",
      "d",
      "d",
      "d",
      "from",
      "range.from",
    ]);
  });

  /**
   * The checker has to have resolved real types.
   *
   * If module resolution fails, every expression comes back as `any`, nothing
   * is a Date, and the file below passes while checking nothing. The fixture
   * above uses local declarations and would still pass in that state, so this
   * asserts against the real program.
   */
  it("resolved real types across the real program", () => {
    expect(roots.length, "no source files found").toBeGreaterThan(50);
    expect(result.templates, "no sql templates found, so the tag match is broken").toBeGreaterThan(50);
    expect(
      result.interpolations,
      "sql templates but no interpolations, so the span walk is broken"
    ).toBeGreaterThan(50);

    const checker = program.getTypeChecker();
    const session = program.getSourceFile(`${ROOT}/src/server/auth/session.ts`);
    expect(session, "expected session.ts in the program").toBeDefined();

    let sawATypedDate = false;
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node) && node.expression.getText(session!) === "Date") {
        if (mentionsDate(checker, checker.getTypeAtLocation(node))) sawATypedDate = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(session!);

    expect(
      sawATypedDate,
      "the checker could not type `new Date()` as Date, so module resolution failed " +
        "and every Date in this codebase is currently invisible to this test"
    ).toBe(true);
  });

  it("never interpolates a Date", () => {
    const report = result.offences
      .map((o) => `  ${o.file}:${o.line}  \${${o.expression}}`)
      .join("\n");

    expect(
      result.offences,
      "a Date in a raw sql template reaches the driver as an object it cannot " +
        "serialise, and the query throws at runtime. Use " +
        "`${value.toISOString()}::timestamptz`:\n" +
        report
    ).toEqual([]);
  });
});

/**
 * A no-op `dotenv`, substituted into the production image at build time.
 *
 * The operational scripts open with `config({ path: ".env.local" })` because
 * that is what makes them runnable on a laptop. In the image there is no
 * `.env.local`, the environment is supplied by the container runtime, and the
 * real dotenv is a devDependency that the traced production `node_modules` does
 * not contain.
 *
 * Bundling the real one instead fails in a way that reads like something else
 * entirely: dotenv is CommonJS, its internal `require("fs")` becomes a dynamic
 * require inside an ESM bundle, and the script dies on its first line with
 * `Dynamic require of "fs" is not supported`. Compiling to CommonJS to dodge
 * that fails differently, because both scripts use top-level await.
 *
 * So the import stays and resolves to nothing. Reading a file that is not there
 * was always a no-op; this just makes it an honest one.
 */

export const config = () => ({ parsed: {} });
export const parse = () => ({});
export const populate = () => {};
export default { config, parse, populate };

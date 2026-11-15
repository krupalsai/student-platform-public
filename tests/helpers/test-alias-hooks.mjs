/**
 * ESM resolve hook for tests: maps the repo's `@/` path alias to `src/`.
 *
 * The app's tsconfig maps `@/*` to `src/*`, but plain `node --test` has no
 * alias support, so a test that imports a module which itself imports
 * `@/lib/...` needs this hook registered first:
 *
 *   import { register } from "node:module";
 *   register("./helpers/test-alias-hooks.mjs", import.meta.url);
 *
 * Register it before the dynamic import of the module under test. It only
 * rewrites specifiers starting with `@/`; everything else resolves as
 * normal. The `.ts` suffix is appended because the source files import the
 * alias without an extension.
 */
import { existsSync } from "node:fs";

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const rel = specifier.slice(2);
    const path = rel.endsWith(".ts") ? rel : `${rel}.ts`;
    return {
      url: new URL(path, new URL("../../src/", import.meta.url)).href,
      shortCircuit: true,
    };
  }
  // Extensionless relative imports: the app's source uses them (the
  // bundler/tsconfig resolve them), but plain node needs the `.ts`.
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    if (!/\.(?:ts|js|mjs|json)$/.test(specifier)) {
      const withTs = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(withTs)) return { url: withTs.href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}

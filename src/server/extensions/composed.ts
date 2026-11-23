import type { ServerExtension } from "./index.js";

/** The extensions composed into this build. Empty in the first-party product; a build that sets
 * `MP_EXTENSIONS_DIR` replaces this module with one import per extension
 * (scripts/extension-bundle-plugin.mjs, ADR-068). Imported directly, never re-exported from
 * `./index`, so an extension importing `./index` does not form an import cycle.
 */
export const COMPOSED_EXTENSIONS: readonly ServerExtension[] = Object.freeze([]);

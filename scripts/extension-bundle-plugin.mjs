/** esbuild plugin that composes build-time extensions into the server bundle (ADR-068).
 *
 * An extension is a directory named after its id inside the directory given by
 * `MP_EXTENSIONS_DIR`, outside the core tree. Its `server.ts` default-exports a `ServerExtension`.
 * The plugin replaces `src/server/extensions/composed.ts` with one static import per extension,
 * so extensions share the server's bundle and its `getDb()` singleton, like the public seeds.
 * Without a configured directory the module is left as shipped: an empty list.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** Mirrors EXTENSION_ID_PATTERN in src/shared/plugins.ts (a boundary test compares them). */
export const EXTENSION_ID_PATTERN = /^ext-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SERVER_ENTRY = "server.ts";
const COMPOSED_FILE = /[\\/]src[\\/]server[\\/]extensions[\\/]composed\.ts$/;

/** What extension code may import from the host, besides its own files and npm packages. */
const HOST_MODULES = {
  "@marplanner/extension": "src/server/extensions/index.ts",
  "@marplanner/host-api": "src/server/host-api/index.ts",
};

/** Extension ids in `extensionsDirectory`, sorted. Throws on anything that is not an extension. */
export function extensionIds(extensionsDirectory) {
  if (!existsSync(extensionsDirectory) || !statSync(extensionsDirectory).isDirectory()) {
    throw new Error(`MP_EXTENSIONS_DIR is not a directory: ${extensionsDirectory}`);
  }
  return readdirSync(extensionsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => {
      if (!EXTENSION_ID_PATTERN.test(entry.name)) {
        throw new Error(
          `${join(extensionsDirectory, entry.name)}: directory name is not an extension id (${EXTENSION_ID_PATTERN.source}).`
        );
      }
      if (!existsSync(join(extensionsDirectory, entry.name, SERVER_ENTRY))) {
        throw new Error(`Extension ${entry.name} has no ${SERVER_ENTRY}.`);
      }
      return entry.name;
    })
    .sort();
}

/** Source that replaces `composed.ts`: one static import per extension, checked against its
 * directory name so an id cannot be claimed by a differently named directory.
 */
export function composedExtensionsSource(extensionsDirectory) {
  const ids = extensionIds(extensionsDirectory);
  const imports = ids.map(
    (id, index) =>
      `import extension${index} from ${JSON.stringify(join(extensionsDirectory, id, SERVER_ENTRY))};`
  );
  const entries = ids.map((id, index) => `[${JSON.stringify(id)}, extension${index}]`).join(", ");
  return `${imports.join("\n")}
const entries = [${entries}];
for (const [directory, extension] of entries) {
  if (extension?.manifest?.id !== directory) {
    throw new Error(
      \`Extension directory \${directory} exports manifest id \${String(extension?.manifest?.id)}.\`
    );
  }
}
export const COMPOSED_EXTENSIONS = Object.freeze(entries.map(([, extension]) => extension));
`;
}

export function extensionBundlePlugin({
  extensionsDirectory = process.env.MP_EXTENSIONS_DIR,
  repositoryRoot = resolve("."),
} = {}) {
  return {
    name: "marplanner-extensions",
    setup(build) {
      if (!extensionsDirectory) return;
      const directory = resolve(extensionsDirectory);
      // Extension files live outside the repository: resolve the host modules to this checkout
      // and their npm imports from its node_modules.
      build.initialOptions.nodePaths = [
        ...(build.initialOptions.nodePaths ?? []),
        join(repositoryRoot, "node_modules"),
      ];
      build.onResolve({ filter: /^@marplanner\/(?:extension|host-api)$/ }, (args) => ({
        path: join(repositoryRoot, HOST_MODULES[args.path]),
      }));
      build.onLoad({ filter: COMPOSED_FILE }, () => ({
        contents: composedExtensionsSource(directory),
        loader: "ts",
        resolveDir: directory,
        watchFiles: [directory],
      }));
    },
  };
}

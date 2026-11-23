/** The server bundle composes build-time extensions from a directory outside the core tree
 * (ADR-068). These tests drive the real esbuild plugin over synthetic extension directories.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build, type Plugin } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { EXTENSION_ID_PATTERN } from "../../src/shared/plugins";

interface ExtensionBundlePluginModule {
  EXTENSION_ID_PATTERN: RegExp;
  extensionIds: (extensionsDirectory: string) => string[];
  extensionBundlePlugin: (options: { extensionsDirectory?: string }) => Plugin;
}

const repoRoot = resolve(import.meta.dirname, "../..");
const pluginModule = (await import(
  join(repoRoot, "scripts/extension-bundle-plugin.mjs")
)) as ExtensionBundlePluginModule;
const COMPOSED_ENTRY = join(repoRoot, "src/server/extensions/composed.ts");

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "mp-extension-bundle-"));
  directories.push(directory);
  return directory;
}

function extensionsDirectory(extensions: Record<string, string | null>): string {
  const directory = join(temporaryDirectory(), "extensions");
  mkdirSync(directory);
  for (const [name, serverSource] of Object.entries(extensions)) {
    mkdirSync(join(directory, name));
    if (serverSource !== null) writeFileSync(join(directory, name, "server.ts"), serverSource);
  }
  return directory;
}

const serverSource = (id: string) => `
import { defineExtension } from "@marplanner/extension";
import { getDb } from "@marplanner/host-api";

export default {
  manifest: defineExtension({
    id: ${JSON.stringify(id)},
    labelKey: "ext.${id}.label",
    descriptionKey: "ext.${id}.description",
  }),
  migrations: [{ id: "0001", apply: () => { void getDb; return undefined; } }],
};
`;

async function composedIds(directory: string | undefined): Promise<string[]> {
  const outfile = join(temporaryDirectory(), "composed.mjs");
  await build({
    entryPoints: [COMPOSED_ENTRY],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    packages: "external",
    logLevel: "silent",
    plugins: [pluginModule.extensionBundlePlugin({ extensionsDirectory: directory })],
  });
  const composed = (await import(pathToFileURL(outfile).href)) as {
    COMPOSED_EXTENSIONS: ReadonlyArray<{ manifest: { id: string } }>;
  };
  return composed.COMPOSED_EXTENSIONS.map(({ manifest }) => manifest.id);
}

describe("extension bundle plugin (ADR-068)", () => {
  it("shares the extension id pattern with the runtime", () => {
    expect(pluginModule.EXTENSION_ID_PATTERN.source).toBe(EXTENSION_ID_PATTERN.source);
  });

  it("composes nothing when no extensions directory is configured", async () => {
    await expect(composedIds(undefined)).resolves.toEqual([]);
  });

  it("composes every extension in the directory, ordered by id", async () => {
    const directory = extensionsDirectory({
      "ext-tasks": serverSource("ext-tasks"),
      "ext-shopping-list": serverSource("ext-shopping-list"),
    });

    expect(pluginModule.extensionIds(directory)).toEqual(["ext-shopping-list", "ext-tasks"]);
    await expect(composedIds(directory)).resolves.toEqual(["ext-shopping-list", "ext-tasks"]);
  });

  it("ignores dot directories and loose files", () => {
    const directory = extensionsDirectory({ "ext-tasks": serverSource("ext-tasks"), ".git": null });
    writeFileSync(join(directory, "README.md"), "# extensions\n");

    expect(pluginModule.extensionIds(directory)).toEqual(["ext-tasks"]);
  });

  it("fails the build for a directory whose name is not an extension id", () => {
    const directory = extensionsDirectory({ weather: serverSource("ext-weather") });

    expect(() => pluginModule.extensionIds(directory)).toThrow(/weather.*extension id/);
  });

  it("fails the build for an extension directory without a server entry", () => {
    const directory = extensionsDirectory({ "ext-tasks": null });

    expect(() => pluginModule.extensionIds(directory)).toThrow(/ext-tasks.*server\.ts/);
  });

  it("fails the build when the configured directory does not exist", () => {
    expect(() => pluginModule.extensionIds(join(temporaryDirectory(), "missing"))).toThrow(
      /MP_EXTENSIONS_DIR/
    );
  });

  it("fails at load when a manifest id differs from its directory name", async () => {
    const directory = extensionsDirectory({ "ext-tasks": serverSource("ext-other") });

    await expect(composedIds(directory)).rejects.toThrow(/ext-tasks.*ext-other/);
  });
});

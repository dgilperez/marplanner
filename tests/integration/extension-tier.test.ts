import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { buildApp } from "../../src/server/app.js";
import { hashKey } from "../../src/server/auth/credentials.js";
import { getDb } from "../../src/server/db/client.js";
import {
  defineExtension,
  ExtensionDefinitionError,
  type ServerExtension,
} from "../../src/server/extensions/index.js";
import { createServerPluginRuntime } from "../../src/server/plugins/runtime.js";
import { SqlitePluginLifecycleStore } from "../../src/server/plugins/store.js";
import { PLUGIN_IDS } from "../../src/shared/plugins.js";
import { useIsolatedDb } from "../helpers/db.js";

const NOW = "2026-09-27T10:15:30.000Z";
const DEVICE_KEY = "extension-tier-device";
const cookies = { mp_device_key: DEVICE_KEY };

function exampleExtension(overrides: Partial<ServerExtension> = {}): ServerExtension {
  return {
    manifest: defineExtension({
      id: "ext-example",
      labelKey: "ext.ext-example.label",
      descriptionKey: "ext.ext-example.description",
      contributions: { routes: ["ext-example-api"] },
    }),
    routes: async (app) => {
      app.get("/ping", async () => ({ pong: true }));
    },
    migrations: [
      {
        id: "0001_notes",
        apply: () => {
          getDb().exec("CREATE TABLE ext_example_notes (id TEXT PRIMARY KEY NOT NULL)");
          return undefined;
        },
      },
    ],
    ...overrides,
  };
}

function runtime(extensions: readonly ServerExtension[]) {
  return createServerPluginRuntime({
    store: new SqlitePluginLifecycleStore(() => getDb()),
    now: () => NOW,
    operationId: (pluginId) => `extension-tier-${pluginId}`,
    drainDeadline: () => ({ expiresAt: "2026-09-27T10:20:30.000Z" }),
    extensions,
  });
}

function seedDeviceKey(): void {
  getDb()
    .prepare(
      `INSERT INTO api_keys (id, key_hash, scope, kind, created_at)
       VALUES ('extension-tier-key', ?, '*', 'device', ?)`
    )
    .run(hashKey(DEVICE_KEY), Date.parse(NOW));
}

async function appWith(extensions: readonly ServerExtension[]): Promise<{
  app: FastifyInstance;
  lifecycle: ReturnType<typeof runtime>["lifecycle"];
}> {
  seedDeviceKey();
  const { lifecycle } = runtime(extensions);
  const app = await buildApp({ pluginLifecycle: lifecycle, extensions });
  return { app, lifecycle };
}

function registryIds(): string[] {
  return (
    getDb()
      .prepare("SELECT plugin_id AS id FROM plugin_activation_registry ORDER BY rowid")
      .all() as Array<{ id: string }>
  ).map(({ id }) => id);
}

function tableExists(name: string): boolean {
  return (
    getDb().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

describe("extension tier (ADR-068)", () => {
  useIsolatedDb({ pluginState: "inactive" });

  it("a build without extensions keeps the closed first-party registry and catalog", async () => {
    const { lifecycle } = runtime([]);

    expect(registryIds()).toEqual([...PLUGIN_IDS]);
    expect((await lifecycle.listCatalog()).map(({ id }) => id)).toEqual([...PLUGIN_IDS]);
  });

  it("lists a discovered extension after the first-party plugins, inactive, in its own trust tier", async () => {
    const { lifecycle } = runtime([exampleExtension()]);

    const catalog = await lifecycle.listCatalog();

    expect(catalog.map(({ id }) => id)).toEqual([...PLUGIN_IDS, "ext-example"]);
    expect(catalog.at(-1)).toMatchObject({
      id: "ext-example",
      state: "inactive",
      trustTier: "extension",
      contributions: { routes: ["ext-example-api"] },
    });
    expect(registryIds()).toEqual([...PLUGIN_IDS, "ext-example"]);
  });

  it("serves extension routes under /api/ext/<id>/ only while the extension is active", async () => {
    const { app, lifecycle } = await appWith([exampleExtension()]);
    const ping = () => app.inject({ method: "GET", url: "/api/ext/ext-example/ping", cookies });

    try {
      const inactive = await ping();
      expect(inactive.statusCode).toBe(503);
      expect(inactive.json()).toEqual({
        code: "plugin_unavailable",
        message: "This plugin is unavailable.",
      });

      await lifecycle.activate("ext-example");
      const active = await ping();
      expect(active.statusCode).toBe(200);
      expect(active.json()).toEqual({ pong: true });

      await lifecycle.deactivate("ext-example");
      expect((await ping()).statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });

  it("requires a device credential on extension routes", async () => {
    const { app, lifecycle } = await appWith([exampleExtension()]);

    try {
      await lifecycle.activate("ext-example");
      const response = await app.inject({ method: "GET", url: "/api/ext/ext-example/ping" });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("is managed through the plugin management API like a first-party plugin", async () => {
    const { app } = await appWith([exampleExtension()]);

    try {
      const activated = await app.inject({
        method: "POST",
        url: "/api/plugins/ext-example/activate",
        cookies,
      });
      expect(activated.statusCode).toBe(200);

      const catalog = await app.inject({ method: "GET", url: "/api/plugins", cookies });
      const entry = (
        catalog.json() as { plugins: Array<{ id: string; state: string }> }
      ).plugins.at(-1);
      expect(entry).toMatchObject({ id: "ext-example", state: "active", trustTier: "extension" });

      const unknown = await app.inject({
        method: "POST",
        url: "/api/plugins/ext-missing/activate",
        cookies,
      });
      expect(unknown.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("runs an extension's migrations once, on activation, and journals them", async () => {
    const { lifecycle } = runtime([exampleExtension()]);
    expect(tableExists("ext_example_notes")).toBe(false);

    await lifecycle.activate("ext-example");
    await lifecycle.deactivate("ext-example");
    await lifecycle.activate("ext-example");

    expect(tableExists("ext_example_notes")).toBe(true);
    expect(
      getDb()
        .prepare(
          "SELECT migration_id AS id FROM plugin_migration_journal WHERE plugin_id = 'ext-example'"
        )
        .all()
    ).toEqual([{ id: "0001_notes" }]);
  });

  it("accepts a migration whose table makes SQLite create its own bookkeeping table", async () => {
    const { lifecycle } = runtime([
      exampleExtension({
        migrations: [
          {
            id: "0001_counter",
            apply: () => {
              // The first AUTOINCREMENT table in a database creates `sqlite_sequence`.
              getDb().exec(
                "CREATE TABLE ext_example_counter (id INTEGER PRIMARY KEY AUTOINCREMENT)"
              );
              return undefined;
            },
          },
        ],
      }),
    ]);

    await expect(lifecycle.activate("ext-example")).resolves.toMatchObject({ state: "active" });
    expect(tableExists("ext_example_counter")).toBe(true);
  });

  it("rejects a migration that creates a table outside the extension's namespace", async () => {
    const { lifecycle } = runtime([
      exampleExtension({
        migrations: [
          {
            id: "0001_trespass",
            apply: () => {
              getDb().exec("CREATE TABLE household_notes (id TEXT PRIMARY KEY NOT NULL)");
              return undefined;
            },
          },
        ],
      }),
    ]);

    await expect(lifecycle.activate("ext-example")).rejects.toMatchObject({
      code: "migration_failed",
    });

    expect(tableExists("household_notes")).toBe(false);
    expect((await lifecycle.listCatalog()).at(-1)).toMatchObject({
      state: "errored",
      error: { code: "migration_failed" },
    });
  });

  it("contains an extension that fails to mount without affecting first-party plugins", async () => {
    const { app, lifecycle } = await appWith([
      exampleExtension({
        mount: () => {
          throw new Error("boom");
        },
      }),
    ]);

    try {
      await lifecycle.activate("weather");
      await expect(lifecycle.activate("ext-example")).rejects.toMatchObject({
        code: "runtime_mount_failed",
      });

      const catalog = await lifecycle.listCatalog();
      expect(catalog.at(-1)).toMatchObject({ id: "ext-example", state: "errored" });
      expect(catalog.find(({ id }) => id === "weather")).toMatchObject({ state: "active" });
      expect(
        (await app.inject({ method: "GET", url: "/api/ext/ext-example/ping", cookies })).statusCode
      ).toBe(503);
    } finally {
      await app.close();
    }
  });

  it("keeps the registry row and data of an extension that is no longer in the build", async () => {
    const first = runtime([exampleExtension()]);
    await first.lifecycle.activate("ext-example");

    const { lifecycle } = runtime([]);

    expect((await lifecycle.listCatalog()).map(({ id }) => id)).toEqual([...PLUGIN_IDS]);
    expect(registryIds()).toEqual([...PLUGIN_IDS, "ext-example"]);
    expect(tableExists("ext_example_notes")).toBe(true);
    await expect(lifecycle.reconcileAll()).resolves.toEqual({ results: [] });
  });

  it("leaves an interrupted operation of an absent extension for a build that contains it", async () => {
    runtime([exampleExtension()]);
    getDb()
      .prepare(
        `INSERT INTO plugin_lifecycle_operations
           (operation_id, plugin_id, target_state, phase, started_at, updated_at)
         VALUES ('interrupted', 'ext-example', 'active', 'running-migrations', ?, ?)`
      )
      .run(NOW, NOW);

    const { lifecycle } = runtime([]);

    await expect(lifecycle.reconcileAll()).resolves.toEqual({ results: [] });
    expect(
      getDb().prepare("SELECT operation_id AS id FROM plugin_lifecycle_operations").all()
    ).toEqual([{ id: "interrupted" }]);
  });

  it.each([
    ["an id without the ext- prefix", "example"],
    ["a first-party plugin id", "weather"],
    ["an id with characters outside the pattern", "ext-Example_1"],
  ])("rejects %s", (_label, id) => {
    expect(() =>
      defineExtension({ id, labelKey: "ext.x.label", descriptionKey: "ext.x.description" })
    ).toThrow(ExtensionDefinitionError);
  });

  it("rejects two extensions with the same id", () => {
    expect(() => runtime([exampleExtension(), exampleExtension()])).toThrow(
      ExtensionDefinitionError
    );
  });

  it("rejects two extensions when one's table prefix contains the other's", () => {
    const nested: ServerExtension = {
      manifest: defineExtension({
        id: "ext-example-notes",
        labelKey: "ext.ext-example-notes.label",
        descriptionKey: "ext.ext-example-notes.description",
      }),
    };

    // `ext-example` owns `ext_example_*`, which would include `ext_example_notes_*`.
    expect(() => runtime([exampleExtension(), nested])).toThrow(ExtensionDefinitionError);
    expect(() => runtime([nested, exampleExtension()])).toThrow(ExtensionDefinitionError);
  });

  it("rejects a contribution id that is not prefixed with the extension id", () => {
    expect(() =>
      defineExtension({
        id: "ext-example",
        labelKey: "ext.ext-example.label",
        descriptionKey: "ext.ext-example.description",
        contributions: { routes: ["meals-api"] },
      })
    ).toThrow(ExtensionDefinitionError);
  });

  describe("restart and restore", () => {
    it("contains an active extension whose mount fails at restart instead of failing the boot", async () => {
      await runtime([exampleExtension()]).lifecycle.activate("ext-example");

      const { lifecycle } = runtime([
        exampleExtension({
          mount: () => {
            throw new Error("boom at boot");
          },
        }),
      ]);

      await expect(lifecycle.reconcileAll()).resolves.toBeDefined();
      expect(lifecycle.isActive("ext-example")).toBe(false);
      expect((await lifecycle.listCatalog()).at(-1)).toMatchObject({
        id: "ext-example",
        state: "errored",
      });
    });

    it("runs the migrations a rebuilt extension gained while it stayed active", async () => {
      await runtime([exampleExtension()]).lifecycle.activate("ext-example");

      const rebuilt = exampleExtension({
        migrations: [
          ...(exampleExtension().migrations ?? []),
          {
            id: "0002_tags",
            apply: () => {
              getDb().exec("CREATE TABLE ext_example_tags (id TEXT PRIMARY KEY NOT NULL)");
              return undefined;
            },
          },
        ],
      });
      const { lifecycle } = runtime([rebuilt]);
      await lifecycle.reconcileAll();

      expect(tableExists("ext_example_tags")).toBe(true);
      expect(lifecycle.isActive("ext-example")).toBe(true);
    });

    it("contains an active extension whose new migration fails at restart", async () => {
      await runtime([exampleExtension()]).lifecycle.activate("ext-example");

      const { lifecycle } = runtime([
        exampleExtension({
          migrations: [
            ...(exampleExtension().migrations ?? []),
            {
              id: "0002_broken",
              apply: () => {
                throw new Error("broken migration");
              },
            },
          ],
        }),
      ]);

      await expect(lifecycle.reconcileAll()).resolves.toBeDefined();
      expect(lifecycle.isActive("ext-example")).toBe(false);
      expect((await lifecycle.listCatalog()).at(-1)).toMatchObject({ state: "errored" });
    });

    it("re-creates the registry row when a restored database predates the extension", async () => {
      const { lifecycle } = runtime([exampleExtension()]);
      // What a restore of an older backup leaves behind: the nine first-party rows only.
      getDb()
        .prepare("DELETE FROM plugin_activation_registry WHERE plugin_id = 'ext-example'")
        .run();

      await expect(lifecycle.reconcileAll()).resolves.toBeDefined();

      expect(registryIds()).toEqual([...PLUGIN_IDS, "ext-example"]);
      expect((await lifecycle.listCatalog()).at(-1)).toMatchObject({
        id: "ext-example",
        state: "inactive",
      });
    });

    it("does not unmount an extension that was never mounted", async () => {
      let unmounts = 0;
      const { lifecycle } = runtime([
        exampleExtension({
          unmount: () => {
            unmounts += 1;
          },
        }),
      ]);

      await lifecycle.reconcileAll();

      expect(unmounts).toBe(0);
    });
  });

  describe("declarations the runtime refuses", () => {
    const handWritten = (manifest: Record<string, unknown>): ServerExtension =>
      ({ manifest: { ...exampleExtension().manifest, ...manifest } }) as unknown as ServerExtension;

    it.each([
      ["a data namespace that is not derived from its id", { dataNamespace: "plugin" }],
      ["the first-party trust tier", { trustTier: "first-party" }],
      ["an id outside the extension id space", { id: "weather" }],
    ])("rejects a hand-written manifest with %s", (_label, manifest) => {
      expect(() => runtime([handWritten(manifest)])).toThrow(ExtensionDefinitionError);
    });

    it("rejects an asynchronous migration before it runs", async () => {
      const { lifecycle } = runtime([
        exampleExtension({
          migrations: [
            {
              id: "0001_async",
              apply: (async () => {
                // Everything after the first await would run outside the migration's transaction.
                await Promise.resolve();
                getDb().exec("CREATE TABLE ext_example_async (id TEXT PRIMARY KEY NOT NULL)");
              }) as unknown as () => undefined,
            },
          ],
        }),
      ]);

      await expect(lifecycle.activate("ext-example")).rejects.toMatchObject({
        code: "migration_failed",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(tableExists("ext_example_async")).toBe(false);
    });

    it("rejects an extension whose table prefix overlaps one that left data in this database", async () => {
      const nested: ServerExtension = {
        manifest: defineExtension({
          id: "ext-example-notes",
          labelKey: "ext.ext-example-notes.label",
          descriptionKey: "ext.ext-example-notes.description",
        }),
      };
      runtime([nested]);

      // `ext-example-notes` is no longer in the build, but its row and tables remain.
      expect(() => runtime([exampleExtension()])).toThrow(ExtensionDefinitionError);
    });
  });
});

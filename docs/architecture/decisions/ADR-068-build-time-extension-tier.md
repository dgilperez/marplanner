# ADR-068 Build-Time Extension Tier

Status: proposed
Owner: architecture
Decision date: 2026-11-23

## Context

ADR-039 made the plugin system first-party only and kept a seam for third-party plugins
("declare-now, enforce-later"). Section 4 keeps install/uninstall as a dormant concept and says
in-tree plugins register at build/boot time, shaped so a later loader is additive.

Half of that seam exists. First-party plugin modules already reach the host only through the
barrel in `src/server/host-api/`, and ESLint zones enforce it (Rule B). The other half, adding a
plugin without editing core, does not:

- `PLUGIN_IDS`, `PluginJobId` and `PluginContentSourceId` in `src/shared/plugins.ts` are closed
  unions.
- `plugin_activation_registry.plugin_id` carries a `CHECK` listing the nine first-party ids, and
  its rows are seeded by the baseline migration.
- `src/server/app.ts` maps every plugin id to its route registrar by hand.
- `src/client/plugins/PluginCatalogProvider.tsx` rejects a catalog whose ids differ from
  `PLUGIN_IDS`.
- Client contributions are static imports guarded by `PluginContribution`.
- Translations live in one `messages` object.

A household that wants a feature of its own (a shopping list, a connector to a private service)
has to fork the core and carry the divergence.

## Decision

Add an **extension tier composed at build time**. An extension is a directory outside the core
tree. The build discovers extensions in the directory named by `MP_EXTENSIONS_DIR` and generates
the registry modules the server and the client import. With the variable unset the generated
modules are empty and the product is the first-party product, unchanged.

There is no dynamic loader, no install endpoint and no sandbox. An extension runs with full host
privileges, as first-party plugins do. This is the "declare" half of ADR-039 for third parties;
enforcement stays deferred.

### 1. Identity and trust tier

- Extension ids match `^ext-[a-z0-9]+(-[a-z0-9]+)*$`. The prefix keeps the first-party id space
  closed and makes the origin visible in the registry, the API and logs.
- `PluginId` becomes `CorePluginId | ExtensionId`. `CorePluginId` is today's union, so every
  exhaustive `Record<CorePluginId, …>` in core keeps its compile-time check.
- `PluginTrustTier` gains `"extension"`. Plugin management shows the tier.
- The runtime refuses, when it assembles, a duplicate id, an id outside the extension id space,
  a manifest whose trust tier or data namespace is not its own, and two extensions whose table
  prefixes overlap (`ext-a` and `ext-a-b`), including one that is no longer in the build but
  left its registry row. `defineExtension` rejects the same mistakes when the module loads.

### 2. Extension layout

```
<MP_EXTENSIONS_DIR>/<id>/
  server.ts          # default export: ServerExtension (manifest, routes, migrations, mount)
  client.tsx         # optional: default export client contributions
  messages.ts        # optional: { en: {...}, es: {...} }
```

The directory name is the extension id; the build fails when the manifest declares another one,
when a directory name is not an extension id, or when `server.ts` is missing.

Extension code imports two host modules, resolved to the checkout by the build:

- `@marplanner/extension`: `defineExtension` and the `ServerExtension` types.
- `@marplanner/host-api`: the barrel in `src/server/host-api/`.

Contribution ids an extension declares must be prefixed with its id (`ext-tasks-api`).
`examples/extensions/ext-hello/` is a complete example.

### 3. Server entry and host API

Extension server code imports from the existing `src/server/host-api` barrel, under the same
Rule B as first-party plugin modules. No second host surface is introduced.

`server.ts` default-exports what the generated registry wires into the existing mechanisms:

| Export                  | Wired into                                   | Notes                                                                                                                          |
| ----------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `routes(app)`           | `registerPluginHttp`                         | Mounted under `/api/ext/<id>/`, behind the lifecycle gate (`503 plugin_unavailable` while inactive) and the device credential. |
| `migrations`            | `createPluginRuntimeAdapter({ migrations })` | Tables must be prefixed `ext_<id>_`; checked when the migration runs.                                                          |
| `jobs`                  | `registerJob` from the host API              | Ids prefixed with the extension id; claims follow the lifecycle gate and drain on deactivation.                                |
| `mount()` / `unmount()` | the runtime adapter                          | Optional; for event subscriptions and in-memory state.                                                                         |

Settings descriptors and event names are declared in the manifest, as for first-party plugins.
Operator configuration goes through `getOperatorConfig`; an extension declares its keys and
environment variable names in the manifest, and `process.env` stays banned in extension code.

Core modules stay unaware of extensions. Anything an extension needs that the barrel lacks is a
host API change, reviewed as such.

### 4. Data and migrations

- Extension migrations run in the existing `running-migrations` phase, journaled per plugin id.
  They also run at every start for an extension that is already active, so a rebuilt extension
  gets its new migrations without being deactivated.
- A migration is rejected, and rolled back, when it changes a table, index, view or trigger
  outside the tables prefixed with the extension's data namespace. This check catches mistakes.
  It is not a security boundary: an extension holds the shared database handle, so it can change
  rows in any table and use the temp schema.
- One core migration, `0003_extension_registry.sql`, replaces the `plugin_id` `CHECK` on the
  registry with "one of the first-party ids or the extension id pattern". It changes no row.
  **It is one-way:** a build without that migration refuses the database ("Unsupported migration
  history"), so going back to such a build means restoring the pre-migration backup the runner
  takes.
- Registry rows for composed extensions are inserted `inactive` when the runtime assembles and
  again at every reconciliation, so a restored database that predates an extension gets its row.
  Rows whose extension is no longer in the build are left in place with their tables; the catalog
  does not list them. Nothing drops an extension's tables yet.

### 5. Client contributions

`client.tsx` exports admin pages, navigation entries, home widgets and settings panels. The build
generates one module mapping extension ids to lazy imports; the Shell, Admin routes and Home
surface render them through `PluginContribution`, so the existing activation check and render
boundary apply. The catalog provider validates first-party ids in their fixed order and accepts
extension ids after them.

### 6. Translations

Extension messages are merged under the `ext.<id>.` key prefix. The parity gate covers them: a key
present in `en` and missing in another shipped language fails the build.

### 7. Guards

- Import boundary: the ESLint zones that fence first-party plugin modules gain one zone for the
  extensions directory. Server code may import the host API barrel and its own files; client code
  may import the UI primitives the kiosk already exposes to plugin screens and its own files.
- `check:plugin-events` validates extension event declarations and namespaces.
- Extension routes are excluded from the core OpenAPI drift gate; an extension may publish its own
  document under `/api/ext/<id>/openapi.json`.

## Implementation status

Delivered with this decision:

- Identity, trust tier and the registry constraint (`drizzle/0003_extension_registry.sql`).
- Server composition: `scripts/extension-bundle-plugin.mjs` replaces
  `src/server/extensions/composed.ts` in the server bundle.
- Lifecycle, catalog and management API for extensions; routes under `/api/ext/<id>/`.
- Namespaced, journaled migrations with the schema check of section 4.

- Plugin management lists extensions after the first-party plugins, named by id, in the
  `extension` tier; the catalog provider validates both id spaces.

- An active extension whose migration or mount fails at start is marked `errored`
  (`contribution_failed`) and the server starts without it.
- The demo seed accepts a registry that holds extension rows and still refuses extension data.

Not delivered yet: jobs, events and settings objects for extensions (section 3), client
contributions (section 5), translations (section 6), the extension lint zone and the
`check:plugin-events` extension (section 7), `hostApiVersion`, and the operator command that drops
an absent extension's tables. Until then an extension contributes API routes and data, and its
screens live outside the kiosk.

Known gaps of what is delivered:

- Composition happens only in the production server bundle (`scripts/build-server.mjs`).
  `npm run dev` and the test runner do not compose extensions, and `infra/docker/Dockerfile`
  neither sets `MP_EXTENSIONS_DIR` nor copies an extensions directory.
- An extension outside the repository has no type-check recipe yet.
- `tests/e2e/plugin-lifecycle.spec.ts` and `plugin-lifecycle-visual.spec.ts` assert the nine-plugin
  catalog and fail against a build that composes an extension.
- Extension routes carry no OpenAPI schema and are absent from the served document.
- A manifest id that differs from its directory name fails when the server starts, not when the
  bundle is built.

## Consequences

- A build without extensions must produce the same route table, catalog payload, bundles and
  database as before, apart from the registry constraint. Tests pin the registry and the catalog;
  the route table and bundles are covered only by the existing suites staying green.
- First-party plugins keep their current wiring. Moving them onto the host API is not part of
  this decision.
- Extensions are trusted code. An extension that throws on activation, migration, mount or at start is contained by the lifecycle (marked
  `errored`); memory or CPU exhaustion is not contained, as stated in ADR-039.
- The host API barrel becomes a compatibility surface for code outside the repository. The
  manifest will carry `hostApiVersion` (not delivered), so that an extension built against a newer
  version fails the build.
  `hostApiExportNames` in the assembly cohort fixture already pins the barrel's exports.

## Alternatives considered

- **Runtime loading from a plugins directory.** Needs a loader, client code delivery outside the
  Vite build and a decision on isolation. ADR-039 defers all three.
- **Carrying household features as core patches in a fork.** Every upstream change to the same
  files conflicts, and private features cannot stay private.
- **HTTP-only connectors.** Already possible and still preferred when a feature needs no UI or
  tables inside the product. They cannot add screens, widgets or briefing content.

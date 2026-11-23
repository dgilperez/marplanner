import type { FastifyInstance } from "fastify";

import {
  EXTENSION_ID_PATTERN,
  isExtensionId,
  type ExtensionId,
  type PluginManifest,
  type PluginRequirementId,
  type PluginServiceContribution,
  type PluginSettingDescriptor,
} from "../../shared/plugins.js";

/** Build-time extension tier (ADR-068). An extension lives outside the core tree, is composed
 * into the build, and plugs into the same lifecycle, HTTP gate and migration journal as a
 * first-party plugin. Extension code reaches the host through `../host-api` only (Rule B).
 */

export const EXTENSION_ROUTE_PREFIX = "/api/ext";

export class ExtensionDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionDefinitionError";
  }
}

export interface ExtensionContributions {
  readonly routes?: readonly string[];
  readonly admin?: readonly string[];
  readonly settings?: readonly string[];
  readonly widgets?: readonly string[];
  readonly services?: readonly PluginServiceContribution[];
}

export interface ExtensionManifestInput {
  readonly id: string;
  readonly labelKey: string;
  readonly descriptionKey: string;
  readonly contributions?: ExtensionContributions;
  readonly requirements?: readonly PluginRequirementId[];
  readonly settingsSchema?: readonly PluginSettingDescriptor[];
}

export interface ExtensionMigration {
  readonly id: string;
  /** Synchronous, like first-party plugin migrations: it runs inside one SQLite transaction. */
  readonly apply: () => undefined;
}

export type ExtensionManifest = PluginManifest & { readonly id: ExtensionId };

export interface ServerExtension {
  readonly manifest: ExtensionManifest;
  /** Registered once under `/api/ext/<id>/`, behind the lifecycle gate and the device credential. */
  readonly routes?: (app: FastifyInstance) => Promise<void>;
  readonly migrations?: readonly ExtensionMigration[];
  readonly mount?: () => void | Promise<void>;
  readonly unmount?: () => void | Promise<void>;
}

/** `ext-shopping-list` owns the tables prefixed `ext_shopping_list_`. */
export function extensionDataNamespace(id: ExtensionId): string {
  return id.replaceAll("-", "_");
}

export function extensionRoutePrefix(id: ExtensionId): string {
  return `${EXTENSION_ROUTE_PREFIX}/${id}`;
}

function assertExtensionId(id: string): asserts id is ExtensionId {
  if (!isExtensionId(id)) {
    throw new ExtensionDefinitionError(
      `Extension id "${id}" must match ${EXTENSION_ID_PATTERN.source}.`
    );
  }
}

function assertOwnedIds(id: ExtensionId, group: string, contributionIds: readonly string[]): void {
  for (const contributionId of contributionIds) {
    if (contributionId !== id && !contributionId.startsWith(`${id}-`)) {
      throw new ExtensionDefinitionError(
        `Extension ${id} declares ${group} contribution "${contributionId}", which is not prefixed with its id.`
      );
    }
  }
}

/** Validate an extension's declaration and complete it into a manifest. */
export function defineExtension(input: ExtensionManifestInput): ExtensionManifest {
  const { id } = input;
  assertExtensionId(id);
  const routes = input.contributions?.routes ?? [];
  const admin = input.contributions?.admin ?? [];
  const settings = input.contributions?.settings ?? [];
  const widgets = input.contributions?.widgets ?? [];
  const services = input.contributions?.services ?? [];
  assertOwnedIds(id, "routes", routes);
  assertOwnedIds(id, "admin", admin);
  assertOwnedIds(id, "settings", settings);
  assertOwnedIds(id, "widgets", widgets);
  assertOwnedIds(
    id,
    "services",
    services.map((service) => service.id)
  );

  return Object.freeze({
    id,
    labelKey: input.labelKey,
    descriptionKey: input.descriptionKey,
    trustTier: "extension",
    contributions: Object.freeze({
      routes: Object.freeze([...routes]),
      admin: Object.freeze([...admin]),
      settings: Object.freeze([...settings]),
      widgets: Object.freeze([...widgets]),
      services: Object.freeze(services.map((service) => Object.freeze({ ...service }))),
      contentSources: Object.freeze([]),
      jobs: Object.freeze([]),
    }),
    events: Object.freeze({ emits: Object.freeze([]), subscribes: Object.freeze([]) }),
    requirements: Object.freeze([...(input.requirements ?? [])]),
    settingsSchema: Object.freeze((input.settingsSchema ?? []).map((d) => Object.freeze({ ...d }))),
    dataNamespace: extensionDataNamespace(id),
    runtimeAdapterKey: id,
    adr029Classification: "extension",
    lifecycleCapabilities: Object.freeze(["activate", "deactivate"] as const),
  });
}

/** Rejects a set of extensions that cannot be composed into one database. `defineExtension`
 * produces valid manifests, but nothing forces an extension to use it, so the runtime checks the
 * manifest again: id space, trust tier and data namespace cannot be claimed by hand.
 * `residentIds` are the extension ids that already have a registry row, composed or not: an
 * extension that is no longer in the build still owns its tables.
 */
export function assertComposableExtensions(
  extensions: readonly ServerExtension[],
  residentIds: readonly string[] = []
): void {
  const composed = new Set<ExtensionId>();
  for (const { manifest } of extensions) {
    // Typed as ExtensionId, but a hand-written manifest may carry any string.
    const id: string = manifest.id;
    assertExtensionId(id);
    if (
      manifest.trustTier !== "extension" ||
      manifest.dataNamespace !== extensionDataNamespace(id) ||
      manifest.runtimeAdapterKey !== id
    ) {
      throw new ExtensionDefinitionError(
        `Extension ${id} declares a trust tier, data namespace or adapter key that is not its own.`
      );
    }
    if (composed.has(id)) {
      throw new ExtensionDefinitionError(`Extension ${id} is composed more than once.`);
    }
    composed.add(id);
  }
  // `ext-a` owns `ext_a_*`, which would contain the `ext_a_b_*` of `ext-a-b`.
  const owners = [...new Set([...composed, ...residentIds.filter(isExtensionId)])];
  for (const id of composed) {
    const namespace = extensionDataNamespace(id);
    for (const other of owners) {
      if (other === id) continue;
      const otherNamespace = extensionDataNamespace(other);
      if (
        namespace.startsWith(`${otherNamespace}_`) ||
        otherNamespace.startsWith(`${namespace}_`)
      ) {
        throw new ExtensionDefinitionError(
          `Extensions ${other} and ${id} have overlapping table prefixes; rename one.`
        );
      }
    }
  }
}

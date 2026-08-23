import type { ElementDescriptor, ModuleDescriptor, RelationDescriptor } from '../adapters/types.js';

/**
 * Stable, versioned, absPath-free shape for `docmap scan --json`'s output. This is a public
 * contract external tooling (CI bots, dashboards) can rely on across docmap releases — unlike
 * ModuleDescriptor/ElementDescriptor, which are internal and free to evolve.
 *
 * Deliberately excludes:
 * - Every `absPath` (only `relPath`, project-root-relative, survives into `files`).
 * - `module.metadata` (e.g. the reverse "dependents" index, or adapter-internal fields like
 *   Magento's module name) — an internal, evolving bag, not part of this stable shape.
 *
 * Bump `schema_version` (and add a new `ScanContractV<N>` / mapping function alongside, rather
 * than mutating this one in place) for any breaking change to this shape.
 */
export interface ScanContractV1 {
  schema_version: 1;
  framework: string;
  modules: ScanContractModuleV1[];
}

export interface ScanContractModuleV1 {
  id: string;
  name: string;
  path: string;
  elements: ScanContractElementV1[];
  relations: ScanContractRelationV1[];
}

export interface ScanContractElementV1 {
  id: string;
  kind: string;
  files: string[];
}

export interface ScanContractRelationV1 {
  type: string;
  fromId: string;
  toId: string;
  toModule?: string;
  /** Structured endpoint/operation name (e.g. "REST GET /V1/carts/mine", "GraphQL GetCart") for a
   * cross-stack api-call relation — present so a consumer doesn't have to re-parse `detail`. */
  operation?: string;
  /** Structured display name of the relation's target module — present for the same reason as
   * `operation`; most useful for a peer `toModule` (`peer:<name>::<id>`), whose id alone isn't a
   * readable name. */
  toModuleName?: string;
  detail?: string;
  confidence: string;
}

function toContractRelation(relation: RelationDescriptor): ScanContractRelationV1 {
  return {
    type: relation.type,
    fromId: relation.fromId,
    toId: relation.toId,
    ...(relation.toModule !== undefined ? { toModule: relation.toModule } : {}),
    ...(relation.operation !== undefined ? { operation: relation.operation } : {}),
    ...(relation.toModuleName !== undefined ? { toModuleName: relation.toModuleName } : {}),
    ...(relation.detail !== undefined ? { detail: relation.detail } : {}),
    confidence: relation.confidence,
  };
}

function toContractElement(element: ElementDescriptor): ScanContractElementV1 {
  return {
    id: element.id,
    kind: element.kind,
    files: element.files.map((file) => file.relPath),
  };
}

function toContractModule(module: ModuleDescriptor): ScanContractModuleV1 {
  return {
    id: module.id,
    name: module.name,
    path: module.relRootPath,
    elements: module.elements.map(toContractElement),
    relations: module.relations.map(toContractRelation),
  };
}

/** Maps internal discovery output to the stable, versioned, absPath-free `scan --json` contract. */
export function toScanContract(frameworkName: string, modules: ModuleDescriptor[]): ScanContractV1 {
  return {
    schema_version: 1,
    framework: frameworkName,
    modules: modules.map(toContractModule),
  };
}

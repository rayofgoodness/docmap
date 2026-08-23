import type { Logger } from '../utils/logger.js';
import type { ResolvedDocmapConfig } from '../config/schema.js';

export type ElementKind =
  | 'controller'
  | 'model'
  | 'observer'
  | 'plugin'
  | 'block'
  | 'api'
  | 'helper'
  | 'setup'
  | 'page'
  | 'component'
  | 'composable'
  | 'server-route'
  | 'store'
  | 'layout'
  | 'middleware'
  | 'service'
  | 'guard'
  | 'interceptor'
  | 'pipe'
  | 'dto'
  | 'entity'
  | 'repository'
  | 'gateway'
  | 'resolver'
  | 'module'
  | 'file'
  | 'directory'
  | 'cron'
  | 'console'
  | 'viewmodel'
  | 'ui'
  | 'section'
  | 'unknown';

export interface SourceFileRef {
  absPath: string;
  relPath: string;
  sizeBytes: number;
}

export type RelationType =
  | 'di'
  | 'event'
  | 'import'
  | 'api-call'
  | 'extends'
  | 'plugin-intercepts'
  | 'route'
  | 'store'
  | 'unknown';

export type RelationConfidence = 'deterministic' | 'heuristic';

export interface RelationDescriptor {
  type: RelationType;
  fromId: string;
  toId: string;
  toModule?: string;
  /**
   * Structured label for the API endpoint/operation this relation crosses (e.g.
   * "REST GET /V1/carts/mine" or "GraphQL GetCart"), set by cross-stack (peer) `api-call`
   * relations. Redundant with the prefix of `detail` for those relations, but kept as its own
   * field so consumers — e.g. index.md's Integration surface table — don't need to re-parse the
   * human-readable `detail` string.
   */
  operation?: string;
  /**
   * Human-readable display name of the relation's target module (e.g. a peer's Magento module
   * name "Vendor_PeerModule"), set alongside `operation` by cross-stack `api-call` relations.
   * Redundant with the suffix of `detail` for those relations, kept separate for the same reason
   * as `operation`.
   */
  toModuleName?: string;
  detail?: string;
  confidence: RelationConfidence;
}

export interface ElementDescriptor {
  id: string;
  kind: ElementKind;
  name: string;
  files: SourceFileRef[];
  summaryHints?: string[];
  relations?: RelationDescriptor[];
}

export interface ModuleDescriptor {
  id: string;
  name: string;
  rootPath: string;
  relRootPath: string;
  framework: string;
  elements: ElementDescriptor[];
  relations: RelationDescriptor[];
  files: SourceFileRef[];
  metadata?: Record<string, unknown>;
}

export interface DiscoveryContext {
  projectRoot: string;
  config: ResolvedDocmapConfig;
  logger: Logger;
}

export interface FrameworkAdapter {
  name: string;
  detect(ctx: DiscoveryContext): Promise<boolean>;
  discoverModules(ctx: DiscoveryContext): Promise<ModuleDescriptor[]>;
  resolveRelations?(
    modules: ModuleDescriptor[],
    ctx: DiscoveryContext,
  ): Promise<RelationDescriptor[]>;
}

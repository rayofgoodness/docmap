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
  | 'file'
  | 'directory'
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
  | 'unknown';

export type RelationConfidence = 'deterministic' | 'heuristic';

export interface RelationDescriptor {
  type: RelationType;
  fromId: string;
  toId: string;
  toModule?: string;
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

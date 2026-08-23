import fs from 'node:fs/promises';
import type { ElementDescriptor, ModuleDescriptor, RelationDescriptor } from '../adapters/types.js';
import {
  FETCH_CALL_PATTERN,
  callSiteMatchesRoute,
  normalizeCallSiteUrlForMatch,
} from '../adapters/nuxt4/relations.js';
import type { PeerProject } from './peers.js';

// Captures `query OperationName` / `mutation OperationName` — matched against the *entire* source
// text rather than only inside `gql\`...\`` blocks, which deliberately also covers a standalone
// `.gql`/`.graphql` file whose content is basically one query/mutation block: this function doesn't
// need to know the file extension, the same regex over the whole text handles both shapes.
const GQL_OPERATION_NAME_PATTERN = /\b(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/g;

// `useAsyncQuery('opName')` / `useAsyncQuery("opName")` — the string literal argument is the
// operation/field name directly, no `query `/`mutation ` keyword involved.
const USE_ASYNC_QUERY_PATTERN = /useAsyncQuery\(\s*['"]([^'"]+)['"]/g;

/**
 * Finds `$fetch`/`useFetch`/`useLazyFetch` call sites in Nuxt source that plausibly target a
 * Magento REST endpoint, and returns each as a `V1/...`-prefixed path (everything before the
 * `V1/` segment — a literal `/rest/` prefix or a collapsed `${config.magentoUrl}`-style template
 * placeholder — is dropped) suitable for segment-wise matching against a peer's webapi.xml routes.
 *
 * Reuses nuxt4/relations.ts's own FETCH_CALL_PATTERN and normalizeCallSiteUrlForMatch rather than
 * reimplementing call-site URL extraction: the only difference from that module's local-route
 * matching is that every URL is collected here for the caller to match against a peer, instead of
 * being matched against local server routes inline.
 */
export function extractRestApiCalls(source: string): string[] {
  const results: string[] = [];
  FETCH_CALL_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FETCH_CALL_PATTERN.exec(source)) !== null) {
    const rawUrl = match[1] ?? match[2];
    if (!rawUrl) continue;
    const normalized = normalizeCallSiteUrlForMatch(rawUrl);
    if (!normalized.includes('/V1/')) continue;
    const v1Index = normalized.indexOf('V1/');
    if (v1Index === -1) continue;
    results.push(normalized.slice(v1Index));
  }
  return results;
}

/**
 * Finds GraphQL operation/field names referenced in Nuxt source, from three call shapes:
 * `gql\`query Foo { ... }\`` / `gql\`mutation Foo { ... }\`` tagged templates (also covers a raw
 * `.gql`/`.graphql` file passed as `source` — same regex, no extension awareness needed),
 * and `useAsyncQuery('opName')` / `useAsyncQuery("opName")` call arguments.
 */
export function extractGraphqlOperations(source: string): string[] {
  const names = new Set<string>();

  GQL_OPERATION_NAME_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = GQL_OPERATION_NAME_PATTERN.exec(source)) !== null) {
    if (match[1]) names.add(match[1]);
  }

  USE_ASYNC_QUERY_PATTERN.lastIndex = 0;
  while ((match = USE_ASYNC_QUERY_PATTERN.exec(source)) !== null) {
    if (match[1]) names.add(match[1]);
  }

  return [...names];
}

interface PeerApiMatch {
  peerModule: ModuleDescriptor;
  element: ElementDescriptor;
  /** The matched summaryHint entry as it literally appears on the peer element (e.g. "GET /V1/carts/mine" or "peerModuleCart"). */
  hint: string;
}

/**
 * Matches a `V1/...`-prefixed call-site path (from extractRestApiCalls) against a peer's webapi.xml
 * route elements. A webapi.xml summaryHint looks like "METHOD /V1/some/route" — the "METHOD " prefix
 * is stripped before comparing path segments. This is a deliberate v1 simplification: matching is by
 * path segments only, regardless of HTTP method, since cheaply inferring the method from a
 * $fetch/useFetch call site (it's usually a separate `method:` option, not part of the URL) isn't
 * reliable enough to gate the match on.
 */
function findPeerRestMatch(peer: PeerProject, v1Path: string): PeerApiMatch | null {
  for (const peerModule of peer.modules) {
    for (const element of peerModule.elements) {
      if (element.kind !== 'api') continue;
      for (const hint of element.summaryHints ?? []) {
        const withoutMethod = hint.replace(/^\S+\s+/, '');
        const hintPath = withoutMethod.startsWith('/') ? withoutMethod.slice(1) : withoutMethod;
        if (!hintPath.startsWith('V1/')) continue; // not a webapi.xml route hint (e.g. a schema.graphqls field name) — skip
        if (callSiteMatchesRoute(v1Path, hintPath)) {
          return { peerModule, element, hint };
        }
      }
    }
  }
  return null;
}

/** Matches a GraphQL operation/field name against a peer's schema.graphqls Query/Mutation field summaryHints (exact match). */
function findPeerGraphqlMatch(peer: PeerProject, opName: string): PeerApiMatch | null {
  for (const peerModule of peer.modules) {
    for (const element of peerModule.elements) {
      if (element.kind !== 'api') continue;
      if (element.summaryHints?.includes(opName)) {
        return { peerModule, element, hint: opName };
      }
    }
  }
  return null;
}

/**
 * Matches Nuxt consumer source (REST call sites and GraphQL operations) against a single peer
 * project's declared API surface (webapi.xml routes, schema.graphqls fields), emitting `api-call`
 * relations that cross the project boundary. The `peer:<name>::<moduleId>` prefix on toId/toModule
 * is deliberate — it must never collide with a local module id, so cross-project relations stay
 * visually and programmatically distinguishable from local ones.
 */
export async function resolveCrossStackRelations(
  consumerModules: ModuleDescriptor[],
  peer: PeerProject,
): Promise<RelationDescriptor[]> {
  const relations: RelationDescriptor[] = [];

  for (const module of consumerModules) {
    for (const element of module.elements) {
      const file = element.files[0];
      if (!file) continue;
      let source: string;
      try {
        source = await fs.readFile(file.absPath, 'utf8');
      } catch {
        continue;
      }
      const fromId = `${module.id}::${element.id}`;

      for (const v1Path of extractRestApiCalls(source)) {
        const restMatch = findPeerRestMatch(peer, v1Path);
        if (!restMatch) continue;
        relations.push({
          type: 'api-call',
          fromId,
          toId: `peer:${peer.peerName}::${restMatch.peerModule.id}::${restMatch.element.id}`,
          toModule: `peer:${peer.peerName}::${restMatch.peerModule.id}`,
          detail: `REST ${restMatch.hint} -> ${restMatch.peerModule.name}`,
          confidence: 'heuristic',
        });
      }

      for (const opName of extractGraphqlOperations(source)) {
        const graphqlMatch = findPeerGraphqlMatch(peer, opName);
        if (!graphqlMatch) continue;
        relations.push({
          type: 'api-call',
          fromId,
          toId: `peer:${peer.peerName}::${graphqlMatch.peerModule.id}::${graphqlMatch.element.id}`,
          toModule: `peer:${peer.peerName}::${graphqlMatch.peerModule.id}`,
          detail: `GraphQL ${opName} -> ${graphqlMatch.peerModule.name}`,
          confidence: 'heuristic',
        });
      }
    }
  }

  return relations;
}

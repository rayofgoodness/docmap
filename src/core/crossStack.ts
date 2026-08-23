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
    // Anchored on the SAME '/V1/' occurrence used to validate the URL — searching for the bare,
    // unanchored 'V1/' here would find an earlier, spurious match (e.g. a store-code segment that
    // happens to contain the substring 'V1/' before the real route) and slice from the wrong index.
    const v1Index = normalized.indexOf('/V1/');
    if (v1Index === -1) continue;
    results.push(normalized.slice(v1Index + 1));
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
 * A peer's declared API surface, indexed once so matching a call site against it is O(1)-ish instead
 * of a full peerModule/element/summaryHints scan per call site:
 * - `restBySegmentCount`: webapi.xml route hints (method-stripped, leading-slash-stripped), bucketed by
 *   path segment count — callSiteMatchesRoute requires equal segment counts, so this prunes almost all
 *   candidates before the full segment-wise comparison.
 * - `hintExact`: every summaryHint verbatim (REST or otherwise), for GraphQL/plain-name matching —
 *   mirrors the original scan's behavior of matching ANY summaryHint against an operation name, not
 *   just ones that look like REST routes.
 */
interface PeerApiIndex {
  restBySegmentCount: Map<number, Array<{ match: PeerApiMatch; hintPath: string }>>;
  hintExact: Map<string, PeerApiMatch>;
}

function buildPeerApiIndex(peer: PeerProject): PeerApiIndex {
  const restBySegmentCount = new Map<number, Array<{ match: PeerApiMatch; hintPath: string }>>();
  const hintExact = new Map<string, PeerApiMatch>();

  for (const peerModule of peer.modules) {
    for (const element of peerModule.elements) {
      if (element.kind !== 'api') continue;
      for (const hint of element.summaryHints ?? []) {
        const match: PeerApiMatch = { peerModule, element, hint };
        if (!hintExact.has(hint)) hintExact.set(hint, match); // first occurrence wins, same as the original module-order scan

        const withoutMethod = hint.replace(/^\S+\s+/, '');
        const hintPath = withoutMethod.startsWith('/') ? withoutMethod.slice(1) : withoutMethod;
        if (!hintPath.startsWith('V1/')) continue; // not a webapi.xml route hint (e.g. a schema.graphqls field name) — skip
        const segCount = hintPath.split('/').length;
        const bucket = restBySegmentCount.get(segCount);
        if (bucket) bucket.push({ match, hintPath });
        else restBySegmentCount.set(segCount, [{ match, hintPath }]);
      }
    }
  }

  return { restBySegmentCount, hintExact };
}

/**
 * Matches a `V1/...`-prefixed call-site path (from extractRestApiCalls) against a peer's indexed
 * webapi.xml route elements. This is a deliberate v1 simplification: matching is by path segments
 * only, regardless of HTTP method, since cheaply inferring the method from a $fetch/useFetch call site
 * (it's usually a separate `method:` option, not part of the URL) isn't reliable enough to gate on.
 */
function matchPeerRest(index: PeerApiIndex, v1Path: string): PeerApiMatch | null {
  const candidates = index.restBySegmentCount.get(v1Path.split('/').length);
  if (!candidates) return null;
  for (const { match, hintPath } of candidates) {
    if (callSiteMatchesRoute(v1Path, hintPath)) return match;
  }
  return null;
}

/** Matches a GraphQL operation/field name against a peer's indexed schema.graphqls Query/Mutation field summaryHints (exact match). */
function matchPeerGraphql(index: PeerApiIndex, opName: string): PeerApiMatch | null {
  return index.hintExact.get(opName) ?? null;
}

export interface ConsumerCallSites {
  fromId: string;
  restPaths: string[];
  graphqlOps: string[];
}

/**
 * Reads every consumer element's source once and extracts REST/GraphQL call sites — independent of
 * any particular peer. Callers matching against MULTIPLE peers should call this ONCE and reuse the
 * result across every peer (via resolveCrossStackRelationsFromCallSites) rather than re-reading and
 * re-scanning the same files once per peer.
 */
export async function extractConsumerCallSites(consumerModules: ModuleDescriptor[]): Promise<ConsumerCallSites[]> {
  const results: ConsumerCallSites[] = [];
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
      const restPaths = extractRestApiCalls(source);
      const graphqlOps = extractGraphqlOperations(source);
      if (restPaths.length === 0 && graphqlOps.length === 0) continue;
      results.push({ fromId: `${module.id}::${element.id}`, restPaths, graphqlOps });
    }
  }
  return results;
}

/**
 * Matches already-extracted consumer call sites (see extractConsumerCallSites) against a single peer's
 * declared API surface, emitting `api-call` relations that cross the project boundary. The
 * `peer:<name>::<moduleId>` prefix on toId/toModule is deliberate — it must never collide with a local
 * module id, so cross-project relations stay visually and programmatically distinguishable from local
 * ones. Pure/synchronous: all I/O already happened in extractConsumerCallSites.
 */
export function resolveCrossStackRelationsFromCallSites(
  callSites: ConsumerCallSites[],
  peer: PeerProject,
): RelationDescriptor[] {
  const relations: RelationDescriptor[] = [];
  const index = buildPeerApiIndex(peer);

  for (const { fromId, restPaths, graphqlOps } of callSites) {
    for (const v1Path of restPaths) {
      const restMatch = matchPeerRest(index, v1Path);
      if (!restMatch) continue;
      relations.push({
        type: 'api-call',
        fromId,
        toId: `peer:${peer.peerName}::${restMatch.peerModule.id}::${restMatch.element.id}`,
        toModule: `peer:${peer.peerName}::${restMatch.peerModule.id}`,
        operation: `REST ${restMatch.hint}`,
        toModuleName: restMatch.peerModule.name,
        detail: `REST ${restMatch.hint} -> ${restMatch.peerModule.name}`,
        confidence: 'heuristic',
      });
    }

    for (const opName of graphqlOps) {
      const graphqlMatch = matchPeerGraphql(index, opName);
      if (!graphqlMatch) continue;
      relations.push({
        type: 'api-call',
        fromId,
        toId: `peer:${peer.peerName}::${graphqlMatch.peerModule.id}::${graphqlMatch.element.id}`,
        toModule: `peer:${peer.peerName}::${graphqlMatch.peerModule.id}`,
        operation: `GraphQL ${opName}`,
        toModuleName: graphqlMatch.peerModule.name,
        detail: `GraphQL ${opName} -> ${graphqlMatch.peerModule.name}`,
        confidence: 'heuristic',
      });
    }
  }

  return relations;
}

/**
 * Convenience single-peer wrapper: extracts consumer call sites itself, then matches them against one
 * peer. Prefer calling extractConsumerCallSites once and resolveCrossStackRelationsFromCallSites per
 * peer directly when matching against MULTIPLE peers, to avoid re-reading/re-extracting the same
 * consumer files once per peer.
 */
export async function resolveCrossStackRelations(
  consumerModules: ModuleDescriptor[],
  peer: PeerProject,
): Promise<RelationDescriptor[]> {
  const callSites = await extractConsumerCallSites(consumerModules);
  return resolveCrossStackRelationsFromCallSites(callSites, peer);
}

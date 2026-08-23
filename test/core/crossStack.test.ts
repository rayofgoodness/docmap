import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractGraphqlOperations, extractRestApiCalls, resolveCrossStackRelations } from '../../src/core/crossStack.js';
import { discoverProject } from '../../src/core/discovery.js';
import { loadConfig } from '../../src/config/load.js';
import { createLogger } from '../../src/utils/logger.js';
import type { DiscoveryContext } from '../../src/adapters/types.js';

const FIXTURES_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const CONSUMER_FIXTURE_ROOT = path.join(FIXTURES_ROOT, 'nuxt4-peer-consumer-fake');

describe('extractRestApiCalls', () => {
  it('extracts a literal $fetch REST call as a V1/-prefixed path', () => {
    expect(extractRestApiCalls(`const cart = await $fetch('/rest/V1/carts/mine');`)).toEqual(['V1/carts/mine']);
  });

  it('extracts a template-literal $fetch call, collapsing the interpolated prefix', () => {
    const source = 'await $fetch(`${config.magentoUrl}/V1/products/${id}`)';
    // The interpolated ${id} segment collapses to nuxt4/relations.ts's TEMPLATE_PARAM_PLACEHOLDER sentinel ('\u0000').
    expect(extractRestApiCalls(source)).toEqual(['V1/products/' + '\u0000']);
  });

  it('extracts a useFetch call the same way as $fetch', () => {
    expect(extractRestApiCalls(`useFetch('/rest/V1/orders/mine')`)).toEqual(['V1/orders/mine']);
  });

  it('ignores calls that do not plausibly target a Magento REST endpoint', () => {
    expect(extractRestApiCalls(`$fetch('/api/cart')`)).toEqual([]);
  });
});

describe('extractGraphqlOperations', () => {
  it('extracts an operation name from a gql-tagged query', () => {
    const source = 'const Q = gql`query GetCart { cart { id } }`;';
    expect(extractGraphqlOperations(source)).toEqual(['GetCart']);
  });

  it('extracts an operation name from a gql-tagged mutation', () => {
    const source = 'const M = gql`mutation AddToCart($id: Int!) { addToCart(id: $id) { id } }`;';
    expect(extractGraphqlOperations(source)).toEqual(['AddToCart']);
  });

  it('extracts operation names from raw .gql/.graphql file content with no surrounding JS', () => {
    const source = 'query PeerModuleCart {\n  peerModuleCart {\n    id\n  }\n}\n';
    expect(extractGraphqlOperations(source)).toEqual(['PeerModuleCart']);
  });

  it('captures a useAsyncQuery string literal argument directly', () => {
    expect(extractGraphqlOperations(`useAsyncQuery('peerModuleCart')`)).toEqual(['peerModuleCart']);
    expect(extractGraphqlOperations(`useAsyncQuery("peerModuleCart")`)).toEqual(['peerModuleCart']);
  });
});

describe('resolveCrossStackRelations / discoverProject integration', () => {
  async function scanConsumerFixture() {
    const config = await loadConfig({ projectRoot: CONSUMER_FIXTURE_ROOT });
    const ctx: DiscoveryContext = { projectRoot: CONSUMER_FIXTURE_ROOT, config, logger: createLogger() };
    return discoverProject(ctx);
  }

  it('reads peers from the fixture docmap.config.json', async () => {
    const config = await loadConfig({ projectRoot: CONSUMER_FIXTURE_ROOT });
    expect(config.peers).toEqual([{ name: 'backend', path: '../magento2-peer-fake' }]);
  });

  it('matches a Nuxt $fetch REST call against the peer webapi.xml route', async () => {
    const { modules, peers } = await scanConsumerFixture();
    expect(peers).toHaveLength(1);
    const peer = peers[0]!;
    expect(peer.peerName).toBe('backend');

    const pages = modules.find((m) => m.id === 'pages');
    expect(pages).toBeDefined();

    const restRelation = pages!.relations.find(
      (r) => r.type === 'api-call' && r.detail?.startsWith('REST '),
    );
    expect(restRelation).toBeDefined();
    expect(restRelation!.toModule).toBe('peer:backend::vendor_peermodule');
    expect(restRelation!.toId).toBe('peer:backend::vendor_peermodule::etc/webapi.xml');
    expect(restRelation!.detail).toBe('REST GET /V1/carts/mine -> Vendor_PeerModule');
    expect(restRelation!.confidence).toBe('heuristic');
  });

  it('matches a Nuxt gql-tagged GraphQL operation against the peer schema.graphqls field', async () => {
    const { modules, peers } = await scanConsumerFixture();
    const peer = peers[0]!;

    const pages = modules.find((m) => m.id === 'pages');
    expect(pages).toBeDefined();

    const graphqlRelation = pages!.relations.find(
      (r) => r.type === 'api-call' && r.detail?.startsWith('GraphQL '),
    );
    expect(graphqlRelation).toBeDefined();
    expect(graphqlRelation!.toModule).toBe(`peer:${peer.peerName}::vendor_peermodule`);
    expect(graphqlRelation!.toId).toBe('peer:backend::vendor_peermodule::etc/schema.graphqls');
    expect(graphqlRelation!.detail).toBe('GraphQL peerModuleCart -> Vendor_PeerModule');
    expect(graphqlRelation!.confidence).toBe('heuristic');
  });

  it('resolveCrossStackRelations returns an empty array when nothing matches the peer surface', async () => {
    const { modules, peers } = await scanConsumerFixture();
    const peer = peers[0]!;
    const utilsLikeModules = modules.filter((m) => m.id !== 'pages');
    const relations = await resolveCrossStackRelations(utilsLikeModules, peer);
    expect(relations).toEqual([]);
  });
});

import type { DiscoveryContext, FrameworkAdapter } from './types.js';
import { genericAdapter } from './generic/index.js';
import { nuxt4Adapter } from './nuxt4/index.js';
import { magento2Adapter } from './magento2/index.js';
import { nestjsAdapter } from './nestjs/index.js';

const ADAPTERS: FrameworkAdapter[] = [magento2Adapter, nuxt4Adapter, nestjsAdapter, genericAdapter];

export function getAdapterByName(name: string): FrameworkAdapter | undefined {
  return ADAPTERS.find((a) => a.name === name);
}

export async function resolveAdapter(ctx: DiscoveryContext): Promise<FrameworkAdapter> {
  const forced = ctx.config.framework;
  if (forced && forced !== 'auto') {
    const adapter = getAdapterByName(forced);
    if (!adapter) throw new Error(`Unknown framework adapter: "${forced}"`);
    return adapter;
  }

  for (const adapter of ADAPTERS) {
    if (adapter.name === 'generic') continue; // fallback, tried last
    if (await adapter.detect(ctx)) return adapter;
  }

  return genericAdapter;
}

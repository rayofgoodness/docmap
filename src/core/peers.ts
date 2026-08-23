import fs from 'node:fs/promises';
import path from 'node:path';
import type { DiscoveryContext, ModuleDescriptor } from '../adapters/types.js';
import { resolveAdapter } from '../adapters/registry.js';
import { loadConfig } from '../config/load.js';
import type { Logger } from '../utils/logger.js';

export interface PeerProject {
  peerName: string;
  frameworkName: string;
  modules: ModuleDescriptor[];
}

/**
 * Discovers a single sibling ("peer") project read-only: resolves its modules using its own
 * adapter and config, but deliberately skips adapter.resolveRelations — later tasks only need
 * the peer's modules and their element summaryHints/api-surface for cross-stack matching, not
 * a full internal relation graph, which would be a wasted second source scan.
 *
 * A misconfigured or broken peer must never crash the main project's scan: any failure is
 * logged as a warning and results in `null`.
 */
export async function discoverPeer(
  peer: { name: string; path: string },
  projectRoot: string,
  logger: Logger,
): Promise<PeerProject | null> {
  const peerAbsPath = path.resolve(projectRoot, peer.path);

  try {
    const stat = await fs.stat(peerAbsPath);
    if (!stat.isDirectory()) {
      logger.warn(`Skipping peer "${peer.name}": resolved path "${peerAbsPath}" is not a directory`);
      return null;
    }
  } catch {
    logger.warn(`Skipping peer "${peer.name}": resolved path "${peerAbsPath}" does not exist`);
    return null;
  }

  try {
    const peerConfig = await loadConfig({ projectRoot: peerAbsPath });
    const peerCtx: DiscoveryContext = { projectRoot: peerAbsPath, config: peerConfig, logger };
    const adapter = await resolveAdapter(peerCtx);
    const modules = await adapter.discoverModules(peerCtx);
    return { peerName: peer.name, frameworkName: adapter.name, modules };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(`Skipping peer "${peer.name}": discovery failed (${reason})`);
    return null;
  }
}

export async function discoverAllPeers(
  peers: Array<{ name: string; path: string }>,
  projectRoot: string,
  logger: Logger,
): Promise<PeerProject[]> {
  const results = await Promise.all(peers.map((peer) => discoverPeer(peer, projectRoot, logger)));
  return results.filter((result): result is PeerProject => result !== null);
}

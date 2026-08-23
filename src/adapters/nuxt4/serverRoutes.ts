import path from 'node:path';
import type { ElementDescriptor, ModuleDescriptor } from '../types.js';
import { toPosixPath } from '../../utils/fsSafe.js';
import { listFilesUnder } from './scan.js';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

/** Nitro filename -> route path, e.g. "api/cart.get.ts" -> "/api/cart", "api/cart/[id].ts" -> "/api/cart/:id". */
export function deriveRoutePath(relPathUnderServer: string): string {
  let withoutExt = relPathUnderServer.replace(/\.(ts|js|mjs)$/, '');
  const segments = withoutExt.split('/');
  const last = segments[segments.length - 1];
  const methodMatch = last?.match(/^(.*)\.(get|post|put|patch|delete|head|options)$/);
  if (methodMatch?.[1] && HTTP_METHODS.includes(methodMatch[2] as string)) {
    segments[segments.length - 1] = methodMatch[1];
  }
  const routeSegments = segments.map((s) => s.replace(/^\[(\.\.\.)?(.+)\]$/, ':$2'));
  return `/${routeSegments.join('/')}`;
}

export async function buildServerModule(
  serverRootAbsPath: string,
  projectRoot: string,
  exclude: string[],
  include: string[],
  idOverride?: string,
  nameOverride?: string,
): Promise<ModuleDescriptor | null> {
  const files = await listFilesUnder(serverRootAbsPath, exclude, include);
  if (files.length === 0) return null;

  const elements: ElementDescriptor[] = files.map((file) => ({
    id: file.relPath,
    kind: 'server-route',
    name: path.basename(file.relPath),
    files: [file],
    summaryHints: [deriveRoutePath(file.relPath)],
  }));

  return {
    id: idOverride ?? 'server',
    name: nameOverride ?? 'Server',
    rootPath: serverRootAbsPath,
    relRootPath: toPosixPath(path.relative(projectRoot, serverRootAbsPath)),
    framework: 'nuxt4',
    elements,
    relations: [],
    files,
  };
}

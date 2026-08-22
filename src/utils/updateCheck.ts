import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Notify-only update check: reports a newer published version, never installs it.
 * The registry is consulted at most once per CHECK_INTERVAL_MS (cached in the user's
 * home dir) and every failure — offline, timeout, malformed response — is silent so
 * the actual command is never blocked by the updater. */

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 2000;

export const DEFAULT_CACHE_PATH = path.join(os.homedir(), '.docmap', 'update-check.json');

interface UpdateCache {
  lastCheckMs: number;
  latest: string;
}

export interface UpdateCheckOptions {
  packageName: string;
  currentVersion: string;
  cachePath?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string): [number, number, number] | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const l = parse(latest);
  const c = parse(current);
  if (!l || !c) return false;
  if (l[0] !== c[0]) return l[0] > c[0];
  if (l[1] !== c[1]) return l[1] > c[1];
  return l[2] > c[2];
}

function readCache(cachePath: string): UpdateCache | null {
  try {
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as UpdateCache;
    if (typeof parsed?.lastCheckMs === 'number' && typeof parsed?.latest === 'string') return parsed;
  } catch {
    // missing or corrupt cache — treat as never checked
  }
  return null;
}

function writeCache(cachePath: string, cache: UpdateCache): void {
  try {
    mkdirSync(path.dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cache));
  } catch {
    // read-only home dir etc. — the check just repeats next run
  }
}

async function fetchLatestVersion(packageName: string, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(`https://registry.npmjs.org/${packageName}/latest`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  }
}

/** Returns the newer published version if one exists, otherwise null. Never throws. */
export async function checkForUpdate(options: UpdateCheckOptions): Promise<string | null> {
  const {
    packageName,
    currentVersion,
    cachePath = DEFAULT_CACHE_PATH,
    fetchImpl = fetch,
    now = Date.now,
    env = process.env,
  } = options;

  if (env.DOCMAP_NO_UPDATE_CHECK || env.CI) return null;

  const cache = readCache(cachePath);
  let latest = cache && now() - cache.lastCheckMs < CHECK_INTERVAL_MS ? cache.latest : null;
  if (!latest) {
    latest = await fetchLatestVersion(packageName, fetchImpl);
    if (latest) writeCache(cachePath, { lastCheckMs: now(), latest });
  }
  return latest && isNewerVersion(latest, currentVersion) ? latest : null;
}

export function formatUpdateNotice(packageName: string, currentVersion: string, latest: string, color: boolean): string {
  const text = `[docmap] update available ${currentVersion} → ${latest} · npm i -g ${packageName}`;
  return color ? `\x1b[33m${text}\x1b[0m` : text;
}

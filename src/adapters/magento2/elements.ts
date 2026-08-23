import path from 'node:path';
import fg from 'fast-glob';
import fs from 'node:fs/promises';
import { XMLParser } from 'fast-xml-parser';
import type { ElementDescriptor, ElementKind, SourceFileRef } from '../types.js';
import { toPosixPath } from '../../utils/fsSafe.js';
import { isIncluded, toExcludeGlobs } from '../../utils/pathFilter.js';

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

async function readXml(absPath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(absPath, 'utf8');
    return xmlParser.parse(raw);
  } catch {
    return null;
  }
}

/** Plain etc/*.xml config files that are visible to the agent as documentable files but get no bespoke parsing. */
const PLAIN_CONFIG_FILES = ['db_schema.xml', 'system.xml', 'sales.xml', 'email_templates.xml', 'acl.xml'];

const KIND_BY_TOP_DIR: Record<string, ElementKind> = {
  Controller: 'controller',
  Model: 'model',
  Observer: 'observer',
  Plugin: 'plugin',
  Block: 'block',
  Api: 'api',
  Helper: 'helper',
  Setup: 'setup',
  Cron: 'cron',
  Console: 'console',
  ViewModel: 'viewmodel',
  Ui: 'ui',
  Gateway: 'gateway',
  CustomerData: 'section',
  Service: 'service',
};

export async function collectModuleElements(
  moduleRootAbsPath: string,
  exclude: string[],
  include: string[],
): Promise<{ elements: ElementDescriptor[]; files: SourceFileRef[] }> {
  const phpFiles = await fg(Object.keys(KIND_BY_TOP_DIR).map((dir) => `${dir}/**/*.php`), {
    cwd: moduleRootAbsPath,
    onlyFiles: true,
    ignore: toExcludeGlobs(exclude),
  });

  const elements: ElementDescriptor[] = [];
  const files: SourceFileRef[] = [];

  for (const relPath of phpFiles.filter((relPath) => isIncluded(relPath, include))) {
    const absPath = path.join(moduleRootAbsPath, relPath);
    const stat = await fs.stat(absPath);
    const file: SourceFileRef = { absPath, relPath: toPosixPath(relPath), sizeBytes: stat.size };
    files.push(file);

    const topDir = relPath.split('/')[0] as string;
    let kind = KIND_BY_TOP_DIR[topDir] ?? 'unknown';
    // GraphQL resolvers live under Model/Resolver/ but are a distinct, more specific kind
    // than the generic 'model' the top-dir lookup would otherwise assign.
    if (relPath.startsWith('Model/Resolver/')) {
      kind = 'resolver';
    }

    elements.push({
      id: file.relPath,
      kind,
      name: path.basename(relPath, '.php'),
      files: [file],
    });
  }

  return { elements, files };
}

async function buildSourceFileRef(moduleRootAbsPath: string, relPath: string): Promise<SourceFileRef> {
  const absPath = path.join(moduleRootAbsPath, relPath);
  const stat = await fs.stat(absPath);
  return { absPath, relPath: toPosixPath(relPath), sizeBytes: stat.size };
}

async function webapiElement(moduleRootAbsPath: string, relPath: string): Promise<ElementDescriptor | null> {
  const doc = await readXml(path.join(moduleRootAbsPath, relPath));
  const routes = doc?.routes as Record<string, unknown> | undefined;
  if (!routes) return null;

  const summaryHints: string[] = [];
  for (const route of asArray(routes.route as Record<string, string> | Record<string, string>[])) {
    const url = route?.['@_url'];
    const method = route?.['@_method'];
    if (!url || !method) continue;
    summaryHints.push(`${method} ${url}`);
  }

  const file = await buildSourceFileRef(moduleRootAbsPath, relPath);
  return { id: file.relPath, kind: 'api', name: 'webapi.xml', files: [file], summaryHints };
}

async function crontabElement(moduleRootAbsPath: string, relPath: string): Promise<ElementDescriptor | null> {
  const doc = await readXml(path.join(moduleRootAbsPath, relPath));
  const config = doc?.config as Record<string, unknown> | undefined;
  if (!config) return null;

  const summaryHints: string[] = [];
  for (const group of asArray(config.group as Record<string, unknown> | Record<string, unknown>[])) {
    for (const job of asArray((group as Record<string, unknown>).job as Record<string, unknown> | Record<string, unknown>[])) {
      const name = (job as Record<string, string>)?.['@_name'];
      const schedule = (job as Record<string, unknown>)?.schedule;
      if (!name) continue;
      summaryHints.push(`${name} (${typeof schedule === 'string' ? schedule : 'unknown schedule'})`);
    }
  }

  const file = await buildSourceFileRef(moduleRootAbsPath, relPath);
  return { id: file.relPath, kind: 'cron', name: 'crontab.xml', files: [file], summaryHints };
}

/** Extracts the source of a `type <typeName> { ... }` block (brace-balanced), or null if absent. */
function extractTypeBlock(source: string, typeName: string): string | null {
  const opener = new RegExp(`type\\s+${typeName}\\s*\\{`, 'm');
  const match = opener.exec(source);
  if (!match) return null;

  const start = match.index + match[0].length;
  let depth = 1;
  let i = start;
  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    i++;
  }
  return source.slice(start, depth === 0 ? i - 1 : i);
}

/** Pulls field names out of a Query/Mutation block body, one per line (`fieldName(args): Type` or `fieldName: Type`). */
function extractFieldNames(blockSource: string): string[] {
  const names: string[] = [];
  for (const rawLine of blockSource.split('\n')) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (!line) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*[:(]/.exec(line);
    if (match) names.push(match[1] as string);
  }
  return names;
}

async function schemaGraphqlsElement(moduleRootAbsPath: string, relPath: string): Promise<ElementDescriptor | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(moduleRootAbsPath, relPath), 'utf8');
  } catch {
    return null;
  }

  const summaryHints: string[] = [];
  for (const typeName of ['Query', 'Mutation']) {
    const block = extractTypeBlock(raw, typeName);
    if (block) summaryHints.push(...extractFieldNames(block));
  }

  const file = await buildSourceFileRef(moduleRootAbsPath, relPath);
  return { id: file.relPath, kind: 'api', name: 'schema.graphqls', files: [file], summaryHints };
}

/**
 * Parses etc/webapi.xml and etc/crontab.xml into dedicated elements, exposes the remaining
 * recognized etc/*.xml config files as plain 'file' elements, and folds view/**\/*.{xml,phtml,js}
 * into the module's overall `files` inventory so batching/prompt-building can pick them up.
 */
export async function collectModuleConfigElements(
  moduleRootAbsPath: string,
  exclude: string[],
  include: string[],
): Promise<{ elements: ElementDescriptor[]; files: SourceFileRef[] }> {
  const elements: ElementDescriptor[] = [];
  const files: SourceFileRef[] = [];

  const etcFiles = (
    await fg(['etc/webapi.xml', 'etc/crontab.xml', 'etc/schema.graphqls', ...PLAIN_CONFIG_FILES.map((f) => `etc/${f}`)], {
      cwd: moduleRootAbsPath,
      onlyFiles: true,
      ignore: toExcludeGlobs(exclude),
    })
  ).filter((relPath) => isIncluded(relPath, include));

  for (const relPath of etcFiles) {
    const base = path.basename(relPath);
    let element: ElementDescriptor | null = null;
    if (base === 'webapi.xml') {
      element = await webapiElement(moduleRootAbsPath, relPath);
    } else if (base === 'crontab.xml') {
      element = await crontabElement(moduleRootAbsPath, relPath);
    } else if (base === 'schema.graphqls') {
      element = await schemaGraphqlsElement(moduleRootAbsPath, relPath);
    } else if (PLAIN_CONFIG_FILES.includes(base)) {
      const file = await buildSourceFileRef(moduleRootAbsPath, relPath);
      element = { id: file.relPath, kind: 'file', name: base, files: [file] };
    }
    if (!element) continue;
    elements.push(element);
    files.push(...element.files);
  }

  const viewFiles = (
    await fg(['view/**/*.xml', 'view/**/*.phtml', 'view/**/*.js'], {
      cwd: moduleRootAbsPath,
      onlyFiles: true,
      ignore: toExcludeGlobs(exclude),
    })
  ).filter((relPath) => isIncluded(relPath, include));

  for (const relPath of viewFiles) {
    files.push(await buildSourceFileRef(moduleRootAbsPath, relPath));
  }

  return { elements, files };
}

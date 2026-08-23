import fs from 'node:fs/promises';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import type { ModuleDescriptor, RelationDescriptor } from '../types.js';
import { buildNamespaceMap, resolveOwner, type NamespaceEntry } from './namespace.js';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

async function readXml(absPath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(absPath, 'utf8');
    return parser.parse(raw);
  } catch {
    return null;
  }
}

function ownerRef(fqcn: string, nsMap: NamespaceEntry[]): { id: string; moduleId?: string } {
  const owner = resolveOwner(fqcn, nsMap);
  return owner ? { id: `${owner.moduleId}::${owner.elementId}`, moduleId: owner.moduleId } : { id: fqcn };
}

// Magento reads di.xml/events.xml from the global (root) area plus these per-area
// subdirectories. '' denotes the global area, i.e. the root-level etc/di.xml.
const AREAS = ['', 'frontend', 'adminhtml', 'webapi_rest', 'webapi_soap', 'graphql', 'crontab'];

function areaSuffix(area: string): string {
  return area ? ` (${area})` : '';
}

function areaEtcPath(module: ModuleDescriptor, area: string, fileName: string): string {
  return area ? path.join(module.rootPath, 'etc', area, fileName) : path.join(module.rootPath, 'etc', fileName);
}

async function diRelationsForArea(
  module: ModuleDescriptor,
  nsMap: NamespaceEntry[],
  area: string,
): Promise<RelationDescriptor[]> {
  const doc = await readXml(areaEtcPath(module, area, 'di.xml'));
  const config = doc?.config as Record<string, unknown> | undefined;
  if (!config) return [];

  const relations: RelationDescriptor[] = [];
  const suffix = areaSuffix(area);

  for (const pref of asArray(config.preference as Record<string, string> | Record<string, string>[])) {
    const forClass = pref?.['@_for'];
    const typeClass = pref?.['@_type'];
    if (!forClass || !typeClass) continue;
    const from = ownerRef(typeClass, nsMap);
    const to = ownerRef(forClass, nsMap);
    relations.push({
      type: 'di',
      fromId: from.id,
      toId: to.id,
      toModule: to.moduleId,
      detail: `preference for ${forClass}${suffix}`,
      confidence: 'deterministic',
    });
  }

  for (const typeNode of asArray(config.type as Record<string, unknown> | Record<string, unknown>[])) {
    const targetType = (typeNode as Record<string, string>)?.['@_name'];
    if (!targetType) continue;
    for (const plugin of asArray((typeNode as Record<string, unknown>).plugin as Record<string, string> | Record<string, string>[])) {
      const pluginType = plugin?.['@_type'];
      if (!pluginType) continue;
      const from = ownerRef(pluginType, nsMap);
      const to = ownerRef(targetType, nsMap);
      relations.push({
        type: 'plugin-intercepts',
        fromId: from.id,
        toId: to.id,
        toModule: to.moduleId,
        detail: `plugin on ${targetType}${suffix}`,
        confidence: 'deterministic',
      });
    }

    // Heuristic: <arguments><argument xsi:type="object">SomeClass</argument></arguments>
    // is DI-injected construction, not a hard code dependency the way preference/plugin
    // are (arg wiring can be overridden per-area/per-instance), so mark it heuristic.
    const argumentsNode = (typeNode as Record<string, unknown>).arguments as Record<string, unknown> | undefined;
    for (const argument of asArray(argumentsNode?.argument as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
      const argRecord = argument as Record<string, unknown>;
      if (argRecord['@_xsi:type'] !== 'object') continue;
      const depClass = argRecord['#text'];
      if (typeof depClass !== 'string' || !depClass) continue;
      const from = ownerRef(targetType, nsMap);
      const to = ownerRef(depClass, nsMap);
      relations.push({
        type: 'di',
        fromId: from.id,
        toId: to.id,
        toModule: to.moduleId,
        detail: `constructor arg: ${depClass}${suffix}`,
        confidence: 'heuristic',
      });
    }
  }

  // Heuristic: <virtualType name="X" type="Y"> is config-level composition, not a hard
  // code dependency the way preference/plugin are, so mark it heuristic.
  for (const virtualTypeNode of asArray(config.virtualType as Record<string, string> | Record<string, string>[])) {
    const vtName = virtualTypeNode?.['@_name'];
    const vtType = virtualTypeNode?.['@_type'];
    if (!vtName || !vtType) continue;
    const from = ownerRef(vtName, nsMap);
    const to = ownerRef(vtType, nsMap);
    relations.push({
      type: 'di',
      fromId: from.id,
      toId: to.id,
      toModule: to.moduleId,
      detail: `virtualType ${vtName} extends ${vtType}${suffix}`,
      confidence: 'heuristic',
    });
  }

  return relations;
}

async function diRelations(module: ModuleDescriptor, nsMap: NamespaceEntry[]): Promise<RelationDescriptor[]> {
  const relations: RelationDescriptor[] = [];
  for (const area of AREAS) {
    relations.push(...(await diRelationsForArea(module, nsMap, area)));
  }
  return relations;
}

async function eventRelationsForArea(
  module: ModuleDescriptor,
  nsMap: NamespaceEntry[],
  area: string,
): Promise<RelationDescriptor[]> {
  const doc = await readXml(areaEtcPath(module, area, 'events.xml'));
  const config = doc?.config as Record<string, unknown> | undefined;
  if (!config) return [];

  const relations: RelationDescriptor[] = [];
  const suffix = areaSuffix(area);
  for (const eventNode of asArray(config.event as Record<string, unknown> | Record<string, unknown>[])) {
    const eventName = (eventNode as Record<string, string>)?.['@_name'];
    if (!eventName) continue;
    for (const observer of asArray((eventNode as Record<string, unknown>).observer as Record<string, string> | Record<string, string>[])) {
      const instanceClass = observer?.['@_instance'];
      if (!instanceClass) continue;
      const from = ownerRef(instanceClass, nsMap);
      relations.push({
        type: 'event',
        fromId: from.id,
        toId: eventName,
        detail: `observes ${eventName}${suffix}`,
        confidence: 'deterministic',
      });
    }
  }
  return relations;
}

async function eventRelations(module: ModuleDescriptor, nsMap: NamespaceEntry[]): Promise<RelationDescriptor[]> {
  const relations: RelationDescriptor[] = [];
  for (const area of AREAS) {
    relations.push(...(await eventRelationsForArea(module, nsMap, area)));
  }
  return relations;
}

export async function resolveMagento2XmlRelations(
  modules: ModuleDescriptor[],
  nsMap: NamespaceEntry[],
): Promise<RelationDescriptor[]> {
  const relations: RelationDescriptor[] = [];
  for (const module of modules) {
    relations.push(...(await diRelations(module, nsMap)));
    relations.push(...(await eventRelations(module, nsMap)));
  }
  return relations;
}

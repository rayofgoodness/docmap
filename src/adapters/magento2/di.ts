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

async function diRelations(module: ModuleDescriptor, nsMap: NamespaceEntry[]): Promise<RelationDescriptor[]> {
  const doc = await readXml(path.join(module.rootPath, 'etc', 'di.xml'));
  const config = doc?.config as Record<string, unknown> | undefined;
  if (!config) return [];

  const relations: RelationDescriptor[] = [];

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
      detail: `preference for ${forClass}`,
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
        detail: `plugin on ${targetType}`,
        confidence: 'deterministic',
      });
    }
  }

  return relations;
}

async function eventRelations(module: ModuleDescriptor, nsMap: NamespaceEntry[]): Promise<RelationDescriptor[]> {
  const doc = await readXml(path.join(module.rootPath, 'etc', 'events.xml'));
  const config = doc?.config as Record<string, unknown> | undefined;
  if (!config) return [];

  const relations: RelationDescriptor[] = [];
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
        detail: `observes ${eventName}`,
        confidence: 'deterministic',
      });
    }
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

import fs from 'node:fs/promises';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

export async function readModuleName(moduleRootAbsPath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(moduleRootAbsPath, 'etc', 'module.xml'), 'utf8');
    const parsed = parser.parse(raw);
    const name = parsed?.config?.module?.['@_name'];
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

/** Magento module name "Vendor_Module" maps 1:1 onto the PHP namespace prefix "Vendor\Module". */
export function moduleNameToNamespace(moduleName: string): string {
  return moduleName.replace(/_/g, '\\');
}

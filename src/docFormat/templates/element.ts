import type { SectionLabels } from '../../utils/lang.js';

export function buildElementPlaceholderBody(labels: SectionLabels): string {
  return [
    `## ${labels.purpose}`,
    '_Pending generation._',
    '',
    `## ${labels.businessLogic}`,
    '_Pending generation._',
    '',
    `## ${labels.relationships}`,
    '_Pending generation._',
  ].join('\n');
}

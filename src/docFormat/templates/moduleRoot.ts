import type { SectionLabels } from '../../utils/lang.js';

export function buildModulePlaceholderBody(labels: SectionLabels): string {
  return [
    `## ${labels.purpose}`,
    '_Pending generation._',
    '',
    `## ${labels.responsibilities}`,
    '_Pending generation._',
    '',
    `## ${labels.businessLogic}`,
    '_Pending generation._',
    '',
    `## ${labels.invariants}`,
    '_Pending generation._',
    '',
    `## ${labels.inputsOutputs}`,
    '_Pending generation._',
    '',
    `## ${labels.relationships}`,
    '_Pending generation._',
  ].join('\n');
}

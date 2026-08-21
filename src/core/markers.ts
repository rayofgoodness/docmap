export const BODY_START = '<<<DOCMAP_BODY_START>>>';
export const BODY_END = '<<<DOCMAP_BODY_END>>>';
export const ELEMENT_END = '<<<END>>>';

export function elementStartMarker(id: string): string {
  return `<<<DOCMAP_ELEMENT id="${id}">>>`;
}

export interface ParsedAgentOutput {
  body: string | null;
  elements: Record<string, string>;
}

export function parseAgentOutput(text: string): ParsedAgentOutput {
  const bodyMatch = text.match(
    new RegExp(`${escapeRe(BODY_START)}([\\s\\S]*?)${escapeRe(BODY_END)}`),
  );
  const body = bodyMatch?.[1]?.trim() ?? null;

  const elements: Record<string, string> = {};
  const elementPattern = /<<<DOCMAP_ELEMENT id="([^"]+)">>>([\s\S]*?)<<<END>>>/g;
  let match: RegExpExecArray | null;
  while ((match = elementPattern.exec(text)) !== null) {
    const id = match[1];
    const content = match[2];
    if (id && content !== undefined) elements[id] = content.trim();
  }

  return { body, elements };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface ParsedInvariant {
  id: string;
  text: string;
}

const NUMBERED_ITEM = /^\d+\.\s+(.+)$/;

/**
 * Extracts the numbered list immediately following a "## <headingText>" heading in a module body,
 * assigning sequential I1, I2, ... ids in list order. Parsing stops at the next "## " heading (or the
 * end of the body), so later sections are never swallowed into the invariants list. Returns [] when the
 * heading is absent or has no matching numbered lines directly beneath it (e.g. mock-generated docs).
 */
export function parseInvariantsSection(body: string, headingText: string): ParsedInvariant[] {
  const lines = body.split('\n');
  const target = `## ${headingText}`;

  const startIndex = lines.findIndex((line) => line.trim() === target);
  if (startIndex === -1) return [];

  const invariants: ParsedInvariant[] = [];
  let n = 0;
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('## ')) break;
    const match = NUMBERED_ITEM.exec(line.trim());
    if (match) {
      n += 1;
      invariants.push({ id: `I${n}`, text: match[1]! });
    }
  }

  return invariants;
}

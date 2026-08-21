import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export function hashString(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export async function hashFile(absPath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(absPath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

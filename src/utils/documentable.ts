import path from 'node:path';

// A whitelist of "code" extensions always lags behind whatever language/format a project actually
// uses. Blocklisting known binary/asset types instead means any text-based format — code, markdown
// docs, yaml/shell deploy scripts, sql migrations, whatever — is documentable by default.
const BINARY_EXTENSIONS = new Set([
  '.ico', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif', '.svg', '.icns', '.tiff',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.mov', '.avi', '.webm', '.wav', '.ogg', '.flac',
  '.zip', '.tar', '.gz', '.tgz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.wasm', '.o', '.a', '.class', '.jar',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.db', '.sqlite', '.sqlite3',
  '.lock',
]);

export function isDocumentable(relPath: string): boolean {
  return !BINARY_EXTENSIONS.has(path.extname(relPath).toLowerCase());
}

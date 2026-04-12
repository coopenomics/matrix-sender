import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface MatrixTokenFilePayload {
  homeserver_url: string;
  username: string;
  access_token: string;
  expires_at_ms: number;
}

function isPayload(x: unknown): x is MatrixTokenFilePayload {
  if (!x || typeof x !== 'object') {
    return false;
  }
  const o = x as Record<string, unknown>;
  return (
    typeof o.homeserver_url === 'string' &&
    typeof o.username === 'string' &&
    typeof o.access_token === 'string' &&
    typeof o.expires_at_ms === 'number' &&
    Number.isFinite(o.expires_at_ms)
  );
}

export async function readMatrixTokenFile(filePath: string): Promise<MatrixTokenFilePayload | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isPayload(parsed)) {
      return null;
    }
    return parsed;
  } catch (err: unknown) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as NodeJS.ErrnoException).code : '';
    if (code === 'ENOENT') {
      return null;
    }
    return null;
  }
}

export async function writeMatrixTokenFileAtomic(filePath: string, payload: MatrixTokenFilePayload): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(payload)}\n`, 'utf8');
  await rename(tmp, filePath);
}

export async function clearMatrixTokenFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (err: unknown) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as NodeJS.ErrnoException).code : '';
    if (code !== 'ENOENT') {
      throw err;
    }
  }
}

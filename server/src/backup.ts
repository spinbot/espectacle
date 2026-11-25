// Backup and restore of everything the server keeps: the project, settings (including the MQTT and
// WiFi passwords), the yard scan, music, videos and firmware files, as one .tar.gz. Left out: the
// PlatformIO tools and build folders (downloaded again when needed) and the login secret.
import { existsSync, promises as fs } from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import type { Readable, Writable } from 'stream';
import * as tar from 'tar';

export const BACKUP_PARTS = ['project.json', 'settings.json', 'area.bin', 'audio', 'media', 'firmware'];

const skip = (p: string) => path.basename(p).startsWith('.') || p.endsWith('.tmp');

/** Streams a backup of `dataDir` to `out`. */
export async function writeBackup(dataDir: string, out: Writable) {
  const present = BACKUP_PARTS.filter(p => existsSync(path.join(dataDir, p)));
  await pipeline(tar.c({ gzip: true, cwd: dataDir, portable: true, filter: p => !skip(p) }, present), out);
}

export function backupName(d = new Date()) {
  const z = (n: number) => String(n).padStart(2, '0');
  return `espectacle-backup-${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}.tar.gz`;
}

/**
 * Unpacks an uploaded backup into a new folder inside `dataDir` (only the known parts; no paths
 * outside it) and returns that folder. The caller applies it and removes the folder.
 */
export async function unpackBackup(dataDir: string, input: Readable): Promise<string> {
  const dir = path.join(dataDir, `.restore-${Date.now()}`);
  await fs.mkdir(dir, { recursive: true });
  try {
    await pipeline(input, tar.x({
      cwd: dir, strict: true,
      filter: p => {
        const top = p.replace(/^\.\//, '').split('/')[0];
        return BACKUP_PARTS.includes(top) && !p.split('/').includes('..');
      },
    }));
    if (!existsSync(path.join(dir, 'project.json'))) throw Object.assign(new Error('that isn\'t an ESPectacle backup (there is no project in it)'), { ours: true });
    return dir;
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true });
    if ((e as Error & { ours?: boolean }).ours) throw e;
    throw new Error('that file isn\'t an ESPectacle backup (.tar.gz), or it is damaged');
  }
}

/** Plain files in one folder of an unpacked backup. */
export async function filesIn(dir: string): Promise<string[]> {
  try {
    const list = await fs.readdir(dir, { withFileTypes: true });
    return list.filter(e => e.isFile() && !skip(e.name)).map(e => e.name);
  } catch { return []; }
}

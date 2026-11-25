import { promises as fs } from 'fs';
import path from 'path';
import { AppData, ProjectEnvelope, emptyProject } from '../shared/project.js';

/**
 * Everything lives in one data folder (a Docker volume):
 *   project.json   the project, with a revision number that goes up on every change
 *   area.bin       the LiDAR yard scan (same format as the app's file)
 *   audio/         music for shows, under the file names the app gave them
 */
export class Storage {
  private project: ProjectEnvelope | null = null;
  constructor(readonly dir: string) {}

  private get projectFile() { return path.join(this.dir, 'project.json'); }
  get areaFile() { return path.join(this.dir, 'area.bin'); }
  get audioDir() { return path.join(this.dir, 'audio'); }

  async init() {
    await fs.mkdir(this.audioDir, { recursive: true });
    try {
      this.project = JSON.parse(await fs.readFile(this.projectFile, 'utf8'));
    } catch {
      this.project = { revision: 0, updated: new Date().toISOString(), data: emptyProject() };
    }
  }

  get(): ProjectEnvelope {
    return this.project!;
  }

  /**
   * Replaces the project if `baseRevision` matches (or `force`). Returns the new envelope, or
   * null on a conflict - someone else saved in between.
   */
  async put(data: AppData, baseRevision: number, force = false, atLeast = 0): Promise<ProjectEnvelope | null> {
    const cur = this.get();
    if (!force && baseRevision !== cur.revision) return null;
    const next: ProjectEnvelope = { revision: Math.max(cur.revision, atLeast) + 1, updated: new Date().toISOString(), data };
    await writeAtomic(this.projectFile, JSON.stringify(next));
    this.project = next;
    return next;
  }

  async putArea(bytes: Buffer) { await writeAtomic(this.areaFile, bytes); }

  async readArea(): Promise<Buffer | null> {
    try { return await fs.readFile(this.areaFile); } catch { return null; }
  }

  audioPath(name: string) {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.')) throw new Error('bad file name');
    return path.join(this.audioDir, name);
  }

  async listAudio(): Promise<{ name: string; bytes: number }[]> {
    const names = await fs.readdir(this.audioDir);
    return Promise.all(names.filter(n => !n.startsWith('.')).map(async name => ({
      name, bytes: (await fs.stat(path.join(this.audioDir, name))).size,
    })));
  }

  async putAudio(name: string, bytes: Buffer) { await writeAtomic(this.audioPath(name), bytes); }
}

async function writeAtomic(file: string, contents: string | Buffer) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, contents);
  await fs.rename(tmp, file);
}

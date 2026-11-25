import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import type { Request, Response, NextFunction } from 'express';

/**
 * One shared password (ESPECTACLE_PASSWORD). The app sends it as a bearer token; the website
 * logs in once and gets a signed cookie. With no password set, everything is open (fine on a
 * trusted home network, and the server says so at start-up).
 */
export class Auth {
  private secret = Buffer.alloc(0);
  constructor(readonly password: string | undefined, private dataDir: string) {}

  get enabled() { return !!this.password; }

  async init() {
    const file = path.join(this.dataDir, 'secret');
    try {
      this.secret = await fs.readFile(file);
    } catch {
      this.secret = crypto.randomBytes(32);
      await fs.writeFile(file, this.secret, { mode: 0o600 });
    }
  }

  /** Cookie value: proves the holder knew the current password. */
  private sessionToken() {
    return crypto.createHmac('sha256', this.secret).update('web:' + this.password).digest('base64url');
  }

  checkPassword(p: unknown) {
    if (!this.password || typeof p !== 'string') return false;
    const a = Buffer.from(p), b = Buffer.from(this.password);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  login(res: Response) {
    res.cookie('tl_session', this.sessionToken(), { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 365 * 86400_000 });
  }

  isAuthed(req: Request) {
    if (!this.enabled) return true;
    const h = req.headers.authorization;
    if (h?.startsWith('Bearer ') && this.checkPassword(h.slice(7))) return true;
    const cookie = (req.headers.cookie ?? '').split(';').map(s => s.trim()).find(s => s.startsWith('tl_session='));
    if (!cookie) return false;
    const v = Buffer.from(cookie.slice('tl_session='.length)), t = Buffer.from(this.sessionToken());
    return v.length === t.length && crypto.timingSafeEqual(v, t);
  }

  middleware = (req: Request, res: Response, next: NextFunction) => {
    if (this.isAuthed(req)) return next();
    res.status(401).json({ error: 'login required' });
  };
}

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const sessionToken = randomBytes(32).toString('base64url');
const allowedOrigins = new Set(
  (process.env.CHAT_ALLOWED_ORIGINS ??
    'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);

function tokenMatches(candidate: string | undefined): boolean {
  if (!candidate) return false;
  const expected = Buffer.from(sessionToken);
  const actual = Buffer.from(candidate);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function secureLocalApi(req: Request, res: Response, next: NextFunction): void {
  const origin = req.get('origin');
  if (origin && !allowedOrigins.has(origin)) {
    res.status(403).json({ error: 'This local API does not accept requests from that origin.' });
    return;
  }
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Chat-Session');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
}

export function exposeSessionToken(_req: Request, res: Response): void {
  res.json({ token: sessionToken });
}

export function requireSessionToken(req: Request, res: Response, next: NextFunction): void {
  if (!tokenMatches(req.get('x-chat-session'))) {
    res.status(401).json({ error: 'A valid local chat session token is required.' });
    return;
  }
  next();
}

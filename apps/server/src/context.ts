import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';
import type { Envelope } from './crypto/envelope.js';
import type { Db } from './db/index.js';
import type { Role } from '@qs/shared';

export interface AppCtx {
  config: Config;
  db: Db;
  envelope: Envelope;
  log: FastifyBaseLogger;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  isBreakglass: boolean;
  isDemo: boolean;
  /** A local password is set (password sign-in possible when enabled). */
  hasPassword: boolean;
  /** The account still has a temporary password (enforced for password sessions only). */
  mustChangePassword: boolean;
}

export interface SessionInfo {
  idHash: string;
  csrfToken: string;
  authMethod: string;
  expiresAt: Date;
  createdAt: Date;
  /** Last re-authentication within this session, if any. */
  reauthAt: Date | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
    session?: SessionInfo;
  }
}

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    /** Machine-readable code, included in the JSON body as { error, code } (e.g. reauth_required). */
    public code?: string,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Not found') => new HttpError(404, what);
export const forbidden = (what = 'Forbidden') => new HttpError(403, what);
export const badRequest = (what: string) => new HttpError(400, what);

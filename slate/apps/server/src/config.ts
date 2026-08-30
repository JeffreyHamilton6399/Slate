/**
 * Server config. Reads env vars with safe defaults so it boots locally with
 * zero setup and can be overridden in production.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

// Load apps/server/.env when present (native Node ≥ 21.7) so local dev can
// hold secrets like ZAI_API_KEY outside the shell. Deploys set real env vars.
try {
  process.loadEnvFile();
} catch {
  // no .env file — fine
}

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  /** Path to LevelDB store for Yjs snapshots. */
  STORAGE_DIR: z.string().default('./data'),

  /** JWT signing secret. Left unset it falls back to DEV_JWT_SECRET in dev and
   *  to a per-boot random key in production — see resolveJwtSecret below. */
  JWT_SECRET: z.string().min(1).optional(),
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24),

  /** Allowed origins for CORS. Empty = same-origin only. */
  CORS_ORIGINS: z.string().default(''),

  /** Built client dir, resolved relative to the compiled server file
   *  (apps/server/dist/), so the default reaches apps/client/dist. */
  CLIENT_DIST: z.string().default('../../client/dist'),

  /** Optional TURN config passed through to clients. */
  TURN_URL: z.string().optional(),
  TURN_USERNAME: z.string().optional(),
  TURN_CREDENTIAL: z.string().optional(),
  /** Optional URL returning `{ iceServers | array }` (e.g. Metered's
   *  /api/v1/turn/credentials?apiKey=...) — fetched server-side and cached. */
  TURN_CREDENTIALS_URL: z.string().optional(),

  /** Optional Z.AI config for /api/ai-chat (see aiChat.ts). Without
   *  ZAI_BASE_URL + ZAI_API_KEY the route responds 503 "not configured". */
  ZAI_BASE_URL: z.string().optional(),
  ZAI_API_KEY: z.string().optional(),
  ZAI_TOKEN: z.string().optional(),
  ZAI_USER_ID: z.string().optional(),
  ZAI_CHAT_ID: z.string().optional(),
  ZAI_MODEL: z.string().optional(),
});

/** The committed dev fallback. Public knowledge, so it must never sign
 *  tokens on a real deployment — those tokens are the only thing gating
 *  access to the Yjs relay, and anyone holding the key can mint one for any
 *  peer id and read or write every board on the server. */
const DEV_JWT_SECRET = 'dev-secret-CHANGE-ME-in-production-please';

const parsed = envSchema.parse(process.env);

export const isProd = parsed.NODE_ENV === 'production';

/**
 * Resolve the JWT signing key.
 *
 * Dev keeps the fixed default so tokens survive a server restart. Production
 * never falls back to it: an unset secret gets a strong per-boot random key
 * (so `docker run` stays zero-config and is still safe), and explicitly
 * setting the dev value is refused outright. Render's blueprint generates a
 * real secret; `fly.toml` and a bare `docker run` do not, which is exactly
 * the gap the random key closes.
 *
 * The per-boot key is ephemeral — tokens do not survive a restart, and a
 * multi-instance deploy would hand out keys that disagree. Clients recover on
 * their own (the sync provider re-issues on auth failure), but set JWT_SECRET
 * explicitly for stable sessions or more than one instance.
 */
function resolveJwtSecret(provided: string | undefined): string {
  if (!isProd) return provided ?? DEV_JWT_SECRET;
  if (provided === DEV_JWT_SECRET) {
    throw new Error(
      'JWT_SECRET is set to the public dev default. Set a real secret ' +
        '(e.g. `openssl rand -base64 32`) before running in production.',
    );
  }
  if (!provided) {
    console.warn(
      '[config] JWT_SECRET is not set — signing with a random per-boot key. ' +
        'Sessions will not survive a restart and multiple instances will not ' +
        'agree. Set JWT_SECRET to a stable secret in production.',
    );
    return randomBytes(32).toString('base64url');
  }
  return provided;
}

export const env = { ...parsed, JWT_SECRET: resolveJwtSecret(parsed.JWT_SECRET) };

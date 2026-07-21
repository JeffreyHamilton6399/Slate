/**
 * Server config. Reads env vars with safe defaults so it boots locally with
 * zero setup and can be overridden in production.
 */
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

  /** JWT signing secret. In dev a default is used so things "just work". */
  JWT_SECRET: z.string().default('dev-secret-CHANGE-ME-in-production-please'),
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

export const env = envSchema.parse(process.env);

export const isProd = env.NODE_ENV === 'production';

/**
 * Server config. Reads env vars with safe defaults so it boots locally with
 * zero setup and can be overridden in production.
 */
import { z } from 'zod';

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

  /** Public-facing path where the built client lives. */
  CLIENT_DIST: z.string().default('../client/dist'),

  /** Optional TURN config passed through to clients. */
  TURN_URL: z.string().optional(),
  TURN_USERNAME: z.string().optional(),
  TURN_CREDENTIAL: z.string().optional(),
});

export const env = envSchema.parse(process.env);

export const isProd = env.NODE_ENV === 'production';

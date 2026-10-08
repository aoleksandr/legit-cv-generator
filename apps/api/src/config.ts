import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

// Local dev keeps a single .env at the repo root; in Docker, env comes from compose.
for (const path of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')]) {
  if (existsSync(path)) loadDotenv({ path, quiet: true });
}

const DEV_JWT_SECRET = 'dev-only-insecure-secret';
/** Values that appear in this repo; anyone could sign sessions with them. */
const PUBLIC_SECRETS = new Set([DEV_JWT_SECRET, 'change-me-in-production', 'local-docker-secret-change-me']);
const MIN_SECRET_LENGTH = 32;

/**
 * Local dev and tests may use a built-in secret. Production (the Docker image sets
 * NODE_ENV=production) refuses to start without a real one from .env, since a known
 * secret lets anyone forge a session for any user.
 */
export function resolveJwtSecret(env: NodeJS.ProcessEnv): string {
  const secret = env.JWT_SECRET?.trim();
  if (env.NODE_ENV !== 'production') return secret || DEV_JWT_SECRET;
  if (!secret || PUBLIC_SECRETS.has(secret) || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET must be set in .env to a random value of at least ${MIN_SECRET_LENGTH} characters ` +
        '(e.g. the output of `openssl rand -hex 32`).',
    );
  }
  return secret;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://cv:cv@localhost:5432/cv',
  jwtSecret: resolveJwtSecret(process.env),
  /** Cookies are marked Secure only when served over HTTPS (not the case for local docker). */
  secureCookies: process.env.SECURE_COOKIES === 'true',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  models: {
    main: process.env.AI_MODEL_MAIN ?? 'claude-sonnet-5',
  },
  /** Per LLM call. Generation of a long CV can legitimately take a while. */
  llmTimeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 180_000),
  /**
   * pino level. Tests are silent unless DEBUG is set; in Docker (NODE_ENV=production)
   * logs are JSON lines, elsewhere pretty-printed.
   */
  logLevel: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' && !process.env.DEBUG ? 'silent' : 'info'),
  prettyLogs: process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test',
  /** Disable the background worker (used by e2e tests that drive jobs manually). */
  workerEnabled: process.env.WORKER_ENABLED !== 'false',
} as const;

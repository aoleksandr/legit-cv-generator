import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

// Local dev keeps a single .env at the repo root; in Docker, env comes from compose.
for (const path of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')]) {
  if (existsSync(path)) loadDotenv({ path, quiet: true });
}

const DEV_JWT_SECRET = 'dev-only-insecure-secret';

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://cv:cv@localhost:5432/cv',
  jwtSecret: process.env.JWT_SECRET ?? DEV_JWT_SECRET,
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

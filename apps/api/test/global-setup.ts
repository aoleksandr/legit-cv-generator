import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import pg from 'pg';

/** Recreates the test database and applies migrations, once per e2e run. */
export default async function setup() {
  const url = new URL(process.env.TEST_DATABASE_URL ?? 'postgresql://cv:cv@localhost:5432/cv_test');
  const dbName = url.pathname.slice(1);
  if (!/^[\w]+_test$/.test(dbName))
    throw new Error(`Refusing to reset "${dbName}": test database names must end in _test`);

  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(`e2e tests need Postgres at ${admin.host} (run \`pnpm db:up\`): ${(err as Error).message}`);
  }
  await client.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await client.query(`CREATE DATABASE "${dbName}"`);
  await client.end();

  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, DATABASE_URL: url.toString() },
    stdio: 'pipe',
  });
}

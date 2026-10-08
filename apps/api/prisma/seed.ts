/**
 * Development seed: creates the DEV_TEST_USER account (idempotent).
 * Run with `pnpm db:seed`; never part of the Docker / production boot.
 */
import { DEV_TEST_USER } from '@cv/shared';
import * as argon2 from 'argon2';
import pg from 'pg';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed a test account with NODE_ENV=production.');
  process.exit(1);
}

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL ?? 'postgresql://cv:cv@localhost:5432/cv',
});
await client.connect();
try {
  const { rowCount } = await client.query(
    `INSERT INTO users (id, email, password_hash) VALUES (gen_random_uuid(), $1, $2) ON CONFLICT (email) DO NOTHING`,
    [DEV_TEST_USER.email, await argon2.hash(DEV_TEST_USER.password)],
  );
  console.log(rowCount ? `Created ${DEV_TEST_USER.email}` : `${DEV_TEST_USER.email} already exists`);
} finally {
  await client.end();
}

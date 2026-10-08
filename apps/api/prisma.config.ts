import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

config({ path: '../../.env', quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'node prisma/seed.ts' },
  datasource: {
    url: process.env.DATABASE_URL ?? 'postgresql://cv:cv@localhost:5432/cv',
  },
});

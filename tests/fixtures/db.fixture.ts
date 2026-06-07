import { test as base, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

type TaskStatus = 'open' | 'done';

type TaskRow = {
  id: string;
  title: string;
  status: TaskStatus;
  created_at?: Date;
};

type TestFixtures = {
  runId: string;
  makeTitle: (label: string) => string;
  seedTask: (title: string, status?: TaskStatus) => Promise<TaskRow>;
  findTaskByTitle: (title: string) => Promise<TaskRow | undefined>;
};

type WorkerFixtures = {
  db: Pool;
};

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://demo:demo@localhost:55432/demo';

export const test = base.extend<TestFixtures, WorkerFixtures>({
  db: [
    async ({}, use) => {
      const db = new Pool({
        connectionString: databaseUrl,
        max: 5,
        connectionTimeoutMillis: 5_000,
        allowExitOnIdle: true,
      });

      await db.query('SELECT 1');

      await use(db);

      await db.end();
    },
    { scope: 'worker' },
  ],

  runId: async ({ db }, use) => {
    const runId = randomUUID();

    await use(runId);

    await db.query('DELETE FROM tasks WHERE title LIKE $1', [`e2e-${runId}-%`]);
  },

  makeTitle: async ({ runId }, use) => {
    await use((label: string) => `e2e-${runId}-${label}`);
  },

  seedTask: async ({ db }, use) => {
    await use(async (title: string, status: TaskStatus = 'open') => {
      const result = await db.query<TaskRow>(
        `INSERT INTO tasks (title, status)
         VALUES ($1, $2)
         RETURNING id, title, status`,
        [title, status],
      );

      return result.rows[0];
    });
  },

  findTaskByTitle: async ({ db }, use) => {
    await use(async (title: string) => {
      const result = await db.query<TaskRow>(
        `SELECT id, title, status, created_at
           FROM tasks
          WHERE title = $1
          ORDER BY id DESC
          LIMIT 1`,
        [title],
      );

      return result.rows[0];
    });
  },
});

export { expect };

import express from 'express';
import { Pool } from 'pg';

const app = express();
const port = Number(process.env.PORT ?? 3000);
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://demo:demo@localhost:55432/demo';

const db = new Pool({ connectionString: databaseUrl });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get('/', (_req, res) => {
  res.redirect('/tasks');
});

app.get('/health', (_req, res) => {
  res.status(200).send('ok');
});

app.get('/tasks', async (_req, res) => {
  const result = await db.query<TaskRow>(
    'SELECT id, title, status FROM tasks ORDER BY id DESC LIMIT 50',
  );

  res.type('html').send(`
    <main>
      <h1>Tasks</h1>
      <form method="post" action="/tasks">
        <label>
          Title
          <input name="title" aria-label="Title" />
        </label>
        <button type="submit">Create</button>
      </form>
      <ul>
        ${result.rows
          .map((task) => `<li>${escapeHtml(task.title)} - ${escapeHtml(task.status)}</li>`)
          .join('')}
      </ul>
    </main>
  `);
});

app.post('/tasks', async (req, res, next) => {
  try {
    await insertTask(String(req.body.title ?? ''));
    res.redirect('/tasks');
  } catch (error) {
    next(error);
  }
});

app.post('/api/tasks', async (req, res) => {
  try {
    const task = await insertTask(String(req.body.title ?? ''));
    res.status(201).json(task);
  } catch (error) {
    if (isPostgresError(error) && error.code === '23505') {
      res.status(409).json({ error: 'duplicate_task' });
      return;
    }

    if (error instanceof Error && error.message === 'title_required') {
      res.status(400).json({ error: 'title_required' });
      return;
    }

    res.status(500).json({ error: 'server_error' });
  }
});

type TaskRow = {
  id: string;
  title: string;
  status: 'open' | 'done';
};

async function insertTask(title: string): Promise<TaskRow> {
  const normalizedTitle = title.trim();

  if (!normalizedTitle) {
    throw new Error('title_required');
  }

  const result = await db.query<TaskRow>(
    `INSERT INTO tasks (title)
     VALUES ($1)
     RETURNING id, title, status`,
    [normalizedTitle],
  );

  return result.rows[0];
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function isPostgresError(error: unknown): error is { code: string } {
  return typeof error === 'object' && error !== null && 'code' in error;
}

app.listen(port, () => {
  console.log(`Demo app listening on http://localhost:${port}`);
});

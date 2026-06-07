import { test, expect } from './fixtures/db.fixture';

test('DB connector smoke test', async ({ db }) => {
  const result = await db.query<{ ok: number }>('SELECT 1::int AS ok');

  expect(result.rows[0].ok).toBe(1);
});

test('DB seed -> UI verification', async ({ page, makeTitle, seedTask }) => {
  const title = makeTitle('seeded-visible-in-ui');

  await seedTask(title);

  await page.goto('/tasks');

  await expect(page.getByText(title)).toBeVisible();
});

test('UI action -> DB verification', async ({ page, makeTitle, findTaskByTitle }) => {
  const title = makeTitle('created-from-ui');

  await page.goto('/tasks');
  await page.getByLabel('Title').fill(title);
  await page.getByRole('button', { name: 'Create' }).click();

  await expect.poll(async () => {
    return (await findTaskByTitle(title))?.status;
  }).toBe('open');
});

test('API action -> DB verification', async ({ request, makeTitle, findTaskByTitle }) => {
  const title = makeTitle('created-from-api');

  const response = await request.post('/api/tasks', {
    data: { title },
  });

  await expect(response).toBeOK();

  await expect.poll(async () => {
    return (await findTaskByTitle(title))?.title;
  }).toBe(title);
});

test('negative test: duplicate task is not inserted twice', async ({
  db,
  request,
  makeTitle,
  seedTask,
}) => {
  const title = makeTitle('duplicate-title');

  await seedTask(title);

  const response = await request.post('/api/tasks', {
    data: { title },
  });

  expect(response.status()).toBe(409);

  const countResult = await db.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM tasks WHERE title = $1',
    [title],
  );

  expect(countResult.rows[0].count).toBe(1);
});

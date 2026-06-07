# Playwright PostgreSQL Database Testing Demo

[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)
[![Playwright](https://img.shields.io/badge/test-Playwright-2EAD33)](https://playwright.dev/)
[![PostgreSQL](https://img.shields.io/badge/db-PostgreSQL-336791)](https://www.postgresql.org/)

A minimal, copy-paste-friendly reference for **database-backed E2E tests** with Playwright. Tests seed PostgreSQL directly, drive the app through UI or API, assert persistence in the database, and clean up safely while running in parallel.

> [!TIP]
> Porting this pattern to another project? Start with the [Integration Guide](./docs/db-testing-integration.md) — it catalogs every component, checklist, and agent-ready instructions.

## Why this exists

Most E2E suites stop at the UI or HTTP response. That misses an entire class of bugs: data that never landed, duplicates that slipped through, or constraints the API surface hides. This demo shows a practical middle ground — real PostgreSQL round-trips without standing up a full test harness or ORM layer.

**What you get:**

- Playwright custom fixtures with a worker-scoped `pg` pool
- Per-test data isolation via `runId` prefixes (parallel-safe, no global `TRUNCATE`)
- Five canonical test patterns: smoke, seed→UI, UI→DB, API→DB, and negative/duplicate
- Docker Compose Postgres on a dedicated port so you never hit your dev database by accident

## Architecture

```mermaid
flowchart LR
  subgraph infra [Infrastructure]
    Docker[Docker PostgreSQL]
    InitSQL[db/init/*.sql]
    Docker --> InitSQL
  end

  subgraph runtime [Test Runtime]
    PW[Playwright]
    Fixture[db.fixture.ts]
    App[Express app]
    PW --> Fixture
    PW --> App
    Fixture -->|pg Pool| Docker
    App -->|pg Pool| Docker
  end

  subgraph tests [Test Patterns]
    Seed[Seed via fixture]
    UI[UI action]
    API[API action]
    Assert[DB assertion]
    Cleanup[runId cleanup]
  end

  Fixture --> Seed
  Seed --> UI
  UI --> Assert
  API --> Assert
  Assert --> Cleanup
```

The app and tests share one `DATABASE_URL`. Playwright starts the Express server via `webServer`, passes the same connection string, and waits on `/health` before running specs.

## Prerequisites

| Tool | Purpose |
|---|---|
| [Node.js](https://nodejs.org/) 20+ | Runtime (ESM project) |
| [Docker](https://www.docker.com/) | Local PostgreSQL |
| npm | Install dependencies and run scripts |

## Quickstart

```bash
git clone https://github.com/StevenG0211/database-testing-demo.git
cd database-testing-demo

npm install
npm run db:up
npm run test:e2e
npm run db:down   # optional — tears down container and volume
```

Playwright boots the demo app automatically. You do not need to run `npm run app` separately for tests.

### Other test commands

```bash
npm run test:headed   # run with a visible browser
npm run test:ui       # Playwright UI mode
npm run app           # run the demo app alone (http://localhost:3000)
```

## What the tests demonstrate

| Test | Pattern | Proves |
|---|---|---|
| DB connector smoke | `SELECT 1` via fixture pool | Database is reachable before UI tests |
| DB seed → UI | `seedTask` then `page.goto` | Pre-seeded rows render in the browser |
| UI → DB | Form submit then `findTaskByTitle` | UI writes persist to PostgreSQL |
| API → DB | `request.post` then DB query | API writes persist to PostgreSQL |
| Duplicate negative | Seed + conflicting POST + `COUNT(*)` | Unique constraint holds; only one row exists |

Example — UI action verified in the database:

```typescript
test('UI action -> DB verification', async ({ page, makeTitle, findTaskByTitle }) => {
  const title = makeTitle('created-from-ui');

  await page.goto('/tasks');
  await page.getByLabel('Title').fill(title);
  await page.getByRole('button', { name: 'Create' }).click();

  await expect.poll(async () => {
    return (await findTaskByTitle(title))?.status;
  }).toBe('open');
});
```

## Project structure

```
database-testing-demo/
├── db/init/001_schema.sql      # Postgres schema (applied on first container boot)
├── src/app.ts                  # Express app — UI + API routes under test
├── tests/
│   ├── fixtures/db.fixture.ts  # Playwright extension: db pool, runId, helpers
│   └── tasks-db.spec.ts        # Five example specs
├── docs/
│   └── db-testing-integration.md  # Full integration guide (how-to + reference)
├── docker-compose.yml
├── playwright.config.ts
└── package.json
```

## How it works

### Custom fixture (`tests/fixtures/db.fixture.ts`)

| Fixture | Scope | Role |
|---|---|---|
| `db` | worker | Shared `pg.Pool`, smoke-tested, closed on worker exit |
| `runId` | test | UUID; scopes all data for one test; triggers cleanup |
| `makeTitle(label)` | test | Returns `e2e-{runId}-{label}` |
| `seedTask(title, status?)` | test | Inserts a row, returns it |
| `findTaskByTitle(title)` | test | Queries a row for assertions |

Import `test` and `expect` from the fixture file — not from `@playwright/test` directly.

### Parallel-safe cleanup

Each test prefixes its data with a unique `runId`. Teardown deletes only matching rows:

```typescript
await db.query('DELETE FROM tasks WHERE title LIKE $1', [`e2e-${runId}-%`]);
```

> [!IMPORTANT]
> Do not use global `TRUNCATE` or blanket `DELETE` when `fullyParallel: true`. Scoped prefixes let workers run independently without wiping each other's data.

### Parameterized SQL

All queries use bound parameters (`$1`, `$2`). Never concatenate user or test input into SQL strings.

## Configuration

| Variable | Default | Used by |
|---|---|---|
| `DATABASE_URL` | `postgres://demo:demo@localhost:55432/demo` | App, fixture, Playwright `webServer` |
| `BASE_URL` | `http://localhost:3000` | Playwright `baseURL` |
| `PORT` | `3000` | Demo app |
| `CI` | unset locally | When set, Playwright always starts a fresh server |

All three layers must agree on `DATABASE_URL`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `ECONNREFUSED` on port `55432` | Run `npm run db:up` and wait for Postgres |
| `relation "tasks" does not exist` | Reset volume: `npm run db:down && npm run db:up` |
| DB tests fail, UI tests pass | Align `DATABASE_URL` in app, fixture, and `playwright.config.ts` |
| Flaky UI → DB assertions | Use `expect.poll` for read-after-write timing |
| Parallel collisions | Always use `makeTitle()` — never hard-code titles |

## Documentation

| Document | Type | Audience |
|---|---|---|
| [Integration Guide](./docs/db-testing-integration.md) | How-to + reference | Developers or agents porting this pattern to another repo |

The integration guide includes a step-by-step checklist, component catalog, adaptation table, and agent consumption notes.

## Tech stack

- **Runtime:** Node.js, TypeScript, ESM
- **App:** Express + `pg`
- **Tests:** Playwright Test with custom fixtures
- **Database:** PostgreSQL 17 (Docker)

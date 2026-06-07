# Playwright + PostgreSQL Database Testing — Integration Guide

> Companion doc for [database-testing-demo](../README.md). Read the README for quickstart and overview; use this guide when porting the pattern elsewhere.

**Document type:** How-to Guide (with Reference sections)  
**Audience:** An agent or developer integrating database-backed E2E tests into a Node.js / Playwright project  
**Goal:** Reproduce a working pattern where tests seed data, drive UI/API, assert DB state, and clean up safely under parallel execution  
**Scope:** Infrastructure, fixtures, app wiring, test patterns, and operational commands. Does not cover ORMs, migration tools, or CI vendor specifics.

---

## 1. What You Are Building

Database testing in E2E means tests can:

1. **Seed** rows directly in PostgreSQL before or during a test
2. **Act** through the UI or HTTP API (same paths production code uses)
3. **Assert** persistence by querying the database (not only the response body)
4. **Clean up** per-test data without blocking parallel runs

This demo uses **Playwright custom fixtures** + **`pg` Pool** + **Docker PostgreSQL**. The app and tests share the same `DATABASE_URL`.

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

---

## 2. Prerequisites

| Requirement | Notes |
|---|---|
| Node.js (ESM) | `"type": "module"` in `package.json` |
| Docker | Runs PostgreSQL locally on a non-default host port |
| Playwright | `@playwright/test` |
| PostgreSQL client | `pg` + `@types/pg` |
| App server | Any HTTP server that reads `DATABASE_URL` (Express shown here) |

---

## 3. Component Catalog

Every piece required for a successful integration. An implementing agent should create or verify each item.

### 3.1 Database schema (`db/init/001_schema.sql`)

PostgreSQL init scripts run once when the container is first created. Mount them at `/docker-entrypoint-initdb.d`.

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Rules:**

- Schema must exist before tests run (`npm run db:up` before `test:e2e`)
- Use constraints (e.g. `UNIQUE`) when negative/duplicate tests are needed

---

### 3.2 Docker Compose (`docker-compose.yml`)

Provides an isolated PostgreSQL instance for local and CI use.

```yaml
services:
  db:
    image: postgres:17-alpine
    container_name: playwright-db-demo-postgres
    ports:
      - "55432:5432"          # host:container — avoid clashing with local Postgres
    environment:
      POSTGRES_DB: demo
      POSTGRES_USER: demo
      POSTGRES_PASSWORD: demo
    volumes:
      - ./db/init:/docker-entrypoint-initdb.d:ro
```

**Rules:**

- Use a dedicated host port (here `55432`) so tests do not hit a dev database by accident
- `db:down` should use `docker compose down -v` to reset volume + re-run init scripts on next up

---

### 3.3 Application database connection (`src/app.ts`)

The app under test must use the **same connection string** as tests.

```typescript
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://demo:demo@localhost:55432/demo';
const db = new Pool({ connectionString: databaseUrl });
```

**Rules:**

- Always use parameterized queries (`$1`, `$2`) — never string-concatenate SQL
- Expose both UI and API paths if tests cover both
- Map Postgres error codes (e.g. `23505` unique violation) to HTTP status codes for negative tests

---

### 3.4 Playwright config (`playwright.config.ts`)

Wires the app server and passes `DATABASE_URL` into the app process.

```typescript
const appUrl = process.env.BASE_URL ?? 'http://localhost:3000';
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://demo:demo@localhost:55432/demo';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  use: { baseURL: appUrl },
  webServer: {
    command: 'npm run app',
    url: `${appUrl}/health`,
    reuseExistingServer: !process.env.CI,
    env: {
      DATABASE_URL: databaseUrl,
      PORT: '3000',
    },
    timeout: 60_000,
  },
});
```

**Rules:**

- `webServer.env.DATABASE_URL` must match the fixture default
- Health endpoint (`/health`) gives Playwright a ready signal
- `fullyParallel: true` is safe only when tests isolate data (see §4)

---

### 3.5 DB fixture (`tests/fixtures/db.fixture.ts`) — **core integration piece**

Extends Playwright's `test` with worker-scoped DB pool and test-scoped helpers.

| Fixture | Scope | Purpose |
|---|---|---|
| `db` | worker | Shared `pg.Pool`; smoke-tested with `SELECT 1`; closed after worker |
| `runId` | test | UUID prefix for all titles in one test; triggers cleanup after test |
| `makeTitle(label)` | test | Returns `e2e-{runId}-{label}` — unique, grep-friendly title |
| `seedTask(title, status?)` | test | `INSERT ... RETURNING` helper |
| `findTaskByTitle(title)` | test | `SELECT` helper for assertions |

**Connection defaults:**

```typescript
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://demo:demo@localhost:55432/demo';
```

**Cleanup pattern (critical for parallel tests):**

```typescript
runId: async ({ db }, use) => {
  const runId = randomUUID();
  await use(runId);
  await db.query('DELETE FROM tasks WHERE title LIKE $1', [`e2e-${runId}-%`]);
},
```

**Why this works:**

- No global `TRUNCATE` — parallel workers do not wipe each other's data
- Prefix `e2e-{runId}-` scopes deletion to one test's rows
- Parameterized `LIKE` pattern prevents SQL injection

**Export pattern:**

```typescript
export const test = base.extend<TestFixtures, WorkerFixtures>({ /* ... */ });
export { expect };
```

Tests import from `./fixtures/db.fixture`, not `@playwright/test` directly.

---

### 3.6 Test specs (`tests/tasks-db.spec.ts`)

Five canonical patterns to implement or adapt:

| Test | Pattern | Key fixtures |
|---|---|---|
| DB connector smoke | Prove pool works | `db` |
| DB seed → UI verify | Arrange in DB, assert in browser | `seedTask`, `makeTitle`, `page` |
| UI action → DB verify | Act in browser, assert in DB | `findTaskByTitle`, `makeTitle`, `page` |
| API action → DB verify | Act via `request`, assert in DB | `findTaskByTitle`, `makeTitle`, `request` |
| Negative / duplicate | Seed + conflict API + count query | `db`, `seedTask`, `request`, `makeTitle` |

**Polling for async persistence:**

```typescript
await expect.poll(async () => {
  return (await findTaskByTitle(title))?.status;
}).toBe('open');
```

Use `expect.poll` when UI/API write and DB read may not be instantaneous.

---

### 3.7 NPM scripts (`package.json`)

```json
{
  "scripts": {
    "app": "tsx src/app.ts",
    "db:up": "docker compose up -d db",
    "db:down": "docker compose down -v",
    "test:e2e": "playwright test"
  },
  "dependencies": { "express": "latest", "pg": "latest" },
  "devDependencies": {
    "@playwright/test": "latest",
    "@types/pg": "latest",
    "tsx": "latest",
    "typescript": "latest"
  }
}
```

---

## 4. Integration Checklist (Agent Execution Order)

Use this as a step-by-step recipe when porting to another repo.

- [ ] **1. Add dependencies:** `pg`, `@types/pg`, `@playwright/test`
- [ ] **2. Add schema:** `db/init/*.sql` with tables your app uses
- [ ] **3. Add Docker Compose:** Postgres service + init volume mount + dedicated port
- [ ] **4. Wire app:** `Pool` from `DATABASE_URL`; parameterized queries only
- [ ] **5. Add health route:** Used by Playwright `webServer.url`
- [ ] **6. Configure Playwright:** `testDir`, `baseURL`, `webServer` with matching `DATABASE_URL`
- [ ] **7. Create `db.fixture.ts`:** worker `db` pool + `runId` cleanup + seed/query helpers
- [ ] **8. Write tests:** import `test`/`expect` from fixture; use `makeTitle` for every inserted title
- [ ] **9. Start DB:** `npm run db:up`
- [ ] **10. Run tests:** `npm run test:e2e`
- [ ] **11. Tear down (optional):** `npm run db:down`

---

## 5. Environment Variables

| Variable | Default | Used by |
|---|---|---|
| `DATABASE_URL` | `postgres://demo:demo@localhost:55432/demo` | App, fixture, Playwright `webServer` |
| `BASE_URL` | `http://localhost:3000` | Playwright `baseURL` |
| `PORT` | `3000` | App (set in `webServer.env`) |
| `CI` | unset locally | When set, Playwright does not reuse an existing server |

All three layers (fixture, config, app) must agree on `DATABASE_URL`.

---

## 6. Design Decisions (Do Not Skip)

### 6.1 Parallel-safe isolation

- **Do:** Prefix test data with a per-test UUID (`runId`)
- **Do:** Delete only rows matching that prefix in fixture teardown
- **Don't:** `TRUNCATE` or delete all rows between tests when `fullyParallel: true`

### 6.2 Worker-scoped pool

- One `Pool` per Playwright worker reduces connection churn
- `allowExitOnIdle: true` helps workers exit cleanly
- Smoke query (`SELECT 1`) fails fast if DB is down

### 6.3 Assertions live in two places

- **UI assertions:** User-visible outcome (`page.getByText`)
- **DB assertions:** Source of truth for persistence (`findTaskByTitle`, raw `COUNT(*)`)

Both are valid; DB assertions catch cases where the UI lies or caches stale data.

### 6.4 SQL safety

Always bind values:

```typescript
await db.query('SELECT * FROM tasks WHERE title = $1', [title]);
```

Never:

```typescript
await db.query(`SELECT * FROM tasks WHERE title = '${title}'`); // unsafe
```

---

## 7. File Tree Reference

```
project/
├── db/
│   └── init/
│       └── 001_schema.sql       # Schema applied on container first boot
├── src/
│   └── app.ts                   # App with pg Pool + routes under test
├── tests/
│   ├── fixtures/
│   │   └── db.fixture.ts        # Playwright extension: db, runId, helpers
│   └── tasks-db.spec.ts         # Example specs (5 patterns)
├── docker-compose.yml           # Local Postgres
├── playwright.config.ts         # webServer + env wiring
└── package.json                 # db:up, db:down, test:e2e scripts
```

---

## 8. Verification Commands

```bash
npm install
npm run db:up          # wait for Postgres healthy
npm run test:e2e       # Playwright starts app + runs tests
npm run db:down        # optional: remove container + volume
```

**Expected outcomes:**

- All 5 tests pass
- No leftover rows matching `e2e-%` after suite (each test cleans its `runId`)
- Connector smoke test confirms DB reachable before UI tests run

---

## 9. Adapting to Another Project

| This demo | Your project |
|---|---|
| `tasks` table | Your domain tables |
| `seedTask` / `findTaskByTitle` | Helpers matching your schema |
| `DELETE ... WHERE title LIKE 'e2e-{runId}-%'` | Cleanup keyed on your isolation column/prefix |
| Express + HTML | Next.js, Fastify, etc. — keep `DATABASE_URL` + health check |
| Port `55432` | Any free host port; update default connection string everywhere |

**Minimum viable port:**

1. Docker Postgres + init SQL
2. App reading `DATABASE_URL`
3. Fixture with worker pool + per-test cleanup prefix
4. One smoke test + one round-trip test (seed→UI or UI→DB)

---

## 10. Common Failures

| Symptom | Likely cause | Fix |
|---|---|---|
| `ECONNREFUSED` on `55432` | DB not running | `npm run db:up` |
| App tests pass, DB tests fail | Mismatched `DATABASE_URL` | Align fixture, `playwright.config.ts`, and app defaults |
| Flaky UI→DB test | Read before commit visible | Use `expect.poll` |
| Parallel collisions | Missing `runId` prefix or global truncate | Scope data + targeted DELETE |
| `relation "tasks" does not exist` | Volume reused without init | `docker compose down -v` then `db:up` |
| Unique violation unexpected | Reused title across tests | Always use `makeTitle()` |

---

## 11. Agent Consumption Notes

When another agent uses this document:

1. Treat **§3 Component Catalog** and **§4 Checklist** as the authoritative integration surface.
2. Copy fixture patterns verbatim first; only rename table/column helpers after green tests.
3. Preserve the **runId + prefixed cleanup** pattern before enabling `fullyParallel`.
4. Do not mock the database for persistence tests — the value is real round-trips.
5. Reference implementation lives in the `database-testing-demo` repo paths listed in §7.

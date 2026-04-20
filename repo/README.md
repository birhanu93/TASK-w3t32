# Training Assessment & Content Governance Backend

Offline-first fitness and skills evaluation platform. Participants complete structured plans, submit activity logs, earn rankings/certificates, and interact with moderated content — all without external network dependencies.

**Stack:** Koa · Knex · PostgreSQL · Argon2id · AES-256-GCM · JWT · Pino

---

## Quick Start

The primary deployment method is Docker. A single command builds the app, starts PostgreSQL, runs migrations, seeds roles/permissions, and serves the API.

### Prerequisites

- Docker & Docker Compose

### 1. Configure secrets

```bash
cp .env.example .env
```

Edit `.env` and set the four required secrets:

| Variable | How to generate |
|---|---|
| `DB_PASSWORD` | Any strong password |
| `JWT_SECRET` | `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"` |
| `ENCRYPTION_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `CERTIFICATE_SECRET` | `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"` |

### 2. Build and start

```bash
docker-compose up --build
```

The container auto-runs migrations and seeds on first start. The API is available at `http://localhost:3000`. If any required secret is missing, docker-compose will fail fast with an error message.

### 3. Create demo users

After the container is running, register a user for each role. The first step is to register users via the `/api/auth/register` endpoint, then promote them to the appropriate role using the admin account.

```bash
# Register the admin user (automatically gets Participant role)
curl -s -X POST http://localhost:3000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","email":"admin@demo.local","password":"AdminPass12345!","full_name":"Demo Administrator"}' | jq .

# Save the admin token (you will use it to assign roles)
ADMIN_TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"AdminPass12345!"}' | jq -r .token)
```

Then assign the Administrator role and register the remaining users:

```bash
# Get the admin user ID and Administrator role — assign it
ADMIN_ID=$(curl -s http://localhost:3000/api/auth/me -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r .id)
curl -s -X POST "http://localhost:3000/api/users/$ADMIN_ID/roles" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"role_name":"Administrator"}'

# Register and assign Operations Manager
curl -s -X POST http://localhost:3000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"opsmanager","email":"ops@demo.local","password":"OpsPass123456!","full_name":"Demo Ops Manager"}'
OPS_ID=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"opsmanager","password":"OpsPass123456!"}' | jq -r .user.id)
curl -s -X POST "http://localhost:3000/api/users/$OPS_ID/roles" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"role_name":"Operations Manager"}'

# Register and assign Reviewer
curl -s -X POST http://localhost:3000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"reviewer","email":"reviewer@demo.local","password":"ReviewPass1234!","full_name":"Demo Reviewer"}'
REVIEWER_ID=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"reviewer","password":"ReviewPass1234!"}' | jq -r .user.id)
curl -s -X POST "http://localhost:3000/api/users/$REVIEWER_ID/roles" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"role_name":"Reviewer"}'

# Register and assign Coach
curl -s -X POST http://localhost:3000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"coach","email":"coach@demo.local","password":"CoachPass12345!","full_name":"Demo Coach"}'
COACH_ID=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"coach","password":"CoachPass12345!"}' | jq -r .user.id)
curl -s -X POST "http://localhost:3000/api/users/$COACH_ID/roles" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"role_name":"Coach"}'

# Register Participant (default role — no promotion needed)
curl -s -X POST http://localhost:3000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"participant","email":"participant@demo.local","password":"PartPass123456!","full_name":"Demo Participant"}'
```

### Demo Credentials

After running the setup commands above, the following accounts are available:

| Role | Username | Email | Password |
|---|---|---|---|
| **Administrator** | `admin` | `admin@demo.local` | `AdminPass12345!` |
| **Operations Manager** (alias: OManager) | `opsmanager` | `ops@demo.local` | `OpsPass123456!` |
| **Reviewer** | `reviewer` | `reviewer@demo.local` | `ReviewPass1234!` |
| **Coach** | `coach` | `coach@demo.local` | `CoachPass12345!` |
| **Participant** | `participant` | `participant@demo.local` | `PartPass123456!` |

All passwords meet the 12-character minimum. Login via `POST /api/auth/login` returns a JWT token valid for 24 hours.

---

## Verification

After the service is running, verify it is working correctly:

### Health check

```bash
curl -s http://localhost:3000/health | jq .
```

Expected response:

```json
{
  "status": "healthy",
  "timestamp": "2026-04-16T12:00:00.000Z",
  "uptime": 12.345
}
```

### Login and get a token

```bash
curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"AdminPass12345!"}' | jq .
```

Expected response:

```json
{
  "user": {
    "id": "...",
    "username": "admin",
    "email": "admin@demo.local",
    "full_name": "Demo Administrator",
    "roles": ["Participant", "Administrator"]
  },
  "token": "eyJhbGciOiJIUzI1NiIs..."
}
```

### List plans (authenticated)

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"participant","password":"PartPass123456!"}' | jq -r .token)

curl -s http://localhost:3000/api/plans \
  -H "Authorization: Bearer $TOKEN" | jq .
```

Expected response:

```json
{
  "data": [],
  "pagination": {
    "page": 1,
    "per_page": 20,
    "total": 0,
    "total_pages": 0
  }
}
```

### Create a campaign (requires campaigns.manage permission)

```bash
ADMIN_TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"AdminPass12345!"}' | jq -r .token)

curl -s -X POST http://localhost:3000/api/campaigns \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Welcome Campaign","description":"Onboarding promotion"}' | jq .
```

Expected response:

```json
{
  "id": "...",
  "name": "Welcome Campaign",
  "description": "Onboarding promotion",
  "status": "draft",
  "created_at": "..."
}
```

### Run a data consistency check

```bash
curl -s -X POST http://localhost:3000/api/data/consistency-check \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq .
```

Expected response:

```json
{
  "checked_at": "2026-04-16T12:00:00.000Z",
  "foreign_key_issues": [],
  "orphan_records": [],
  "total_issues": 0
}
```

---

## Configuration

All configuration is in `src/config/index.js`, driven by environment variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server listen port |
| `NODE_ENV` | `development` | `development`, `production`, or `test` |
| `DB_HOST` | `localhost` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_NAME` | `training_assessment` | Database name |
| `DB_USER` | `postgres` | Database user |
| `DB_PASSWORD` | `postgres` | Database password |
| `JWT_SECRET` | **required** | JWT signing secret (64-byte hex). Auto-generated only in `test` mode |
| `ENCRYPTION_KEY` | **required** | AES-256 key for at-rest encryption (32-byte hex). Auto-generated only in `test` mode |
| `CERTIFICATE_SECRET` | **required** | HMAC secret for certificate verification codes (64-byte hex). Auto-generated only in `test` mode |
| `JWT_EXPIRES_IN` | `24h` | JWT token lifetime |
| `DATA_DIR` | `./data` | Local storage directory for logs and metrics |

## Running Tests

Tests run **inside the `app` container** via the Docker-first script
`run_tests.sh`, which wraps `docker-compose exec` so every path matches
what CI uses:

```bash
# Default: unit + api (no DB dependency)
./run_tests.sh

# Targets
./run_tests.sh unit         # pure functions, middleware — no DB
./run_tests.sh api          # HTTP tests with mocked DB
./run_tests.sh integration  # no-mock DB-backed HTTP integration tests
./run_tests.sh all          # unit + api + integration
./run_tests.sh ci           # alias for `all` (CI path)
```

Equivalent raw commands (the script runs these for you):

```bash
# Unit
docker-compose exec app sh -c "NODE_ENV=test node --test tests/unit/*.test.js"

# API (mocked-DB HTTP)
docker-compose exec app sh -c "NODE_ENV=test node --test tests/api/*.test.js"

# Integration (real PostgreSQL in the sibling db service)
docker-compose exec \
  -e NODE_ENV=test -e DB_HOST=db -e DB_NAME=training_assessment_test \
  app sh -c "node --test tests/integration/*.integration.test.js"
```

Tests use the Node.js built-in test runner (`node:test`) — no external
test framework required. API tests mock only the database layer and make
real HTTP requests against Koa app instances. Integration suites run
against the live PostgreSQL `db` service; `run_tests.sh integration`
(re)creates a throwaway `training_assessment_test` database before
invoking the suites.

## API Overview

All endpoints are prefixed under their resource group. Authentication via `Authorization: Bearer <token>`.

| Group | Prefix | Description |
|---|---|---|
| Auth | `/api/auth` | Register, login, profile, password change |
| Users | `/api/users` | User management, role assignment |
| Plans | `/api/plans` | Training plans, tasks, enrollments |
| Activity Logs | `/api/activity-logs` | Log submission (single/batch), outlier approval |
| Assessments | `/api/assessments` | Scoring rules, score computation, outlier checks |
| Rankings | `/api/rankings` | Level progression, leaderboard, certificates, verification |
| Content | `/api/content` | Content CRUD, topics, violation categories |
| Moderation | `/api/moderation` | Review queue, reports, appeals |
| Campaigns | `/api/campaigns` | Campaigns, placements, coupons, A/B tests, analytics |
| Messages | `/api/messages` | In-app messaging, templates, subscriptions |
| Data | `/api/data` | Import/export, backup/restore, consistency checks |
| Resources | `/api/resources` | Resource management, ACL entries |
| Audit | `/api/audit` | Immutable audit log queries |

### Roles

| Role | Access |
|---|---|
| Administrator | Full system access |
| Operations Manager / OManager | Plans, campaigns, content config, data ops, messaging |
| Reviewer | Content moderation, violation categories |
| Coach | Training plans, participant data, outlier approval |
| Participant | Enroll, submit logs, view own scores/certificates |

### Key Features

- **Assessment scoring:** Configurable items (time/reps/combined), per-item weights summing to 1.00, min/max normalization to 0-100, outlier detection (3-sigma from trailing 30)
- **Rankings:** Rolling 14-day window, Bronze >= 60 / Silver >= 75 / Gold >= 90
- **Certificates:** HMAC-SHA256 tamper-evident verification, fully offline verification endpoint
- **Content moderation:** Keyword lists, file type allowlists, size limits, SHA-256 fingerprint blocking, 14-day appeal window
- **Campaigns:** Phased rollout (5% -> 25% -> 50% -> 100%), deterministic A/B assignment, idempotent event ingestion
- **Security:** Argon2id (min 12 chars), 10-attempt lockout/15 min, AES-256-GCM at rest, RBAC + ACL with deny overrides, immutable audit trail
- **Observability:** Structured Pino logs, p95 latency tracking, persisted metrics snapshots
- **Offline-first:** Zero external dependencies, single-node Docker deployment


# Training Assessment & Content Governance Backend

Offline-first fitness and skills evaluation platform. Participants complete structured plans, submit activity logs, earn rankings/certificates, and interact with moderated content — all without external network dependencies.

**Stack:** Koa · Knex · PostgreSQL · Argon2id · AES-256-GCM · JWT · Pino

---

## Prerequisites

**Local development:**
- Node.js >= 20
- PostgreSQL 16+

**Containerized deployment:**
- Docker & Docker Compose
- A `.env` file with `DB_PASSWORD`, `JWT_SECRET`, `ENCRYPTION_KEY`, and `CERTIFICATE_SECRET` set (see Quick Start below)

## Quick Start (Docker)

```bash
# 1. Create a .env file with required secrets (docker-compose reads it automatically)
cp .env.example .env
# Edit .env — you MUST set DB_PASSWORD, JWT_SECRET, ENCRYPTION_KEY, CERTIFICATE_SECRET
# Generate secrets:
#   node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"   # JWT_SECRET, CERTIFICATE_SECRET
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # ENCRYPTION_KEY

# 2. Build and start
docker-compose up --build
# API available at http://localhost:3000
# Health check at http://localhost:3000/health
```

The container auto-runs migrations and seeds on first start. If any required secret is missing, docker-compose will fail fast with an error message.

## Quick Start (local)

```bash
# 1. Install dependencies
npm install

# 2. Configure environment (copy and edit)
cp .env.example .env
# Edit .env with your PostgreSQL credentials and secrets

# 3. Run migrations
npm run migrate

# 4. Seed roles, permissions, templates, violation categories
npm run seed

# 5. Start the server
npm start          # production
npm run dev        # development (auto-reload)
```

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

Generate secrets:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"   # JWT_SECRET, CERTIFICATE_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # ENCRYPTION_KEY
```

## Database Migrations

```bash
npm run migrate            # Apply all pending migrations
npm run migrate:rollback   # Roll back the last migration batch
```

Migration files live in `src/db/migrations/`. The schema creates 25+ tables including users, roles, permissions, plans, tasks, activity_logs, assessment_rules, computed_scores, rankings, certificates, content_items, moderation_cases, appeals, campaigns, placements, coupons, messages, subscriptions, import_jobs, and more.

## Seed Data

```bash
npm run seed
```

Seeds create:
- **5 roles:** Administrator, Operations Manager (alias: OManager), Reviewer, Coach, Participant
- **26 permissions** mapped to roles
- **4 message templates:** enrollment confirmation, waitlist promotion, schedule change, score release
- **2 violation categories:** Inappropriate Language (keyword-based), File Policy (type/size-based)

## Running Tests

```bash
# Full suite (167+ tests)
./run_tests.sh

# By category
./run_tests.sh unit        # Unit tests only (pure functions, middleware)
./run_tests.sh api         # API route tests only (HTTP-level with mock DB)

# Via npm
npm test                   # All tests
npm run test:unit          # Unit tests
npm run test:api           # API tests
```

Tests use Node.js built-in test runner (`node:test`) — no external test framework required. API tests mock the database layer and make real HTTP requests against Koa app instances.

## Static Verification

```bash
# Syntax check all source files
node -e "
const fs = require('fs');
const path = require('path');
function check(dir) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory() && f.name !== 'node_modules') check(p);
    else if (f.name.endsWith('.js')) {
      try { require(p); console.log('OK', p); }
      catch(e) { console.error('FAIL', p, e.message); process.exitCode = 1; }
    }
  }
}
check('./src');
"
```

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

- **Assessment scoring:** Configurable items (time/reps/combined), per-item weights summing to 1.00, min/max normalization to 0–100, outlier detection (3σ from trailing 30)
- **Rankings:** Rolling 14-day window, Bronze ≥ 60 / Silver ≥ 75 / Gold ≥ 90
- **Certificates:** HMAC-SHA256 tamper-evident verification, fully offline verification endpoint
- **Content moderation:** Keyword lists, file type allowlists, size limits, SHA-256 fingerprint blocking, 14-day appeal window
- **Campaigns:** Phased rollout (5% → 25% → 50% → 100%), deterministic A/B assignment, idempotent event ingestion
- **Security:** Argon2id (min 12 chars), 10-attempt lockout/15 min, AES-256-GCM at rest, RBAC + ACL with deny overrides, immutable audit trail
- **Observability:** Structured Pino logs, p95 latency tracking, persisted metrics snapshots
- **Offline-first:** Zero external dependencies, single-node Docker deployment

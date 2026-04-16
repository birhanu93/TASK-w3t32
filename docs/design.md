# Overview

This system is a single-node, offline-capable backend for a training assessment and content governance program. It manages participant plans/tasks/logs, computes assessments and rankings, issues certificates, moderates content, runs campaigns/coupons/A-B tests, supports in-app messaging, and performs data interchange (import/export/backup/restore) without external network dependencies.

Technology stack:
- API: Koa (resource-grouped routing, middleware pipeline)
- Data access: Knex (migrations, query building, transactions)
- Persistence: PostgreSQL (primary store, local-only deployment)
- Runtime: Docker single-node deployment

# Goals and non-goals

## Goals

- Provide secure offline-first backend APIs for all required domains: auth, user profile, plans/tasks/logs, assessments, rankings, content/moderation, campaigns, messaging, and data interchange.
- Implement deterministic scoring and explainability:
  - weighted item scoring where item weights sum to `1.00`
  - normalization to `0-100` by per-item min/max bounds
  - outlier exclusion (`> 3` standard deviations from trailing `30` submissions unless approved)
  - attribution dimensions and percentile peer comparison by cohort
  - full traceability to source log IDs and rule versions
- Enforce combined RBAC + ACL with inheritance and explicit deny precedence.
- Ensure immutable auditability for all privileged operations.
- Support certificates with tamper-evident offline verification codes.
- Meet p95 API latency target (<300 ms for common queries at 200 concurrent users).

## Non-goals

- Any external integrations (email/SMS providers, third-party auth, cloud analytics).
- Multi-node clustering or distributed consensus.
- Real-time external communications dependent on internet connectivity.

# Architecture

Layered architecture with domain modules:

1. API Layer (Koa)
   - Resource-grouped routers: `auth`, `users`, `plans`, `assessments`, `rankings`, `content`, `moderation`, `campaigns`, `messages`, `data`.
   - Middleware chain:
     - request ID + structured logging
     - authentication/session/token validation
     - authorization (RBAC + ACL checks)
     - validation (schema-level request/body/query/path checks)
     - idempotency handling for event ingestion/import
     - error normalization

2. Domain Services Layer
   - Encapsulates business logic:
     - scoring engine and outlier analysis
     - ranking window computation
     - certificate code generation/verification
     - moderation workflow and appeal rules
     - campaign rollout and deterministic A/B assignment
     - template rendering + placeholder validation
     - import/export conflict resolution and consistency checks

3. Data Access Layer (Knex Repositories)
   - Transaction boundaries for multi-table mutations.
   - Optimized read queries for common dashboard/list endpoints.
   - Row-level filtering support for ACL-aware queries.

4. Persistence Layer (PostgreSQL)
   - Relational schema with strict foreign keys.
   - Versioned rules and immutable audit/event histories.
   - Indexing optimized for `user_id`, `created_at`, lookup keys, and unique constraints.

Cross-cutting:
- Crypto service for AES-256 field encryption and certificate code material handling.
- Password policy and lockout service (Argon2id, failed-attempt windows).
- Metrics/logging service storing output locally.

# Data model

Core entities and key constraints:

- `users`
  - unique: `username`
  - fields: role linkage, cohort, auth lockout counters, timestamps
  - indexes: `user_id`, `created_at`

- `roles`, `permissions`, `resources`, `acl_entries`
  - ACL actions: `read`, `download`, `edit`, `delete`, `share`, `submit`, `approve`
  - inheritance basis: folder/topic ownership
  - explicit deny override flag

- `plans`, `tasks`, `activity_logs`
  - task completion and user-submitted metrics (seconds/reps/combined)
  - append-only option for logs for merge conflict handling

- `assessment_rules` (versioned)
  - unique active version per assessment type
  - scoring item definitions:
    - metric type (`time_seconds`, `rep_count`, `combined_completion`)
    - weight (decimal), min/max bounds
    - attribution dimension mapping
  - rule metadata for traceability

- `computed_scores`
  - stores final score, per-dimension breakdown, percentile, excluded-log markers
  - links to `assessment_rule_version`

- `rankings`
  - rolling 14-day aggregate status
  - level values: Bronze/Silver/Gold thresholds

- `certificates`
  - unique verification code
  - issue metadata and ranking snapshot reference

- `content_items`, `moderation_cases`, `appeals`
  - moderation status history + reviewer comments
  - appeal window enforcement (`<=14 days` from decision)

- `campaigns`, `placements`, `coupons`
  - rollout phases and placement scheduling
  - coupon rule bounds:
    - fixed amount: `$5` to `$50`
    - percent discount: `5%` to `30%`
    - spend-threshold discount support

- `messages`, `subscriptions`
  - in-app channel only
  - template version reference, read/unread state

- `import_jobs`
  - format, schema version, validation result, conflict strategy, status

- `audit_logs` (immutable)
  - actor, action, resource, before hash, after hash, timestamp

- `events` (analytics ingestion)
  - idempotency key uniqueness
  - funnel stage, campaign/experiment links

# Core flows

1. Authentication and account protection
   - User login validates Argon2id hash.
   - Enforce minimum password length 12 during set/reset.
   - After 10 failed attempts, account lockout for 15 minutes.

2. Activity logging and assessment computation
   - Participant submits log (`time`, `reps`, or combined values).
   - System loads active rule version for assessment type.
   - Validate item weight sum equals `1.00` (fixed decimal precision).
   - For each item:
     - normalize value to `0-100` via rule min/max
     - apply metric-direction handling (e.g., lower time better)
   - Outlier detection compares candidate input against trailing 30 submissions for user/item:
     - if deviation > 3 standard deviations, mark as outlier and exclude
     - include only with manual reviewer approval
   - Aggregate weighted score and write `computed_scores` with traceability references.

3. Attribution and percentile analysis
   - Attribution dimensions aggregate weighted contributions by configured dimension.
   - Percentiles computed by cohort using recent valid score distribution.
   - Response includes per-item sources and originating log IDs + rule version.

4. Ranking and certificate issuance
   - Rolling 14-day score window updates level:
     - Bronze >= 60
     - Silver >= 75
     - Gold >= 90
   - Eligible users receive certificate.
   - Verification code derived from certificate ID, user ID, issue timestamp, and local secret; stored and validated offline.

5. Moderation and appeal workflow
   - On content submit, deterministic pre-screen executes:
     - keyword rules
     - file type allowlist
     - file size limits
     - SHA-256 fingerprint checks
   - Cases enter review queue; reviewer adds decision/comments.
   - Appeals allowed only within 14 days; approved appeal reopens review.

6. Campaigns, rollout, and analytics
   - Campaign placement schedules enforced by start/end timestamps.
   - Rollout ramps in phases (5% -> 25% -> 50% -> 100%).
   - A/B assignment uses deterministic hash(user_id, experiment_id).
   - Event ingestion uses idempotency key dedupe and persists conversion funnel events.

7. Import/export and consistency maintenance
   - Import JSON/CSV with schema validation.
   - Run FK completeness and orphan detection checks before commit.
   - Resolve conflicts by last-write-wins on `updated_at`; optional merge for append-only logs.
   - Backup/restore operations are local and integrity-checked.

# Security and privacy considerations

- Passwords: Argon2id with secure parameters and per-user salts.
- Secrets/sensitive fields: AES-256 at rest (application-level encryption), keys stored locally (no external KMS).
- Authz: RBAC baseline, ACL enforcement per resource/action, explicit deny precedence over inherited grants.
- Audit: immutable privileged-action records; append-only with cryptographic hash chaining optional for tamper evidence.
- Input hardening: strict schema validation and placeholder validation for message templates.
- Offline-only policy: all integrations disabled if they require external network.

# Performance and scalability constraints

- Target: p95 < 300 ms at 200 concurrent users for common read/write operations.
- Approach:
  - composite indexes for common filters/sorts (`user_id`, `created_at`, status/type fields)
  - precomputed rolling aggregates for rankings
  - bounded window queries for outlier detection (last 30 logs)
  - pagination and projection controls for list endpoints
  - batched writes for event ingestion/import jobs

# Reliability and failure handling

- Transactional integrity for multi-entity updates (e.g., score + ranking + certificate issuance states).
- Idempotent ingestion via unique idempotency keys.
- Retry-safe import job execution with persisted checkpoints.
- Failure states explicit on moderation, campaign publication, and import workflows.
- Backup/restore includes pre-restore validation and post-restore consistency checks.

# Observability and analytics

- Structured logs:
  - request metadata, actor, resource, latency, status, error class
  - stored locally in rotating files/tables
- Metrics:
  - endpoint latency percentiles
  - auth failures/lockouts
  - scoring compute timings and outlier rates
  - moderation queue depth and SLA timers
  - campaign conversion funnel metrics
- Traceability:
  - computed score provenance references item-level source logs and rule versions.

# Deployment/runtime assumptions

- Single Docker container deployment with Koa app + PostgreSQL service in local environment.
- No external credentials, no external APIs, no network dependency required for normal operation.
- Time synchronization depends on local host clock; timestamps are UTC in storage.
- Background workers (within same node/process group) handle async jobs:
  - campaign ramp progression
  - analytics aggregation
  - import processing
  - notification rendering/distribution (in-app only)

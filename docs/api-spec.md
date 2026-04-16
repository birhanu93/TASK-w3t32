# API Specification

Base path: `/api/v1`  
Content types:
- Request: `application/json` (imports additionally support `text/csv`)
- Response: `application/json`

Authentication:
- Offline-local auth (no external identity provider).
- Access token required for protected endpoints.

## Error model

All errors return:

```json
{
  "error": {
    "code": "STRING_CODE",
    "message": "Human readable message",
    "details": {},
    "request_id": "uuid"
  }
}
```

Common codes:
- `VALIDATION_ERROR`
- `AUTH_INVALID_CREDENTIALS`
- `AUTH_LOCKED`
- `AUTH_FORBIDDEN`
- `NOT_FOUND`
- `CONFLICT`
- `OUTLIER_EXCLUDED`
- `IDEMPOTENCY_REPLAY`
- `RULE_VERSION_CONFLICT`
- `IMPORT_SCHEMA_INVALID`

## Versioning strategy

- URI versioning (`/v1`).
- `assessment_rules.version` controls scoring logic compatibility.
- Backward-incompatible API changes require `/v2`.

## Validation and invariants

- Password min length: `12`.
- Lockout: `10` failed logins => `15 minutes` locked.
- Assessment item weights per rule version must sum to exactly `1.00` (fixed decimal precision).
- Only one active rule version per assessment type.
- Certificate verification code must be unique.
- Coupon constraints:
  - fixed discount: `5.00 <= value <= 50.00`
  - percent discount: `5 <= value <= 30`
- Appeals accepted only within `14 days` of moderation decision.
- Event ingestion requires idempotency key.

---

## Auth

### POST `/auth/login`

Request:

```json
{
  "username": "participant_001",
  "password": "StrongPassword123!"
}
```

Response `200`:

```json
{
  "token": "jwt-or-local-token",
  "user": {
    "id": "usr_123",
    "role": "Participant",
    "cohort_id": "cohort_a"
  }
}
```

Failure:
- `401 AUTH_INVALID_CREDENTIALS`
- `423 AUTH_LOCKED` with lockout expiry timestamp

### POST `/auth/logout`
- Invalidates token/session.

---

## Users, roles, ACL

### GET `/users/:id`
- Requires `read` permission through RBAC + ACL resolution.

### POST `/acl/check`

Request:

```json
{
  "actor_user_id": "usr_100",
  "resource_id": "cnt_900",
  "action": "approve"
}
```

Response:

```json
{
  "allowed": false,
  "decision_path": {
    "rbac": true,
    "inherited_acl": true,
    "explicit_deny": true
  }
}
```

### POST `/acl/entries`
- Create ACL entry with allow/deny and inheritance scope.
- Privileged action must emit immutable audit record.

---

## Plans, tasks, activity logs

### GET `/plans`
- Filters: `user_id`, `status`, pagination.

### POST `/tasks/:taskId/logs`

Request:

```json
{
  "user_id": "usr_123",
  "logged_at": "2026-04-16T10:00:00Z",
  "metrics": {
    "time_seconds": 75,
    "rep_count": 42,
    "completion": 1
  },
  "notes": "session complete"
}
```

Response `201`:

```json
{
  "log_id": "log_789",
  "status": "accepted"
}
```

---

## Assessment rules and scoring

### POST `/assessment-rules`
- Create new versioned rule set (admin/ops only).

Request:

```json
{
  "assessment_type": "fitness_baseline",
  "version": 3,
  "active": true,
  "items": [
    {
      "item_key": "sprint_100m",
      "metric_type": "time_seconds",
      "weight": 0.4,
      "min_bound": 10,
      "max_bound": 60,
      "direction": "lower_is_better",
      "dimension": "endurance"
    },
    {
      "item_key": "pushups",
      "metric_type": "rep_count",
      "weight": 0.6,
      "min_bound": 0,
      "max_bound": 80,
      "direction": "higher_is_better",
      "dimension": "strength"
    }
  ]
}
```

Validation:
- Reject when weight sum != `1.00`.
- Reject activation if another active version exists for same assessment type.

### POST `/assessments/compute`

Request:

```json
{
  "user_id": "usr_123",
  "assessment_type": "fitness_baseline",
  "log_ids": ["log_789", "log_790"]
}
```

Response `200`:

```json
{
  "computed_score_id": "score_3001",
  "total_score": 82.45,
  "rule_version": 3,
  "outlier_flags": [
    {
      "log_id": "log_790",
      "item_key": "sprint_100m",
      "reason": "beyond_3_stddev",
      "excluded": true
    }
  ],
  "dimensions": {
    "strength": 88.0,
    "endurance": 77.2,
    "consistency": 81.5
  },
  "percentile": {
    "cohort_id": "cohort_a",
    "value": 91.2
  },
  "traceability": [
    {
      "item_key": "pushups",
      "log_id": "log_789",
      "normalized_score": 86.5,
      "weight": 0.6,
      "rule_version": 3
    }
  ]
}
```

Computation contract:
- Normalize per item:
  - higher-is-better: `((raw - min) / (max - min)) * 100`
  - lower-is-better: `((max - raw) / (max - min)) * 100`
  - clamp to `0..100`
- Weighted aggregate: `sum(normalized_i * weight_i)`.
- Exclude outliers where value deviates `>3` standard deviations from user trailing 30 submissions unless approved.

### POST `/assessments/outliers/:id/approve`
- Reviewer/admin approves previously excluded outlier for recomputation.

---

## Rankings and certificates

### GET `/rankings/:userId`

Response:

```json
{
  "user_id": "usr_123",
  "rolling_window_days": 14,
  "rolling_score": 84.1,
  "level": "Silver",
  "thresholds": {
    "Bronze": 60,
    "Silver": 75,
    "Gold": 90
  }
}
```

### POST `/certificates/issue`
- Issues certificate when ranking criteria met.

### POST `/certificates/verify`

Request:

```json
{
  "certificate_id": "cert_101",
  "user_id": "usr_123",
  "issued_at": "2026-04-16T11:00:00Z",
  "verification_code": "7b7f4a..."
}
```

Response:

```json
{
  "valid": true,
  "integrity": "verified_offline"
}
```

Verification contract:
- Recompute code from `(certificate_id, user_id, issued_at, local_secret)` and compare constant-time.

---

## Content and moderation

### POST `/content-items`
- Submit participant/coach content.
- Pre-screening runs deterministic checks:
  - keyword list
  - file type allowlist
  - size limits
  - SHA-256 fingerprint blocklist

### GET `/moderation/cases`
- Queue listing with status filtering and pagination.

### POST `/moderation/cases/:id/decision`

Request:

```json
{
  "decision": "reject",
  "category": "unsafe_content",
  "reviewer_comment": "matches disallowed keyword policy"
}
```

### POST `/moderation/cases/:id/appeal`
- Fails with `VALIDATION_ERROR` if beyond 14-day appeal window.

---

## Campaigns, placements, coupons, A/B testing

### POST `/campaigns`
- Create campaign and rollout phases.

Rollout example:

```json
{
  "campaign_id": "cmp_1",
  "start_at": "2026-05-01T00:00:00Z",
  "end_at": "2026-05-31T23:59:59Z",
  "rollout_phases": [5, 25, 50, 100]
}
```

### POST `/placements`
- Assign campaign placements with schedule windows.

### POST `/coupons`

Request:

```json
{
  "code": "FIT15",
  "discount_type": "percent",
  "discount_value": 15,
  "min_spend": 100.0
}
```

### GET `/experiments/:id/assignment/:userId`

Response:

```json
{
  "experiment_id": "exp_home_banner",
  "user_id": "usr_123",
  "variant": "B",
  "method": "deterministic_hash"
}
```

---

## Messaging and subscriptions (in-app only)

### POST `/message-templates`
- Create versioned template.
- Strict placeholder validation (all placeholders declared and typed).

### POST `/messages/send`

Request:

```json
{
  "template_id": "tpl_score_release_v3",
  "recipient_user_id": "usr_123",
  "channel": "in_app",
  "variables": {
    "score": 82.45,
    "level": "Silver"
  }
}
```

Validation:
- Reject `channel` values `email` and `sms`.

### GET `/messages/inbox`
- Returns read/unread state and pagination metadata.

### PATCH `/messages/:id/read`
- Marks message read.

### PUT `/subscriptions/:userId`
- Update notification preferences for supported in-app message types.

---

## Data interchange and integrity operations

### POST `/data/imports`
- Accepts JSON/CSV payload (or file reference).
- Creates import job with schema validation result.

Request:

```json
{
  "format": "csv",
  "entity": "activity_logs",
  "conflict_strategy": "last_write_wins",
  "append_merge": true
}
```

### GET `/data/imports/:jobId`
- Import status and validation/conflict report.

### POST `/data/exports`
- Export selected entities to JSON/CSV.

### POST `/data/backup`
- Trigger local backup snapshot.

### POST `/data/restore`
- Restore local backup with preflight consistency checks.

Consistency contract:
- Validate foreign-key completeness.
- Detect orphans.
- Resolve conflicts by `updated_at` unless append-only merge is explicitly enabled.

---

## Analytics events ingestion

### POST `/events/ingest`

Headers:
- `Idempotency-Key: <unique-key>`

Request:

```json
{
  "event_name": "campaign_view",
  "user_id": "usr_123",
  "campaign_id": "cmp_1",
  "experiment_id": "exp_home_banner",
  "variant": "B",
  "occurred_at": "2026-04-16T11:20:00Z",
  "properties": {
    "placement": "home_top"
  }
}
```

Response:

```json
{
  "status": "accepted",
  "deduplicated": false
}
```

Behavior:
- If idempotency key already processed with same payload, return success with `deduplicated: true`.
- If key reused with different payload, return `409 CONFLICT`.

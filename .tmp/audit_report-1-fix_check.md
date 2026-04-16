# Fix Check Report - Audit Round 1 Issues

## Scope and Boundary
- This is a **static-only re-check** of the previously reported issues.
- I did **not** run the app, Docker, or tests.
- Conclusions below are based on code/test/config evidence only.

## Overall Re-check Verdict
- **Partial Pass**
- Most previously reported High/Medium issues are fixed with clear static evidence.
- Remaining gaps: one High (ACL breadth) and one Low (ambiguous authorization test) are still open; one Medium (data-governance depth for import/export consistency checks) is partially fixed.

## Issue-by-Issue Fix Check

### 1) Permission model defined but not enforced (High)
- **Status:** Fixed
- **Evidence:** `requirePermission` middleware implemented in `src/middleware/rbac.js:70`; pervasive permission checks now wired across privileged routes, e.g. users (`src/routes/users.js:10`), plans (`src/routes/plans.js:61`), campaigns (`src/routes/campaigns.js:12`), import/export (`src/routes/importExport.js:70`), moderation (`src/routes/moderation.js:11`), audit (`src/routes/audit.js:10`).
- **Notes:** This directly addresses the prior role-only enforcement gap.

### 2) Resource ACL narrowly applied (High)
- **Status:** Partially Fixed (still open)
- **Evidence (improved):** resource listing is ACL-filtered (`src/routes/resources.js:20`), object read/delete use ACL checks (`src/routes/resources.js:36`, `src/routes/resources.js:69`).
- **Evidence (remaining gap):** ACL enforcement is still effectively confined to `resources` routes (`src/routes/resources.js:5`, `src/routes/resources.js:36`, `src/routes/resources.js:69`); other domain objects (e.g., content list/get) do not use ACL checks (`src/routes/content.js:73`, `src/routes/content.js:91`).
- **Impact:** The broader “resource-level ACL across relevant document/content actions” requirement remains incompletely enforced.
- **Minimum fix:** Apply ACL checks (or ACL-backed resource bindings) to non-resource endpoints that represent document/content read/download/edit/share/submit/approve actions.

### 3) Deactivated accounts can still authenticate (High)
- **Status:** Fixed
- **Evidence:** login now rejects inactive users (`src/routes/auth.js:86`); token auth middleware also blocks inactive users to prevent use of existing tokens (`src/middleware/auth.js:29`).

### 4) Audit logging not guaranteed/immutable (High)
- **Status:** Fixed
- **Evidence:** audit write failures now propagate (no swallow) (`src/middleware/audit.js:76`); middleware comments and flow explicitly enforce failure on audit-write failure (`src/middleware/audit.js:44`); DB immutability trigger blocks UPDATE/DELETE on `audit_logs` (`src/db/migrations/20260416000001_initial_schema.js:501`).

### 5) Offline deployment claim mismatch in compose (Medium)
- **Status:** Fixed
- **Evidence:** network is now explicitly internal (`docker-compose.yml:57`) and required secrets are enforced via compose env validation (`docker-compose.yml:30`).

### 6) Import/restore governance depth + conflict strategy alignment (Medium)
- **Status:** Partially Fixed
- **Evidence (improved):** allowed tables expanded substantially (`src/routes/importExport.js:14`); `merge_append` and `last_write_wins` paths exist in import/restore (`src/routes/importExport.js:232`, `src/routes/importExport.js:645`); consistency checks expanded to multiple tables (`src/routes/importExport.js:288`).
- **Remaining gap:** consistency checks are still selective rather than full-model comprehensive; some model relationships and tables are not checked in the consistency routine, and `import_jobs` is not in allowed transfer set (`src/routes/importExport.js:14`, `src/routes/importExport.js:288`).
- **Minimum fix:** complete FK/orphan coverage for all required model relations and align table scope with full governance expectations.

### 7) Silent generation of security-critical secrets (Medium)
- **Status:** Fixed
- **Evidence:** non-test environments now fail-fast on missing `JWT_SECRET`, `ENCRYPTION_KEY`, `CERTIFICATE_SECRET` (`src/config/index.js:12`, `src/config/index.js:16`).

### 8) Ambiguous security test assertion (Low)
- **Status:** Not Fixed
- **Evidence:** test still allows either 200 or 403 (`tests/api/content.test.js:192`).
- **Impact:** permission regressions for this route can still pass tests.
- **Minimum fix:** make assertion deterministic to intended policy and fixture setup.

## New Issues Introduced While Fixing
- No new Blocker/High issues identified beyond the still-open ACL breadth issue.

## Current Priority Remediation
1. Expand ACL enforcement beyond `resources` endpoints to all ACL-relevant domain actions.
2. Make `tests/api/content.test.js` authorization assertion deterministic.
3. Complete full-model consistency checks in `importExport` governance paths.

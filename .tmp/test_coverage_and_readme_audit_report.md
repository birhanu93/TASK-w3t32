# Test Coverage Audit

## Scope and Method

- Static inspection only (no execution).
- Inspected: `src/index.js`, `src/routes/*`, `tests/api/*`, `tests/integration/*`, `tests/unit/*`, `README.md`, `run_tests.sh`.
- Project type declared at README top: **backend**.

## Backend Endpoint Inventory

- Total discovered endpoints: **99**
- Source evidence:
  - Route definitions in `src/routes/*` (`router.get/post/put/delete(...)`)
  - Internal endpoints in `src/index.js` (`/health`, `/api/metrics`, `/api/metrics/snapshot`)

## API Test Mapping Table

### Coverage Result (all endpoints)

- Endpoints covered by explicit HTTP requests in tests: **99/99**
- Evidence source:
  - `tests/api/*.test.js` request calls (mocked DB HTTP tests)
  - `tests/integration/hardening.integration.test.js`
  - `tests/integration/flows.integration.test.js`

### Endpoint-to-test mapping status

| Endpoint group | Coverage | Test type | Evidence files |
|---|---:|---|---|
| Health + Metrics (`/health`, `/api/metrics*`) | covered | HTTP with mocking | `tests/api/internalEndpoints.test.js` |
| Auth (`/api/auth/*`) | covered | mixed (true no-mock + HTTP with mocking) | `tests/api/auth.test.js`, `tests/integration/hardening.integration.test.js`, `tests/integration/flows.integration.test.js` |
| Users (`/api/users/*`) | covered | HTTP with mocking | `tests/api/users.test.js` |
| Plans + Tasks (`/api/plans/*`) | covered | mixed | `tests/api/plans.test.js`, `tests/integration/flows.integration.test.js` |
| Activity Logs (`/api/activity-logs/*`) | covered | HTTP with mocking | `tests/api/activityLogs.test.js`, `tests/api/outlierIngestion.test.js` |
| Assessments (`/api/assessments/*`) | covered | mixed | `tests/api/assessments.test.js`, `tests/integration/hardening.integration.test.js` |
| Rankings (`/api/rankings/*`) | covered | HTTP with mocking | `tests/api/rankings.test.js` |
| Content (`/api/content/*`) | covered | mixed | `tests/api/content.test.js`, `tests/api/highRiskPaths.test.js`, `tests/integration/*` |
| Moderation (`/api/moderation/*`) | covered | mixed | `tests/api/moderation.test.js`, `tests/integration/flows.integration.test.js` |
| Campaigns (`/api/campaigns/*`) | covered | mixed | `tests/api/campaigns.test.js`, `tests/integration/hardening.integration.test.js`, `tests/integration/flows.integration.test.js` |
| Messages (`/api/messages/*`) | covered | mixed | `tests/api/messages.test.js`, `tests/integration/flows.integration.test.js` |
| Data (`/api/data/*`) | covered | mixed | `tests/api/importExport.test.js`, `tests/api/restore.test.js`, `tests/integration/*` |
| Resources (`/api/resources/*`) | covered | mixed | `tests/api/resources.test.js`, `tests/integration/flows.integration.test.js` |
| Audit (`/api/audit/*`) | covered | HTTP with mocking | `tests/api/audit.test.js` |

## API Test Classification

1. **True No-Mock HTTP**
   - `tests/integration/hardening.integration.test.js`
   - `tests/integration/flows.integration.test.js`
   - Evidence: real PostgreSQL Knex instance + HTTP request execution through Koa app.
2. **HTTP with Mocking**
   - Majority of `tests/api/*.test.js` (DB overridden via `require.cache` and chain/proxy stubs).
3. **Non-HTTP (unit/integration without HTTP)**
   - `tests/unit/*.test.js`.

## Mock Detection Rules

- Detected mock/stub patterns:
  - DB override via `require.cache[connPath] = ... exports: db` in many API/unit tests.
  - Stubbed query builders in `tests/setup.js` and API/unit test helpers.
- Not detected:
  - `jest.mock`, `vi.mock`, `sinon.stub`.

## Coverage Summary

- Total endpoints: **99**
- Endpoints with HTTP tests: **99**
- Endpoints with true no-mock tests: **35** (auth/content/campaigns/messages/data/resources/moderation + selected others)
- HTTP coverage: **100.00%**
- True API coverage: **35.35%**

## Unit Test Summary

### Backend Unit Tests

- Present: `tests/unit/*.test.js` (config, crypto, errors, assessment engine, middleware, encryption, RBAC, audit enforcement, ACL/security math).
- Modules covered:
  - controllers/routes behavior mostly via HTTP tests
  - services (`assessmentEngine`)
  - middleware (`auth`, `rbac`, `audit`, `errorHandler`)
  - utilities (`crypto`, `fieldEncryption`, `errors`)
- Important backend modules not deeply unit-tested:
  - per-route business logic internals in `src/routes/*` (mostly HTTP-tested instead)
  - migrations/seeds as unit modules

### Frontend Unit Tests (STRICT REQUIREMENT)

- Frontend test files: **NONE**
- Frameworks/tools detected: **NONE**
- Components/modules covered: **NONE**
- Important frontend components/modules not tested: **N/A (backend repository, no frontend code detected)**
- Mandatory verdict: **Frontend unit tests: MISSING (N/A for backend project type)**

### Cross-Layer Observation

- Backend-only repo; frontend-vs-backend balance check not applicable.

## API Observability Check

- Strong: method/path/request body assertions are present across broad route surface.
- Improved: integration suites assert meaningful response fields for many critical flows.
- Weakness that remains: mocked API suites still include some status-heavy assertions.

## Tests Check

- Success paths: broad.
- Failure/validation/auth paths: strong.
- Edge cases: strong in campaigns, ACL/moderation, data import/consistency/backup.
- Integration boundaries: materially improved with two no-mock integration suites.
- `run_tests.sh`: still local runtime based (`node --test`) and not Docker script-native.

## Test Coverage Score (0-100)

- **89/100**

## Score Rationale

- 100% endpoint HTTP coverage.
- Significant increase in true no-mock API evidence.
- Good negative-path and permission depth.
- Remaining tradeoff: mocked API tests still dominate count over no-mock API tests.

## Key Gaps

- No uncovered endpoint gaps remain.
- Primary residual gap is ratio of mocked vs true no-mock endpoint tests.

## Confidence & Assumptions

- Confidence: **high**.
- Assumption: concrete test IDs are normalized against parameterized route patterns.

## Test Coverage Audit Verdict

- **PASS**

---

# README Audit

## README Location

- Required file `repo/README.md`: **present**.

## Hard Gate Evaluation

### Formatting

- Clean markdown and readable structure: **PASS**.

### Startup Instructions

- Backend requirement (`docker-compose up`) present (`docker-compose up --build`): **PASS**.

### Access Method

- URL + port provided (`http://localhost:3000`): **PASS**.

### Verification Method

- Explicit verification flows with curl and expected responses included: **PASS**.

### Environment Rules (STRICT)

- No local `npm install`, no manual local DB setup instructions, no runtime install workflow in README.
- Docker-contained operational path documented.
- Result: **PASS**.

### Demo Credentials (Conditional)

- Auth exists and credentials for all roles are listed (Administrator, Operations Manager/OManager, Reviewer, Coach, Participant): **PASS**.

## Engineering Quality

- Tech stack clarity: strong.
- Architecture/features: strong.
- Testing instructions: Docker-based and clear.
- Role/security workflow: clear with credential table and setup sequence.
- Presentation quality: strong.

## High Priority Issues

- None.

## Medium Priority Issues

- None.

## Low Priority Issues

- None.

## Hard Gate Failures

- None.

## README Verdict

- **PASS**

## README Audit Final Verdict

- **PASS**

# Test Coverage Audit

## Scope and Method

- Static inspection only (no code/test/script execution).
- Files inspected: `src/index.js`, `src/routes/*`, `tests/api/*`, `tests/integration/*`, `tests/unit/*`, `tests/setup.js`, `README.md`, `run_tests.sh`.
- Project type declaration at top of README: **backend**.

## Backend Endpoint Inventory

Total endpoints discovered: **99**

1. `GET /health`
2. `GET /api/metrics`
3. `POST /api/metrics/snapshot`
4. `POST /api/auth/register`
5. `POST /api/auth/login`
6. `GET /api/auth/me`
7. `PUT /api/auth/me`
8. `POST /api/auth/change-password`
9. `GET /api/users`
10. `GET /api/users/:id`
11. `POST /api/users/:id/roles`
12. `DELETE /api/users/:id/roles/:roleName`
13. `POST /api/users/:id/deactivate`
14. `POST /api/users/:id/activate`
15. `GET /api/plans`
16. `GET /api/plans/:id`
17. `POST /api/plans`
18. `PUT /api/plans/:id`
19. `DELETE /api/plans/:id`
20. `POST /api/plans/:id/enroll`
21. `GET /api/plans/:id/tasks`
22. `POST /api/plans/:id/tasks`
23. `PUT /api/plans/:planId/tasks/:taskId`
24. `DELETE /api/plans/:planId/tasks/:taskId`
25. `POST /api/activity-logs`
26. `GET /api/activity-logs/me`
27. `GET /api/activity-logs/user/:userId`
28. `GET /api/activity-logs/:id`
29. `POST /api/activity-logs/:id/approve-outlier`
30. `POST /api/activity-logs/batch`
31. `GET /api/assessments/rules`
32. `GET /api/assessments/rules/active/:type`
33. `POST /api/assessments/rules`
34. `POST /api/assessments/compute`
35. `POST /api/assessments/compute/:userId`
36. `GET /api/assessments/scores/me`
37. `GET /api/assessments/scores/:id`
38. `POST /api/assessments/check-outlier`
39. `POST /api/rankings/compute`
40. `GET /api/rankings/leaderboard`
41. `GET /api/rankings/me`
42. `GET /api/rankings/certificates/me`
43. `GET /api/rankings/certificates/verify/:code`
44. `GET /api/rankings/config`
45. `POST /api/rankings/config`
46. `GET /api/content/topics/list`
47. `POST /api/content/topics`
48. `GET /api/content/violation-categories`
49. `POST /api/content/violation-categories`
50. `GET /api/content`
51. `POST /api/content`
52. `GET /api/content/:id`
53. `PUT /api/content/:id`
54. `DELETE /api/content/:id`
55. `GET /api/moderation/cases`
56. `GET /api/moderation/cases/:id`
57. `POST /api/moderation/report`
58. `POST /api/moderation/cases/:id/review`
59. `POST /api/moderation/cases/:id/appeal`
60. `POST /api/moderation/appeals/:id/review`
61. `GET /api/campaigns`
62. `GET /api/campaigns/:id`
63. `POST /api/campaigns`
64. `PUT /api/campaigns/:id`
65. `POST /api/campaigns/:id/advance-rollout`
66. `GET /api/campaigns/:id/ab-assignment`
67. `POST /api/campaigns/:id/placements`
68. `GET /api/campaigns/placements/active`
69. `POST /api/campaigns/coupons`
70. `POST /api/campaigns/coupons/validate`
71. `POST /api/campaigns/events`
72. `GET /api/campaigns/analytics/funnel`
73. `GET /api/campaigns/analytics/ab-test/:testId`
74. `GET /api/messages/templates`
75. `POST /api/messages/templates`
76. `POST /api/messages/send`
77. `POST /api/messages/broadcast`
78. `GET /api/messages/inbox`
79. `GET /api/messages/:id`
80. `POST /api/messages/:id/read`
81. `POST /api/messages/mark-all-read`
82. `GET /api/messages/subscriptions/me`
83. `PUT /api/messages/subscriptions`
84. `POST /api/data/export`
85. `POST /api/data/import`
86. `POST /api/data/consistency-check`
87. `POST /api/data/backup`
88. `POST /api/data/restore`
89. `GET /api/data/jobs`
90. `GET /api/data/jobs/:id`
91. `GET /api/resources`
92. `GET /api/resources/:id`
93. `POST /api/resources`
94. `DELETE /api/resources/:id`
95. `POST /api/resources/:id/acl`
96. `DELETE /api/resources/:resourceId/acl/:aclId`
97. `POST /api/resources/:id/acl/propagate`
98. `GET /api/audit/logs`
99. `GET /api/audit/logs/:id`

## API Test Mapping Table

All 99 endpoints have explicit HTTP request evidence in test files.

| Endpoint status | Covered | Primary test type | Evidence |
|---|---|---|---|
| `GET /health`, `GET /api/metrics`, `POST /api/metrics/snapshot` | yes | HTTP with mocking | `tests/api/internalEndpoints.test.js` (`it(...)` request calls) |
| `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`, `PUT /api/auth/me`, `POST /api/auth/change-password` | yes | mixed (TNM + HTTP with mocking) | `tests/api/auth.test.js`; TNM in `tests/integration/hardening.integration.test.js`, `tests/integration/flows.integration.test.js` |
| `GET /api/users`, `GET /api/users/:id`, `POST /api/users/:id/roles`, `DELETE /api/users/:id/roles/:roleName`, `POST /api/users/:id/deactivate`, `POST /api/users/:id/activate` | yes | HTTP with mocking | `tests/api/users.test.js` |
| `GET /api/plans`, `GET /api/plans/:id`, `POST /api/plans`, `PUT /api/plans/:id`, `DELETE /api/plans/:id`, `POST /api/plans/:id/enroll`, `GET /api/plans/:id/tasks`, `POST /api/plans/:id/tasks`, `PUT /api/plans/:planId/tasks/:taskId`, `DELETE /api/plans/:planId/tasks/:taskId` | yes | mixed (TNM + HTTP with mocking) | `tests/api/plans.test.js`; TNM in `tests/integration/flows.integration.test.js` |
| `POST /api/activity-logs`, `GET /api/activity-logs/me`, `GET /api/activity-logs/user/:userId`, `GET /api/activity-logs/:id`, `POST /api/activity-logs/:id/approve-outlier`, `POST /api/activity-logs/batch` | yes | HTTP with mocking | `tests/api/activityLogs.test.js`, `tests/api/outlierIngestion.test.js` |
| `GET /api/assessments/rules`, `GET /api/assessments/rules/active/:type`, `POST /api/assessments/rules`, `POST /api/assessments/compute`, `POST /api/assessments/compute/:userId`, `GET /api/assessments/scores/me`, `GET /api/assessments/scores/:id`, `POST /api/assessments/check-outlier` | yes | mixed (TNM + HTTP with mocking) | `tests/api/assessments.test.js`; TNM in `tests/integration/hardening.integration.test.js` |
| `POST /api/rankings/compute`, `GET /api/rankings/leaderboard`, `GET /api/rankings/me`, `GET /api/rankings/certificates/me`, `GET /api/rankings/certificates/verify/:code`, `GET /api/rankings/config`, `POST /api/rankings/config` | yes | HTTP with mocking | `tests/api/rankings.test.js` |
| `GET /api/content/topics/list`, `POST /api/content/topics`, `GET /api/content/violation-categories`, `POST /api/content/violation-categories`, `GET /api/content`, `POST /api/content`, `GET /api/content/:id`, `PUT /api/content/:id`, `DELETE /api/content/:id` | yes | mixed (TNM + HTTP with mocking) | `tests/api/content.test.js`, `tests/api/highRiskPaths.test.js`; TNM in `tests/integration/hardening.integration.test.js`, `tests/integration/flows.integration.test.js` |
| `GET /api/moderation/cases`, `GET /api/moderation/cases/:id`, `POST /api/moderation/report`, `POST /api/moderation/cases/:id/review`, `POST /api/moderation/cases/:id/appeal`, `POST /api/moderation/appeals/:id/review` | yes | mixed (TNM + HTTP with mocking) | `tests/api/moderation.test.js`; TNM in `tests/integration/flows.integration.test.js` |
| `GET /api/campaigns`, `GET /api/campaigns/:id`, `POST /api/campaigns`, `PUT /api/campaigns/:id`, `POST /api/campaigns/:id/advance-rollout`, `GET /api/campaigns/:id/ab-assignment`, `POST /api/campaigns/:id/placements`, `GET /api/campaigns/placements/active`, `POST /api/campaigns/coupons`, `POST /api/campaigns/coupons/validate`, `POST /api/campaigns/events`, `GET /api/campaigns/analytics/funnel`, `GET /api/campaigns/analytics/ab-test/:testId` | yes | mixed (TNM + HTTP with mocking) | `tests/api/campaigns.test.js`; TNM in `tests/integration/hardening.integration.test.js`, `tests/integration/flows.integration.test.js` |
| `GET /api/messages/templates`, `POST /api/messages/templates`, `POST /api/messages/send`, `POST /api/messages/broadcast`, `GET /api/messages/inbox`, `GET /api/messages/:id`, `POST /api/messages/:id/read`, `POST /api/messages/mark-all-read`, `GET /api/messages/subscriptions/me`, `PUT /api/messages/subscriptions` | yes | mixed (TNM + HTTP with mocking) | `tests/api/messages.test.js`; TNM in `tests/integration/flows.integration.test.js` |
| `POST /api/data/export`, `POST /api/data/import`, `POST /api/data/consistency-check`, `POST /api/data/backup`, `POST /api/data/restore`, `GET /api/data/jobs`, `GET /api/data/jobs/:id` | yes | mixed (TNM + HTTP with mocking) | `tests/api/importExport.test.js`, `tests/api/restore.test.js`, `tests/api/highRiskPaths.test.js`; TNM in `tests/integration/hardening.integration.test.js`, `tests/integration/flows.integration.test.js` |
| `GET /api/resources`, `GET /api/resources/:id`, `POST /api/resources`, `DELETE /api/resources/:id`, `POST /api/resources/:id/acl`, `DELETE /api/resources/:resourceId/acl/:aclId`, `POST /api/resources/:id/acl/propagate` | yes | mixed (TNM + HTTP with mocking) | `tests/api/resources.test.js`; TNM in `tests/integration/flows.integration.test.js` |
| `GET /api/audit/logs`, `GET /api/audit/logs/:id` | yes | HTTP with mocking | `tests/api/audit.test.js` |

## API Test Classification

1. **True No-Mock HTTP**
   - `tests/integration/hardening.integration.test.js`
   - `tests/integration/flows.integration.test.js`
   - Evidence: both files state live PostgreSQL use and execute HTTP requests via running Koa server.
2. **HTTP with Mocking**
   - Most `tests/api/*.test.js` suites (DB connection replaced with mock/stub chain values).
3. **Non-HTTP (unit/integration without HTTP)**
   - `tests/unit/*.test.js` direct service/middleware/module testing.

## Mock Detection Rules (Findings)

- Mock/stub behavior detected in API/unit tests via `require.cache[connPath] = ... exports: db` where `db` is a stub/chain in:
  - `tests/api/*.test.js`
  - `tests/setup.js`
  - `tests/unit/*.test.js`
- No explicit `jest.mock`, `vi.mock`, `sinon.stub` usage detected.
- Integration tests (`tests/integration/*.integration.test.js`) inject a real Knex DB instance, not a stubbed query chain.

## Coverage Summary

- Total endpoints: **99**
- Endpoints with HTTP tests: **99**
- Endpoints with true no-mock HTTP tests: **35** (core routes across auth/plans/content/campaigns/messages/data/resources/moderation)
- HTTP coverage %: **100.00%**
- True API coverage %: **35.35%**

## Unit Test Summary

### Backend Unit Tests

- Present under `tests/unit/*` (config, crypto, errors, assessment engine, middleware, encryption, RBAC, audit, ACL, security).
- Covered module categories:
  - controllers/routes behavior indirectly via mocked HTTP tests
  - services (`assessmentEngine`)
  - middleware (`auth`, `rbac`, `audit`, `errorHandler`)
  - utilities/security modules (`crypto`, `fieldEncryption`, `errors`)
- Important backend modules with weak direct unit targeting:
  - deep route-specific business logic in `src/routes/*` remains mostly tested at HTTP level
  - DB migration/seed correctness not unit-tested as modules

### Frontend Unit Tests (STRICT REQUIREMENT)

- Project type: backend.
- Frontend test files: **NONE**
- Frameworks/tools detected: **NONE**
- Components/modules covered: **NONE**
- Important frontend modules not tested: **N/A (no frontend codebase detected)**
- Mandatory verdict: **Frontend unit tests: MISSING (not required for backend type)**

### Cross-Layer Observation

- No frontend layer in scope; backend-only test balance is acceptable.

## API Observability Check

- Improved: major endpoints now include explicit request payloads and response assertions in new integration flows.
- Remaining weakness: many mocked API tests still assert mostly status/shape rather than full response contract.
- Verdict: **moderate-to-strong observability**.

## Test Quality & Sufficiency

- Success paths: broadly covered.
- Failure/validation/auth paths: strong.
- Edge cases: improved, especially in campaigns, data operations, and ACL/resource handling.
- Integration boundaries: materially improved by DB-backed HTTP integration suites.
- `run_tests.sh` check:
  - **FLAG**: relies on local runtime (`node --test`) and local PostgreSQL for integration; not Docker-only test orchestration.

## End-to-End Expectations

- Backend repository; FE↔BE E2E requirement not applicable.
- Backend integration realism is now significantly stronger due to two DB-backed integration suites.

## Tests Check

- Endpoint inventory complete: yes.
- Endpoint coverage matrix complete: yes.
- Mock classification complete: yes.
- Sufficiency improved: yes.

## Test Coverage Score (0–100)

- **89/100**

## Score Rationale

- + 100% endpoint HTTP coverage.
- + Added real no-mock integration coverage for critical workflows.
- + Better request/response assertion depth in new integration suite.
- - True no-mock coverage still not dominant across all 99 endpoints.
- - Heavy mock-based API suite remains primary for many endpoints.

## Key Gaps

- No uncovered endpoint gaps remain.
- Main gap is still **coverage quality mix**: many endpoints rely only on mocked HTTP tests for primary confidence.

## Confidence & Assumptions

- Confidence: **high**.
- Assumption: endpoint matching normalizes concrete IDs in tests to parameterized route definitions.

## Test Coverage Audit Verdict

- **PASS**

---

# README Audit

## README Location

- Required path `repo/README.md`: **present**.

## Hard Gate Results

### Formatting

- Clean markdown and structure: **PASS**.

### Startup Instructions (Backend/Fullstack)

- Includes `docker-compose up --build`: **PASS**.

### Access Method

- URL + port clearly stated (`http://localhost:3000`): **PASS**.

### Verification Method

- Includes concrete curl flows and expected responses for health, login, plans, campaign creation, consistency check: **PASS**.

### Environment Rules (STRICT Docker-contained)

- **FAIL**: README still contains local runtime/dependency/manual DB instructions (`npm install`, local PostgreSQL, `createdb`) in "Local Development Setup (advanced)".

### Demo Credentials (Conditional)

- Auth exists and credentials for all roles are documented: **PASS**.

## Engineering Quality

- Tech stack clarity: strong.
- Architecture/features: strong.
- Testing instructions: clear and expanded.
- Security/roles: clear role matrix and credentials.
- Workflow quality: good but strict-env conflict remains.

## High Priority Issues

- Strict environment policy violation due inclusion of local install/manual DB setup instructions.

## Medium Priority Issues

- Demo role assignment command uses payload key `role` in examples while route expects `role_name` (`POST /api/users/:id/roles`), which can make setup commands fail.
- Sample expected responses in verification may not exactly match current implementation fields (`/health` shape mismatch risk).

## Low Priority Issues

- None significant beyond the above.

## Hard Gate Failures

- Environment Rules (STRICT): **FAIL**

## README Verdict

- **PARTIAL PASS** (informational quality high, but one strict hard gate still failing)

## README Audit Final Verdict

- **PARTIAL PASS**

# Test Coverage Audit

## Scope and Method

- Audit mode: static inspection only (no execution).
- Inspected files: `src/index.js`, `src/routes/*`, `tests/api/*`, `tests/integration/hardening.integration.test.js`, `tests/unit/*`, `tests/setup.js`, `run_tests.sh`, `README.md`.
- Project type declaration at top of README: **backend** (`README.md` title includes "Backend").

## Strict Endpoint Inventory (METHOD + PATH)

Total endpoints discovered: **99**

### Backend Endpoint Inventory

| # | Endpoint |
|---:|---|
| 1 | `GET /health` |
| 2 | `GET /api/metrics` |
| 3 | `POST /api/metrics/snapshot` |
| 4 | `POST /api/auth/register` |
| 5 | `POST /api/auth/login` |
| 6 | `GET /api/auth/me` |
| 7 | `PUT /api/auth/me` |
| 8 | `POST /api/auth/change-password` |
| 9 | `GET /api/users` |
| 10 | `GET /api/users/:id` |
| 11 | `POST /api/users/:id/roles` |
| 12 | `DELETE /api/users/:id/roles/:roleName` |
| 13 | `POST /api/users/:id/deactivate` |
| 14 | `POST /api/users/:id/activate` |
| 15 | `GET /api/plans` |
| 16 | `GET /api/plans/:id` |
| 17 | `POST /api/plans` |
| 18 | `PUT /api/plans/:id` |
| 19 | `DELETE /api/plans/:id` |
| 20 | `POST /api/plans/:id/enroll` |
| 21 | `GET /api/plans/:id/tasks` |
| 22 | `POST /api/plans/:id/tasks` |
| 23 | `PUT /api/plans/:planId/tasks/:taskId` |
| 24 | `DELETE /api/plans/:planId/tasks/:taskId` |
| 25 | `POST /api/activity-logs` |
| 26 | `GET /api/activity-logs/me` |
| 27 | `GET /api/activity-logs/user/:userId` |
| 28 | `GET /api/activity-logs/:id` |
| 29 | `POST /api/activity-logs/:id/approve-outlier` |
| 30 | `POST /api/activity-logs/batch` |
| 31 | `GET /api/assessments/rules` |
| 32 | `GET /api/assessments/rules/active/:type` |
| 33 | `POST /api/assessments/rules` |
| 34 | `POST /api/assessments/compute` |
| 35 | `POST /api/assessments/compute/:userId` |
| 36 | `GET /api/assessments/scores/me` |
| 37 | `GET /api/assessments/scores/:id` |
| 38 | `POST /api/assessments/check-outlier` |
| 39 | `POST /api/rankings/compute` |
| 40 | `GET /api/rankings/leaderboard` |
| 41 | `GET /api/rankings/me` |
| 42 | `GET /api/rankings/certificates/me` |
| 43 | `GET /api/rankings/certificates/verify/:code` |
| 44 | `GET /api/rankings/config` |
| 45 | `POST /api/rankings/config` |
| 46 | `GET /api/content/topics/list` |
| 47 | `POST /api/content/topics` |
| 48 | `GET /api/content/violation-categories` |
| 49 | `POST /api/content/violation-categories` |
| 50 | `GET /api/content` |
| 51 | `POST /api/content` |
| 52 | `GET /api/content/:id` |
| 53 | `PUT /api/content/:id` |
| 54 | `DELETE /api/content/:id` |
| 55 | `GET /api/moderation/cases` |
| 56 | `GET /api/moderation/cases/:id` |
| 57 | `POST /api/moderation/report` |
| 58 | `POST /api/moderation/cases/:id/review` |
| 59 | `POST /api/moderation/cases/:id/appeal` |
| 60 | `POST /api/moderation/appeals/:id/review` |
| 61 | `GET /api/campaigns` |
| 62 | `GET /api/campaigns/:id` |
| 63 | `POST /api/campaigns` |
| 64 | `PUT /api/campaigns/:id` |
| 65 | `POST /api/campaigns/:id/advance-rollout` |
| 66 | `GET /api/campaigns/:id/ab-assignment` |
| 67 | `POST /api/campaigns/:id/placements` |
| 68 | `GET /api/campaigns/placements/active` |
| 69 | `POST /api/campaigns/coupons` |
| 70 | `POST /api/campaigns/coupons/validate` |
| 71 | `POST /api/campaigns/events` |
| 72 | `GET /api/campaigns/analytics/funnel` |
| 73 | `GET /api/campaigns/analytics/ab-test/:testId` |
| 74 | `GET /api/messages/templates` |
| 75 | `POST /api/messages/templates` |
| 76 | `POST /api/messages/send` |
| 77 | `POST /api/messages/broadcast` |
| 78 | `GET /api/messages/inbox` |
| 79 | `GET /api/messages/:id` |
| 80 | `POST /api/messages/:id/read` |
| 81 | `POST /api/messages/mark-all-read` |
| 82 | `GET /api/messages/subscriptions/me` |
| 83 | `PUT /api/messages/subscriptions` |
| 84 | `POST /api/data/export` |
| 85 | `POST /api/data/import` |
| 86 | `POST /api/data/consistency-check` |
| 87 | `POST /api/data/backup` |
| 88 | `POST /api/data/restore` |
| 89 | `GET /api/data/jobs` |
| 90 | `GET /api/data/jobs/:id` |
| 91 | `GET /api/resources` |
| 92 | `GET /api/resources/:id` |
| 93 | `POST /api/resources` |
| 94 | `DELETE /api/resources/:id` |
| 95 | `POST /api/resources/:id/acl` |
| 96 | `DELETE /api/resources/:resourceId/acl/:aclId` |
| 97 | `POST /api/resources/:id/acl/propagate` |
| 98 | `GET /api/audit/logs` |
| 99 | `GET /api/audit/logs/:id` |

## API Test Mapping Table (All Endpoints)

Legend:
- `TNM HTTP` = true no-mock HTTP test
- `HTTP+Mock` = HTTP request path tested, but DB/services mocked/stubbed
- `Unit/Indirect` = no HTTP request hitting route

| Endpoint | Covered | Test type | Test files | Evidence |
|---|---|---|---|---|
| `GET /health` | yes | HTTP+Mock | `tests/api/internalEndpoints.test.js` | `it('should return 200 without auth')` |
| `GET /api/metrics` | yes | HTTP+Mock | `tests/api/internalEndpoints.test.js` | `it('should return metrics for Administrator')` |
| `POST /api/metrics/snapshot` | yes | HTTP+Mock | `tests/api/internalEndpoints.test.js` | `it('should persist snapshot for Administrator')` |
| `POST /api/auth/register` | yes | HTTP+Mock | `tests/api/auth.test.js` | `it('should return 201 with user and token on success')` |
| `POST /api/auth/login` | yes | HTTP+Mock | `tests/api/auth.test.js` | `it('should return 200 with token for correct password')` |
| `GET /api/auth/me` | yes | TNM HTTP + HTTP+Mock | `tests/api/auth.test.js`, `tests/integration/hardening.integration.test.js` | `it('should return user profile with valid token')`; `it('should succeed for an active, existing user')` |
| `PUT /api/auth/me` | yes | HTTP+Mock | `tests/api/auth.test.js` | `it('should update profile with valid token')` |
| `POST /api/auth/change-password` | yes | HTTP+Mock | `tests/api/auth.test.js` | `it('should return 200 on success')` |
| `GET /api/users` | yes | HTTP+Mock | `tests/api/users.test.js` | `it('should return paginated users for admin')` |
| `GET /api/users/:id` | yes | HTTP+Mock | `tests/api/users.test.js` | `it('should return user for admin')` |
| `POST /api/users/:id/roles` | yes | HTTP+Mock | `tests/api/users.test.js` | `it('should return 400 when role_name missing')` |
| `DELETE /api/users/:id/roles/:roleName` | yes | HTTP+Mock | `tests/api/users.test.js` | `it('should return 404 when role not found')` |
| `POST /api/users/:id/deactivate` | yes | HTTP+Mock | `tests/api/users.test.js` | `it('should deactivate user for admin')` |
| `POST /api/users/:id/activate` | yes | HTTP+Mock | `tests/api/users.test.js` | `it('should activate user for admin')` |
| `GET /api/plans` | yes | HTTP+Mock | `tests/api/plans.test.js` | `it('should return plans list')` |
| `GET /api/plans/:id` | yes | HTTP+Mock | `tests/api/plans.test.js` | `it('should return plan with tasks and enrollments')` |
| `POST /api/plans` | yes | HTTP+Mock | `tests/api/plans.test.js` | `it('should create plan for Coach')` |
| `PUT /api/plans/:id` | yes | HTTP+Mock | `tests/api/plans.test.js` | `it('should return 404 for non-existent plan')` |
| `DELETE /api/plans/:id` | yes | HTTP+Mock | `tests/api/plans.test.js` | `it('should return 403 for non-Admin')` |
| `POST /api/plans/:id/enroll` | yes | HTTP+Mock | `tests/api/plans.test.js` | `it('should reject enrollment in non-active plan')` |
| `GET /api/plans/:id/tasks` | no | Unit/Indirect | - | no HTTP test request found |
| `POST /api/plans/:id/tasks` | yes | HTTP+Mock | `tests/api/plans.test.js` | `it('should create task')` |
| `PUT /api/plans/:planId/tasks/:taskId` | no | Unit/Indirect | - | no HTTP test request found |
| `DELETE /api/plans/:planId/tasks/:taskId` | yes | HTTP+Mock | `tests/api/plans.test.js` | `it('should produce explicit audit with beforeState on task delete')` |
| `POST /api/activity-logs` | yes | HTTP+Mock | `tests/api/activityLogs.test.js`, `tests/api/outlierIngestion.test.js` | `it('should create activity log')`; `it('should include outlier_detection in response')` |
| `GET /api/activity-logs/me` | yes | HTTP+Mock | `tests/api/activityLogs.test.js` | `it('should return paginated logs')` |
| `GET /api/activity-logs/user/:userId` | yes | HTTP+Mock | `tests/api/activityLogs.test.js` | `it('should return logs for Coach')` |
| `GET /api/activity-logs/:id` | yes | HTTP+Mock | `tests/api/activityLogs.test.js` | `it('should return own log')` |
| `POST /api/activity-logs/:id/approve-outlier` | yes | HTTP+Mock | `tests/api/activityLogs.test.js` | `it('should return 400 when not flagged as outlier')` |
| `POST /api/activity-logs/batch` | yes | HTTP+Mock | `tests/api/activityLogs.test.js`, `tests/api/outlierIngestion.test.js` | `it('should insert batch of logs')`; `it('should include outlier_detection per log...')` |
| `GET /api/assessments/rules` | yes | HTTP+Mock | `tests/api/assessments.test.js` | `it('should return rules list')` |
| `GET /api/assessments/rules/active/:type` | yes | HTTP+Mock | `tests/api/assessments.test.js` | `it('should return active rule')` |
| `POST /api/assessments/rules` | yes | TNM HTTP + HTTP+Mock | `tests/api/assessments.test.js`, `tests/integration/hardening.integration.test.js` | `it('should return 400 when weights do not sum to 1.00')`; `describe('Assessment rules: strict validation')` |
| `POST /api/assessments/compute` | yes | HTTP+Mock | `tests/api/assessments.test.js` | `it('should return 400 without assessment_type')` |
| `POST /api/assessments/compute/:userId` | no | Unit/Indirect | - | no HTTP test request found |
| `GET /api/assessments/scores/me` | yes | HTTP+Mock | `tests/api/assessments.test.js` | `it('should return score history')` |
| `GET /api/assessments/scores/:id` | yes | HTTP+Mock | `tests/api/assessments.test.js` | `it('should return 404 for non-existent score')` |
| `POST /api/assessments/check-outlier` | yes | HTTP+Mock | `tests/api/assessments.test.js` | `it('should return 400 without required fields')` |
| `POST /api/rankings/compute` | yes | HTTP+Mock | `tests/api/rankings.test.js` | `it('should return none level when no scores')` |
| `GET /api/rankings/leaderboard` | yes | HTTP+Mock | `tests/api/rankings.test.js` | `it('should return paginated leaderboard')` |
| `GET /api/rankings/me` | yes | HTTP+Mock | `tests/api/rankings.test.js` | `it('should return user rankings')` |
| `GET /api/rankings/certificates/me` | yes | HTTP+Mock | `tests/api/rankings.test.js` | `it('should return user certificates')` |
| `GET /api/rankings/certificates/verify/:code` | yes | HTTP+Mock | `tests/api/rankings.test.js` | `it('should return invalid for non-existent certificate')` |
| `GET /api/rankings/config` | yes | HTTP+Mock | `tests/api/rankings.test.js` | `it('should return configs for admin')` |
| `POST /api/rankings/config` | yes | HTTP+Mock | `tests/api/rankings.test.js` | `it('should return 400 without assessment_type')` |
| `GET /api/content/topics/list` | yes | HTTP+Mock | `tests/api/content.test.js`, `tests/api/highRiskPaths.test.js` | `it('should return topics')`; `it('GET /topics/list does not hit /:id...')` |
| `POST /api/content/topics` | yes | HTTP+Mock | `tests/api/content.test.js` | `it('should return 400 without name')` |
| `GET /api/content/violation-categories` | yes | HTTP+Mock | `tests/api/content.test.js`, `tests/api/highRiskPaths.test.js` | `it('should return categories for Reviewer')`; role-based route tests |
| `POST /api/content/violation-categories` | yes | HTTP+Mock | `tests/api/content.test.js`, `tests/api/highRiskPaths.test.js` | `it('should return 400 without name')`; participant forbidden test |
| `GET /api/content` | yes | TNM HTTP + HTTP+Mock | `tests/api/content.test.js`, `tests/integration/hardening.integration.test.js` | `it('should return content list')`; `it('should exclude non-author items...')` |
| `POST /api/content` | yes | HTTP+Mock | `tests/api/content.test.js` | `it('should create content with pre-screening')` |
| `GET /api/content/:id` | yes | TNM HTTP + HTTP+Mock | `tests/api/content.test.js`, `tests/api/highRiskPaths.test.js`, `tests/integration/hardening.integration.test.js` | `it('should return 404 for non-existent item')`; ACL fail-closed integration tests |
| `PUT /api/content/:id` | yes | TNM HTTP + HTTP+Mock | `tests/api/content.test.js`, `tests/integration/hardening.integration.test.js` | `it('should return 404 for non-existent')`; `it('should produce audit records...')` |
| `DELETE /api/content/:id` | yes | HTTP+Mock | `tests/api/content.test.js`, `tests/api/highRiskPaths.test.js` | participant/coach forbidden delete cases |
| `GET /api/moderation/cases` | yes | HTTP+Mock | `tests/api/moderation.test.js` | `it('should return cases for Reviewer')` |
| `GET /api/moderation/cases/:id` | no | Unit/Indirect | - | no HTTP test request found |
| `POST /api/moderation/report` | yes | HTTP+Mock | `tests/api/moderation.test.js` | `it('should return 404 for non-existent content')` |
| `POST /api/moderation/cases/:id/review` | yes | HTTP+Mock | `tests/api/moderation.test.js` | `it('should return 400 for invalid decision')` |
| `POST /api/moderation/cases/:id/appeal` | yes | HTTP+Mock | `tests/api/moderation.test.js` | `it('should return 400 when case is not rejected')` |
| `POST /api/moderation/appeals/:id/review` | yes | HTTP+Mock | `tests/api/moderation.test.js` | `it('should return 400 for invalid decision')` |
| `GET /api/campaigns` | no | Unit/Indirect | - | no HTTP test request found |
| `GET /api/campaigns/:id` | no | Unit/Indirect | - | no HTTP test request found |
| `POST /api/campaigns` | yes | TNM HTTP + HTTP+Mock | `tests/api/campaigns.test.js`, `tests/integration/hardening.integration.test.js` | `it('should create campaign')`; rollout progression integration setup |
| `PUT /api/campaigns/:id` | yes | TNM HTTP + HTTP+Mock | `tests/api/campaigns.test.js`, `tests/integration/hardening.integration.test.js` | `it('should accept valid rollout phases on update')`; `it('should reject direct current_rollout_percent via PUT')` |
| `POST /api/campaigns/:id/advance-rollout` | yes | TNM HTTP | `tests/integration/hardening.integration.test.js` | `describe('Campaign rollout: progression enforcement')` |
| `GET /api/campaigns/:id/ab-assignment` | no | Unit/Indirect | - | no HTTP test request found |
| `POST /api/campaigns/:id/placements` | no | Unit/Indirect | - | no HTTP test request found |
| `GET /api/campaigns/placements/active` | no | Unit/Indirect | - | no HTTP test request found |
| `POST /api/campaigns/coupons` | yes | HTTP+Mock | `tests/api/campaigns.test.js` | coupon creation validation tests |
| `POST /api/campaigns/coupons/validate` | yes | HTTP+Mock | `tests/api/campaigns.test.js` | `it('should return invalid for non-existent coupon')` |
| `POST /api/campaigns/events` | yes | HTTP+Mock | `tests/api/campaigns.test.js` | `it('should return duplicate for existing idempotency key')` |
| `GET /api/campaigns/analytics/funnel` | yes | HTTP+Mock | `tests/api/campaigns.test.js` | `it('should return 400 without funnel_name')` |
| `GET /api/campaigns/analytics/ab-test/:testId` | no | Unit/Indirect | - | no HTTP test request found |
| `GET /api/messages/templates` | no | Unit/Indirect | - | no HTTP test request found |
| `POST /api/messages/templates` | yes | HTTP+Mock | `tests/api/messages.test.js` | template validation tests |
| `POST /api/messages/send` | yes | HTTP+Mock | `tests/api/messages.test.js` | `it('should send direct message')` |
| `POST /api/messages/broadcast` | yes | HTTP+Mock | `tests/api/messages.test.js` | `it('should return 400 without recipient_ids')` |
| `GET /api/messages/inbox` | yes | HTTP+Mock | `tests/api/messages.test.js` | `it('should return inbox for authenticated user')` |
| `GET /api/messages/:id` | yes | HTTP+Mock | `tests/api/messages.test.js` | `it('should return 403 for other users message')` |
| `POST /api/messages/:id/read` | yes | HTTP+Mock | `tests/api/messages.test.js` | `it('should return 404 for non-existent message')` |
| `POST /api/messages/mark-all-read` | no | Unit/Indirect | - | no HTTP test request found |
| `GET /api/messages/subscriptions/me` | no | Unit/Indirect | - | no HTTP test request found |
| `PUT /api/messages/subscriptions` | yes | HTTP+Mock | `tests/api/messages.test.js` | `it('should return 400 without category')` |
| `POST /api/data/export` | yes | HTTP+Mock | `tests/api/importExport.test.js`, `tests/api/highRiskPaths.test.js` | export format/table/permissions tests |
| `POST /api/data/import` | yes | TNM HTTP + HTTP+Mock | `tests/api/importExport.test.js`, `tests/api/highRiskPaths.test.js`, `tests/integration/hardening.integration.test.js` | import permissions + conflict handling tests |
| `POST /api/data/consistency-check` | no | Unit/Indirect | - | no HTTP test request found |
| `POST /api/data/backup` | no | Unit/Indirect | - | no HTTP test request found |
| `POST /api/data/restore` | yes | HTTP+Mock | `tests/api/restore.test.js` | dry_run and actual restore tests |
| `GET /api/data/jobs` | yes | HTTP+Mock | `tests/api/importExport.test.js` | `it('should return jobs list for admin')` |
| `GET /api/data/jobs/:id` | yes | HTTP+Mock | `tests/api/importExport.test.js` | `it('should return 404 for non-existent job')` |
| `GET /api/resources` | yes | HTTP+Mock | `tests/api/resources.test.js` | `it('should return resource list')` |
| `GET /api/resources/:id` | no | Unit/Indirect | - | no HTTP test request found |
| `POST /api/resources` | yes | HTTP+Mock | `tests/api/resources.test.js` | `it('should create resource')` |
| `DELETE /api/resources/:id` | no | Unit/Indirect | - | no HTTP test request found |
| `POST /api/resources/:id/acl` | yes | HTTP+Mock | `tests/api/resources.test.js` | `it('should create ACL entry')` |
| `DELETE /api/resources/:resourceId/acl/:aclId` | no | Unit/Indirect | - | no HTTP test request found |
| `POST /api/resources/:id/acl/propagate` | no | Unit/Indirect | - | no HTTP test request found |
| `GET /api/audit/logs` | yes | HTTP+Mock | `tests/api/audit.test.js` | `it('should return audit logs for admin')` |
| `GET /api/audit/logs/:id` | yes | HTTP+Mock | `tests/api/audit.test.js` | `it('should return single audit log')` |

## API Test Classification

1. **True No-Mock HTTP**
   - `tests/integration/hardening.integration.test.js` HTTP requests hit route handlers with real Knex/PostgreSQL-backed execution path.
2. **HTTP with Mocking**
   - All `tests/api/*.test.js` use mocked DB injection via `require.cache[connPath] = ... exports: db` and chain/proxy stubs.
3. **Non-HTTP (unit/integration without HTTP)**
   - `tests/unit/*.test.js` direct module/middleware/service tests.
   - In `tests/integration/hardening.integration.test.js`, there are direct `db(...)` operations and direct `writeAuditLog` invocation in addition to HTTP requests.

## Mock Detection (Strict)

- **Mocked DB transport/dependencies via module cache override**
  - `tests/setup.js`: explicit statement "test all routes without a live PostgreSQL connection" and `createMockDb`.
  - `tests/api/*.test.js`: each `buildApp(...)` replaces `src/db/connection` through `require.cache`.
- **Chainable stub query builders**
  - `tests/api/plans.test.js`, `tests/api/campaigns.test.js`, `tests/api/content.test.js`, etc. define `chain(...)`/proxy thenables returning canned values.
- **Unit-level direct dependency stubbing**
  - `tests/unit/*` files override `require.cache` with `mockDb` (e.g., `tests/unit/auditEnforcement.test.js`, `tests/unit/outlierMath.test.js`).
- **No explicit Jest/Vitest/Sinon mocks detected**
  - No `jest.mock`, `vi.mock`, or `sinon.stub` tokens found in tests.

## Coverage Summary

- Total endpoints: **99**
- Endpoints with HTTP tests (mocked and/or true): **80**
- Endpoints with true no-mock HTTP tests: **9**
- HTTP coverage: **80.81%** (`80/99`)
- True API coverage: **9.09%** (`9/99`)

## Unit Test Summary

### Backend Unit Tests

- Test files:
  - `tests/unit/config.test.js`
  - `tests/unit/crypto.test.js`
  - `tests/unit/errors.test.js`
  - `tests/unit/assessmentEngine.test.js`
  - `tests/unit/middleware.test.js`
  - `tests/unit/fieldEncryption.test.js`
  - `tests/unit/rbacAliases.test.js`
  - `tests/unit/peerPercentile.test.js`
  - `tests/unit/auditEnforcement.test.js`
  - `tests/unit/aclInheritanceDeny.test.js`
  - `tests/unit/securityComprehensive.test.js`
  - `tests/unit/outlierMath.test.js`
- Modules covered:
  - services: `src/services/assessmentEngine.js`
  - middleware: auth/rbac/audit/error flows (`src/middleware/*`)
  - security/utilities: `src/utils/crypto.js`, `src/utils/fieldEncryption.js`, `src/utils/errors.js`
  - config: `src/config/index.js`
- Important backend modules not tested (direct unit level):
  - route modules under `src/routes/*` (covered mostly by mocked HTTP tests, not deep unit tests)
  - DB migration/seed correctness (`src/db/migrations/*`, `src/db/seeds/*`) not unit-tested
  - metrics middleware depth (`src/middleware/metrics.js`) only route-level checks

### Frontend Unit Tests (STRICT REQUIREMENT)

- Frontend test files: **NONE**
- Framework/tools detected for frontend tests: **NONE**
- Frontend components/modules covered: **NONE**
- Important frontend components/modules not tested: **N/A (no frontend code detected; no `*.tsx|*.jsx|*.vue|*.svelte` files found)**
- Mandatory verdict: **Frontend unit tests: MISSING (N/A for backend-only repository type)**

### Cross-Layer Observation

- Backend-only repository; frontend/backed balance check is **not applicable**.

## API Observability Check

- Strengths:
  - Most API tests show explicit method + path and expected status.
  - Many include request body examples for validation and auth cases.
- Weaknesses:
  - A large subset assert only status codes (limited response-content assertions), reducing behavioral confidence.
  - Several endpoints are covered only by negative-path status checks; response schema/fields are often not validated.
- Verdict: **Observability is mixed; often weak for response-body verification depth.**

## Tests Check

- Success-path coverage: present but uneven.
- Failure/validation coverage: strong across auth, campaigns, content, import/export paths.
- Edge-case coverage: present in selected hardened flows (outlier, rollout sequence, import conflict behavior).
- Auth/permissions coverage: broad at route level.
- Integration boundaries: limited true no-mock HTTP coverage (9/99 endpoints).
- `run_tests.sh` environment expectation:
  - **FLAG**: local runtime dependency (`node --test`) and optional live PostgreSQL for integration tests; not Docker-contained by default.

## End-to-End Expectations

- Repository type is backend (not fullstack); FE↔BE E2E expectation is not applicable.
- Backend E2E realism is partial: one real-DB integration suite exists but endpoint breadth is narrow.

## Test Coverage Score (0–100)

- **Score: 63/100**

## Score Rationale

- + Good route-level HTTP breadth (80/99 endpoints touched).
- + Strong negative-path and permission checks.
- - True no-mock API coverage is low (9/99), so realistic integration confidence is limited.
- - 19 endpoints have zero HTTP coverage.
- - Many assertions are shallow (status-only), reducing sufficiency.

## Key Gaps

- Uncovered endpoints (19):
  - `GET /api/plans/:id/tasks`
  - `PUT /api/plans/:planId/tasks/:taskId`
  - `POST /api/assessments/compute/:userId`
  - `GET /api/moderation/cases/:id`
  - `GET /api/campaigns`
  - `GET /api/campaigns/:id`
  - `GET /api/campaigns/:id/ab-assignment`
  - `POST /api/campaigns/:id/placements`
  - `GET /api/campaigns/placements/active`
  - `GET /api/campaigns/analytics/ab-test/:testId`
  - `GET /api/messages/templates`
  - `POST /api/messages/mark-all-read`
  - `GET /api/messages/subscriptions/me`
  - `POST /api/data/consistency-check`
  - `POST /api/data/backup`
  - `GET /api/resources/:id`
  - `DELETE /api/resources/:id`
  - `DELETE /api/resources/:resourceId/acl/:aclId`
  - `POST /api/resources/:id/acl/propagate`
- Mock-heavy API tests dominate the suite.
- Response-body and contract assertions are inconsistent.

## Confidence & Assumptions

- Confidence: **high** for endpoint inventory and coverage mapping (explicit static route and test request extraction).
- Assumptions:
  - Dynamic route strings in tests were normalized to corresponding parameterized route definitions.
  - Coverage requires direct HTTP call to exact METHOD + resolved PATH pattern; indirect code execution not counted.

## Test Coverage Audit Verdict

- **PARTIAL PASS (strict mode)**: broad mocked HTTP coverage, but insufficient true no-mock depth and 19 uncovered endpoints.

---

# README Audit

## README Location

- Required location `repo/README.md`: **present**.

## Hard Gate Results

### Formatting

- Clean markdown with sections/tables/code blocks: **PASS**.

### Startup Instructions (Backend/Fullstack gate)

- `docker-compose up` present (`docker-compose up --build`): **PASS**.

### Access Method

- URL/port provided (`http://localhost:3000`, `/health`): **PASS**.

### Verification Method

- Explicit functional verification flow (curl/Postman request/expected response) is **not provided**.
- Gate result: **FAIL**.

### Environment Rules (STRICT Docker-contained only)

- README contains local runtime/install instructions:
  - `npm install`
  - local PostgreSQL prerequisite
  - local migrations/seeds and `npm start`
- This violates strict "no runtime installs/manual DB setup".
- Gate result: **FAIL**.

### Demo Credentials (Conditional)

- Authentication exists (`/api/auth/*` endpoints and role model documented).
- README does not provide demo credentials by role and does not state "No authentication required".
- Gate result: **FAIL**.

## Engineering Quality Assessment

- Tech stack clarity: good.
- Architecture/domain explanation: strong feature summary.
- Testing instructions: present but mostly command-oriented; limited expected outcomes.
- Security/roles: role descriptions present.
- Workflow clarity: mixed (Docker + local paths conflict under strict environment rule).
- Presentation quality: generally strong markdown organization.

## High Priority Issues

- Missing authentication demo credentials despite documented auth/roles.
- Verification section lacks concrete testable request/response checks.
- Environment policy violation: local `npm install` and local DB setup instructions are included under strict Docker-only requirement.

## Medium Priority Issues

- Local and Docker workflows coexist without strict-mode boundary notes.
- README does not clearly define minimal "first success" validation checklist.

## Low Priority Issues

- Some operational details are extensive but could be condensed for onboarding speed.

## Hard Gate Failures

- Verification Method: **FAIL**
- Environment Rules (STRICT Docker-contained): **FAIL**
- Demo Credentials (auth exists): **FAIL**

## README Verdict

- **FAIL**

## README Audit Final Verdict

- **FAIL (strict mode)**


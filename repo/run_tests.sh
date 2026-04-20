#!/usr/bin/env bash
#
# run_tests.sh — Docker-first test runner for the Training Assessment &
# Content Governance Backend.
#
# Every target runs inside the `app` container via `docker-compose exec`,
# mirroring the commands documented in README.md so CI and local runs use
# the exact same code path as production.
#
# Usage:
#   ./run_tests.sh              # unit + api (no DB required in container)
#   ./run_tests.sh unit         # unit tests only
#   ./run_tests.sh api          # API (mocked-DB HTTP) tests only
#   ./run_tests.sh integration  # no-mock DB-backed HTTP integration tests
#   ./run_tests.sh all          # unit + api + integration
#   ./run_tests.sh ci           # alias for `all` — CI path
#
# Environment:
#   COMPOSE — override compose command (default: auto-detect
#     `docker compose` vs `docker-compose`)
#   APP_SERVICE — compose service name for the app container (default: app)
#   DB_SERVICE  — compose service name for the DB container  (default: db)
#   TEST_DB_NAME — integration test database (default: training_assessment_test)
#   INTEGRATION_DB_RESET — if "1", recreate the integration DB before running
#     (default: "1" — always start from an empty DB)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

TARGET="${1:-default}"
APP_SERVICE="${APP_SERVICE:-app}"
DB_SERVICE="${DB_SERVICE:-db}"
TEST_DB_NAME="${TEST_DB_NAME:-training_assessment_test}"
INTEGRATION_DB_RESET="${INTEGRATION_DB_RESET:-1}"

# ── Resolve docker-compose invocation ──────────────────────────────────
if [[ -z "${COMPOSE:-}" ]]; then
  if docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE="docker-compose"
  else
    echo "ERROR: neither 'docker compose' nor 'docker-compose' is available." >&2
    echo "This script is Docker-first — please install Docker Compose." >&2
    exit 2
  fi
fi

echo "=========================================="
echo "  Training Assessment Backend — Test Suite"
echo "  (Docker-first: all tests run inside the '$APP_SERVICE' container)"
echo "=========================================="
echo ""

# ── Ensure the stack is up ─────────────────────────────────────────────
ensure_stack_running() {
  if ! $COMPOSE ps --status=running "$APP_SERVICE" >/dev/null 2>&1 || \
     [[ -z "$($COMPOSE ps --status=running --services 2>/dev/null | grep -x "$APP_SERVICE" || true)" ]]; then
    echo "→ Starting '$APP_SERVICE' + '$DB_SERVICE' (detached)..."
    $COMPOSE up -d "$DB_SERVICE" "$APP_SERVICE"
  fi

  echo "→ Waiting for Postgres to be ready..."
  local retries=30
  until $COMPOSE exec -T "$DB_SERVICE" pg_isready -U postgres >/dev/null 2>&1; do
    retries=$((retries - 1))
    if [[ $retries -le 0 ]]; then
      echo "ERROR: Postgres did not become ready in time." >&2
      exit 1
    fi
    sleep 1
  done
  echo "→ Postgres ready."
  echo ""
}

# ── Ensure the integration test DB exists (empty — migrations run per-suite) ──
ensure_test_db() {
  if [[ "$INTEGRATION_DB_RESET" == "1" ]]; then
    echo "→ Resetting integration DB '$TEST_DB_NAME'..."
    # Terminate any stale connections before dropping — previous test runs
    # sometimes leave idle pg pools behind which block DROP DATABASE.
    $COMPOSE exec -T "$DB_SERVICE" psql -U postgres -c \
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${TEST_DB_NAME}' AND pid <> pg_backend_pid()" \
      >/dev/null 2>&1 || true
    $COMPOSE exec -T "$DB_SERVICE" psql -U postgres -c "DROP DATABASE IF EXISTS ${TEST_DB_NAME}" >/dev/null
  fi
  echo "→ Ensuring integration DB '$TEST_DB_NAME' exists..."
  $COMPOSE exec -T "$DB_SERVICE" psql -U postgres -tc \
    "SELECT 1 FROM pg_database WHERE datname='${TEST_DB_NAME}'" | grep -q 1 || \
    $COMPOSE exec -T "$DB_SERVICE" psql -U postgres -c "CREATE DATABASE ${TEST_DB_NAME}" >/dev/null
  echo ""
}

# ── Run a test target inside the app container ─────────────────────────
run_in_container() {
  local label="$1"; shift
  local env_prefix="$1"; shift
  local pattern="$1"; shift

  echo "── $label ──"
  if $COMPOSE exec -T \
       -e NODE_ENV=test \
       $env_prefix \
       "$APP_SERVICE" sh -c "node --test $pattern"; then
    echo "  ✓ $label passed"
    echo ""
  else
    echo "  ✗ $label FAILED"
    echo ""
    FAILED=1
  fi
}

FAILED=0

run_unit() {
  run_in_container "Unit tests" \
    "" \
    "tests/unit/*.test.js"
}

run_api() {
  run_in_container "API tests (mocked-DB HTTP)" \
    "" \
    "tests/api/*.test.js"
}

run_integration() {
  ensure_test_db
  # Integration suites share one test DB and each suite runs its own
  # migrate:rollback + migrate:latest cycle. That means they MUST run
  # serially — parallel runs deadlock on knex's migration lock.
  # Integration suites talk to the sibling DB service on its internal
  # network at DB_HOST=db (the compose service name).
  run_in_container "Integration tests (real PostgreSQL, serial)" \
    "-e DB_HOST=${DB_SERVICE} -e DB_PORT=5432 -e DB_NAME=${TEST_DB_NAME} -e DB_USER=postgres -e DB_PASSWORD=${DB_PASSWORD:-postgres}" \
    "--test-concurrency=1 tests/integration/*.integration.test.js"
}

ensure_stack_running

case "$TARGET" in
  unit)
    run_unit
    ;;
  api)
    run_api
    ;;
  integration)
    run_integration
    ;;
  all|ci)
    run_unit
    run_api
    run_integration
    ;;
  default)
    run_unit
    run_api
    ;;
  *)
    echo "Unknown target: $TARGET" >&2
    echo "Usage: $0 [unit|api|integration|all|ci]" >&2
    exit 2
    ;;
esac

echo "=========================================="
if [[ $FAILED -eq 0 ]]; then
  echo "  ALL TESTS PASSED"
else
  echo "  SOME TESTS FAILED"
  exit 1
fi
echo "=========================================="

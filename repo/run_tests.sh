#!/usr/bin/env bash
#
# run_tests.sh — Run the full test suite for Training Assessment & Content Governance Backend
#
# Usage:
#   ./run_tests.sh              # Run unit + api tests (no DB required)
#   ./run_tests.sh unit         # Run only unit tests
#   ./run_tests.sh api          # Run only API tests
#   ./run_tests.sh integration  # Run only integration tests (requires PostgreSQL)
#   ./run_tests.sh ci           # Run ALL tests including integration (CI path)
#
# Integration tests require a live PostgreSQL instance. Set TEST_DATABASE_URL
# or DB_NAME=training_assessment_test to point at a throwaway database.
# In CI, always use `./run_tests.sh ci` or `npm run test:ci` to include them.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

export NODE_ENV=test

echo "=========================================="
echo "  Training Assessment Backend — Test Suite"
echo "=========================================="
echo ""

FAILED=0

run_tests() {
  local label="$1"
  shift
  echo "── $label ──"
  if node --test "$@"; then
    echo "  ✓ $label passed"
  else
    echo "  ✗ $label FAILED"
    FAILED=1
  fi
  echo ""
}

if [[ "${1:-all}" == "unit" || "${1:-all}" == "all" || "${1:-all}" == "ci" ]]; then
  run_tests "Unit: Config"                tests/unit/config.test.js
  run_tests "Unit: Crypto"                tests/unit/crypto.test.js
  run_tests "Unit: Errors"                tests/unit/errors.test.js
  run_tests "Unit: Assessment Engine"     tests/unit/assessmentEngine.test.js
  run_tests "Unit: Middleware"            tests/unit/middleware.test.js
  run_tests "Unit: Field Encryption"      tests/unit/fieldEncryption.test.js
  run_tests "Unit: RBAC Aliases"          tests/unit/rbacAliases.test.js
  run_tests "Unit: Peer Percentile"       tests/unit/peerPercentile.test.js
  run_tests "Unit: Audit Enforcement"     tests/unit/auditEnforcement.test.js
  run_tests "Unit: ACL Inheritance/Deny"  tests/unit/aclInheritanceDeny.test.js
  run_tests "Unit: Security Comprehensive" tests/unit/securityComprehensive.test.js
  run_tests "Unit: Outlier Math"           tests/unit/outlierMath.test.js
fi

if [[ "${1:-all}" == "api" || "${1:-all}" == "all" || "${1:-all}" == "ci" ]]; then
  run_tests "API: Auth"                   tests/api/auth.test.js
  run_tests "API: Users"                  tests/api/users.test.js
  run_tests "API: Plans"                  tests/api/plans.test.js
  run_tests "API: Activity Logs"          tests/api/activityLogs.test.js
  run_tests "API: Assessments"            tests/api/assessments.test.js
  run_tests "API: Rankings"               tests/api/rankings.test.js
  run_tests "API: Content"                tests/api/content.test.js
  run_tests "API: Moderation"             tests/api/moderation.test.js
  run_tests "API: Campaigns"              tests/api/campaigns.test.js
  run_tests "API: Messages"               tests/api/messages.test.js
  run_tests "API: Import/Export"          tests/api/importExport.test.js
  run_tests "API: Resources"              tests/api/resources.test.js
  run_tests "API: Audit"                  tests/api/audit.test.js
  run_tests "API: Restore"               tests/api/restore.test.js
  run_tests "API: Internal Endpoints"     tests/api/internalEndpoints.test.js
  run_tests "API: Outlier Ingestion"      tests/api/outlierIngestion.test.js
  run_tests "API: High-Risk Paths"       tests/api/highRiskPaths.test.js
fi

if [[ "${1:-}" == "integration" || "${1:-}" == "ci" ]]; then
  echo ""
  echo "── Integration Tests (requires PostgreSQL) ──"
  run_tests "Integration: Hardening"      tests/integration/hardening.integration.test.js
fi

echo "=========================================="
if [[ $FAILED -eq 0 ]]; then
  echo "  ALL TESTS PASSED"
else
  echo "  SOME TESTS FAILED"
  exit 1
fi
echo "=========================================="

const db = require('../db/connection');
const config = require('../config');

/**
 * Assessment Scoring Engine
 *
 * Supports configurable scoring items (time_seconds, rep_count, combined_completion)
 * with per-item weights summing to 1.00. Normalizes raw inputs to 0–100 using min/max
 * bounds, applies weighted aggregation, and enforces outlier detection/exclusion.
 */

/**
 * Get the active assessment rule for a given type.
 */
async function getActiveRule(assessmentType) {
  return db('assessment_rules')
    .where({ assessment_type: assessmentType, is_active: true })
    .first();
}

/**
 * Detect outliers: any log > 3 standard deviations from user's trailing 30 submissions.
 * The current log (excludeLogId) is excluded from its own baseline so it cannot
 * influence the mean/stdDev it is evaluated against.
 * Returns { isOutlier, mean, stdDev, value }
 */
async function detectOutlier(userId, activityType, value, excludeLogId) {
  let query = db('activity_logs')
    .where({ user_id: userId, activity_type: activityType })
    .where('is_outlier', false)
    .orderBy('performed_at', 'desc')
    .limit(config.assessment.trailingSubmissionCount);

  if (excludeLogId) {
    query = query.whereNot('id', excludeLogId);
  }

  const trailing = await query.pluck('value');

  if (trailing.length < 2) {
    return { isOutlier: false, mean: null, stdDev: null, value };
  }

  const nums = trailing.map(Number);
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const variance = nums.reduce((sum, v) => sum + (v - mean) ** 2, 0) / nums.length;
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) {
    return { isOutlier: false, mean, stdDev, value };
  }

  const zScore = Math.abs(Number(value) - mean) / stdDev;
  const isOutlier = zScore > config.assessment.outlierStdDevThreshold;

  return { isOutlier, mean, stdDev, zScore, value };
}

/**
 * Flag a log as outlier if detected.
 */
async function flagOutlierIfNeeded(logId, userId, activityType, value) {
  const result = await detectOutlier(userId, activityType, value, logId);
  if (result.isOutlier) {
    await db('activity_logs').where('id', logId).update({
      is_outlier: true,
      updated_at: new Date(),
    });
  }
  return result;
}

/**
 * Normalize a raw value to 0–100 using min/max bounds.
 * For time_seconds: lower is better (inverted normalization).
 * For rep_count: higher is better.
 * For combined_completion: percentage-based.
 */
function normalizeValue(rawValue, item) {
  const { type, min_bound, max_bound } = item;
  const val = Number(rawValue);
  const min = Number(min_bound);
  const max = Number(max_bound);

  if (max === min) return 50; // Avoid division by zero

  let normalized;
  if (type === 'time_seconds') {
    // Lower time = higher score (inverted)
    normalized = ((max - val) / (max - min)) * 100;
  } else {
    // Higher value = higher score
    normalized = ((val - min) / (max - min)) * 100;
  }

  return Math.max(0, Math.min(100, normalized));
}

/**
 * Compute assessment score for a user.
 *
 * @param {string} userId
 * @param {string} assessmentType
 * @param {Object} options - { windowStart, windowEnd }
 * @returns {Object} Computed score with full breakdown
 */
async function computeScore(userId, assessmentType, options = {}) {
  const rule = await getActiveRule(assessmentType);
  if (!rule) throw new Error(`No active assessment rule for type: ${assessmentType}`);

  const scoringItems = rule.scoring_items;
  const outlierConfig = rule.outlier_config || {
    std_dev_threshold: config.assessment.outlierStdDevThreshold,
    trailing_count: config.assessment.trailingSubmissionCount,
  };

  // Gather logs per scoring item
  const itemScores = [];
  const allSourceLogIds = [];
  let totalLogsIncluded = 0;
  let totalLogsExcludedOutlier = 0;
  const dimensionalBreakdown = {};

  for (const item of scoringItems) {
    let logsQuery = db('activity_logs')
      .where({ user_id: userId, activity_type: item.name })
      .where(function () {
        // Include non-outlier logs OR manually approved outliers
        this.where('is_outlier', false).orWhere('outlier_approved', true);
      });

    if (options.windowStart) logsQuery = logsQuery.where('performed_at', '>=', options.windowStart);
    if (options.windowEnd) logsQuery = logsQuery.where('performed_at', '<=', options.windowEnd);

    const logs = await logsQuery.orderBy('performed_at', 'desc');

    // Count excluded outliers
    let excludedQuery = db('activity_logs')
      .where({ user_id: userId, activity_type: item.name, is_outlier: true, outlier_approved: false });
    if (options.windowStart) excludedQuery = excludedQuery.where('performed_at', '>=', options.windowStart);
    if (options.windowEnd) excludedQuery = excludedQuery.where('performed_at', '<=', options.windowEnd);
    const [{ count: excludedCount }] = await excludedQuery.count();

    totalLogsExcludedOutlier += Number(excludedCount);

    if (logs.length === 0) {
      itemScores.push({
        name: item.name,
        type: item.type,
        raw_value: null,
        normalized_score: 0,
        weight: item.weight,
        weighted_score: 0,
        log_ids: [],
        logs_count: 0,
      });
      continue;
    }

    // Compute average raw value across eligible logs
    const values = logs.map((l) => Number(l.value));
    const avgValue = values.reduce((a, b) => a + b, 0) / values.length;
    const normalizedScore = normalizeValue(avgValue, item);
    const weightedScore = normalizedScore * item.weight;

    const logIds = logs.map((l) => l.id);
    allSourceLogIds.push(...logIds);
    totalLogsIncluded += logs.length;

    itemScores.push({
      name: item.name,
      type: item.type,
      raw_value: avgValue,
      normalized_score: Math.round(normalizedScore * 100) / 100,
      weight: item.weight,
      weighted_score: Math.round(weightedScore * 100) / 100,
      log_ids: logIds,
      logs_count: logs.length,
    });

    // Dimensional breakdown
    if (item.dimension) {
      if (!dimensionalBreakdown[item.dimension]) {
        dimensionalBreakdown[item.dimension] = { total_weighted: 0, total_weight: 0 };
      }
      dimensionalBreakdown[item.dimension].total_weighted += weightedScore;
      dimensionalBreakdown[item.dimension].total_weight += item.weight;
    }
  }

  // Total score is weighted sum
  const totalScore = Math.round(
    itemScores.reduce((sum, is) => sum + is.weighted_score, 0) * 100
  ) / 100;

  // Finalize dimensional breakdown (normalize per dimension)
  const dimensions = {};
  for (const [dim, data] of Object.entries(dimensionalBreakdown)) {
    dimensions[dim] = data.total_weight > 0
      ? Math.round((data.total_weighted / data.total_weight) * 100) / 100
      : 0;
  }

  // Compute peer percentiles by cohort
  const peerPercentiles = await computePeerPercentiles(userId, assessmentType, totalScore);

  // Store computed score
  const [stored] = await db('computed_scores')
    .insert({
      user_id: userId,
      assessment_rule_id: rule.id,
      total_score: totalScore,
      item_scores: JSON.stringify(itemScores),
      dimensional_breakdown: JSON.stringify(dimensions),
      peer_percentiles: JSON.stringify(peerPercentiles),
      source_log_ids: JSON.stringify(allSourceLogIds),
      rule_version: rule.version,
      logs_included: totalLogsIncluded,
      logs_excluded_outlier: totalLogsExcludedOutlier,
      window_start: options.windowStart || null,
      window_end: options.windowEnd || null,
    })
    .returning('*');

  return {
    ...stored,
    item_scores: itemScores,
    dimensional_breakdown: dimensions,
    peer_percentiles: peerPercentiles,
    source_log_ids: allSourceLogIds,
  };
}

/**
 * Compute peer comparison percentiles across multiple cohorts.
 *
 * Supported cohorts:
 *   - 'all': all users with scores for this assessment type
 *   - 'plan:<planId>': users enrolled in a specific plan
 *   - 'assessment_type': users grouped by the same assessment_type (same as 'all')
 *
 * @returns {Array} Array of { cohort, percentile, peer_count } objects
 */
async function computePeerPercentiles(userId, assessmentType, userScore, options = {}) {
  const cohortResults = [];

  // ── Cohort: all ─────────────────────────────────────────────────────
  const allPeerScores = await db('computed_scores')
    .join('assessment_rules', 'assessment_rules.id', 'computed_scores.assessment_rule_id')
    .where('assessment_rules.assessment_type', assessmentType)
    .whereNot('computed_scores.user_id', userId)
    .distinctOn('computed_scores.user_id')
    .orderBy(['computed_scores.user_id', { column: 'computed_scores.computed_at', order: 'desc' }])
    .select('computed_scores.total_score', 'computed_scores.user_id');

  cohortResults.push(computePercentile('all', allPeerScores, userScore));

  // ── Cohort: plan-based (if user is enrolled in plans) ───────────────
  try {
    const userPlans = await db('plan_enrollments')
      .where('user_id', userId)
      .pluck('plan_id');

    for (const planId of userPlans) {
      // Get peers enrolled in the same plan
      const planPeerIds = await db('plan_enrollments')
        .where('plan_id', planId)
        .whereNot('user_id', userId)
        .pluck('user_id');

      if (planPeerIds.length === 0) continue;

      const planPeerScores = allPeerScores.filter((p) =>
        planPeerIds.includes(p.user_id)
      );

      if (planPeerScores.length > 0) {
        cohortResults.push(computePercentile(`plan:${planId}`, planPeerScores, userScore));
      }
    }
  } catch {
    // Plan enrollment lookup may fail if tables don't exist yet; skip gracefully
  }

  // ── Cohort: explicit cohort from options ────────────────────────────
  if (options.cohortUserIds && Array.isArray(options.cohortUserIds)) {
    const customPeerScores = allPeerScores.filter((p) =>
      options.cohortUserIds.includes(p.user_id)
    );
    if (customPeerScores.length > 0) {
      cohortResults.push(computePercentile(
        options.cohortName || 'custom',
        customPeerScores,
        userScore
      ));
    }
  }

  return cohortResults;
}

/**
 * Helper: compute percentile from a set of peer scores.
 */
function computePercentile(cohortName, peerScores, userScore) {
  if (peerScores.length === 0) {
    return { cohort: cohortName, percentile: 100, peer_count: 0 };
  }
  const belowCount = peerScores.filter((p) => Number(p.total_score) < userScore).length;
  const percentile = Math.round((belowCount / peerScores.length) * 100);
  return { cohort: cohortName, percentile, peer_count: peerScores.length };
}

module.exports = {
  getActiveRule,
  detectOutlier,
  flagOutlierIfNeeded,
  normalizeValue,
  computeScore,
  computePeerPercentiles,
  computePercentile,
};

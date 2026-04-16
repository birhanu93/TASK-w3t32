const Router = require('koa-router');
const db = require('../db/connection');
const config = require('../config');
const { Errors } = require('../utils/errors');
const { authenticate } = require('../middleware/auth');
const { requireRole, requirePermission } = require('../middleware/rbac');
const { generateCertificateCode, verifyCertificateCode } = require('../utils/crypto');

const router = new Router({ prefix: '/api/rankings' });

/**
 * Determine ranking level from rolling average score.
 */
function determineLevel(score, thresholds) {
  if (score >= thresholds.gold) return 'gold';
  if (score >= thresholds.silver) return 'silver';
  if (score >= thresholds.bronze) return 'bronze';
  return 'none';
}

// ── Compute/update ranking for a user ───────────────────────────────────
router.post('/compute', authenticate(), async (ctx) => {
  const { assessment_type } = ctx.request.body;
  if (!assessment_type) throw Errors.badRequest('assessment_type is required');

  // Get ranking config or use defaults
  const rankingConfig = await db('ranking_configs')
    .where({ assessment_type, is_active: true })
    .first();
  const windowDays = rankingConfig?.window_days || config.ranking.windowDays;
  const thresholds = rankingConfig?.thresholds || config.ranking.thresholds;

  // Rolling window
  const windowStart = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const windowEnd = new Date();

  // Get computed scores in window
  const scores = await db('computed_scores')
    .join('assessment_rules', 'assessment_rules.id', 'computed_scores.assessment_rule_id')
    .where('assessment_rules.assessment_type', assessment_type)
    .where('computed_scores.user_id', ctx.state.user.id)
    .where('computed_scores.computed_at', '>=', windowStart)
    .where('computed_scores.computed_at', '<=', windowEnd)
    .select('computed_scores.total_score', 'computed_scores.computed_at');

  if (scores.length === 0) {
    ctx.body = { message: 'No scores in window', level: 'none', rolling_avg: 0 };
    return;
  }

  const rollingAvg = scores.reduce((sum, s) => sum + Number(s.total_score), 0) / scores.length;
  const level = determineLevel(rollingAvg, thresholds);

  // Upsert ranking
  const existing = await db('rankings')
    .where({ user_id: ctx.state.user.id, assessment_type })
    .first();

  let ranking;
  if (existing) {
    [ranking] = await db('rankings')
      .where('id', existing.id)
      .update({
        level,
        rolling_avg_score: rollingAvg,
        window_start: windowStart,
        window_end: windowEnd,
        achieved_at: level !== 'none' && level !== existing.level ? new Date() : existing.achieved_at,
        updated_at: new Date(),
      })
      .returning('*');
  } else {
    [ranking] = await db('rankings')
      .insert({
        user_id: ctx.state.user.id,
        assessment_type,
        level,
        rolling_avg_score: rollingAvg,
        window_start: windowStart,
        window_end: windowEnd,
        achieved_at: level !== 'none' ? new Date() : null,
      })
      .returning('*');
  }

  // Auto-generate certificate on level achievement
  let certificate = null;
  if (level !== 'none') {
    const existingCert = await db('certificates')
      .where({ user_id: ctx.state.user.id, assessment_type, level })
      .first();

    if (!existingCert) {
      const certId = require('uuid').v4();
      const issuedAt = new Date().toISOString();
      const verificationCode = generateCertificateCode(certId, ctx.state.user.id, issuedAt);

      [certificate] = await db('certificates')
        .insert({
          id: certId,
          user_id: ctx.state.user.id,
          ranking_id: ranking.id,
          assessment_type,
          level,
          score: rollingAvg,
          verification_code: verificationCode,
          issued_at: issuedAt,
          details: JSON.stringify({
            window_days: windowDays,
            scores_count: scores.length,
            thresholds,
          }),
        })
        .returning('*');

      await ctx.audit({
        action: 'certificate.issue',
        resourceType: 'certificate',
        resourceId: certId,
        afterState: certificate,
        details: { assessment_type, level, score: rollingAvg },
      });
    }
  }

  ctx.body = { ranking, certificate };
});

// ── Get rankings leaderboard ────────────────────────────────────────────
router.get('/leaderboard', authenticate(), async (ctx) => {
  const { assessment_type, level, page = 1, per_page = 50 } = ctx.query;

  let query = db('rankings')
    .join('users', 'users.id', 'rankings.user_id')
    .select(
      'rankings.*',
      'users.username',
      'users.full_name'
    );

  if (assessment_type) query = query.where('rankings.assessment_type', assessment_type);
  if (level) query = query.where('rankings.level', level);

  const offset = (page - 1) * per_page;
  const [{ count }] = await query.clone().count();
  const rankings = await query
    .orderBy('rankings.rolling_avg_score', 'desc')
    .offset(offset)
    .limit(per_page);

  ctx.body = {
    data: rankings,
    pagination: { page: +page, per_page: +per_page, total: +count, total_pages: Math.ceil(count / per_page) },
  };
});

// ── Get my ranking ──────────────────────────────────────────────────────
router.get('/me', authenticate(), async (ctx) => {
  const rankings = await db('rankings').where('user_id', ctx.state.user.id);
  ctx.body = rankings;
});

// ── Certificates ────────────────────────────────────────────────────────

// List my certificates
router.get('/certificates/me', authenticate(), async (ctx) => {
  const certs = await db('certificates')
    .where('user_id', ctx.state.user.id)
    .orderBy('issued_at', 'desc');
  ctx.body = certs;
});

// Verify certificate (fully offline — no auth required)
router.get('/certificates/verify/:code', async (ctx) => {
  const cert = await db('certificates')
    .where('verification_code', ctx.params.code)
    .first();

  if (!cert) {
    ctx.body = { valid: false, message: 'Certificate not found' };
    return;
  }

  try {
    const isValid = verifyCertificateCode(
      ctx.params.code,
      cert.id,
      cert.user_id,
      cert.issued_at.toISOString()
    );

    if (isValid) {
      const user = await db('users').where('id', cert.user_id)
        .select('username', 'full_name').first();

      ctx.body = {
        valid: true,
        certificate: {
          id: cert.id,
          user: user,
          assessment_type: cert.assessment_type,
          level: cert.level,
          score: cert.score,
          issued_at: cert.issued_at,
        },
      };
    } else {
      ctx.body = { valid: false, message: 'Verification code tampered or invalid' };
    }
  } catch {
    ctx.body = { valid: false, message: 'Verification failed' };
  }
});

// ── Ranking Configuration (Admin) ───────────────────────────────────────
router.get('/config', authenticate(), requirePermission('rankings.manage_config'), async (ctx) => {
  ctx.body = await db('ranking_configs').orderBy('assessment_type');
});

router.post('/config', authenticate(), requirePermission('rankings.manage_config'), async (ctx) => {
  const { assessment_type, window_days, thresholds } = ctx.request.body;
  if (!assessment_type) throw Errors.badRequest('assessment_type is required');

  const existing = await db('ranking_configs').where('assessment_type', assessment_type).first();
  if (existing) {
    const [updated] = await db('ranking_configs')
      .where('id', existing.id)
      .update({
        window_days: window_days || 14,
        thresholds: thresholds ? JSON.stringify(thresholds) : existing.thresholds,
        updated_at: new Date(),
      })
      .returning('*');
    ctx.body = updated;
  } else {
    const [created] = await db('ranking_configs')
      .insert({
        assessment_type,
        window_days: window_days || 14,
        thresholds: thresholds ? JSON.stringify(thresholds) : '{"bronze":60,"silver":75,"gold":90}',
      })
      .returning('*');
    ctx.status = 201;
    ctx.body = created;
  }

  await ctx.audit({
    action: 'ranking_config.upsert',
    resourceType: 'ranking_config',
    resourceId: assessment_type,
    beforeState: existing || null,
    afterState: ctx.body,
    details: { window_days, thresholds },
  });
});

module.exports = router;

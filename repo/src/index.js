const Koa = require('koa');
const bodyParser = require('koa-bodyparser');
const json = require('koa-json');
const logger = require('./utils/logger');
const config = require('./config');
const errorHandler = require('./middleware/errorHandler');
const { auditMiddleware } = require('./middleware/audit');
const { metricsMiddleware, getMetrics, persistMetricsSnapshot } = require('./middleware/metrics');
const { authenticate } = require('./middleware/auth');
const { requireRole, requirePermission } = require('./middleware/rbac');

// Route modules
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const planRoutes = require('./routes/plans');
const activityLogRoutes = require('./routes/activityLogs');
const assessmentRoutes = require('./routes/assessments');
const rankingRoutes = require('./routes/rankings');
const contentRoutes = require('./routes/content');
const moderationRoutes = require('./routes/moderation');
const campaignRoutes = require('./routes/campaigns');
const messageRoutes = require('./routes/messages');
const importExportRoutes = require('./routes/importExport');
const resourceRoutes = require('./routes/resources');
const auditRoutes = require('./routes/audit');

const app = new Koa();

// ── Global Middleware ───────────────────────────────────────────────────
app.use(errorHandler());
app.use(metricsMiddleware());
app.use(bodyParser({ jsonLimit: '50mb' }));
app.use(json());
app.use(auditMiddleware());

// ── Health Check (public) ───────────────────────────────────────────────
const Router = require('koa-router');
const healthRouter = new Router();

healthRouter.get('/health', async (ctx) => {
  const db = require('./db/connection');
  try {
    await db.raw('SELECT 1');
    ctx.body = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  } catch (err) {
    ctx.status = 503;
    ctx.body = { status: 'unhealthy', error: 'Database connection failed' };
  }
});

// ── Metrics endpoint (admin-only) ───────────────────────────────────────
healthRouter.get('/api/metrics', authenticate(), requireRole('Administrator'), async (ctx) => {
  ctx.body = getMetrics();
});

// ── Persist metrics snapshot on-demand (admin-only) ─────────────────────
healthRouter.post('/api/metrics/snapshot', authenticate(), requireRole('Administrator'), async (ctx) => {
  persistMetricsSnapshot();
  ctx.body = { message: 'Metrics snapshot persisted', metrics: getMetrics() };
});

app.use(healthRouter.routes());
app.use(healthRouter.allowedMethods());

// ── API Routes ──────────────────────────────────────────────────────────
app.use(authRoutes.routes()).use(authRoutes.allowedMethods());
app.use(userRoutes.routes()).use(userRoutes.allowedMethods());
app.use(planRoutes.routes()).use(planRoutes.allowedMethods());
app.use(activityLogRoutes.routes()).use(activityLogRoutes.allowedMethods());
app.use(assessmentRoutes.routes()).use(assessmentRoutes.allowedMethods());
app.use(rankingRoutes.routes()).use(rankingRoutes.allowedMethods());
app.use(contentRoutes.routes()).use(contentRoutes.allowedMethods());
app.use(moderationRoutes.routes()).use(moderationRoutes.allowedMethods());
app.use(campaignRoutes.routes()).use(campaignRoutes.allowedMethods());
app.use(messageRoutes.routes()).use(messageRoutes.allowedMethods());
app.use(importExportRoutes.routes()).use(importExportRoutes.allowedMethods());
app.use(resourceRoutes.routes()).use(resourceRoutes.allowedMethods());
app.use(auditRoutes.routes()).use(auditRoutes.allowedMethods());

// ── Start Server ────────────────────────────────────────────────────────
const server = app.listen(config.port, () => {
  logger.info({ port: config.port, env: config.env }, 'Server started');
});

module.exports = { app, server };

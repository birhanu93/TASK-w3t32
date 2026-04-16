const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');

const metricsDir = path.join(config.dataDir, 'metrics');
fs.mkdirSync(metricsDir, { recursive: true });

// Simple in-process metrics for structured local storage
const metrics = {
  requestCount: 0,
  errorCount: 0,
  latencyHistogram: [],
  startedAt: new Date().toISOString(),
};

function metricsMiddleware() {
  return async (ctx, next) => {
    const start = Date.now();
    metrics.requestCount++;

    try {
      await next();
    } catch (err) {
      metrics.errorCount++;
      throw err;
    } finally {
      const duration = Date.now() - start;
      metrics.latencyHistogram.push(duration);
      // Keep only last 10000 entries for p95 calculation
      if (metrics.latencyHistogram.length > 10000) {
        metrics.latencyHistogram = metrics.latencyHistogram.slice(-10000);
      }
      logger.info({
        method: ctx.method,
        path: ctx.path,
        status: ctx.status,
        duration_ms: duration,
        user_id: ctx.state.user?.id,
      }, 'request');
    }
  };
}

function getMetrics() {
  const sorted = [...metrics.latencyHistogram].sort((a, b) => a - b);
  const p95Index = Math.floor(sorted.length * 0.95);
  return {
    total_requests: metrics.requestCount,
    total_errors: metrics.errorCount,
    p95_latency_ms: sorted[p95Index] || 0,
    avg_latency_ms: sorted.length
      ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length)
      : 0,
    started_at: metrics.startedAt,
    snapshot_at: new Date().toISOString(),
  };
}

/**
 * Persist a metrics snapshot to disk. Called on an interval from the app.
 */
function persistMetricsSnapshot() {
  try {
    const snapshot = getMetrics();
    const filename = `metrics_${Date.now()}.json`;
    const filepath = path.join(metricsDir, filename);
    fs.writeFileSync(filepath, JSON.stringify(snapshot, null, 2));

    // Keep only last 100 snapshot files
    const files = fs.readdirSync(metricsDir)
      .filter((f) => f.startsWith('metrics_') && f.endsWith('.json'))
      .sort();
    while (files.length > 100) {
      const old = files.shift();
      fs.unlinkSync(path.join(metricsDir, old));
    }
  } catch (err) {
    logger.error({ err }, 'Failed to persist metrics snapshot');
  }
}

// Persist snapshot every 60 seconds
const _snapshotInterval = setInterval(persistMetricsSnapshot, 60000);
_snapshotInterval.unref(); // Don't prevent process exit

module.exports = { metricsMiddleware, getMetrics, persistMetricsSnapshot };

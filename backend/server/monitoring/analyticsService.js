import { all } from '../db.js';

const RANGE_HOURS = { '1h': 1, '24h': 24, '7d': 24 * 7, '30d': 24 * 30 };

export async function getMonitorAnalytics(userId, range = '24h', now = Date.now()) {
  const rangeHours = RANGE_HOURS[range];
  if (!rangeHours) {
    const error = new Error('Range must be 1h, 24h, 7d, or 30d.');
    error.code = 'INVALID_ANALYTICS_RANGE';
    throw error;
  }

  const cutoff = new Date(now - rangeHours * 60 * 60 * 1000).toISOString();
  const monitors = await all(
    'SELECT id, name, apiUrl, currentStatus, enabled FROM monitors WHERE userId = ? ORDER BY id DESC',
    [userId],
  );
  const analytics = await Promise.all(monitors.map(async (monitor) => {
    const history = await all(
      `SELECT id, currentStatus, httpStatus, responseTime, failureReason, checkedAt
       FROM healthChecks WHERE monitorId = ? AND checkedAt >= ? ORDER BY checkedAt ASC`,
      [monitor.id, cutoff],
    );
    const responseTimes = history.map((check) => check.responseTime).filter(Number.isFinite);
    const healthyChecks = history.filter((check) => check.currentStatus === 'healthy').length;
    return {
      monitor,
      history,
      summary: {
        totalChecks: history.length,
        averageResponseTime: responseTimes.length
          ? Math.round(responseTimes.reduce((total, value) => total + value, 0) / responseTimes.length)
          : null,
        uptimePercent: history.length ? Math.round((healthyChecks / history.length) * 10000) / 100 : null,
      },
    };
  }));

  return { range, cutoff, monitors: analytics };
}

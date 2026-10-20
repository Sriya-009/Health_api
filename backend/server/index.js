import 'dotenv/config';
import bcrypt from 'bcryptjs';
import cors from 'cors';
import express from 'express';
import jwt from 'jsonwebtoken';
import { all, closeDb, get, initDb, normalizeMonitor, run } from './db.js';
import { getEmailConfigSummary, validateEmailConfig } from './email/emailService.js';
import { validateMonitorTarget } from './monitoring/healthCheck.js';
import {
  loadActiveMonitorJobs,
  rescheduleMonitorJob,
  runCheck,
  startMonitorJob,
  stopAllMonitorJobs,
  stopMonitorJob,
} from './monitoring/monitorService.js';
import { getMonitorAnalytics } from './monitoring/analyticsService.js';

const app = express();
const PORT = Number(process.env.PORT || 5000);
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const allowedOrigins = (process.env.FRONTEND_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('Origin is not allowed by the backend CORS configuration.'));
    },
    credentials: true,
  }),
);
app.use(express.json({ limit: '100kb' }));

function requireJwtSecret() {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not configured.');
  }

  return process.env.JWT_SECRET;
}

function createToken(user) {
  return jwt.sign({ sub: String(user.id), email: user.email }, requireJwtSecret(), {
    expiresIn: JWT_EXPIRES_IN,
  });
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
  };
}

function asyncHandler(handler) {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

function validateInterval(value) {
  const interval = Number(value || 30);
  if (!Number.isFinite(interval)) return 30;
  return Math.min(86400, Math.max(5, Math.round(interval)));
}

const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

async function validateMonitorConfig(body, existing = {}) {
  const name = String(body.name || existing.name || '').trim();
  const apiUrl = String(body.apiUrl || existing.apiUrl || '').trim();
  const httpMethod = String(body.httpMethod || existing.httpMethod || 'GET').toUpperCase();
  const intervalSeconds = validateInterval(body.intervalSeconds || existing.intervalSeconds || 30);
  const timeoutMs = Math.min(120000, Math.max(100, Math.round(Number(body.timeoutMs || existing.timeoutMs || 8000))));
  const expectedStatusCodes = String(body.expectedStatusCodes || existing.expectedStatusCodes || '2xx').trim();
  const reminderIntervalSeconds = Math.min(
    604800,
    Math.max(0, Math.round(Number(body.reminderIntervalSeconds || existing.reminderIntervalSeconds || 0))),
  );
  const notifyOnRecovery =
    typeof body.notifyOnRecovery === 'boolean'
      ? Number(body.notifyOnRecovery)
      : Number(existing.notifyOnRecovery === undefined ? 1 : existing.notifyOnRecovery);
  const enabled =
    typeof body.enabled === 'boolean'
      ? Number(body.enabled)
      : Number(existing.enabled === undefined ? 1 : existing.enabled);
  const requestHeadersValue = body.requestHeaders ?? existing.requestHeaders ?? '{}';
  let requestHeaders;
  try {
    requestHeaders = typeof requestHeadersValue === 'string' ? JSON.parse(requestHeadersValue || '{}') : requestHeadersValue;
  } catch {
    return { error: 'Request headers must be valid JSON.' };
  }

  if (!name) return { error: 'API name is required.' };
  const target = await validateMonitorTarget(apiUrl);
  if (!target.valid) return { error: target.error };
  if (!ALLOWED_METHODS.has(httpMethod)) return { error: 'Enter a supported HTTP method.' };
  if (!Number.isFinite(timeoutMs)) return { error: 'Timeout must be a valid number.' };
  if (!/^(?:[2345]xx|\d{3})(?:\s*,\s*(?:[2345]xx|\d{3}))*$/i.test(expectedStatusCodes)) {
    return { error: 'Expected status codes must look like 2xx or 200,201.' };
  }
  if (!requestHeaders || typeof requestHeaders !== 'object' || Array.isArray(requestHeaders)) {
    return { error: 'Request headers must be a JSON object.' };
  }
  if (Object.keys(requestHeaders).length > 30) return { error: 'Use no more than 30 request headers.' };
  const requestBody = body.requestBody ?? existing.requestBody ?? '';
  if (String(requestBody).length > 50000) return { error: 'Request body must be 50 KB or smaller.' };

  return {
    name,
    apiUrl,
    httpMethod,
    intervalSeconds,
    timeoutMs,
    expectedStatusCodes,
    notifyOnRecovery,
    reminderIntervalSeconds,
    enabled,
    requestHeaders: JSON.stringify(requestHeaders),
    requestBody: String(requestBody),
  };
}

function requireAuth(request, response, next) {
  const authHeader = request.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (!token) {
    return response.status(401).json({ error: 'Authentication is required.' });
  }

  try {
    const payload = jwt.verify(token, requireJwtSecret());
    request.user = {
      id: Number(payload.sub),
      email: payload.email,
    };
    return next();
  } catch {
    return response.status(401).json({ error: 'Invalid or expired token.' });
  }
}

async function getOwnedMonitor(monitorId, userId) {
  const row = await get('SELECT * FROM monitors WHERE id = ? AND userId = ?', [monitorId, userId]);
  const monitor = normalizeMonitor(row);
  if (!monitor) return null;
  const uptime = await get(
    `SELECT COUNT(*) AS totalChecks, SUM(CASE WHEN currentStatus = 'healthy' THEN 1 ELSE 0 END) AS healthyChecks FROM healthChecks WHERE monitorId = ?`,
    [monitor.id],
  );
  return { ...monitor, uptimePercent: uptime.totalChecks ? Math.round((uptime.healthyChecks / uptime.totalChecks) * 10000) / 100 : null };
}

app.get('/api/health', (_request, response) => {
  response.json({ ok: true });
});

app.post(
  '/api/auth/signup',
  asyncHandler(async (request, response) => {
    const name = String(request.body.name || '').trim();
    const email = String(request.body.email || '').trim().toLowerCase();
    const password = String(request.body.password || '');
    const confirmPassword = String(request.body.confirmPassword || '');

    if (!name) {
      return response.status(400).json({ error: 'Name is required.' });
    }

    if (!validateEmail(email)) {
      return response.status(400).json({ error: 'Enter a valid email address.' });
    }

    if (password.length < 6) {
      return response.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    if (password !== confirmPassword) {
      return response.status(400).json({ error: 'Passwords do not match.' });
    }

    const existingUser = await get('SELECT id FROM users WHERE email = ?', [email]);
    if (existingUser) {
      return response.status(409).json({ error: 'An account with this email already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const result = await run(
      'INSERT INTO users (name, email, passwordHash, createdAt) VALUES (?, ?, ?, ?)',
      [name, email, passwordHash, new Date().toISOString()],
    );
    const user = await get('SELECT id, name, email FROM users WHERE id = ?', [result.lastID]);

    return response.status(201).json({
      token: createToken(user),
      user: publicUser(user),
    });
  }),
);

app.post(
  '/api/auth/login',
  asyncHandler(async (request, response) => {
    const email = String(request.body.email || '').trim().toLowerCase();
    const password = String(request.body.password || '');

    if (!validateEmail(email) || !password) {
      return response.status(400).json({ error: 'Email and password are required.' });
    }

    const user = await get('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) {
      return response.status(401).json({ error: 'Invalid email or password.' });
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatches) {
      return response.status(401).json({ error: 'Invalid email or password.' });
    }

    return response.json({
      token: createToken(user),
      user: publicUser(user),
    });
  }),
);

app.get(
  '/api/monitors',
  requireAuth,
  asyncHandler(async (request, response) => {
    const rows = await all('SELECT * FROM monitors WHERE userId = ? ORDER BY id DESC', [
      request.user.id,
    ]);
    const monitors = await Promise.all(rows.map((row) => getOwnedMonitor(row.id, request.user.id)));
    response.json({ monitors });
  }),
);

app.post(
  '/api/monitors',
  requireAuth,
  asyncHandler(async (request, response) => {
    const config = await validateMonitorConfig(request.body);
    if (config.error) return response.status(400).json({ error: config.error });

    const result = await run(
      `
        INSERT INTO monitors (
          userId,
          name,
          apiUrl,
          httpMethod,
          requestHeaders,
          requestBody,
          intervalSeconds,
          timeoutMs,
          expectedStatusCodes,
          notifyOnRecovery,
          reminderIntervalSeconds,
          enabled,
          currentStatus,
          createdAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?)
      `,
      [
        request.user.id,
        config.name,
        config.apiUrl,
        config.httpMethod,
        config.requestHeaders,
        config.requestBody,
        config.intervalSeconds,
        config.timeoutMs,
        config.expectedStatusCodes,
        config.notifyOnRecovery,
        config.reminderIntervalSeconds,
        config.enabled,
        new Date().toISOString(),
      ],
    );
    const monitor = await getOwnedMonitor(result.lastID, request.user.id);

    response.status(201).json({ monitor });
  }),
);

app.put(
  '/api/monitors/:id',
  requireAuth,
  asyncHandler(async (request, response) => {
    const monitorId = Number(request.params.id);
    const monitor = await getOwnedMonitor(monitorId, request.user.id);

    if (!monitor) {
      return response.status(404).json({ error: 'Monitor not found.' });
    }

    const config = await validateMonitorConfig(request.body, monitor);
    if (config.error) return response.status(400).json({ error: config.error });
    const enabled =
      typeof request.body.enabled === 'boolean' ? Number(request.body.enabled) : Number(monitor.enabled);
    const configurationChanged =
      config.apiUrl !== monitor.apiUrl ||
      config.httpMethod !== monitor.httpMethod ||
      config.expectedStatusCodes !== monitor.expectedStatusCodes ||
      config.requestHeaders !== monitor.requestHeaders ||
      config.requestBody !== monitor.requestBody;

    await run(
      `
        UPDATE monitors
        SET
          name = ?,
          apiUrl = ?,
          httpMethod = ?,
          requestHeaders = ?,
          requestBody = ?,
          intervalSeconds = ?,
          timeoutMs = ?,
          expectedStatusCodes = ?,
          notifyOnRecovery = ?,
          reminderIntervalSeconds = ?,
          enabled = ?,
          currentStatus = CASE WHEN ? THEN 'unknown' ELSE currentStatus END,
          lastHttpStatus = CASE WHEN ? THEN NULL ELSE lastHttpStatus END,
          lastResponseTime = CASE WHEN ? THEN NULL ELSE lastResponseTime END,
          lastError = CASE WHEN ? THEN NULL ELSE lastError END,
          lastCheckedAt = CASE WHEN ? THEN NULL ELSE lastCheckedAt END,
          lastAlertState = CASE WHEN ? THEN NULL ELSE lastAlertState END,
          lastAlertAt = CASE WHEN ? THEN NULL ELSE lastAlertAt END
        WHERE id = ? AND userId = ?
      `,
      [
        config.name,
        config.apiUrl,
        config.httpMethod,
        config.requestHeaders,
        config.requestBody,
        config.intervalSeconds,
        config.timeoutMs,
        config.expectedStatusCodes,
        config.notifyOnRecovery,
        config.reminderIntervalSeconds,
        enabled,
        configurationChanged,
        configurationChanged,
        configurationChanged,
        configurationChanged,
        configurationChanged,
        configurationChanged,
        configurationChanged,
        monitorId,
        request.user.id,
      ],
    );

    if (enabled) {
      await rescheduleMonitorJob(monitorId);
    } else {
      stopMonitorJob(monitorId);
    }

    const updatedMonitor = await getOwnedMonitor(monitorId, request.user.id);
    response.json({ monitor: updatedMonitor });
  }),
);

app.delete(
  '/api/monitors/:id',
  requireAuth,
  asyncHandler(async (request, response) => {
    const monitorId = Number(request.params.id);
    const monitor = await getOwnedMonitor(monitorId, request.user.id);

    if (!monitor) {
      return response.status(404).json({ error: 'Monitor not found.' });
    }

    stopMonitorJob(monitorId);
    await run('DELETE FROM monitors WHERE id = ? AND userId = ?', [monitorId, request.user.id]);
    response.status(204).end();
  }),
);

app.post(
  '/api/monitors/:id/start',
  requireAuth,
  asyncHandler(async (request, response) => {
    const monitorId = Number(request.params.id);
    const monitor = await getOwnedMonitor(monitorId, request.user.id);

    if (!monitor) {
      return response.status(404).json({ error: 'Monitor not found.' });
    }

    await run(
      "UPDATE monitors SET enabled = 1, currentStatus = 'checking' WHERE id = ? AND userId = ?",
      [monitorId, request.user.id],
    );
    await startMonitorJob(monitorId, true);

    const updatedMonitor = await getOwnedMonitor(monitorId, request.user.id);
    response.json({ monitor: updatedMonitor });
  }),
);

app.post(
  '/api/monitors/:id/stop',
  requireAuth,
  asyncHandler(async (request, response) => {
    const monitorId = Number(request.params.id);
    const monitor = await getOwnedMonitor(monitorId, request.user.id);

    if (!monitor) {
      return response.status(404).json({ error: 'Monitor not found.' });
    }

    stopMonitorJob(monitorId);
    await run('UPDATE monitors SET enabled = 0 WHERE id = ? AND userId = ?', [
      monitorId,
      request.user.id,
    ]);

    const updatedMonitor = await getOwnedMonitor(monitorId, request.user.id);
    response.json({ monitor: updatedMonitor });
  }),
);

app.get(
  '/api/monitors/:id/status',
  requireAuth,
  asyncHandler(async (request, response) => {
    const monitor = await getOwnedMonitor(Number(request.params.id), request.user.id);

    if (!monitor) {
      return response.status(404).json({ error: 'Monitor not found.' });
    }

    response.json({ monitor });
  }),
);

app.post(
  '/api/monitors/:id/test',
  requireAuth,
  asyncHandler(async (request, response) => {
    const monitorId = Number(request.params.id);
    const monitor = await getOwnedMonitor(monitorId, request.user.id);
    if (!monitor) return response.status(404).json({ error: 'Monitor not found.' });

    await run("UPDATE monitors SET currentStatus = 'checking' WHERE id = ? AND userId = ?", [
      monitorId,
      request.user.id,
    ]);
    await runCheck(monitorId, { force: true });
    response.json({ monitor: await getOwnedMonitor(monitorId, request.user.id) });
  }),
);

app.post(
  '/api/monitors/test-all',
  requireAuth,
  asyncHandler(async (request, response) => {
    const monitors = await all('SELECT id FROM monitors WHERE userId = ?', [request.user.id]);
    await Promise.all(monitors.map(({ id }) => runCheck(id, { force: true })));
    const updated = await all('SELECT * FROM monitors WHERE userId = ? ORDER BY id DESC', [request.user.id]);
    const monitorsWithUptime = await Promise.all(updated.map((row) => getOwnedMonitor(row.id, request.user.id)));
    response.json({ monitors: monitorsWithUptime });
  }),
);

app.get(
  '/api/monitors/analytics',
  requireAuth,
  asyncHandler(async (request, response) => {
    const range = String(request.query.range || '24h');
    try {
      response.json(await getMonitorAnalytics(request.user.id, range));
    } catch (error) {
      if (error.code === 'INVALID_ANALYTICS_RANGE') return response.status(400).json({ error: error.message });
      throw error;
    }
  }),
);

app.get(
  '/api/monitors/:id/history',
  requireAuth,
  asyncHandler(async (request, response) => {
    const monitor = await getOwnedMonitor(Number(request.params.id), request.user.id);
    if (!monitor) return response.status(404).json({ error: 'Monitor not found.' });
    const limit = Math.min(200, Math.max(1, Number(request.query.limit || 50)));
    const history = await all(
      'SELECT id, currentStatus, httpStatus, responseTime, failureReason, checkedAt FROM healthChecks WHERE monitorId = ? ORDER BY checkedAt DESC LIMIT ? ',
      [monitor.id, limit],
    );
    const uptime = await get(
      `
        SELECT COUNT(*) AS totalChecks,
               SUM(CASE WHEN currentStatus = 'healthy' THEN 1 ELSE 0 END) AS healthyChecks
        FROM healthChecks
        WHERE monitorId = ?
      `,
      [monitor.id],
    );
    const uptimePercent = uptime.totalChecks
      ? Math.round((uptime.healthyChecks / uptime.totalChecks) * 10000) / 100
      : null;
    response.json({ history, uptimePercent });
  }),
);

app.get(
  '/api/monitors/:id/notifications',
  requireAuth,
  asyncHandler(async (request, response) => {
    const monitor = await getOwnedMonitor(Number(request.params.id), request.user.id);
    if (!monitor) return response.status(404).json({ error: 'Monitor not found.' });
    const notifications = await all(
      'SELECT id, type, status, recipient, subject, failureReason, sentAt, providerMessageId, errorMessage FROM notificationHistory WHERE monitorId = ? AND userId = ? ORDER BY sentAt DESC LIMIT 100',
      [monitor.id, request.user.id],
    );
    response.json({ notifications });
  }),
);

app.use((error, _request, response, _next) => {
  console.error(error.message);
  response.status(500).json({ error: error.message || 'Internal server error.' });
});

validateEmailConfig();
const emailConfig = getEmailConfigSummary();
console.info(
  `[email] provider=${emailConfig.provider} senderConfigured=${emailConfig.hasSender} ` +
    `resendKeyConfigured=${emailConfig.hasResendKey} smtpConfigured=${emailConfig.hasSmtpHost && emailConfig.hasSmtpUser && emailConfig.hasSmtpPass}`,
);
await initDb();
await loadActiveMonitorJobs();

const server = app.listen(PORT, () => {
  console.log(`API monitoring backend running at http://localhost:${PORT}`);
});

async function shutdown() {
  stopAllMonitorJobs();
  server.close(async () => {
    await closeDb();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

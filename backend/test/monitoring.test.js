import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';

const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'api-monitoring-'));
process.env.DATABASE_PATH = path.join(tempDirectory, 'monitoring.sqlite');
process.env.EMAIL_PROVIDER = 'console';
process.env.EMAIL_FROM = 'test@example.com';
process.env.API_REQUEST_TIMEOUT_MS = '100';
process.env.ALLOW_PRIVATE_MONITOR_TARGETS = 'true';

const { all, closeDb, get, initDb, run } = await import('../server/db.js');
const { checkApiHealth } = await import('../server/monitoring/healthCheck.js');
const { getMonitorAnalytics } = await import('../server/monitoring/analyticsService.js');
const { loadActiveMonitorJobs, runCheck, stopAllMonitorJobs } = await import('../server/monitoring/monitorService.js');
const { sendMonitorAlert, validateEmailConfig } = await import('../server/email/emailService.js');
const { getPasswordValidation } = await import('../server/auth/passwordValidation.js');

let localServer;
let localServerUrl;
let responseMode = 'healthy';

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function createUser(name, email) {
  const result = await run(
    'INSERT INTO users (name, email, passwordHash) VALUES (?, ?, ?)',
    [name, email, 'test-hash'],
  );
  return result.lastID;
}

async function createMonitor(userId, name, url, overrides = {}) {
  const values = {
    name,
    apiUrl: url,
    httpMethod: 'GET',
    intervalSeconds: 5,
    timeoutMs: 100,
    expectedStatusCodes: '2xx',
    notifyOnRecovery: 1,
    reminderIntervalSeconds: 0,
    enabled: 1,
    ...overrides,
  };
  const result = await run(
    `
      INSERT INTO monitors
        (userId, name, apiUrl, httpMethod, intervalSeconds, timeoutMs, expectedStatusCodes,
        notifyOnRecovery, reminderIntervalSeconds, enabled, currentStatus)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown')
    `,
    [
      userId,
      values.name,
      values.apiUrl,
      values.httpMethod,
      values.intervalSeconds,
      values.timeoutMs,
      values.expectedStatusCodes,
      values.notifyOnRecovery,
      values.reminderIntervalSeconds,
      values.enabled,
    ],
  );
  return result.lastID;
}

before(async () => {
  await initDb();
  localServer = http.createServer((request, response) => {
    if (responseMode === 'timeout') return setTimeout(() => response.end('late'), 250);
    response.statusCode = responseMode === 'error' ? 500 : 200;
    response.end(responseMode === 'error' ? 'failure' : 'healthy');
  });
  await new Promise((resolve) => localServer.listen(0, '127.0.0.1', resolve));
  localServerUrl = `http://127.0.0.1:${localServer.address().port}/health`;
});

after(async () => {
  await run('UPDATE monitors SET enabled = 0');
  stopAllMonitorJobs();
  await wait(250);
  await new Promise((resolve) => localServer.close(resolve));
  await closeDb();
  await rm(tempDirectory, { recursive: true, force: true });
});

test('classifies healthy and HTTP 500 responses', async () => {
  responseMode = 'healthy';
  const healthy = await checkApiHealth(localServerUrl, { timeoutMs: 200 });
  assert.equal(healthy.currentStatus, 'healthy');
  assert.equal(healthy.lastHttpStatus, 200);

  responseMode = 'error';
  const failed = await checkApiHealth(localServerUrl, { timeoutMs: 200 });
  assert.equal(failed.currentStatus, 'unhealthy');
  assert.equal(failed.lastHttpStatus, 500);
});

test('validates all password requirements without changing the password', () => {
  for (const password of ['Hello@123', 'Secure#456']) {
    assert.equal(getPasswordValidation(password).valid, true);
  }

  for (const password of ['hello@123', 'HELLO@123', 'HelloWorld@', 'Hello1234', 'Ab@1', '']) {
    assert.equal(getPasswordValidation(password).valid, false);
  }
});

test('classifies unreachable APIs and timeouts', async () => {
  const unreachable = await checkApiHealth('http://127.0.0.1:1/unreachable', { timeoutMs: 100 });
  assert.equal(unreachable.currentStatus, 'offline');
  assert.match(unreachable.lastError, /ECONNREFUSED|fetch failed/i);

  responseMode = 'timeout';
  const timedOut = await checkApiHealth(localServerUrl, { timeoutMs: 50 });
  assert.equal(timedOut.currentStatus, 'offline');
  assert.match(timedOut.lastError, /timed out/i);
});

test('persists all monitor form fields when creating and editing a monitor', async () => {
  const userId = await createUser('CRUD User', 'crud@example.com');
  const requestHeaders = JSON.stringify({ Authorization: 'Bearer test-token', 'X-Region': 'eu' });
  const requestBody = JSON.stringify({ check: true });
  const created = await run(
    `
      INSERT INTO monitors (
        userId, name, apiUrl, httpMethod, requestHeaders, requestBody,
        intervalSeconds, timeoutMs, expectedStatusCodes, notifyOnRecovery,
        reminderIntervalSeconds, enabled, currentStatus, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'unknown', ?)
    `,
    [
      userId,
      'CRUD API',
      'https://example.com/health',
      'POST',
      requestHeaders,
      requestBody,
      300,
      12000,
      '200,201',
      1,
      3600,
      new Date().toISOString(),
    ],
  );
  let monitor = await get('SELECT * FROM monitors WHERE id = ?', [created.lastID]);
  assert.equal(monitor.httpMethod, 'POST');
  assert.equal(monitor.intervalSeconds, 300);
  assert.equal(monitor.timeoutMs, 12000);
  assert.equal(monitor.expectedStatusCodes, '200,201');
  assert.equal(monitor.requestHeaders, requestHeaders);
  assert.equal(monitor.requestBody, requestBody);
  assert.equal(monitor.reminderIntervalSeconds, 3600);

  await run(
    `UPDATE monitors
     SET name = ?, apiUrl = ?, httpMethod = ?, requestHeaders = ?, requestBody = ?,
         intervalSeconds = ?, timeoutMs = ?, expectedStatusCodes = ?, notifyOnRecovery = ?,
         reminderIntervalSeconds = ?, enabled = ?
     WHERE id = ? AND userId = ?`,
    [
      'Edited CRUD API',
      'https://example.com/edited-health',
      'PATCH',
      JSON.stringify({ 'X-Test': 'edited' }),
      JSON.stringify({ edited: true }),
      900,
      5000,
      '204',
      0,
      0,
      1,
      created.lastID,
      userId,
    ],
  );
  monitor = await get('SELECT * FROM monitors WHERE id = ?', [created.lastID]);
  assert.equal(monitor.name, 'Edited CRUD API');
  assert.equal(monitor.httpMethod, 'PATCH');
  assert.equal(monitor.requestHeaders, JSON.stringify({ 'X-Test': 'edited' }));
  assert.equal(monitor.requestBody, JSON.stringify({ edited: true }));
  assert.equal(monitor.intervalSeconds, 900);
  assert.equal(monitor.timeoutMs, 5000);
  assert.equal(monitor.notifyOnRecovery, 0);
  assert.equal(monitor.enabled, 1);
});

test('keeps monitor scheduling state across pause, resume, and restart', async () => {
  stopAllMonitorJobs();
  responseMode = 'healthy';
  const userId = await createUser('Scheduler User', 'scheduler@example.com');
  const defaultMonitor = await run(
    'INSERT INTO monitors (userId, name, apiUrl) VALUES (?, ?, ?)',
    [userId, 'Default Active API', localServerUrl],
  );
  let saved = await get('SELECT enabled FROM monitors WHERE id = ?', [defaultMonitor.lastID]);
  assert.equal(saved.enabled, 1);

  const monitorId = await createMonitor(userId, 'Lifecycle API', localServerUrl, { enabled: 0 });
  await loadActiveMonitorJobs();
  await wait(150);
  let checks = await all('SELECT id FROM healthChecks WHERE monitorId = ?', [monitorId]);
  assert.equal(checks.length, 0);

  await runCheck(monitorId, { force: true });
  checks = await all('SELECT id FROM healthChecks WHERE monitorId = ?', [monitorId]);
  saved = await get('SELECT enabled FROM monitors WHERE id = ?', [monitorId]);
  assert.equal(checks.length, 1);
  assert.equal(saved.enabled, 0);

  await run('UPDATE monitors SET enabled = 1 WHERE id = ?', [monitorId]);
  await loadActiveMonitorJobs();
  await wait(150);
  checks = await all('SELECT id FROM healthChecks WHERE monitorId = ?', [monitorId]);
  assert.ok(checks.length >= 1);

  stopAllMonitorJobs();
  await run('UPDATE monitors SET enabled = 1 WHERE id = ?', [monitorId]);
  await loadActiveMonitorJobs();
  await wait(150);
  const afterRestart = await all('SELECT id FROM healthChecks WHERE monitorId = ?', [monitorId]);
  assert.ok(afterRestart.length > checks.length);
});

test('returns user-scoped analytics in timestamp order for the selected range', async () => {
  const firstUser = await createUser('Analytics User', 'analytics@example.com');
  const secondUser = await createUser('Other Analytics User', 'other-analytics@example.com');
  const firstMonitor = await createMonitor(firstUser, 'Analytics API', localServerUrl);
  const otherMonitor = await createMonitor(secondUser, 'Private Analytics API', localServerUrl);
  const now = Date.now();
  const oldCheck = new Date(now - 2 * 60 * 60 * 1000).toISOString();
  const firstCheck = new Date(now - 30 * 60 * 1000).toISOString();
  const secondCheck = new Date(now - 10 * 60 * 1000).toISOString();

  await run(
    `INSERT INTO healthChecks (monitorId, currentStatus, httpStatus, responseTime, checkedAt) VALUES (?, ?, ?, ?, ?)`,
    [firstMonitor, 'healthy', 200, 100, oldCheck],
  );
  await run(
    `INSERT INTO healthChecks (monitorId, currentStatus, httpStatus, responseTime, failureReason, checkedAt) VALUES (?, ?, ?, ?, ?, ?)`,
    [firstMonitor, 'unhealthy', 500, 200, 'server error', firstCheck],
  );
  await run(
    `INSERT INTO healthChecks (monitorId, currentStatus, httpStatus, responseTime, checkedAt) VALUES (?, ?, ?, ?, ?)`,
    [firstMonitor, 'healthy', 200, 120, secondCheck],
  );
  await run(
    `INSERT INTO healthChecks (monitorId, currentStatus, httpStatus, responseTime, checkedAt) VALUES (?, ?, ?, ?, ?)`,
    [otherMonitor, 'healthy', 200, 40, secondCheck],
  );

  const result = await getMonitorAnalytics(firstUser, '1h', now);
  assert.equal(result.monitors.length, 1);
  assert.deepEqual(result.monitors[0].history.map((check) => check.checkedAt), [firstCheck, secondCheck]);
  assert.equal(result.monitors[0].summary.totalChecks, 2);
  assert.equal(result.monitors[0].summary.averageResponseTime, 160);
  assert.equal(result.monitors[0].summary.uptimePercent, 50);
  await assert.rejects(() => getMonitorAnalytics(firstUser, 'invalid', now), /Range must be/);
});

test('sends one outage notification, then one recovery notification', async () => {
  const userId = await createUser('Alert User', 'alert@example.com');
  responseMode = 'error';
  const monitorId = await createMonitor(userId, 'Alert API', localServerUrl);

  await runCheck(monitorId);
  await runCheck(monitorId);
  let notifications = await all('SELECT * FROM notificationHistory WHERE monitorId = ? ORDER BY id', [monitorId]);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, 'failure');
  assert.equal(notifications[0].status, 'preview');
  assert.equal(notifications[0].recipient, 'alert@example.com');

  responseMode = 'healthy';
  await runCheck(monitorId);
  notifications = await all('SELECT * FROM notificationHistory WHERE monitorId = ? ORDER BY id', [monitorId]);
  assert.equal(notifications.length, 2);
  assert.equal(notifications[1].type, 'recovery');
  assert.equal(notifications[1].status, 'preview');
});

test('keeps notification recipients separate for multiple users', async () => {
  const firstUser = await createUser('First User', 'first@example.com');
  const secondUser = await createUser('Second User', 'second@example.com');
  responseMode = 'error';
  const firstMonitor = await createMonitor(firstUser, 'First API', localServerUrl);
  const secondMonitor = await createMonitor(secondUser, 'Second API', localServerUrl);

  await runCheck(firstMonitor);
  await runCheck(secondMonitor);
  const rows = await all(
    'SELECT monitorId, userId, recipient FROM notificationHistory WHERE monitorId IN (?, ?) ORDER BY monitorId',
    [firstMonitor, secondMonitor],
  );
  assert.deepEqual(rows.map((row) => row.recipient), ['first@example.com', 'second@example.com']);
  assert.equal(rows[0].userId, firstUser);
  assert.equal(rows[1].userId, secondUser);
});

test('validates missing SMTP configuration without exposing values', () => {
  process.env.EMAIL_PROVIDER = 'smtp';
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  delete process.env.EMAIL_FROM;
  assert.throws(() => validateEmailConfig(), /SMTP configuration is missing/);
  process.env.EMAIL_PROVIDER = 'console';
  process.env.EMAIL_FROM = 'test@example.com';
});

test('uses Resend for owner-directed alerts when configured', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  process.env.EMAIL_PROVIDER = 'resend';
  delete process.env.RESEND_API_KEY;
  assert.throws(() => validateEmailConfig(), /RESEND_API_KEY/);
  process.env.RESEND_API_KEY = 'test-key-not-real';
  process.env.EMAIL_FROM = 'verified@example.com';
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      async json() {
        return { id: 'resend-test-id' };
      },
    };
  };

  const info = await sendMonitorAlert({
    type: 'failure',
    monitor: { name: 'Resend Test API', apiUrl: localServerUrl, httpMethod: 'GET' },
    result: {
      lastHttpStatus: 500,
      lastError: 'test failure',
      lastResponseTime: 10,
      lastCheckedAt: new Date().toISOString(),
    },
    userEmail: 'owner@example.com',
  });
  const payload = JSON.parse(request.options.body);

  assert.equal(request.url, 'https://api.resend.com/emails');
  assert.equal(payload.to[0], 'owner@example.com');
  assert.equal(payload.from, 'verified@example.com');
  assert.equal(info.messageId, 'resend-test-id');

  globalThis.fetch = originalFetch;
  process.env.EMAIL_PROVIDER = 'console';
  delete process.env.RESEND_API_KEY;
  process.env.EMAIL_FROM = 'test@example.com';
});

test('records provider rejection and does not repeat the same outage alert', async () => {
  const originalFetch = globalThis.fetch;
  const userId = await createUser('Rejected Alert User', 'rejected@example.com');
  const monitorId = await createMonitor(userId, 'Rejected Alert API', localServerUrl);
  responseMode = 'error';
  process.env.EMAIL_PROVIDER = 'resend';
  process.env.RESEND_API_KEY = 'test-key-not-real';
  process.env.EMAIL_FROM = 'verified@example.com';
  globalThis.fetch = async () => ({ ok: false, status: 401 });

  await runCheck(monitorId);
  await runCheck(monitorId);
  const notifications = await all(
    'SELECT type, status, recipient, errorMessage FROM notificationHistory WHERE monitorId = ?',
    [monitorId],
  );
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, 'failure');
  assert.equal(notifications[0].status, 'failed');
  assert.equal(notifications[0].recipient, 'rejected@example.com');
  assert.match(notifications[0].errorMessage, /Resend rejected/);

  globalThis.fetch = originalFetch;
  process.env.EMAIL_PROVIDER = 'console';
  delete process.env.RESEND_API_KEY;
  process.env.EMAIL_FROM = 'test@example.com';
});

test('resumes enabled monitors through the startup loader', async () => {
  stopAllMonitorJobs();
  await run('UPDATE monitors SET enabled = 0');
  responseMode = 'healthy';
  const userId = await createUser('Restart User', 'restart@example.com');
  const monitorId = await createMonitor(userId, 'Restart API', localServerUrl);
  await loadActiveMonitorJobs();
  await wait(150);
  const checks = await all('SELECT * FROM healthChecks WHERE monitorId = ?', [monitorId]);
  assert.ok(checks.length >= 1);
  await run('UPDATE monitors SET enabled = 0 WHERE id = ?', [monitorId]);
});

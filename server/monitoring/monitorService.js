import { all, get, normalizeMonitor, run } from '../db.js';
import { sendMonitorAlert } from '../email/emailService.js';
import { checkApiHealth, stateBucket } from './healthCheck.js';

const jobs = new Map();
const inFlightChecks = new Set();

function intervalToMs(intervalSeconds) {
  return Math.max(5, Number(intervalSeconds || 30)) * 1000;
}

async function loadMonitorWithUser(monitorId) {
  return get(
    `
      SELECT monitors.*, users.email AS userEmail
      FROM monitors
      JOIN users ON users.id = monitors.userId
      WHERE monitors.id = ?
    `,
    [monitorId],
  );
}

function scheduleNext(monitorId, intervalSeconds, delayMs) {
  const id = Number(monitorId);
  const existingJob = jobs.get(id);
  if (existingJob) clearTimeout(existingJob.timeout);

  const timeout = setTimeout(() => {
    runCheck(id).catch((error) => {
      console.error(`Monitor ${id} failed:`, error.message);
      const job = jobs.get(id);
      if (job) scheduleNext(id, job.intervalSeconds, intervalToMs(job.intervalSeconds));
    });
  }, delayMs);

  jobs.set(id, { timeout, intervalSeconds });
}

async function recordNotification({ monitor, type, result, userEmail }) {
  const subject = type === 'recovery' ? `API RECOVERED: ${monitor.name}` : `API DOWN: ${monitor.name}`;
  const sentAt = new Date().toISOString();

  try {
    const info = await sendMonitorAlert({ type, monitor, result, userEmail });
    await run(
      `
        INSERT INTO notificationHistory
          (monitorId, userId, type, status, recipient, subject, failureReason, sentAt, providerMessageId, errorMessage)
        VALUES (?, ?, ?, 'sent', ?, ?, ?, ?, ?, NULL)
      `,
      [monitor.id, monitor.userId, type, userEmail, subject, result.lastError, sentAt, info.messageId || null],
    );
    return { status: 'sent', sentAt };
  } catch (error) {
    await run(
      `
        INSERT INTO notificationHistory
          (monitorId, userId, type, status, recipient, subject, failureReason, sentAt, providerMessageId, errorMessage)
        VALUES (?, ?, ?, 'failed', ?, ?, ?, ?, NULL, ?)
      `,
      [monitor.id, monitor.userId, type, userEmail, subject, result.lastError, sentAt, error.message],
    );
    console.error(`Email alert failed for monitor ${monitor.id}:`, error.message);
    return { status: 'failed', sentAt };
  }
}

async function updateAlertState({ monitor, result }) {
  const previousAlertState = monitor.lastAlertState;
  const nextBucket = stateBucket(result.currentStatus);
  let lastAlertState = previousAlertState;
  let lastAlertAt = monitor.lastAlertAt;
  const lastAlertTime = monitor.lastAlertAt ? Date.parse(monitor.lastAlertAt) : 0;
  const reminderDue =
    nextBucket === 'down' &&
    monitor.reminderIntervalSeconds > 0 &&
    lastAlertTime > 0 &&
    Date.now() - lastAlertTime >= monitor.reminderIntervalSeconds * 1000;

  if (nextBucket === 'down' && previousAlertState !== 'down') {
    const notification = await recordNotification({ monitor, type: 'failure', result, userEmail: monitor.userEmail });
    lastAlertState = 'down';
    lastAlertAt = notification.sentAt;
  } else if (reminderDue) {
    const notification = await recordNotification({ monitor, type: 'reminder', result, userEmail: monitor.userEmail });
    lastAlertAt = notification.sentAt;
  } else if (nextBucket === 'healthy') {
    if (previousAlertState === 'down' && monitor.notifyOnRecovery) {
      const notification = await recordNotification({ monitor, type: 'recovery', result, userEmail: monitor.userEmail });
      lastAlertAt = notification.sentAt;
    }
    lastAlertState = 'healthy';
  }

  return { lastAlertState, lastAlertAt };
}

async function persistResult(monitor, result) {
  const alert = await updateAlertState({ monitor, result });

  await run(
    `
      INSERT INTO healthChecks
        (monitorId, currentStatus, httpStatus, responseTime, failureReason, checkedAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    [monitor.id, result.currentStatus, result.lastHttpStatus, result.lastResponseTime, result.lastError, result.lastCheckedAt],
  );

  await run(
    `
      UPDATE monitors
      SET currentStatus = ?, lastHttpStatus = ?, lastResponseTime = ?, lastError = ?,
          lastCheckedAt = ?, lastAlertState = ?, lastAlertAt = ?
      WHERE id = ? AND userId = ?
    `,
    [
      result.currentStatus,
      result.lastHttpStatus,
      result.lastResponseTime,
      result.lastError,
      result.lastCheckedAt,
      alert.lastAlertState,
      alert.lastAlertAt,
      monitor.id,
      monitor.userId,
    ],
  );
}

export async function runCheck(monitorId) {
  const id = Number(monitorId);
  if (inFlightChecks.has(id)) return;
  inFlightChecks.add(id);

  try {
    const row = await loadMonitorWithUser(id);
    if (!row || !row.enabled) {
      stopMonitorJob(id);
      return;
    }

    await run("UPDATE monitors SET currentStatus = 'checking' WHERE id = ? AND userId = ?", [id, row.userId]);
    const monitor = normalizeMonitor(row);
    monitor.userEmail = row.userEmail;
    const result = await checkApiHealth(row.apiUrl, monitor);
    await persistResult(monitor, result);
  } finally {
    inFlightChecks.delete(id);
  }

  const latest = await get('SELECT intervalSeconds, enabled FROM monitors WHERE id = ?', [id]);
  if (latest?.enabled) {
    scheduleNext(id, latest.intervalSeconds, intervalToMs(latest.intervalSeconds));
  } else {
    stopMonitorJob(id);
  }
}

export async function startMonitorJob(monitorId, runImmediately = true) {
  const id = Number(monitorId);
  stopMonitorJob(id);
  const monitor = await get('SELECT id, intervalSeconds, enabled FROM monitors WHERE id = ?', [id]);
  if (!monitor?.enabled) return;

  if (runImmediately) {
    runCheck(id).catch((error) => console.error(`Monitor ${id} failed:`, error.message));
  } else {
    scheduleNext(id, monitor.intervalSeconds, intervalToMs(monitor.intervalSeconds));
  }
}

export function stopMonitorJob(monitorId) {
  const id = Number(monitorId);
  const job = jobs.get(id);
  if (!job) return;
  clearTimeout(job.timeout);
  jobs.delete(id);
}

export async function rescheduleMonitorJob(monitorId) {
  await startMonitorJob(Number(monitorId), false);
}

export async function loadActiveMonitorJobs() {
  const monitors = await all('SELECT id FROM monitors WHERE enabled = 1');
  for (const monitor of monitors) await startMonitorJob(monitor.id, true);
}

export function stopAllMonitorJobs() {
  for (const monitorId of jobs.keys()) stopMonitorJob(monitorId);
}

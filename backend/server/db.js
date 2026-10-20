import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sqlite3 from 'sqlite3';

const SERVER_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const configuredDbPath = process.env.DATABASE_PATH;
const dbPath = configuredDbPath
  ? path.resolve(process.cwd(), configuredDbPath)
  : path.join(SERVER_DIRECTORY, 'data', 'monitoring.sqlite');

let db;

function openDatabase() {
  if (db) return db;

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new sqlite3.Database(dbPath);
  db.run('PRAGMA foreign_keys = ON');
  return db;
}

export function run(sql, params = []) {
  const database = openDatabase();
  return new Promise((resolve, reject) => {
    database.run(sql, params, function onRun(error) {
      if (error) {
        reject(error);
        return;
      }

      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

export function get(sql, params = []) {
  const database = openDatabase();
  return new Promise((resolve, reject) => {
    database.get(sql, params, (error, row) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(row);
    });
  });
}

export function all(sql, params = []) {
  const database = openDatabase();
  return new Promise((resolve, reject) => {
    database.all(sql, params, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(rows);
    });
  });
}

export async function initDb() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      passwordHash TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS monitors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      name TEXT NOT NULL DEFAULT 'Unnamed API',
      apiUrl TEXT NOT NULL,
      httpMethod TEXT NOT NULL DEFAULT 'GET',
      intervalSeconds INTEGER NOT NULL DEFAULT 30,
      timeoutMs INTEGER NOT NULL DEFAULT 8000,
      expectedStatusCodes TEXT NOT NULL DEFAULT '2xx',
      notifyOnRecovery INTEGER NOT NULL DEFAULT 1,
      reminderIntervalSeconds INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      currentStatus TEXT NOT NULL DEFAULT 'unknown',
      lastHttpStatus INTEGER,
      lastResponseTime INTEGER,
      lastError TEXT,
      lastCheckedAt TEXT,
      lastAlertState TEXT,
      lastAlertAt TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  const columns = await all('PRAGMA table_info(monitors)');
  const existingColumns = new Set(columns.map((column) => column.name));
  const migrations = [
    ['name', "ALTER TABLE monitors ADD COLUMN name TEXT NOT NULL DEFAULT 'Unnamed API'"],
    ['httpMethod', "ALTER TABLE monitors ADD COLUMN httpMethod TEXT NOT NULL DEFAULT 'GET'"],
    ['requestHeaders', "ALTER TABLE monitors ADD COLUMN requestHeaders TEXT NOT NULL DEFAULT '{}'"],
    ['requestBody', "ALTER TABLE monitors ADD COLUMN requestBody TEXT"],
    ['timeoutMs', 'ALTER TABLE monitors ADD COLUMN timeoutMs INTEGER NOT NULL DEFAULT 8000'],
    [
      'expectedStatusCodes',
      "ALTER TABLE monitors ADD COLUMN expectedStatusCodes TEXT NOT NULL DEFAULT '2xx'",
    ],
    [
      'notifyOnRecovery',
      'ALTER TABLE monitors ADD COLUMN notifyOnRecovery INTEGER NOT NULL DEFAULT 1',
    ],
    [
      'reminderIntervalSeconds',
      'ALTER TABLE monitors ADD COLUMN reminderIntervalSeconds INTEGER NOT NULL DEFAULT 0',
    ],
  ];

  for (const [column, sql] of migrations) {
    if (!existingColumns.has(column)) await run(sql);
  }

  await run(`
    CREATE TABLE IF NOT EXISTS healthChecks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitorId INTEGER NOT NULL,
      currentStatus TEXT NOT NULL,
      httpStatus INTEGER,
      responseTime INTEGER,
      failureReason TEXT,
      checkedAt TEXT NOT NULL,
      FOREIGN KEY (monitorId) REFERENCES monitors(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS notificationHistory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitorId INTEGER NOT NULL,
      userId INTEGER NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      recipient TEXT NOT NULL,
      subject TEXT NOT NULL,
      failureReason TEXT,
      sentAt TEXT NOT NULL,
      providerMessageId TEXT,
      errorMessage TEXT,
      FOREIGN KEY (monitorId) REFERENCES monitors(id) ON DELETE CASCADE,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await run('CREATE INDEX IF NOT EXISTS healthChecks_monitor_checkedAt ON healthChecks (monitorId, checkedAt DESC)');
  await run(
    'CREATE INDEX IF NOT EXISTS notificationHistory_monitor_sentAt ON notificationHistory (monitorId, sentAt DESC)',
  );
}

export function normalizeMonitor(row) {
  if (!row) return null;

  return {
    id: row.id,
    userId: row.userId,
    name: row.name || row.apiUrl,
    apiUrl: row.apiUrl,
    httpMethod: row.httpMethod || 'GET',
    requestHeaders: row.requestHeaders || '{}',
    requestBody: row.requestBody || '',
    intervalSeconds: row.intervalSeconds,
    timeoutMs: row.timeoutMs || 8000,
    expectedStatusCodes: row.expectedStatusCodes || '2xx',
    notifyOnRecovery: Boolean(row.notifyOnRecovery),
    reminderIntervalSeconds: row.reminderIntervalSeconds || 0,
    enabled: Boolean(row.enabled),
    currentStatus: row.currentStatus,
    lastHttpStatus: row.lastHttpStatus,
    lastResponseTime: row.lastResponseTime,
    lastError: row.lastError,
    lastCheckedAt: row.lastCheckedAt,
    lastAlertState: row.lastAlertState,
    lastAlertAt: row.lastAlertAt,
    createdAt: row.createdAt,
  };
}

export function closeDb() {
  if (!db) return Promise.resolve();

  return new Promise((resolve, reject) => {
    db.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      db = null;
      resolve();
    });
  });
}

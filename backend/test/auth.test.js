import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { after, before, test } from 'node:test';

const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'api-monitoring-auth-'));
const databasePath = path.join(tempDirectory, 'monitoring.sqlite');
let port;
let serverProcess;

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(address.port));
    });
  });
}

async function request(pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return { response, data: await response.json() };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const { response } = await request('/api/health');
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error('Authentication test server did not start.');
}

before(async () => {
  port = await getAvailablePort();
  serverProcess = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: databasePath,
      JWT_SECRET: 'test-only-jwt-secret',
      FRONTEND_ORIGIN: 'http://localhost:5173',
      EMAIL_PROVIDER: 'console',
      EMAIL_FROM: 'test@example.com',
    },
    stdio: 'ignore',
  });
  await waitForServer();
});

after(async () => {
  serverProcess.kill();
  await rm(tempDirectory, { recursive: true, force: true });
});

test('rejects missing, invalid, and mismatched signup passwords', async () => {
  const cases = [
    { password: undefined, confirmPassword: undefined },
    { password: 'hello@123', confirmPassword: 'hello@123' },
    { password: 'Hello@123', confirmPassword: 'Hello@124' },
  ];

  for (const [index, passwordCase] of cases.entries()) {
    const { response, data } = await request('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Invalid User',
        email: `invalid-${index}@example.com`,
        ...passwordCase,
      }),
    });
    assert.equal(response.status, 400);
    assert.match(data.error, /password/i);
  }
});

test('signs up with a valid password, logs in, and preserves duplicate-email validation', async () => {
  const payload = {
    name: 'Valid User',
    email: 'valid-auth@example.com',
    password: 'Hello@123',
    confirmPassword: 'Hello@123',
  };
  const signup = await request('/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  assert.equal(signup.response.status, 201);
  assert.equal(typeof signup.data.token, 'string');
  assert.equal(signup.data.user.email, payload.email);

  const login = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: payload.email, password: payload.password }),
  });
  assert.equal(login.response.status, 200);
  assert.equal(typeof login.data.token, 'string');
  assert.equal(login.data.user.email, payload.email);

  const duplicate = await request('/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  assert.equal(duplicate.response.status, 409);
});

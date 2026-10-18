import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  clearStoredSession,
  createMonitor,
  deleteMonitor,
  getMonitors,
  getMonitorHistory,
  getMonitorNotifications,
  getStoredSession,
  login,
  signup,
  startMonitor,
  stopMonitor,
  storeSession,
  updateMonitor,
} from './services/apiClient';

const DEFAULT_INTERVAL_SECONDS = 30;
const UI_REFRESH_MS = 5000;

const statusLabels = {
  healthy: 'Healthy',
  unhealthy: 'Unhealthy',
  offline: 'Offline',
  checking: 'Checking',
  unknown: 'Checking',
};

function formatDateTime(value) {
  if (!value) return 'Not checked yet';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(value));
}

function formatResponseTime(value) {
  if (value === null || value === undefined) return 'N/A';
  return `${value} ms`;
}

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function StatCard({ label, value }) {
  return (
    <section className="stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </section>
  );
}

function AuthPage({ mode, onModeChange, onAuthenticated }) {
  const isSignup = mode === 'signup';
  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
    confirmPassword: '',
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');

    if (isSignup && !form.name.trim()) {
      setError('Name is required.');
      return;
    }

    if (!form.email.trim() || !form.password) {
      setError('Email and password are required.');
      return;
    }

    if (isSignup && form.password !== form.confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      const session = isSignup ? await signup(form) : await login(form);
      storeSession(session);
      onAuthenticated(session);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="app-shell auth-shell">
      <section className="auth-panel">
        <p className="eyebrow">API Monitor</p>
        <h1>{isSignup ? 'Create account' : 'Welcome back'}</h1>

        <form className="auth-form" onSubmit={handleSubmit}>
          {isSignup ? (
            <label>
              Name
              <input
                value={form.name}
                onChange={(event) => updateField('name', event.target.value)}
                autoComplete="name"
                required
              />
            </label>
          ) : null}

          <label>
            Email
            <input
              type="email"
              value={form.email}
              onChange={(event) => updateField('email', event.target.value)}
              autoComplete="email"
              required
            />
          </label>

          <label>
            Password
            <input
              type="password"
              value={form.password}
              onChange={(event) => updateField('password', event.target.value)}
              autoComplete={isSignup ? 'new-password' : 'current-password'}
              minLength={6}
              required
            />
          </label>

          {isSignup ? (
            <label>
              Confirm Password
              <input
                type="password"
                value={form.confirmPassword}
                onChange={(event) => updateField('confirmPassword', event.target.value)}
                autoComplete="new-password"
                minLength={6}
                required
              />
            </label>
          ) : null}

          {error ? <p className="form-error">{error}</p> : null}

          <button type="submit" disabled={loading}>
            {loading ? 'Please wait...' : isSignup ? 'Sign Up' : 'Login'}
          </button>
        </form>

        <button
          className="link-button"
          type="button"
          onClick={() => onModeChange(isSignup ? 'login' : 'signup')}
        >
          {isSignup ? 'Already have an account? Login' : 'Need an account? Sign up'}
        </button>
      </section>
    </main>
  );
}

function Dashboard({ session, onLogout }) {
  const [monitors, setMonitors] = useState([]);
  const [selectedMonitorId, setSelectedMonitorId] = useState(null);
  const [apiUrl, setApiUrl] = useState('');
  const [apiName, setApiName] = useState('');
  const [httpMethod, setHttpMethod] = useState('GET');
  const [intervalSeconds, setIntervalSeconds] = useState(DEFAULT_INTERVAL_SECONDS);
  const [timeoutMs, setTimeoutMs] = useState(8000);
  const [expectedStatusCodes, setExpectedStatusCodes] = useState('2xx');
  const [notifyOnRecovery, setNotifyOnRecovery] = useState(true);
  const [reminderIntervalSeconds, setReminderIntervalSeconds] = useState(0);
  const [history, setHistory] = useState([]);
  const [uptimePercent, setUptimePercent] = useState(null);
  const [notifications, setNotifications] = useState([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const selectedMonitor = useMemo(
    () => monitors.find((monitor) => monitor.id === selectedMonitorId) || monitors[0] || null,
    [monitors, selectedMonitorId],
  );

  const currentStatus = selectedMonitor?.currentStatus || 'unknown';

  const loadMonitors = useCallback(
    async (silent = false) => {
      try {
        const data = await getMonitors(session.token);
        setMonitors(data.monitors);

        if (!selectedMonitorId && data.monitors.length > 0) {
          const first = data.monitors[0];
          setSelectedMonitorId(first.id);
          setApiName(first.name);
          setApiUrl(first.apiUrl);
          setHttpMethod(first.httpMethod);
          setIntervalSeconds(first.intervalSeconds);
          setTimeoutMs(first.timeoutMs);
          setExpectedStatusCodes(first.expectedStatusCodes);
          setNotifyOnRecovery(first.notifyOnRecovery);
          setReminderIntervalSeconds(first.reminderIntervalSeconds);
        }
      } catch (requestError) {
        if (!silent) setError(requestError.message);
        if (requestError.message.includes('token') || requestError.message.includes('Authentication')) {
          onLogout();
        }
      }
    },
    [onLogout, selectedMonitorId, session.token],
  );

  const loadDetails = useCallback(async () => {
    if (!selectedMonitorId) {
      setHistory([]);
      setUptimePercent(null);
      setNotifications([]);
      return;
    }

    try {
      const [historyData, notificationData] = await Promise.all([
        getMonitorHistory(session.token, selectedMonitorId),
        getMonitorNotifications(session.token, selectedMonitorId),
      ]);
      setHistory(historyData.history);
      setUptimePercent(historyData.uptimePercent);
      setNotifications(notificationData.notifications);
    } catch (requestError) {
      setError(requestError.message);
    }
  }, [selectedMonitorId, session.token]);

  useEffect(() => {
    loadMonitors();
  }, [loadMonitors]);

  useEffect(() => {
    loadDetails();
  }, [loadDetails, monitors]);

  useEffect(() => {
    const intervalId = window.setInterval(() => loadMonitors(true), UI_REFRESH_MS);
    return () => window.clearInterval(intervalId);
  }, [loadMonitors]);

  function selectMonitor(monitor) {
    setSelectedMonitorId(monitor.id);
    setApiName(monitor.name);
    setApiUrl(monitor.apiUrl);
    setHttpMethod(monitor.httpMethod);
    setIntervalSeconds(monitor.intervalSeconds);
    setTimeoutMs(monitor.timeoutMs);
    setExpectedStatusCodes(monitor.expectedStatusCodes);
    setNotifyOnRecovery(monitor.notifyOnRecovery);
    setReminderIntervalSeconds(monitor.reminderIntervalSeconds);
    setError('');
    setMessage('');
  }

  async function handleStart(event) {
    event.preventDefault();
    setError('');
    setMessage('');

    const trimmedUrl = apiUrl.trim();
    if (!isValidHttpUrl(trimmedUrl)) {
      setError('Enter a valid HTTP or HTTPS API URL.');
      return;
    }

    setLoading(true);
    try {
      const payload = {
        name: apiName.trim(),
        apiUrl: trimmedUrl,
        httpMethod,
        intervalSeconds: Number(intervalSeconds || DEFAULT_INTERVAL_SECONDS),
        timeoutMs: Number(timeoutMs),
        expectedStatusCodes,
        notifyOnRecovery,
        reminderIntervalSeconds: Number(reminderIntervalSeconds),
      };

      const saved = selectedMonitor
        ? await updateMonitor(session.token, selectedMonitor.id, payload)
        : await createMonitor(session.token, payload);

      await startMonitor(session.token, saved.monitor.id);
      setSelectedMonitorId(saved.monitor.id);
      setMessage('Monitoring started on the backend.');
      await loadMonitors(true);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleStop() {
    if (!selectedMonitor) return;

    setLoading(true);
    setError('');
    setMessage('');
    try {
      await stopMonitor(session.token, selectedMonitor.id);
      setMessage('Monitoring stopped.');
      await loadMonitors(true);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete() {
    if (!selectedMonitor) return;

    setLoading(true);
    setError('');
    setMessage('');
    try {
      await deleteMonitor(session.token, selectedMonitor.id);
      setSelectedMonitorId(null);
      setApiName('');
      setApiUrl('');
      setHttpMethod('GET');
      setIntervalSeconds(DEFAULT_INTERVAL_SECONDS);
      setTimeoutMs(8000);
      setExpectedStatusCodes('2xx');
      setNotifyOnRecovery(true);
      setReminderIntervalSeconds(0);
      setMessage('Monitor removed.');
      await loadMonitors(true);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  function handleLogout() {
    clearStoredSession();
    onLogout();
  }

  return (
    <main className="app-shell">
      <section className="dashboard">
        <div className="top-bar">
          <div>
            <p className="eyebrow">API Monitor</p>
            <h1>Health Dashboard</h1>
          </div>
          <div className="account-actions">
            <span>{session.user.name}</span>
            <button type="button" onClick={handleLogout}>
              Logout
            </button>
          </div>
        </div>

        <form className="api-form" onSubmit={handleStart}>
          <div className="form-grid">
            <label>
              API name
              <input
                value={apiName}
                onChange={(event) => setApiName(event.target.value)}
                placeholder="Payments API"
                required
              />
            </label>

            <label>
              API URL
              <input
                type="url"
                value={apiUrl}
                onChange={(event) => setApiUrl(event.target.value)}
                placeholder="https://example.com/health"
                required
              />
            </label>

            <label>
              HTTP method
              <select value={httpMethod} onChange={(event) => setHttpMethod(event.target.value)}>
                {['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].map((method) => (
                  <option key={method} value={method}>{method}</option>
                ))}
              </select>
            </label>

            <label>
              Interval
              <select
                value={intervalSeconds}
                onChange={(event) => setIntervalSeconds(Number(event.target.value))}
              >
                <option value={30}>30 seconds</option>
                <option value={60}>1 minute</option>
                <option value={300}>5 minutes</option>
                <option value={900}>15 minutes</option>
              </select>
            </label>

            <label>
              Timeout (ms)
              <input type="number" min="100" max="120000" value={timeoutMs} onChange={(event) => setTimeoutMs(event.target.value)} />
            </label>

            <label>
              Expected status codes
              <input value={expectedStatusCodes} onChange={(event) => setExpectedStatusCodes(event.target.value)} placeholder="2xx" />
            </label>

            <label>
              Outage reminder
              <select value={reminderIntervalSeconds} onChange={(event) => setReminderIntervalSeconds(Number(event.target.value))}>
                <option value={0}>Off</option>
                <option value={300}>Every 5 minutes</option>
                <option value={3600}>Every hour</option>
                <option value={86400}>Every day</option>
              </select>
            </label>

            <label className="checkbox-label">
              <input type="checkbox" checked={notifyOnRecovery} onChange={(event) => setNotifyOnRecovery(event.target.checked)} />
              Send recovery email
            </label>
          </div>

          <div className="button-row">
            <button type="submit" disabled={loading}>
              {loading ? 'Working...' : 'Start Monitoring'}
            </button>
            <button type="button" className="secondary-button" onClick={handleStop} disabled={!selectedMonitor || loading}>
              Stop Monitoring
            </button>
            <button type="button" className="danger-button" onClick={handleDelete} disabled={!selectedMonitor || loading}>
              Delete
            </button>
          </div>

          {error ? <p className="form-error">{error}</p> : null}
          {message ? <p className="form-success">{message}</p> : null}
        </form>

        <section className={`status-panel panel-${currentStatus}`}>
          <div className={`status-dot status-${currentStatus}`} aria-hidden="true" />
          <div>
            <p>Current API status</p>
            <strong>{statusLabels[currentStatus] || 'Checking'}</strong>
          </div>
        </section>

        <section className="stats-grid">
          <StatCard label="HTTP status code" value={selectedMonitor?.lastHttpStatus ?? 'N/A'} />
          <StatCard label="Response time" value={formatResponseTime(selectedMonitor?.lastResponseTime)} />
          <StatCard label="Last checked time" value={formatDateTime(selectedMonitor?.lastCheckedAt)} />
          <StatCard label="Monitoring" value={selectedMonitor?.enabled ? 'Active' : 'Stopped'} />
        </section>

        <section className="details-panel">
          <div>
            <h2>Error details</h2>
            <p>{selectedMonitor?.lastError || 'No error reported.'}</p>
          </div>
        </section>

        <section className="details-panel history-panel">
          <div className="section-heading">
            <h2>Recent health checks</h2>
            <span>{uptimePercent === null ? 'No uptime yet' : `${uptimePercent}% uptime`} · {history.length} shown</span>
          </div>
          {history.length === 0 ? <p>No health checks recorded yet.</p> : (
            <div className="history-list">
              {history.slice(0, 10).map((check) => (
                <div className="history-row" key={check.id}>
                  <strong>{statusLabels[check.currentStatus] || check.currentStatus}</strong>
                  <span>{check.httpStatus || 'N/A'} · {formatResponseTime(check.responseTime)}</span>
                  <span>{formatDateTime(check.checkedAt)}</span>
                  <span>{check.failureReason || 'No failure'}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="details-panel history-panel">
          <div className="section-heading">
            <h2>Email alert history</h2>
            <span>{notifications.length} recorded</span>
          </div>
          {notifications.length === 0 ? <p>No email alerts recorded yet.</p> : (
            <div className="history-list">
              {notifications.slice(0, 10).map((notification) => (
                <div className="history-row" key={notification.id}>
                  <strong>{notification.type}</strong>
                  <span>{notification.status}</span>
                  <span>{formatDateTime(notification.sentAt)}</span>
                  <span>{notification.errorMessage || notification.recipient}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="monitor-list">
          <div className="section-heading">
            <h2>Saved monitors</h2>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                setSelectedMonitorId(null);
                setApiName('');
                setApiUrl('');
                setHttpMethod('GET');
                setIntervalSeconds(DEFAULT_INTERVAL_SECONDS);
                setTimeoutMs(8000);
                setExpectedStatusCodes('2xx');
                setNotifyOnRecovery(true);
                setReminderIntervalSeconds(0);
                setMessage('');
                setError('');
              }}
            >
              New
            </button>
          </div>

          {monitors.length === 0 ? (
            <p className="empty-state">No monitors yet.</p>
          ) : (
            <div className="monitor-items">
              {monitors.map((monitor) => (
                <button
                  type="button"
                  key={monitor.id}
                  className={`monitor-item ${monitor.id === selectedMonitor?.id ? 'selected' : ''}`}
                  onClick={() => selectMonitor(monitor)}
                >
                  <span className={`mini-dot status-${monitor.currentStatus}`} />
                  <span>{monitor.apiUrl}</span>
                  <strong>{monitor.enabled ? 'Active' : 'Stopped'}</strong>
                </button>
              ))}
            </div>
          )}
        </section>
      </section>
    </main>
  );
}

export default function App() {
  const [session, setSession] = useState(() => getStoredSession());
  const [authMode, setAuthMode] = useState('login');

  if (!session) {
    return (
      <AuthPage
        mode={authMode}
        onModeChange={setAuthMode}
        onAuthenticated={setSession}
      />
    );
  }

  return <Dashboard session={session} onLogout={() => setSession(null)} />;
}

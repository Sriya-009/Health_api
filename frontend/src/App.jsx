import React, { useEffect, useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  clearStoredSession, createMonitor, deleteMonitor, getMonitorAnalytics, getMonitorHistory, getMonitors,
  getStoredSession, login, signup, storeSession, testAllMonitors, testMonitor,
  updateMonitor, startMonitor, stopMonitor,
} from './services/apiClient';
import { getPasswordRequirements, getPasswordValidation } from './services/passwordValidation';

const EMPTY_FORM = {
  name: '', apiUrl: '', httpMethod: 'GET', expectedStatusCodes: '2xx', intervalSeconds: 60,
  timeoutMs: 8000, requestHeaders: '{}', requestBody: '', notifyOnRecovery: true,
  reminderIntervalSeconds: 0, enabled: true,
};
const STATUS_LABELS = { healthy: 'Healthy', unhealthy: 'Unhealthy', offline: 'Offline', checking: 'Checking', unknown: 'Unknown' };

function formatDate(value) { return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Not checked yet'; }
function formatMs(value) { return value === null || value === undefined ? 'N/A' : `${value} ms`; }
function statusKind(status) { return status === 'offline' ? 'unhealthy' : status === 'checking' || status === 'unknown' ? 'unknown' : status; }

function AuthPage({ mode, onModeChange, onAuthenticated }) {
  const signupMode = mode === 'signup';
  const [form, setForm] = useState({ name: '', email: '', password: '', confirmPassword: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const passwordValidation = getPasswordValidation(form.password);
  const confirmationValid = form.password === form.confirmPassword;
  const submit = async (event) => {
    event.preventDefault(); setError('');
    if (signupMode && !form.name.trim()) return setError('Name is required.');
    if (!form.password) return setError('Password is required.');
    if (signupMode && !passwordValidation.valid) return setError('Password does not meet all requirements.');
    if (signupMode && !confirmationValid) return setError('Passwords do not match.');
    setLoading(true);
    try { const session = signupMode ? await signup(form) : await login(form); storeSession(session); onAuthenticated(session); }
    catch (error) { setError(error.message); } finally { setLoading(false); }
  };
  return <main className="auth-shell"><section className="auth-panel">
    <div className="brand-mark">pulse<span>/</span>watch</div><p className="eyebrow">API observability</p>
    <h1>{signupMode ? 'Build a calmer API stack.' : 'Welcome back.'}</h1><p className="auth-copy">Know what is healthy before your customers tell you otherwise.</p>
    <form className="auth-form" onSubmit={submit}>
      {signupMode && <label>Name<input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required /></label>}
      <label>Email<input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} required /></label>
      <label>Password<div className="password-input"><input type={showPassword ? 'text' : 'password'} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} minLength="8" required /><button className="password-toggle" type="button" onClick={() => setShowPassword(value => !value)}>{showPassword ? 'Hide' : 'Show'}</button></div></label>
      {signupMode && <div className="password-guidance" aria-live="polite"><p>Password requirements</p><ul>{getPasswordRequirements().map(({ key, label }) => <li className={passwordValidation.rules[key] ? 'requirement-met' : ''} key={key}>{passwordValidation.rules[key] ? '✓' : '○'} {label}</li>)}</ul><div className="password-strength">Strength: <strong>{passwordValidation.strength}</strong>{passwordValidation.valid && <span>All requirements met</span>}</div></div>}
      {signupMode && <label>Confirm password<div className="password-input"><input type={showConfirmation ? 'text' : 'password'} value={form.confirmPassword} onChange={e => setForm({ ...form, confirmPassword: e.target.value })} minLength="8" required /> <button className="password-toggle" type="button" onClick={() => setShowConfirmation(value => !value)}>{showConfirmation ? 'Hide' : 'Show'}</button></div>{form.confirmPassword && !confirmationValid && <span className="field-error">Passwords do not match.</span>}</label>}
      {error && <p className="form-error">{error}</p>}<button type="submit" disabled={loading}>{loading ? 'Connecting...' : signupMode ? 'Create account' : 'Sign in'}</button>
    </form><button className="link-button" type="button" onClick={() => onModeChange(signupMode ? 'login' : 'signup')}>{signupMode ? 'Already have an account? Sign in' : 'Create a new account'}</button>
  </section></main>;
}

function MonitorModal({ monitor, onClose, onSaved, token }) {
  const [form, setForm] = useState(monitor ? { ...EMPTY_FORM, ...monitor } : EMPTY_FORM);
  const [error, setError] = useState(''); const [saving, setSaving] = useState(false);
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const submit = async (event) => {
    event.preventDefault(); setError(''); setSaving(true);
    try {
      const payload = { ...form, intervalSeconds: Number(form.intervalSeconds), timeoutMs: Number(form.timeoutMs), reminderIntervalSeconds: Number(form.reminderIntervalSeconds) };
      const data = monitor ? await updateMonitor(token, monitor.id, payload) : await createMonitor(token, payload);
      onSaved(data.monitor); onClose();
    } catch (requestError) { setError(requestError.message); } finally { setSaving(false); }
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={e => e.target === e.currentTarget && onClose()}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="monitor-modal-title">
    <div className="modal-header"><div><p className="eyebrow">Monitor configuration</p><h2 id="monitor-modal-title">{monitor ? 'Edit API' : 'Add API'}</h2></div><button className="icon-button" type="button" onClick={onClose} aria-label="Close">×</button></div>
    <form className="modal-form" onSubmit={submit}>
      <div className="form-grid"><label>API name<input value={form.name} onChange={e => set('name', e.target.value)} placeholder="Payments API" required /></label><label>URL<input type="url" value={form.apiUrl} onChange={e => set('apiUrl', e.target.value)} placeholder="https://api.example.com/health" required /></label><label>Method<select value={form.httpMethod} onChange={e => set('httpMethod', e.target.value)}>{['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(method => <option key={method}>{method}</option>)}</select></label><label>Expected status<input value={form.expectedStatusCodes} onChange={e => set('expectedStatusCodes', e.target.value)} placeholder="2xx or 200,201" required /></label><label>Interval<select value={form.intervalSeconds} onChange={e => set('intervalSeconds', e.target.value)}><option value="30">Every 30 seconds</option><option value="60">Every minute</option><option value="300">Every 5 minutes</option><option value="900">Every 15 minutes</option></select></label><label>Timeout (ms)<input type="number" min="100" max="120000" value={form.timeoutMs} onChange={e => set('timeoutMs', e.target.value)} /></label></div>
      <label>Request headers <span className="field-hint">JSON object, optional</span><textarea value={form.requestHeaders} onChange={e => set('requestHeaders', e.target.value)} rows="3" placeholder={'{"Authorization":"Bearer ..."}'} /></label>
      <label>Request body <span className="field-hint">Used for POST, PUT, PATCH, or DELETE</span><textarea value={form.requestBody} onChange={e => set('requestBody', e.target.value)} rows="4" placeholder={'{"ping":true}'} /></label>
      <div className="modal-options"><label className="checkbox-label"><input type="checkbox" checked={form.notifyOnRecovery} onChange={e => set('notifyOnRecovery', e.target.checked)} /> Email me on recovery</label><label>Outage reminders<select value={form.reminderIntervalSeconds} onChange={e => set('reminderIntervalSeconds', e.target.value)}><option value="0">Off</option><option value="300">Every 5 minutes</option><option value="3600">Every hour</option></select></label></div>
      {error && <p className="form-error">{error}</p>}<div className="modal-actions"><button className="secondary-button" type="button" onClick={onClose}>Cancel</button><button type="submit" disabled={saving}>{saving ? 'Saving...' : monitor ? 'Save changes' : 'Add API'}</button></div>
    </form>
  </section></div>;
}

function MonitorCard({ monitor, onEdit, onDelete, onTest, onHistory, onToggle, testing, toggling }) {
  const kind = statusKind(monitor.currentStatus);
  return <article className={`monitor-card card-${kind}`}>
    <div className="card-top"><span className={`status-badge badge-${kind}`}><span className="status-symbol" aria-hidden="true">{kind === 'healthy' ? '✓' : kind === 'unhealthy' ? '!' : '•'}</span>{STATUS_LABELS[monitor.currentStatus] || 'Unknown'}</span><span className="method-tag">{monitor.httpMethod}</span></div>
    <h3>{monitor.name}</h3><p className="monitor-url" title={monitor.apiUrl}>{monitor.apiUrl}</p>
    <div className="card-metrics"><div><span>Status</span><strong>{monitor.lastHttpStatus || '—'}</strong></div><div><span>Response</span><strong>{formatMs(monitor.lastResponseTime)}</strong></div><div><span>Uptime</span><strong>{monitor.uptimePercent == null ? '—' : `${monitor.uptimePercent}%`}</strong></div></div>
    <p className="last-checked">Last checked {formatDate(monitor.lastCheckedAt)}</p>{monitor.lastError && <p className="card-error">{monitor.lastError}</p>}
    <div className="card-actions"><button type="button" onClick={() => onTest(monitor.id)} disabled={testing || toggling}>{testing ? 'Checking...' : 'Test now'}</button><button className="secondary-button" type="button" onClick={() => onHistory(monitor)}>History</button><button className="icon-button" type="button" onClick={() => onEdit(monitor)} aria-label={`Edit ${monitor.name}`}>⋯</button></div>
    <div className="card-footer"><span>{monitor.enabled ? '● Monitoring active' : '○ Paused'}</span><span className="card-footer-actions"><button className="text-button" type="button" onClick={() => onToggle(monitor)} disabled={toggling}>{toggling ? 'Updating...' : monitor.enabled ? 'Pause' : 'Resume'}</button><button className="text-danger" type="button" onClick={() => onDelete(monitor)}>Delete</button></span></div>
  </article>;
}

const ANALYTICS_RANGES = [
  ['1h', 'Last hour'],
  ['24h', 'Last 24 hours'],
  ['7d', 'Last 7 days'],
  ['30d', 'Last 30 days'],
];

function AnalyticsTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  return <div className="chart-tooltip"><strong>{formatDate(point.checkedAt)}</strong><span className={point.currentStatus === 'healthy' ? 'tooltip-good' : 'tooltip-bad'}>{point.currentStatus === 'healthy' ? 'Healthy' : 'Unhealthy'}</span><span>Response: {formatMs(point.responseTime)}</span><span>HTTP status: {point.httpStatus || '—'}</span>{point.failureReason && <span className="tooltip-error">{point.failureReason}</span>}</div>;
}

function AnalyticsCard({ item }) {
  const chartData = item.history.map((check) => ({ ...check, responseTimeValue: check.responseTime ?? 0 }));
  const status = statusKind(item.monitor.currentStatus);
  const dot = ({ cx, cy, payload }) => <circle cx={cx} cy={cy} r={payload.currentStatus === 'healthy' ? 3 : 5} fill={payload.currentStatus === 'healthy' ? '#43a66d' : '#dc6a67'} stroke="#fff" strokeWidth="2" />;
  return <article className={`analytics-card analytics-${status}`}><div className="analytics-card-header"><div><span className="eyebrow">{item.monitor.enabled ? 'Monitoring active' : 'Paused'}</span><h2>{item.monitor.name}</h2><p>{item.monitor.apiUrl}</p></div><span className={`status-badge badge-${status}`}>{item.monitor.currentStatus === 'healthy' ? 'Healthy' : item.monitor.currentStatus === 'unknown' ? 'Unknown' : 'Unhealthy'}</span></div><div className="analytics-summary"><div><span>Current status</span><strong>{item.monitor.currentStatus === 'healthy' ? 'Healthy' : item.monitor.currentStatus === 'unknown' ? 'Unknown' : 'Unhealthy'}</strong></div><div><span>Avg. response</span><strong>{formatMs(item.summary.averageResponseTime)}</strong></div><div><span>Uptime</span><strong>{item.summary.uptimePercent == null ? '—' : `${item.summary.uptimePercent}%`}</strong></div><div><span>Total checks</span><strong>{item.summary.totalChecks}</strong></div></div>{chartData.length ? <div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><LineChart data={chartData} margin={{ top: 12, right: 18, left: 0, bottom: 4 }}><CartesianGrid stroke="#e5ede8" vertical={false} /><XAxis dataKey="checkedAt" tickFormatter={value => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value))} minTickGap={28} stroke="#8b9b94" fontSize={11} /><YAxis unit=" ms" width={58} stroke="#8b9b94" fontSize={11} /><Tooltip content={<AnalyticsTooltip />} /><Line type="monotone" dataKey="responseTimeValue" name="Response time" stroke="#43a66d" strokeWidth={2.5} dot={dot} activeDot={{ r: 6 }} connectNulls /></LineChart></ResponsiveContainer></div> : <div className="analytics-empty"><span>⌁</span><strong>No checks in this time range</strong><p>Run a test or wait for the next scheduled check.</p></div>}</article>;
}

function AnalyticsPage({ session, onLogout, onNavigate }) {
  const [range, setRange] = useState('24h');
  const [analytics, setAnalytics] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const loadAnalytics = async () => { setLoading(true); setError(''); try { const data = await getMonitorAnalytics(session.token, range); setAnalytics(data.monitors); } catch (requestError) { if (/token|Authentication/i.test(requestError.message)) onLogout(); else setError(requestError.message); } finally { setLoading(false); } };
  useEffect(() => { loadAnalytics(); }, [range]);
  return <main className="app-shell"><div className="dashboard-layout"><aside className="sidebar"><div className="brand-mark">pulse<span>/</span>watch</div><nav><a href="#overview" onClick={event => { event.preventDefault(); onNavigate('overview'); }}><span>◈</span> Overview</a><a className="nav-active" href="#monitors" onClick={event => event.preventDefault()}><span>▦</span> Monitors</a></nav><div className="sidebar-bottom"><div className="user-chip"><span className="avatar">{session.user.name.slice(0, 1).toUpperCase()}</span><span><strong>{session.user.name}</strong><small>{session.user.email}</small></span></div><button className="sidebar-logout" type="button" onClick={() => { clearStoredSession(); onLogout(); }}>Sign out</button></div></aside><section className="main-content"><header className="dashboard-header analytics-header"><div><p className="eyebrow">Monitoring analytics</p><h1>API performance</h1><p className="header-copy">Response time and health history for every monitored endpoint.</p></div><button className="secondary-button" type="button" onClick={loadAnalytics} disabled={loading}>{loading ? 'Refreshing...' : '↻ Refresh'}</button></header><section className="analytics-toolbar"><div className="filter-group" role="group" aria-label="Analytics time range">{ANALYTICS_RANGES.map(([value, label]) => <button key={value} type="button" className={range === value ? 'filter-active' : ''} onClick={() => setRange(value)}>{label}</button>)}</div><span className="analytics-count">{analytics.length} API{analytics.length === 1 ? '' : 's'}</span></section>{error && <div className="analytics-error">Could not load analytics: {error}</div>}{loading ? <div className="analytics-grid">{[1, 2].map(item => <div className="skeleton-chart" key={item} />)}</div> : analytics.length ? <div className="analytics-grid">{analytics.map(item => <AnalyticsCard key={item.monitor.id} item={item} />)}</div> : <section className="empty-state"><div className="empty-icon">⌁</div><h2>No saved APIs yet</h2><p>Add an API from the Overview page to start collecting performance history.</p><button type="button" onClick={() => onNavigate('overview')}>Go to Overview</button></section>}</section></div></main>;
}

function Dashboard({ session, onLogout }) {
  const [view, setView] = useState(() => window.location.hash === '#monitors' ? 'analytics' : 'overview');
  const [monitors, setMonitors] = useState([]); const [modalMonitor, setModalMonitor] = useState(null); const [modalOpen, setModalOpen] = useState(false); const [history, setHistory] = useState(null); const [query, setQuery] = useState(''); const [filter, setFilter] = useState('all'); const [sort, setSort] = useState('status'); const [testing, setTesting] = useState([]); const [toggling, setToggling] = useState([]); const [toast, setToast] = useState(null); const [loading, setLoading] = useState(true);
  const navigate = nextView => { window.history.replaceState(null, '', nextView === 'analytics' ? '#monitors' : '#overview'); setView(nextView); };
  const notify = (message, type = 'success') => { setToast({ message, type }); window.setTimeout(() => setToast(null), 3500); };
  const load = async () => { try { const data = await getMonitors(session.token); setMonitors(data.monitors); } catch (error) { if (/token|Authentication/i.test(error.message)) onLogout(); else notify(error.message, 'error'); } finally { setLoading(false); } };
  useEffect(() => { load(); const id = window.setInterval(load, 10000); return () => window.clearInterval(id); }, []);
  const visible = useMemo(() => monitors.filter(m => (filter === 'all' || statusKind(m.currentStatus) === filter) && `${m.name} ${m.apiUrl}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'response' ? (a.lastResponseTime ?? Infinity) - (b.lastResponseTime ?? Infinity) : statusKind(a.currentStatus).localeCompare(statusKind(b.currentStatus))), [monitors, filter, query, sort]);
  const healthy = monitors.filter(m => m.currentStatus === 'healthy').length; const unhealthy = monitors.filter(m => ['unhealthy', 'offline'].includes(m.currentStatus)).length; const responseTimes = monitors.map(m => m.lastResponseTime).filter(Number.isFinite); const uptime = monitors.map(m => m.uptimePercent).filter(Number.isFinite);
  const updateMonitorList = monitor => setMonitors(current => current.some(item => item.id === monitor.id) ? current.map(item => item.id === monitor.id ? monitor : item) : [monitor, ...current]);
  const openHistory = async monitor => { try { const data = await getMonitorHistory(session.token, monitor.id); setHistory({ monitor, ...data }); } catch (error) { notify(`Could not load test logs: ${error.message}`, 'error'); } };
  const runTest = async id => { if (testing.includes(id)) return; setTesting(current => [...current, id]); try { const data = await testMonitor(session.token, id); updateMonitorList(data.monitor); const latestHistory = await getMonitorHistory(session.token, id); setHistory({ monitor: data.monitor, ...latestHistory }); notify('Health check completed.'); } catch (error) { notify(`Test failed: ${error.message}`, 'error'); } finally { setTesting(current => current.filter(item => item !== id)); } };
  const runAll = async () => { if (testing.length) return; setTesting(monitors.map(m => m.id)); try { const data = await testAllMonitors(session.token); setMonitors(data.monitors); notify(`Checked ${data.monitors.length} APIs.`); } catch (error) { notify(error.message, 'error'); } finally { setTesting([]); } };
  const toggleMonitor = async monitor => { if (toggling.includes(monitor.id)) return; setToggling(current => [...current, monitor.id]); try { const data = monitor.enabled ? await stopMonitor(session.token, monitor.id) : await startMonitor(session.token, monitor.id); updateMonitorList(data.monitor); notify(monitor.enabled ? `${monitor.name} paused.` : `${monitor.name} resumed.`); } catch (error) { notify(`Could not update monitoring: ${error.message}`, 'error'); } finally { setToggling(current => current.filter(item => item !== monitor.id)); } };
  const remove = async monitor => { if (!window.confirm(`Delete ${monitor.name}? This removes its history and alerts.`)) return; try { await deleteMonitor(session.token, monitor.id); setMonitors(current => current.filter(item => item.id !== monitor.id)); notify('API deleted.'); } catch (error) { notify(error.message, 'error'); } };
  const refreshHistory = async () => { if (!history) return; await openHistory(history.monitor); };
  const logout = () => { clearStoredSession(); onLogout(); };
  if (view === 'analytics') return <AnalyticsPage session={session} onLogout={onLogout} onNavigate={navigate} />;
  return <main className="app-shell"><div className="dashboard-layout"><aside className="sidebar"><div className="brand-mark">pulse<span>/</span>watch</div><nav><a className="nav-active" href="#overview" onClick={event => { event.preventDefault(); navigate('overview'); }}><span>◈</span> Overview</a><a href="#monitors" onClick={event => { event.preventDefault(); navigate('analytics'); }}><span>▦</span> Monitors</a></nav><div className="sidebar-bottom"><div className="user-chip"><span className="avatar">{session.user.name.slice(0, 1).toUpperCase()}</span><span><strong>{session.user.name}</strong><small>{session.user.email}</small></span></div><button className="sidebar-logout" type="button" onClick={logout}>Sign out</button></div></aside>
    <section className="main-content"><header className="dashboard-header"><div><p className="eyebrow">Monday, October 19, 2026</p><h1>Good morning, {session.user.name.split(' ')[0]}.</h1><p className="header-copy">Here is the pulse of your APIs.</p></div><div className="header-actions"><button className="secondary-button" type="button" onClick={runAll} disabled={!monitors.length || testing.length > 0}>{testing.length ? 'Checking...' : '↻ Test all'}</button><button type="button" onClick={() => { setModalMonitor(null); setModalOpen(true); }}>+ Add API</button></div></header>
      <section className="stats-grid"><div className="stat-card"><span>Total APIs</span><strong>{monitors.length}</strong><small>Configured monitors</small></div><div className="stat-card stat-healthy"><span>Healthy</span><strong>{healthy}</strong><small>{monitors.length ? Math.round(healthy / monitors.length * 100) : 0}% of your APIs</small></div><div className="stat-card stat-unhealthy"><span>Needs attention</span><strong>{unhealthy}</strong><small>{unhealthy ? 'Review incidents' : 'All systems clear'}</small></div><div className="stat-card stat-amber"><span>Avg. response</span><strong>{responseTimes.length ? `${Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length)} ms` : '—'}</strong><small>Across latest checks</small></div><div className="stat-card stat-purple"><span>Overall uptime</span><strong>{uptime.length ? `${(uptime.reduce((a, b) => a + b, 0) / uptime.length).toFixed(2)}%` : '—'}</strong><small>Historical average</small></div></section>
      <section className="toolbar" id="monitors"><div className="search-wrap"><span aria-hidden="true">⌕</span><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search APIs..." aria-label="Search APIs" /></div><div className="filter-group" role="group" aria-label="Filter APIs">{['all', 'healthy', 'unhealthy'].map(value => <button key={value} className={filter === value ? 'filter-active' : ''} type="button" onClick={() => setFilter(value)}>{value[0].toUpperCase() + value.slice(1)} {value === 'all' ? monitors.length : value === 'healthy' ? healthy : unhealthy}</button>)}</div><select className="sort-select" value={sort} onChange={e => setSort(e.target.value)} aria-label="Sort APIs"><option value="status">Sort: Status</option><option value="name">Sort: Name</option><option value="response">Sort: Response time</option></select></section>
      {loading ? <div className="monitor-grid">{[1, 2, 3].map(item => <div className="skeleton-card" key={item} />)}</div> : visible.length ? <div className="monitor-grid">{visible.map(monitor => <MonitorCard key={monitor.id} monitor={monitor} onEdit={monitor => { setModalMonitor(monitor); setModalOpen(true); }} onDelete={remove} onTest={runTest} onHistory={openHistory} onToggle={toggleMonitor} testing={testing.includes(monitor.id)} toggling={toggling.includes(monitor.id)} />)}</div> : <section className="empty-state"><div className="empty-icon">+</div><h2>{monitors.length ? 'No APIs match your filters' : 'Your API pulse starts here'}</h2><p>{monitors.length ? 'Try another search or status filter.' : 'Add an endpoint and we will keep watch while you focus on the work.'}</p>{!monitors.length && <button type="button" onClick={() => setModalOpen(true)}>Add your first API</button>}</section>}
    </section></div>{toast && <div className={`toast toast-${toast.type}`} role="status">{toast.message}</div>}{modalOpen && <MonitorModal token={session.token} monitor={modalMonitor} onClose={() => setModalOpen(false)} onSaved={monitor => { updateMonitorList(monitor); notify(modalMonitor ? 'API updated.' : 'API added.'); }} />}{history && <div className="modal-backdrop" role="presentation" onMouseDown={e => e.target === e.currentTarget && setHistory(null)}><section className="modal history-modal"><div className="modal-header"><div><p className="eyebrow">Test logs</p><h2>{history.monitor.name}</h2><p className="history-url">{history.monitor.apiUrl}</p></div><button className="icon-button" type="button" onClick={() => setHistory(null)} aria-label="Close test logs">×</button></div>{history.history[0] && <section className={`latest-test latest-${statusKind(history.history[0].currentStatus)}`} aria-label="Latest test result"><div className="latest-test-heading"><div><span className="eyebrow">Latest result</span><strong>{history.history[0].currentStatus === 'healthy' ? 'Healthy' : 'Unhealthy'}</strong></div><span className={`status-badge badge-${statusKind(history.history[0].currentStatus)}`}>{history.history[0].currentStatus === 'healthy' ? 'Passed' : 'Failed'}</span></div><div className="latest-test-metrics"><span><b>HTTP status</b>{history.history[0].httpStatus || '—'}</span><span><b>Response time</b>{formatMs(history.history[0].responseTime)}</span><span><b>Tested</b>{formatDate(history.history[0].checkedAt)}</span></div><p className="latest-test-error"><b>{history.history[0].failureReason ? 'Error details' : 'Details'}</b> {history.history[0].failureReason || 'The API returned the expected status.'}</p></section>}<div className="history-toolbar"><p className="history-summary">{history.uptimePercent == null ? 'No uptime recorded yet' : `${history.uptimePercent}% uptime`} · {history.history.length} checks shown</p><div className="history-actions"><button className="secondary-button" type="button" onClick={refreshHistory}>↻ Refresh</button><button type="button" onClick={() => runTest(history.monitor.id)} disabled={testing.includes(history.monitor.id)}>{testing.includes(history.monitor.id) ? 'Testing...' : '↻ Test again'}</button></div></div><div className="history-list">{history.history.length ? history.history.map(check => <div className="history-row" key={check.id}><strong>{check.currentStatus === 'healthy' ? 'Healthy' : 'Unhealthy'}</strong><span>{check.httpStatus || '—'} · {formatMs(check.responseTime)}</span><span>{formatDate(check.checkedAt)}</span><span>{check.failureReason || 'Passed expected status'}</span></div>) : <p>No checks recorded yet.</p>}</div></section></div>}</main>;
}

export default function App() {
  const [session, setSession] = useState(() => getStoredSession()); const [mode, setMode] = useState('login');
  return session ? <Dashboard session={session} onLogout={() => setSession(null)} /> : <AuthPage mode={mode} onModeChange={setMode} onAuthenticated={setSession} />;
}

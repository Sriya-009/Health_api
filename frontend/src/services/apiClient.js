const TOKEN_STORAGE_KEY = 'api-monitor-token';
const USER_STORAGE_KEY = 'api-monitor-user';
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

export function getStoredSession() {
  const token = window.localStorage.getItem(TOKEN_STORAGE_KEY);
  const userJson = window.localStorage.getItem(USER_STORAGE_KEY);

  if (!token || !userJson) return null;

  try {
    return {
      token,
      user: JSON.parse(userJson),
    };
  } catch {
    clearStoredSession();
    return null;
  }
}

export function storeSession(session) {
  window.localStorage.setItem(TOKEN_STORAGE_KEY, session.token);
  window.localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(session.user));
}

export function clearStoredSession() {
  window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  window.localStorage.removeItem(USER_STORAGE_KEY);
}

async function request(path, { token, ...options } = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });

  if (response.status === 204) return null;

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || 'Request failed.');
  }

  return data;
}

export function signup(payload) {
  return request('/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function login(payload) {
  return request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function getMonitors(token) {
  return request('/api/monitors', { token });
}

export function getMonitorAnalytics(token, range) {
  return request(`/api/monitors/analytics?range=${encodeURIComponent(range)}`, { token });
}

export function createMonitor(token, payload) {
  return request('/api/monitors', {
    token,
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function updateMonitor(token, id, payload) {
  return request(`/api/monitors/${id}`, {
    token,
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export function deleteMonitor(token, id) {
  return request(`/api/monitors/${id}`, {
    token,
    method: 'DELETE',
  });
}

export function startMonitor(token, id) {
  return request(`/api/monitors/${id}/start`, {
    token,
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function stopMonitor(token, id) {
  return request(`/api/monitors/${id}/stop`, {
    token,
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function testMonitor(token, id) {
  return request(`/api/monitors/${id}/test`, {
    token,
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function testAllMonitors(token) {
  return request('/api/monitors/test-all', {
    token,
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function getMonitorHistory(token, id) {
  return request(`/api/monitors/${id}/history`, { token });
}

export function getMonitorNotifications(token, id) {
  return request(`/api/monitors/${id}/notifications`, { token });
}

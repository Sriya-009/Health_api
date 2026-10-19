import dns from 'node:dns/promises';
import net from 'node:net';

const DEFAULT_REQUEST_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [first, second] = address.split('.').map(Number);
    return first === 10 || first === 127 || first === 0 || (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
  }
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:');
  }
  return false;
}

export async function validateMonitorTarget(value, { allowPrivateNetwork = false } = {}) {
  if (!isValidHttpUrl(value)) return { valid: false, error: 'Enter a valid HTTP or HTTPS API URL.' };
  const url = new URL(value);
  if (url.username || url.password) return { valid: false, error: 'API URLs cannot contain embedded credentials.' };
  if (allowPrivateNetwork || process.env.ALLOW_PRIVATE_MONITOR_TARGETS === 'true') return { valid: true };
  try {
    const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
    if (addresses.some(({ address }) => isPrivateAddress(address))) {
      return { valid: false, error: 'Private, localhost, and cloud metadata destinations are not allowed.' };
    }
  } catch {
    return { valid: false, error: 'The API hostname could not be resolved.' };
  }
  return { valid: true };
}

export function isValidHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function parseExpectedStatusCodes(value) {
  const expected = new Set();

  for (const part of String(value || '2xx').toLowerCase().split(',')) {
    const item = part.trim();
    if (/^[2345]xx$/.test(item)) {
      const family = Number(item[0]);
      for (let status = family * 100; status < family * 100 + 100; status += 1) {
        expected.add(status);
      }
    } else if (/^\d{3}$/.test(item)) {
      expected.add(Number(item));
    }
  }

  return expected.size > 0
    ? expected
    : new Set(Array.from({ length: 100 }, (_, index) => index + 200));
}

function normalizeHttpResponse(response, responseTimeMs, checkedAt, expectedStatusCodes) {
  const healthy = expectedStatusCodes.has(response.status);

  return {
    currentStatus: healthy ? 'healthy' : 'unhealthy',
    lastHttpStatus: response.status,
    lastResponseTime: responseTimeMs,
    lastError: healthy ? null : `API responded with HTTP ${response.status}.`,
    lastCheckedAt: checkedAt,
  };
}

function normalizeRequestError(error, responseTimeMs, checkedAt, timeoutMs) {
  const message =
    error?.name === 'AbortError'
      ? `Request timed out after ${Math.round(timeoutMs / 1000)} seconds.`
      : error?.message || 'Unable to reach the API.';

  return {
    currentStatus: 'offline',
    lastHttpStatus: null,
    lastResponseTime: responseTimeMs,
    lastError: message,
    lastCheckedAt: checkedAt,
  };
}

export async function checkApiHealth(apiUrl, options = {}) {
  const checkedAt = new Date().toISOString();
  const timeoutMs = Math.max(
    100,
    Number(options.timeoutMs || process.env.API_REQUEST_TIMEOUT_MS || DEFAULT_REQUEST_TIMEOUT_MS),
  );
  const method = String(options.httpMethod || 'GET').toUpperCase();
  const expectedStatusCodes = parseExpectedStatusCodes(options.expectedStatusCodes);

  const target = await validateMonitorTarget(apiUrl, options);
  if (!target.valid) {
    return {
      currentStatus: 'offline',
      lastHttpStatus: null,
      lastResponseTime: null,
      lastError: target.error,
      lastCheckedAt: checkedAt,
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();

  try {
    const requestHeaders = options.requestHeaders && typeof options.requestHeaders === 'object' ? options.requestHeaders : {};
    const response = await fetch(apiUrl, {
      method,
      headers: requestHeaders,
      body: ['GET', 'HEAD'].includes(method) ? undefined : options.requestBody || undefined,
      cache: 'no-store',
      redirect: 'manual',
      signal: controller.signal,
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      const redirectTarget = await validateMonitorTarget(location ? new URL(location, apiUrl).toString() : '', options);
      if (!redirectTarget.valid) return { currentStatus: 'offline', lastHttpStatus: response.status, lastResponseTime: Math.round(performance.now() - startedAt), lastError: redirectTarget.error, lastCheckedAt: checkedAt };
    }
    if (Number(response.headers.get('content-length') || 0) > MAX_RESPONSE_BYTES) {
      return { currentStatus: 'unhealthy', lastHttpStatus: response.status, lastResponseTime: Math.round(performance.now() - startedAt), lastError: 'Response exceeded the 1 MB limit.', lastCheckedAt: checkedAt };
    }
    const responseTimeMs = Math.round(performance.now() - startedAt);

    return normalizeHttpResponse(response, responseTimeMs, checkedAt, expectedStatusCodes);
  } catch (error) {
    const responseTimeMs = Math.round(performance.now() - startedAt);
    return normalizeRequestError(error, responseTimeMs, checkedAt, timeoutMs);
  } finally {
    clearTimeout(timeoutId);
  }
}

export function stateBucket(status) {
  if (status === 'healthy') return 'healthy';
  if (status === 'unhealthy' || status === 'offline') return 'down';
  return 'unknown';
}

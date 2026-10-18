const DEFAULT_REQUEST_TIMEOUT_MS = 8000;

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

  if (!isValidHttpUrl(apiUrl)) {
    return {
      currentStatus: 'offline',
      lastHttpStatus: null,
      lastResponseTime: null,
      lastError: 'Monitor URL must start with http:// or https://.',
      lastCheckedAt: checkedAt,
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();

  try {
    const response = await fetch(apiUrl, {
      method,
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
    });
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

import nodemailer from 'nodemailer';

let transporter;

function getProvider() {
  return (process.env.EMAIL_PROVIDER || 'console').toLowerCase();
}

function getSenderAddress() {
  return process.env.EMAIL_FROM || process.env.ALERT_FROM_EMAIL;
}

function getRecipientLabel(value) {
  const email = String(value || '');
  const at = email.indexOf('@');
  return at > 1 ? `${email[0]}***${email.slice(at)}` : 'unknown';
}

export function getEmailConfigSummary() {
  const provider = getProvider();
  return {
    provider,
    hasSender: Boolean(getSenderAddress()),
    hasResendKey: Boolean(process.env.RESEND_API_KEY),
    hasSmtpHost: Boolean(process.env.SMTP_HOST),
    hasSmtpUser: Boolean(process.env.SMTP_USER),
    hasSmtpPass: Boolean(process.env.SMTP_PASS),
  };
}

export function validateEmailConfig() {
  const provider = getProvider();

  if (provider === 'console') return;
  if (provider === 'resend') {
    const missing = ['RESEND_API_KEY'].filter((key) => !process.env[key]);
    if (!getSenderAddress()) missing.push('EMAIL_FROM or ALERT_FROM_EMAIL');
    if (missing.length > 0) {
      throw new Error(`Resend configuration is missing: ${missing.join(', ')}.`);
    }
    return;
  }
  if (provider !== 'smtp') {
    throw new Error('EMAIL_PROVIDER must be either console, resend, or smtp.');
  }

  const required = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'];
  const missing = required.filter((key) => !process.env[key]);
  if (!getSenderAddress()) missing.push('EMAIL_FROM or ALERT_FROM_EMAIL');
  const port = Number(process.env.SMTP_PORT || 587);

  if (missing.length > 0) {
    throw new Error(`SMTP configuration is missing: ${missing.join(', ')}.`);
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SMTP_PORT must be a valid TCP port.');
  }
}

function getTransporter() {
  if (transporter) return transporter;

  const provider = getProvider();

  if (provider === 'smtp') {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || 'false') === 'true',
      auth:
        process.env.SMTP_USER && process.env.SMTP_PASS
          ? {
              user: process.env.SMTP_USER,
              pass: process.env.SMTP_PASS,
            }
          : undefined,
    });
    return transporter;
  }

  transporter = nodemailer.createTransport({ jsonTransport: true });
  return transporter;
}

function formatValue(value, fallback = 'N/A') {
  if (value === null || value === undefined || value === '') return fallback;
  return value;
}

function buildFailureEmail({ monitor, result, to }) {
  const subject = `API DOWN: ${monitor.name}`;
  const lines = [
    `API name: ${monitor.name}`,
    `API URL: ${monitor.apiUrl}`,
    `Method: ${monitor.httpMethod}`,
    'Status: DOWN/UNHEALTHY',
    `HTTP status: ${formatValue(result.lastHttpStatus)}`,
    `Error message: ${formatValue(result.lastError)}`,
    `Response time: ${formatValue(result.lastResponseTime)} ms`,
    `Time of failure: ${result.lastCheckedAt}`,
  ];

  return {
    to,
    from: getSenderAddress(),
    subject,
    text: lines.join('\n'),
  };
}

function buildRecoveryEmail({ monitor, result, to }) {
  const subject = `API RECOVERED: ${monitor.name}`;
  const lines = [
    `API name: ${monitor.name}`,
    `API URL: ${monitor.apiUrl}`,
    `Method: ${monitor.httpMethod}`,
    'Status: RECOVERED',
    `HTTP status: ${formatValue(result.lastHttpStatus)}`,
    `Response time: ${formatValue(result.lastResponseTime)} ms`,
    `Recovery time: ${result.lastCheckedAt}`,
  ];

  return {
    to,
    from: getSenderAddress(),
    subject,
    text: lines.join('\n'),
  };
}

export async function sendMonitorAlert({ type, monitor, result, userEmail }) {
  validateEmailConfig();
  const message =
    type === 'recovery'
      ? buildRecoveryEmail({ monitor, result, to: userEmail })
      : buildFailureEmail({ monitor, result, to: userEmail });

  const provider = getProvider();
  console.info(
    `[email] alert attempt monitor=${monitor.id} type=${type} provider=${provider} recipient=${getRecipientLabel(userEmail)}`,
  );
  const info =
    provider === 'resend' ? await sendWithResend(message) : await getTransporter().sendMail(message);

  const accepted =
    provider === 'console'
      ? Boolean(info.messageId)
      : provider === 'resend'
        ? Boolean(info.messageId)
        : Array.isArray(info.accepted) && info.accepted.includes(userEmail);

  if (!accepted) {
    throw new Error('Email provider did not accept the notification.');
  }

  if (provider === 'console') {
    console.log('Email alert preview');
    console.log(info.message);
  }

  return { ...info, deliveryStatus: provider === 'console' ? 'preview' : 'sent' };
}

async function sendWithResend(message) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: message.from,
      to: [message.to],
      subject: message.subject,
      text: message.text,
    }),
  });

  if (!response.ok) {
    throw new Error(`Resend rejected the email with HTTP ${response.status}.`);
  }

  const data = await response.json().catch(() => ({}));
  if (!data.id) throw new Error('Resend did not return an email ID.');

  return { messageId: data.id };
}

# API Health Monitoring

A React/Vite dashboard backed by an Express server, SQLite, and a server-side monitoring worker. Enabled monitors continue checking while the browser is closed because the worker runs in the backend process.

## Setup

1. Install dependencies:

   ```powershell
   npm install
   ```

2. Copy `.env.example` to `.env` and set a long local `JWT_SECRET`. Keep `.env` private and never commit it.

3. Initialize the database without deleting existing data:

   ```powershell
   npm run db:init
   ```

## Run

Open two VS Code terminals in the project root.

Backend:

```powershell
npm run server
```

Frontend:

```powershell
npm run dev
```

Open `http://localhost:5173`.

The backend resumes enabled monitors on startup. Stop the backend with Ctrl+C only after checks are complete.

## Email alerts

Development uses `EMAIL_PROVIDER=console`, which records notification history and prints a Nodemailer JSON preview without contacting a provider.

For Resend, set `EMAIL_PROVIDER=resend`, set `RESEND_API_KEY` in the backend-only `.env`, and set `EMAIL_FROM` to a sender/domain verified in Resend. The server sends `POST https://api.resend.com/emails` directly from Node using the key; the key is never included in Vite variables or API responses. `ALERT_TO_EMAIL` is not used for monitor notifications because each alert must go to the owning user's account email.

Resend setup:

1. Verify a sending domain or sender in the Resend dashboard.
2. Create a Resend API key and put it only in the root `.env` as `RESEND_API_KEY`.
3. Set `EMAIL_PROVIDER=resend` and `EMAIL_FROM` to the verified sender.
4. Restart `npm run server`.

The backend validates these settings at startup. It records an alert as sent only when Resend returns a successful response containing an email ID. Without a real key and verified sender, use console mode; real delivery has not been tested by this project setup.

For real delivery, set `EMAIL_PROVIDER=smtp` and configure these variables in `.env`:

- `SMTP_HOST`: your provider's SMTP hostname
- `SMTP_PORT`: commonly `587` for STARTTLS or `465` for implicit TLS
- `SMTP_SECURE`: `false` for STARTTLS on 587, `true` for 465
- `SMTP_USER`: the provider account or mailbox
- `SMTP_PASS`: an app password or provider-specific SMTP credential, never a normal account password when the provider supports app passwords
- `EMAIL_FROM`: a verified sender address

The server refuses to start in SMTP mode if required settings are missing. It does not log credential values. An alert is recorded as sent only after Nodemailer reports the recipient as accepted.

## Checks

```powershell
npm run db:init
npm run build
npm test
```

The test suite uses local HTTP servers and a temporary SQLite database. It does not call or overload external APIs.

## API verification

```powershell
Invoke-RestMethod http://localhost:5000/api/health
```

Expected response:

```json
{"ok":true}
```

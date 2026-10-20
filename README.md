# API Health Monitoring

A React/Vite dashboard backed by an Express server, SQLite, JWT authentication, and a server-side monitoring worker. Enabled monitors continue checking while the browser is closed because the worker runs in the backend process.

## Project structure

- `frontend/`: React/Vite dashboard and browser-safe configuration.
- `backend/`: Express API, monitoring worker, email delivery, SQLite initialization, and backend-only secrets.
- `backend/server/data/monitoring.sqlite`: existing SQLite database. It is preserved and is not recreated by this reorganization.

## Local setup

### Backend

```powershell
cd backend
npm install
Copy-Item .env.example .env
```

Edit `backend/.env` and set a long, private `JWT_SECRET`. The default `DATABASE_PATH=server/data/monitoring.sqlite` keeps the existing database under `backend/server/data/`. You can use an absolute path for a separately managed database. Initialize safely with:

```powershell
npm run db:init
npm run server
```

The API listens on `http://localhost:5000` by default and resumes enabled monitors at startup.

### Frontend

```powershell
cd frontend
npm install
Copy-Item .env.example .env
npm run dev
```

The dashboard runs at `http://localhost:5173`. `VITE_API_BASE_URL` is the only frontend variable and is exposed to browser code, so it must never contain secrets. Set it to `http://localhost:5000` for local direct API requests or to the deployed backend URL. The Vite proxy remains configured for `/api` local development when the variable is left empty.

## Email alerts

Keep all email credentials in `backend/.env`. `EMAIL_PROVIDER=console` is safe for development and records notification history while printing a Nodemailer preview. For Resend, set `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, and a verified `EMAIL_FROM`. For SMTP, set `EMAIL_PROVIDER=smtp` plus `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, and `EMAIL_FROM`. The backend validates provider settings at startup and never exposes credentials to the frontend.

## Deployment

Deploy `frontend/` as a Vite static site on Vercel, Netlify, or similar:

1. Use `frontend` as the project root.
2. Run `npm install` and `npm run build`.
3. Publish `dist`.
4. Set `VITE_API_BASE_URL` to the public backend URL at build time.

Deploy `backend/` to a Node host such as Render:

1. Use `backend` as the service root.
2. Run `npm install`; start with `npm run server`.
3. Set `PORT`, `FRONTEND_ORIGIN` to the exact frontend origin, `JWT_SECRET`, and `DATABASE_PATH` as platform variables.
4. Configure email variables if real alerts are required.
5. Use persistent storage for the SQLite file. Ephemeral hosting disks will lose monitoring history on restart.

`FRONTEND_ORIGIN` accepts a comma-separated list of allowed frontend origins. CORS is configured by the backend and credentials remain server-side.

## Verification

```powershell
cd backend
npm test
npm run db:init

cd ..\frontend
npm run build
```

With the backend running, verify:

```powershell
Invoke-RestMethod http://localhost:5000/api/health
```

Expected response:

```json
{"ok":true}
```

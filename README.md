# Resort Games

Resort Games is a standalone Node.js platform for hosting resort activities. It includes guest, host, and projection-display screens, with WebSocket connections and event snapshots stored locally during development or in a dedicated PostgreSQL database in production. See the manual for setup and operations.

This project is independent of RGP: it has its own GitHub source, Render web service, and Render PostgreSQL database. It does not require Vercel or an RGP backend.

## Requirements

- Node.js 22 or newer and npm.
- A host password with at least 12 characters.
- A session secret with at least 32 characters.
- PostgreSQL and a `DATABASE_URL` for production.

The package is named `resort-games`. First create `.env` from `.env.example` and set the two required private values, then:

```sh
npm install
npm start
npm test
```

For local development, create `.env` from `.env.example`. Leave `DATABASE_URL` commented out to use the development snapshot in `.data/game.json`; uncomment it only if you intentionally use local PostgreSQL. Do not commit `.env` or `.data`.

## Production

The recommended production setup is the Render Blueprint in `render.yaml`: one Node web service and one dedicated PostgreSQL database. It provisions the service from this GitHub repository and uses Render's private database connection. See [docs/GAMES_MANUAL.md](docs/GAMES_MANUAL.md) for the complete setup, event operation, recovery, and maintenance instructions.

Run exactly one web-service instance with autoscaling disabled. The snapshot backend is not designed for multiple live instances. Automatic deploys are disabled in the Blueprint; deploy manually outside event hours.

No cloud resources have been created by this repository change. You do not need to purchase a domain: Render provides an HTTPS URL. A custom domain is optional.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `HOST_PASSWORD` | Required host authentication password (12+ characters). |
| `SESSION_SECRET` | Required session-signing secret (32+ characters). |
| `PORT` | HTTP port; defaults to `3000`. |
| `NODE_ENV` | Set to `production` on the deployed service. |
| `DATABASE_URL` | Required in production; PostgreSQL connection string. |
| `DATABASE_SSL` | `true` uses `pg` TLS with certificate validation; use `false` for Render's private internal database connection. |
| `DATA_FILE` | Development snapshot path; defaults to `.data/game.json`. |
| `PUBLIC_BASE_URL` | Optional absolute HTTPS canonical URL for QR generation. If unset, the request host is used. |

Never put production credentials in `.env.example`, source control, or public event materials.

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

## Local screens

After starting the service, use `/host` for private event controls, `/` for the guest joining and play screen, and `/display` for the sanitized projection screen. Sign in with the local `HOST_PASSWORD`, open a standalone or Variety Show event, then choose Big Draw (Pictionary), Family Cards, or Get The Picture. Guest devices should open the same service address; localhost is only reachable on the computer running it.

Family Cards gives each phone ten private answer cards. The first five submissions become anonymous finalists for a 30-second audience vote, with no self-voting. Positive-vote answers earn 5/4/3/2/1 points by rank, ties included; points also accumulate across Variety Show games. The host decides whether the supplied deck's humor suits the audience. See the manual's Family Cards section for operation, card maintenance and usage-permission considerations.

Get The Picture supports 2-100 players in small-room, host-reviewed large-audience, and rotating-judge poolside formats. An image appears on phones and the Main Display, followed by 30 seconds to caption and 30 seconds to vote. The game includes six original starter illustrations; optional host uploads use a dedicated private Cloudflare R2 bucket. Captions are filtered server-side, with additional host blocking and removal controls. Automated filtering cannot guarantee suitability; use large-audience mode for human review before display. See the manual for game rules, moderation maintenance, and complete R2/Render setup.

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
| `R2_ACCOUNT_ID` | Optional Cloudflare account ID; set all four R2 values to enable uploads. |
| `R2_BUCKET_NAME` | Dedicated private games image bucket, using Standard storage. |
| `R2_ACCESS_KEY_ID` | Bucket-scoped R2 S3 access key ID, stored only in the environment. |
| `R2_SECRET_ACCESS_KEY` | Corresponding private R2 S3 secret access key. |

Never put production credentials in `.env.example`, source control, or public event materials.

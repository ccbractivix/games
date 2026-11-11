# Resort Games: setup and operations manual

This manual covers the standalone Resort Games service. It is not part of RGP and does not use RGP's backend, database, or hosting. The GitHub repository is the source of truth; Render runs the Node web service and its dedicated PostgreSQL database. Vercel is not used or required.

## What runs where

- **Render web service:** Serves the guest application, `/host`, `/display`, WebSocket connections, and the QR endpoint (`GET /api/qr`).
- **Render PostgreSQL:** Stores the current event snapshot as one JSONB row. The application creates its schema automatically.
- **GitHub:** Holds the source and `render.yaml` deployment blueprint.
- **Local development:** Uses a JSON snapshot file instead of PostgreSQL by default.

The package is `resort-games` and requires Node.js 22 or newer. The deployed service listens on Render's `PORT` (default `3000` locally), and exposes `/health` for health checks.

The snapshot backend supports one live web-service instance only. The Blueprint sets `numInstances: 1`; do not enable autoscaling or add instances in Render. Multiple instances can conflict over the shared event snapshot.

## Local setup

1. Install Node.js 22+ and npm.
2. Clone this games repository and enter its root directory.
3. Copy `.env.example` to `.env`.
4. Set the blank `HOST_PASSWORD` to a private password of at least 12 characters. Set `SESSION_SECRET` to a private value of at least 32 characters. The application refuses to start without these values. To generate a suitable session secret, run:

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

5. Install dependencies and start the application:

   ```sh
   npm install
   npm start
   ```

6. Open `http://localhost:3000`. Run the test suite with `npm test`.

Local development persists snapshots in `.data/game.json` unless `DATA_FILE` is set. `.env` and `.data/` are ignored by Git. Do not copy production secrets into a local file that may be shared.

## Production setup on Render

The repository includes a Render Blueprint, `render.yaml`. It defines a Node web service named `resort-games` in Oregon on Render's `starter` service plan and a separate PostgreSQL database named `resort-games-db` in Oregon on `basic-256mb`. The Blueprint connects them with Render's internal connection string. Check Render's current resource options and billing in your account before provisioning; this manual does not quote prices. Render bills provisioned resources according to the plan and billing cycle shown in its dashboard.

### Connect GitHub and provision the Blueprint

1. Push the intended production branch and the Blueprint to the GitHub repository. Ensure the application package manifest and lockfile are on that branch: the configured build command is `npm ci`, and the start command is `npm start`. The Blueprint disables automatic deploys, so a Git push alone does not deploy or restart the service.
2. Sign in to Render and authorize access to the GitHub account or organization that owns the repository.
3. In the Render dashboard, choose **New +** → **Blueprint**.
4. Select the Resort Games GitHub repository and the branch to deploy. Confirm the Blueprint file is `render.yaml` at the repository root.
5. Review the resources before applying: one web service (`resort-games`) and one PostgreSQL database (`resort-games-db`), both in Oregon. Confirm the region and plans shown in the dashboard. The database is dedicated to this games deployment; do not point it at an RGP database.
6. Provide the requested `HOST_PASSWORD` value (12 or more characters) when prompted. If the Blueprint flow does not prompt for it, finish creating the service without starting a deploy, then open the `resort-games` service's **Environment** page and add `HOST_PASSWORD` there.
7. For `SESSION_SECRET`, let Render generate the value from `generateValue: true` in the Blueprint. If the dashboard requires a value instead, generate a fresh one using the Node command in the Local setup section and enter it as a secret environment variable. Do not use the example value or reuse a publicly known secret.
8. Apply/create the Blueprint. In the service's **Environment** page, confirm `NODE_ENV=production`, `DATABASE_SSL=false`, the generated `SESSION_SECRET`, and `HOST_PASSWORD` are present. Confirm `DATABASE_URL` is sourced from `resort-games-db` using its `connectionString` property. In service **Settings**, confirm there is exactly one instance, autoscaling is off, and automatic deploy is disabled. Do not paste the database URL into GitHub or a public document.
9. Save any environment changes and deploy the latest commit from the service's **Manual Deploy** menu if Render has not deployed it automatically.
10. Wait for the build and deploy to finish. Open the service's **Logs** if it fails; resolve missing package files, invalid credentials, or database connectivity before directing guests to it.
11. In the service **Settings**, copy the assigned `onrender.com` URL and open it over HTTPS. Check `/health`, then open `/host` and `/display` to confirm the service is responding. Set `PUBLIC_BASE_URL` as described below if you want QR codes to use a canonical URL.

The Blueprint uses `npm ci`, so a committed npm lockfile is required. It sets `autoDeployTrigger: "off"` to prevent a source push from restarting a live event. Do not claim a production deployment until the service is healthy and the game has been smoke-tested. Creating this repository configuration does not itself create cloud resources.

### Environment configuration

The Blueprint sets:

| Key | Render value / action |
| --- | --- |
| `NODE_ENV` | `production`. |
| `DATABASE_URL` | Render's `connectionString` for the Blueprint's `resort-games-db` database. |
| `DATABASE_SSL` | `false` for Render's internal database connection. |
| `HOST_PASSWORD` | Enter a private 12+ character value in the dashboard; it is deliberately not stored in the Blueprint. |
| `SESSION_SECRET` | Render-generated secret (`generateValue: true`). Keep it private. |

`PORT` is provided by Render; do not hard-code it. `PUBLIC_BASE_URL` is optional. If set, it must be the full canonical HTTPS origin used by guests, for example `https://games.example.com` (no trailing path). In the Render service dashboard, open **Environment**, add or edit `PUBLIC_BASE_URL`, save, and redeploy. If unset, QR links derive their origin from the request host.

`DATABASE_SSL=true` sets `pg`'s `ssl: true`, which validates the server certificate. Keep it `false` for the Render private internal connection configured by this Blueprint. If you deliberately move to a provider that requires TLS, verify its certificate requirements and test the connection before changing this setting; do not disable certificate validation.

### Optional custom domain

You do not need to buy or configure a domain: the Render-provided `onrender.com` address is sufficient and uses HTTPS. If you already control a domain and want a custom name:

1. In the Render service dashboard, open **Settings** → **Custom Domains** and add the hostname.
2. Copy the exact DNS record Render displays into the DNS provider for that domain. Do not guess the record type or target.
3. Wait for Render to verify the record and provision TLS. Confirm the custom hostname loads over HTTPS.
4. Set `PUBLIC_BASE_URL` to that HTTPS origin in the service's **Environment** page, save, and redeploy.

Domain registration, purchase, and Vercel are not required.

## Hosting and event security

- Keep `HOST_PASSWORD`, `SESSION_SECRET`, and `DATABASE_URL` in Render's environment settings. Never commit secrets, publish them in event materials, or share screenshots that expose them.
- Use the HTTPS URL for hosts and guests. Host authentication uses a signed cookie that lasts 12 hours; guest sessions use a cookie that lasts 7 days. Host cookies are secure in production; do not operate the host panel over an untrusted connection.
- Share the guest URL or QR code privately with event attendees. Do not publish the QR code or guest/host pages in a public place.
- The display is intended for projection. Use `/display` for the public view: its API and real-time connection force sanitized data even when opened in a host browser. Do not project the host screen. Drawings become public at **Show both drawings**, not at the later answer reveal.
- The service stores player identities and scores for the current event. **Conclude event** ends the event without clearing its registrations and scores. **New event** is the destructive reset: it clears guest registrations, scores, rooms, and game state; old guest cookies no longer identify players, while the independent host login cookie remains valid. Treat the snapshot as event data; arrange any needed records and retention with the resort before resetting.
- Keep provider backups only as long as needed for recovery and applicable resort retention rules. A backup can contain player and score data; restrict access and allow provider-retained backups to expire under the provider's configured policy.
- No room cap is imposed. Each browser may join one player session at a time; the same participant can use another browser/device to join a different room. Share the browser and room-code expectations with guests.
- Guest-facing prompts are curated for all ages and English. Offer a standby option and allow guests to opt out rather than requiring participation.

## Running an event

### Host and guest setup

Use a laptop connected to the TV/projector by HDMI for the most predictable display setup. Select **Extend desktop**, not mirror, move the `/display` browser window onto the external screen, and make that window fullscreen. Keep `/host` on the laptop's private screen or a separate phone/tablet. Disable notifications and screen sleep on the display computer. Mirroring the host desktop would expose secret prompts and previews.

The game runs on Render, not on the laptop: the laptop needs only a modern browser. Guests can use resort Wi-Fi or mobile data; they do not need the same local network. Complete any Wi-Fi sign-in page before joining. Artists should keep their phone screen open during their drawing attempt. For local phone testing only, use the laptop's LAN address instead of `localhost`; do not expose the development server to the public internet.

1. Open `/host` and sign in with `HOST_PASSWORD`.
2. Create an event and choose its title and format: standalone Pictionary or Variety Show. The event opens guest registration.
3. Give guests the QR code or site URL. Guests choose a building, room, and (where offered) unit using the room picker, choose whether they are willing to draw, and join. The game assigns a silly player name. There is no typed room-code flow.
4. Open `/display?display=1` on the projection device. Keep host controls private. This public display view stays sanitized even if opened in a browser that also has a host login.
5. Start Pictionary from the host view, then start a new round. The host does not choose the prompt; the game randomly selects a secret word and its two parts.
6. Confirm the projection is legible, the display is connected, and there are at least two connected drawing volunteers. Spin both wheels to select the artists.

### Pictionary

- Two connected, opted-in artists are selected by wheels that spin for 4 seconds. Each artist draws their secret part for up to 30 seconds; the two drawing timers run independently.
- Artists use a finger or pen on the drawing surface. **Undo**, **Clear**, and **Done drawing** are available; Done submits early for private review. Lift your finger to save a stroke. Long gestures are saved in chunks.
- A nonblank drawing is submitted automatically when its 30-second timer expires. The host reviews drawings privately. Players do not see either drawing until the host chooses **Show both drawings**.
- If an artist submits a blank drawing, or the host rejects a drawing, that same artist gets a fresh 30-second attempt for the same part. If their second attempt is blank or rejected, that artist is excluded from drawing for the rest of the game and another eligible artist is selected for that same part. An already approved drawing for the other part remains intact. If there are no eligible volunteers, invite more guests; use **Replace artist** when one is available, or cancel the round.
- After both drawings are approved, the host chooses **Show both drawings**. The public display then shows the drawings and a progress bar starts a 30-second guessing period. Guests submit guesses themselves; guesses are not automatically submitted. Guesses can be retried, subject to a 300-millisecond minimum interval and a maximum of 60 submissions per player for the round.
- Every player who contributed to either drawing—including an artist later replaced—cannot guess in that round. They may guess in a later round.
- Guessing remains open for the full 30 seconds even if someone answers correctly. The first five correct responses earn 5, 4, 3, 2, and 1 point, respectively. Each shown artist earns one point only when the host chooses **Reveal answer** after the guessing deadline; revealing awards points and shows the answer.
- After revealing, choose **Round results** (conclude this round) to display the five earliest correct respondents, then **Show scoreboard** to display the leaders. The host screen also shows game leaders separately. To start another round, choose **Start a new round**.

### Scores, ties, and endings

- A game's scores and the event leaderboard are distinct. Ending or resetting a game must not erase the event's accumulated points.
- Each point award is saved with its participant, game, round, and contribution type. Starting the next Variety Show game retains this award history; creating a fresh event clears it.
- Resolve a tied game end with the host's tie confirmation. Competition cutoffs are inclusive: tied scores at the cutoff remain tied (for example, a top-five cutoff may include more than five players, and a top-three cutoff may include more than three).
- In Variety mode, **Conclude game** ends the current game and shows that game's finale (`game-final`). Guest registrations and cumulative event scores are preserved; start the next game from the host controls.
- To finish the event, choose **Conclude event**. It ends the event and shows the event finale (`event-final`). In standalone mode, concluding the one game also concludes the event.
- **New event** is only for starting a fresh event, not for ending an event or transitioning between Variety games. It is destructive: it removes guest registrations, games, drawings, and scores, so guests must join again. Their old guest cookies no longer identify a registered player. The host's separate signed 12-hour login cookie remains valid.
- The final event screen says **Thank You For Playing** on white. Two black stick figures are drawn, followed by a red heart. Reduced-motion settings show the finished scene without animation.
- Price Is Right is a possible future addition, not an implemented game. Do not advertise it as available.

### Names and word assets

Family-friendly Silly Names are generated locally from the lists in `lib/engine.js` and made unique within the event. The compound-word pack is in `lib/words.js`: each entry is `[answer, firstPart, secondPart]`. No external name or word service is required. Words are not repeated until the entire pack has been used; a long event then starts another cycle without resetting scores or registrations and avoids immediately repeating the previous word. Review additions for all-ages English suitability, keep the answer equal to the two parts combined, and run `npm test` before deploying asset changes.

## Recovery, maintenance, and deploys

### During a live event

Do not deploy during a live event. The snapshot backend is single-instance, and a rolling deployment can run overlapping processes against the same snapshot. A restart can interrupt active play even though the saved snapshot is persistent. If an urgent update is unavoidable, end the event safely and wait until the service is no longer processing a round before deploying. After the deploy, check the service health before starting another event.

On recovery, expired timers are processed instead of silently extended. If recovery finds an artist still in the 4-second selection slot, that artist receives a full 30-second drawing attempt. An expired nonblank drawing is frozen for private host review. An expired blank drawing follows the normal attempt rules: the same artist retries the same part with a fresh 30 seconds on the first failure; after a second failure, the artist is excluded for the game and a replacement is selected for that part when available. An expired guessing period closes guess input and waits for the host to choose **Reveal answer**. Confirm the recovered round state with the host and players before continuing.

### Backups and restore

1. Before provider maintenance, a database migration, or a potentially disruptive change, open the Render PostgreSQL resource and review its **Backups** page and current retention/restore options.
2. Create or confirm a current backup using the controls Render presents for that database. Record the backup time and database identity in the resort's restricted operations log.
3. For a restore, use Render's database backup/restore controls and follow the dashboard's confirmation prompts. Verify the target database carefully; restore can replace newer data.
4. After restore, confirm the web service still uses the intended database connection, then check `/health`, `/host`, `/display`, and the event snapshot before resuming.

Do not assume that a deploy rollback restores database contents: application deployments and PostgreSQL data are separate. Test backup recovery in a non-production environment when possible. Keep backups private because they contain event state.

### Deploying an update or rolling back

1. Merge or push the reviewed change to the branch connected to Render. In the service **Settings**, confirm the instance count remains one and autoscaling is disabled. A push does not auto-deploy.
2. Do not deploy during a live event. Once the event is over, open the `resort-games` service in Render and choose **Manual Deploy** → **Deploy latest commit** (or select a specific reviewed commit). For changes affecting stored data, back up PostgreSQL first.
3. Follow the build and deploy logs and verify `/health` after the service becomes live.
4. If the service is unhealthy, use the service's **Events/Deploys** history to select the last known-good deployment and choose its rollback/redeploy action. Verify health and event state before reopening the host panel.
5. If a database schema/data change caused the failure, a code rollback alone may not undo it; restore from a known-good database backup only after confirming the target and data-loss consequences.

Do not promise zero-downtime game deployments. Test significant changes with a staging service and database before production.

### Routine checks

- Review Render deploy and runtime logs after an update and periodically during operations.
- Confirm the service and database remain healthy and review resource usage and billing in the Render dashboard.
- Review current backups and retention before an event; do not retain snapshots indefinitely without a need.
- Test guest joining and WebSocket updates with multiple devices, a typical venue Wi-Fi connection, and the projection display before the event. A 60-device load test is a recommended pre-event check for a large session; do not add multiple live instances to handle the load.
- If moving away from Render, plan and test both application and database migration. Hetzner or another provider may be a portability option, but this repository does not provide deployment steps or a verified configuration for it.

## Troubleshooting

| Symptom | Checks |
| --- | --- |
| Deploy fails at `npm ci` | Confirm the selected GitHub branch contains `package.json` and its npm lockfile. |
| App does not start | Check Render logs, `NODE_ENV`, `HOST_PASSWORD`, and `SESSION_SECRET`; the secrets must meet their minimum lengths. |
| Database connection fails | Confirm the Blueprint's `DATABASE_URL` references `resort-games-db`, the database is available, and `DATABASE_SSL=false` for the internal URL. Never share the connection string in a support post. |
| QR points to the wrong host | Check the current request host or set `PUBLIC_BASE_URL` to the canonical HTTPS URL, then save and redeploy. |
| Guest or display does not update | Check the service is healthy, reconnect the browser to the HTTPS URL, and inspect service logs. Confirm venue Wi-Fi allows the connection. |
| A room/player appears incorrect | Check the selected building and room and the browser/device identity. Each browser can hold only one player session at a time. |

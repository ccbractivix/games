# Resort Games: setup and operations manual

This manual covers the standalone Resort Games service. It is not part of RGP and does not use RGP's backend, database, or hosting. The GitHub repository is the source of truth; Render runs the Node web service and its dedicated PostgreSQL database. Vercel is not used or required.

## What runs where

- **Render web service:** Serves the guest application, `/host`, `/display`, WebSocket connections, and the QR endpoint (`GET /api/qr`).
- **Render PostgreSQL:** Stores the current event snapshot and persistent game libraries as one JSONB row. The application creates its schema automatically, including Screengrabbers question storage; operators do not need to create tables or write SQL.
- **GitHub:** Holds the source and `render.yaml` deployment blueprint.
- **Cloudflare R2 (optional):** Holds uploaded Get The Picture and Screengrabbers images in a dedicated private games bucket. Each game has its own object prefix and host library. Render uploads optimized images; phones and the display read them through temporary signed links. Questions, correct answers, captions, scores and image metadata stay in the database, not public bucket listings.
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

## Games image storage: Cloudflare R2

The six Get The Picture starter illustrations work without Cloudflare. Screengrabbers requires host-uploaded images and has no bundled movie assets. To enable host uploads, configure R2 separately; the Render Blueprint does not create a Cloudflare account, bucket, or credentials. Keep this infrastructure dedicated to games. Do not move an existing resort domain or attach another resort's bucket. An R2 account is a storage service, not a replacement for Render or PostgreSQL.

Use **one private games bucket**, not one bucket per game. Get The Picture uses `get-the-picture/<random-id>.webp`; Screengrabbers uses `screengrabbers/<random-id>.webp`. These prefixes act like folders. Host albums and database references also stay separate, so neither game's random selection draws from the other's library. Prefixes are not security boundaries: the games server's bucket-scoped credential can access both. Only use separate buckets if independent credentials, jurisdiction, or retention policies require true isolation; that would need additional application configuration. Future image games should follow the same game-specific prefix/library pattern.

**If games R2 is already configured:** keep the same bucket and all four existing Render R2 variables. Deploy this release manually on the existing games service outside event hours. No new Cloudflare token, bucket, Render database, Vercel project, public access, CORS rule, or DNS change is needed. The application creates prefixes when it uploads the first image; do not manually create folders. Then follow the Screengrabbers library steps below.

### Create the private games bucket

1. Create/sign in to your Cloudflare account and enable two-factor authentication. Open **R2 Object Storage** and enable R2. Cloudflare may require billing information even when usage is within its free allowance. Review the current R2 pricing and billing terms before accepting. A paid Cloudflare website plan is not needed.
2. In R2, choose **Create bucket**, with a dedicated name such as `resort-games-images-prod`. Choose **Standard** storage, not Infrequent Access. Use an appropriate location/jurisdiction for the resort's requirements; the default automatic location is acceptable when there are no additional requirements.
3. Keep the bucket **private**: do not enable the Public Development URL (`r2.dev`), connect a custom domain, or enable public access. No domain purchase or DNS changes are required.
4. Do not add lifecycle rules deleting the `get-the-picture/` or `screengrabbers/` prefixes. These are permanent library assets, not temporary uploads.
5. In R2's API-token management, create an R2 S3-compatible credential with **Object Read & Write** permissions restricted to **this bucket only**. Depending on the dashboard, this is labeled **Manage R2 API Tokens** or an account/user R2 token option. Do not create a global Cloudflare API key, account-admin token, or credentials for all resort buckets.
6. Copy the displayed **Access Key ID**, **Secret Access Key**, and account ID into a private password manager. The S3 endpoint is `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`; the app constructs it from the account ID. Use the S3 access-key pair, not the Cloudflare bearer-token string. The secret may only be shown once. Never send these values through chat, GitHub, screenshots, or event materials.

### Connect R2 to the Render games service

1. Wait until no event is running. Open the **resort-games web service** in Render, then **Environment**.
2. Add all four values below. Keep the existing database and authentication settings unchanged.

   | Key | Value |
   | --- | --- |
   | `R2_ACCOUNT_ID` | The 32-character Cloudflare account ID associated with the bucket. |
   | `R2_BUCKET_NAME` | The exact dedicated bucket name. |
   | `R2_ACCESS_KEY_ID` | The bucket-scoped S3 access key ID. |
   | `R2_SECRET_ACCESS_KEY` | Its corresponding secret access key. |

3. Save and deploy the reviewed games release from Render's **Manual Deploy** menu. Automatic deploy remains disabled and the service remains single-instance. Supplying only some R2 variables is a startup error; leave all four unset/blank if using only starter images.
4. Check `/health`. Sign in to `/host`, expand **Get The Picture - Image library & safety** or **Screengrabbers - Image album & questions**, and confirm the upload form is available. An available form means the environment is configured, not that Cloudflare has accepted the credentials.
5. Upload a small test image you own. Enter its title, accessibility description, and credit/source, and confirm permission to use it. A successful upload checks write access. Open its library preview to check read access.
6. Choose Get The Picture, start a test round with that image, and check it on an independent phone and `/display` over the real HTTPS site. Confirm it finishes loading before starting the timer. This is the end-to-end Cloudflare verification; local tests with simulated storage do not verify a real account.

Uploads pass through the authenticated games server, are decoded and re-encoded as still WebP images, resized within 1600 x 1200, and stripped of metadata. Inputs are limited to JPEG, PNG or WebP, 5 MB and 20 megapixels. SVG and animated uploads are rejected. Only the bundled, original SVG illustrations are trusted SVGs. Each game's album holds up to 200 uploaded assets. The upload rate limit is 20 per hour per host IP, shared across games. Coordinate bulk library changes before an event.

Players and the display use the app's same-origin image route, which redirects to an R2 link valid for one hour. The bucket remains private; anyone holding a temporary link can view that image until expiry. Do not use this library for confidential or personal photographs. These ordinary image loads do not require a bucket CORS rule; uploads are server-side, not direct browser uploads. The app allows only this account's R2 image origin in its content-security policy.

### Image operations, backup and billing

- **Add:** Use the host upload form, not a public upload link. The operator must own or have suitable display rights for each image, obtain any necessary permissions, and review its visual content. Captions are filtered; image content is not automatically screened.
- **Select:** Choose an enabled image for the next round, or let the app randomly select unused images. The library cycles without an immediate repeat when multiple images remain available.
- **Disable:** Use **Disable image** in the host library. This prevents future selection; it does not erase the file, break a round already using it, or stop storage billing. Library metadata and safety additions survive **New event**, unlike player registrations and scores.
- **Back up:** R2 image files are not included in Render's database backup. Preserve original source images and a restricted copy of the bucket objects separately, along with a matching database backup containing titles, credits and R2 object keys. For a small library, use the bucket dashboard's download controls; an operator can use an S3-compatible backup tool for a larger library. Keep backups dedicated to games, private, and subject to the resort's retention policy.
- **Remove permanently:** The app disables assets rather than deleting them. For permanent retirement or the 200-upload limit, an operator must back up, stop the games service (not just the round), remove the corresponding uploaded entry from `pictureImages` in the saved event snapshot, and delete exactly its `key` from this bucket. Do not remove the current round's image, delete the whole bucket, or guess object keys. Restart and verify the service afterward. This is an administrative maintenance operation, not a host game control.
- **Rotate keys:** Create a replacement bucket-scoped S3 credential, update both access-key values in Render, redeploy outside event hours, and verify upload plus independent-device viewing. Revoke the old credential in Cloudflare after verification.
- **Monitor:** Review Cloudflare's R2 storage, operation counts and billing regularly. Free allowances are not a hard spending cap. Render and R2 are billed separately; check each dashboard rather than assuming a free game deployment.

## Hosting and event security

- Keep `HOST_PASSWORD`, `SESSION_SECRET`, `DATABASE_URL`, and R2 credentials in Render's environment settings. Never commit secrets, publish them in event materials, or share screenshots that expose them.
- Use the HTTPS URL for hosts and guests. Host authentication uses a signed cookie that lasts 12 hours; guest sessions use a cookie that lasts 7 days. Host cookies are secure in production; do not operate the host panel over an untrusted connection.
- Share the guest URL or QR code privately with event attendees. Do not publish the QR code or guest/host pages in a public place.
- The display is intended for projection. Use `/display` for the public view: its API and real-time connection force sanitized data even when opened in a host browser. Do not project the host screen. Drawings become public at **Show both drawings**, not at the later answer reveal.
- The service stores player identities and scores for the current event. **Conclude event** ends the event without clearing its registrations and scores. **New event** is the destructive reset: it clears guest registrations, scores, rooms, and game state; old guest cookies no longer identify players, while the independent host login cookie remains valid. Treat the snapshot as event data; arrange any needed records and retention with the resort before resetting.
- Keep provider backups only as long as needed for recovery and applicable resort retention rules. A backup can contain player and score data; restrict access and allow provider-retained backups to expire under the provider's configured policy.
- No room cap is imposed. Each browser may join one player session at a time; the same participant can use another browser/device to join a different room. Share the browser and room-code expectations with guests.
- Big Draw prompts are curated for all ages and English. Family Cards uses the supplied Family Edition deck, including toilet humor and dark themes; the host decides whether it is appropriate for the audience. Offer a standby option and allow guests to opt out rather than requiring participation.

## Running an event

### Host and guest setup

Use a laptop connected to the TV/projector by HDMI for the most predictable display setup. Select **Extend desktop**, not mirror, move the `/display` browser window onto the external screen, and make that window fullscreen. Keep `/host` on the laptop's private screen or a separate phone/tablet. Disable notifications and screen sleep on the display computer. Mirroring the host desktop would expose secret prompts and previews.

The game runs on Render, not on the laptop: the laptop needs only a modern browser. Guests can use resort Wi-Fi or mobile data; they do not need the same local network. Complete any Wi-Fi sign-in page before joining. Artists should keep their phone screen open during their drawing attempt. For local phone testing only, use the laptop's LAN address instead of `localhost`; do not expose the development server to the public internet.

1. Open `/host` and sign in with `HOST_PASSWORD`.
2. Create an event and choose its title and format: standalone (one game) or Variety Show. The event opens guest registration, up to 100 registered players for every game and format. Disconnected players still occupy their registration; their existing device can rejoin at capacity. Choose **Start Big Draw**, **Start Family Cards**, **Start Screengrabbers**, or a Get The Picture format from the host controls.
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

### Family Cards

Family Cards is the phone-based audience-vote adaptation of the supplied `docs/CAH_Family_SmallCards.pdf`. It is a different game from Big Draw, available either standalone or as the next Variety Show game. It uses the same joining URL, host login, public `/display`, persistence and event leaderboard; no additional hosting service or account is required. Launch it only when the host considers the deck suitable for the audience.

1. Open an event, choose **Start Family Cards**, and welcome at least two connected players. Drawing willingness has no effect on card participation. Each player receives ten private answer cards on their phone.
2. Choose **Start a new round**. A random prompt appears on phones and the audience display, starting a 30-second submission period. Tapping an answer card submits it immediately and permanently for this round; there is no separate confirmation or answer-editing step.
3. Only the first five distinct players' valid submissions received by the server become finalists. Submissions close immediately at five; otherwise they close at 30 seconds. Speed and connection latency affect qualification. The host can choose **Close submissions now**. Fewer than five answers still proceed; no answers skip the round without points.
4. Finalists are shuffled and shown anonymously with stable answer numbers. Everyone registered can cast one final vote on their phone, including finalists, but nobody can vote for their own answer. Voting lasts 30 seconds; the host can choose **Close voting & show results** early. Voting does not close automatically when everyone has voted, and individual answer totals remain hidden until it closes.
5. When voting closes, results reveal each finalist's Silly Name, vote count and earned points. Answers with positive votes earn 5/4/3/2/1 points by competition rank. Ties share a rank and skip occupied positions: votes 3/3/1 earn points 5/5/3. Answers with zero votes earn no points, including when no one votes. Scoring happens exactly once and updates both game and cumulative event points.
6. Choose **Round results**, **Show scoreboard**, or **Start a new round**. The host can cancel an unscored round without awarding points. **Conclude game** retains registrations and cumulative event points in Variety Show, allowing the host to choose either game next. In standalone mode, it concludes the event.

Hands stay private even in the host view. Only submitted cards are consumed and immediately replaced; other cards remain across rounds. Each hand contains ten distinct cards drawn independently from the 505-answer pack, allowing more than 50 players without running out. Different players can hold and submit the same answer text; such submissions remain separate numbered finalists with separate vote totals. Prompt cards do not repeat until all 95 have been used in the event, then recycle without an immediate repeat. Starting another card game deals fresh hands but retains the event's prompt history.

Guests joining mid-round receive a hand and may vote immediately, but can submit only starting the next round. Reconnecting retains identity, hand, accepted submission and ballot. Keep the host screen private and project only `/display`.

The source PDF describes home printing but does not explicitly grant digital redistribution rights. Closed-group/local operation is not a verified digital-use license. The operator is responsible for confirming appropriate permission before distributing or deploying this deck.

#### Card assets and updates

`lib/family-cards.json` contains the server-only text deck extracted from the supplied PDF. It is not served as a static download, and no external card API is called. Do not put the complete deck, player hands, or ballots into public state.

To regenerate the asset from this exact 33-page PDF layout, install Python and `pypdf` in a local virtual environment, then run:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install pypdf
.venv/bin/python scripts/import-family-cards.py
npm test
```

Keep `.venv` outside source control. The importer checks the printed grid and expects 95 prompts and 505 answers; different PDF layouts require reviewing the importer, not silently accepting a partial deck. Review generated text and card boundaries before deployment. This tooling is for asset maintenance only; Render still uses the unchanged `npm ci` build and `npm start` command, with no Python installation needed.

For local closed-group phone access, start the existing Node service and use the computer's LAN address in guest and display browsers. `localhost` on a phone refers to that phone, not the server. Keep access restricted to the intended network; do not port-forward the local service to the internet. Local snapshots remain in the configured `DATA_FILE`; production still requires the dedicated PostgreSQL backend described above.

### Screengrabbers

Screengrabbers is an "at the movies" image quiz with a cinema marquee, red curtains, ticket-styled choices and a roll-credits finale. It supports 2-100 connected players without drawing volunteers, standalone or in a Variety Show. Silly Names and cumulative event points carry between Variety Show games; the host chooses the next game live.

### Build the image album and question library

1. Sign in to `/host` and expand **Screengrabbers - Image album & questions**. Configure R2 using the complete steps above if uploads are unavailable. You can prepare the library before opening an event.
2. Upload a still JPEG, PNG or WebP up to 5 MB. Supply a private title, an accessibility description, a credit/source, and confirmation of permission and audience suitability. Movie screenshots may require appropriate display rights; the application does not provide licensed movie assets or determine those rights for you. Review image content yourself.
3. Keep the accessibility description **spoiler-free**: guests can read it during answering. Private titles never appear on guest screens. Credits/sources appear only after the answer reveal because they may name the film.
4. Select an uploaded image under **Attach a question**, enter a question (up to 240 characters), provide 2-6 distinct choices (up to 120 characters each), select the correct choice, and save. Add another question against the same image if needed. Up to 1,000 saved questions are supported.
5. Use **Edit** to revise a saved question. Disable individual questions to exclude them, or disable an image to exclude all its questions. Editing or disabling cannot change a live round: its question, choices, correct answer and image details were copied when it started.
6. Albums, questions and enabled/disabled settings survive **New event**. A new event clears player registrations, scores and question-use history, not the content library. Every enabled question with an enabled image is eligible for random selection once per cycle. When the available questions are exhausted, selection starts a new cycle and avoids immediately repeating the preceding question when alternatives exist. An album with one eligible question necessarily repeats. Different questions using the same image can appear in one cycle.

### Run a game

1. Open a standalone or Variety Show event. Welcome at least two connected players, then choose **Start Screengrabbers**.
2. Choose **Start a new round**. The server selects a question randomly and preloads its image on devices behind the curtain; the question and choices are hidden from guests until answering opens. The host gets a private preview, including the correct answer.
3. Check the loaded-player count, the private image preview and the Main Display. If the image fails, use **Retry image** and check R2 credentials, bucket access and Render logs. Do not start with a broken image.
4. Choose **Open curtain & start 30 seconds**. The image, question and choices appear together on phones and the Main Display. The countdown gives 30 seconds from this action, not from preload. Players tap a choice to submit immediately. Their first accepted answer is final, including an incorrect answer; correctness is not disclosed before the reveal.
5. **Close answers early** is optional; otherwise the server closes at the deadline. Guests joining after a question was selected wait until the next question. Reconnecting participants retain their submission and can answer only if they have not already submitted and time remains.
6. Choose **Reveal answer & award points**. All correct answers earn 1 point. The first five correct responses, in server receipt order (not a device's clock), get additional 5/4/3/2/1 bonuses: **6/5/4/3/2 total points**, followed by 1 for every other correct answer. Wrong or missing answers earn zero and do not consume bonus places. Equal recorded timestamps retain server receipt order. Venue latency can affect speed ranking.
7. Scoring happens exactly once on reveal and updates game and cumulative event scores. The top-five round panel shows speed leaders; every correct player sees their own earned points. Use **Round results**, **Show scoreboard**, **Start a new round**, or **Conclude game**. A cancelled unscored question awards no points.
8. Restart recovery retains the live question, submissions and original deadline. An expired answering window closes after restart, but the host must still reveal to award points. No countdown extension or duplicate awards occur. Concluding a standalone game ends the event; concluding a Variety Show game retains players and event totals.

### Backup and retirement

Back up the database snapshot and matching private R2 objects together; database backups do not contain image bytes. Keep original images and the permissions/source information. Ordinary host controls disable content rather than delete it.

For permanent retirement or the 200-image/1,000-question limit, an operator must back up and stop the games service, remove the exact retired entries from `screengrabberQuestions`, remove retired image references from `screengrabberImages`, and delete only those images' exact `key` objects from R2. Remove all questions referencing an image before removing that image. Do not retire an image or question referenced by the saved current round; retain it until a different round is selected. Restart and verify both albums and guest image viewing afterward. Do not delete the bucket or the other game's prefix. This is administrative maintenance, not a host game control.

## Get The Picture

This caption game runs standalone or in a Variety Show with the same Silly Names, registrations and cumulative event scores. It supports 2-100 registered players; drawing willingness is irrelevant. The built-in library contains six original Resort Games illustrations, not third-party photographs. Host-uploaded images require the dedicated R2 setup above.

1. Open an event. In **Get The Picture format**, select **Small room**, **Large audience**, or **Poolside**, then choose **Start Get The Picture**. Format is fixed for this game.
2. Select the next round's image or leave **Random unused image** selected. Choose **Start a new round**. The image appears on phones and the Main Display in an untimed loading stage. The host sees how many round participants have successfully loaded it.
3. Check that the host preview and Main Display are visible and phones are ready, then choose **Start 30-second caption timer**. The host may start before every device reports readiness; an offline or slow participant does not stall the whole event. All devices share the server's deadline. A player can retry a failed image load.
4. Players enter one caption of up to 160 characters and explicitly submit it. The server applies the safety filter before saving anything. Rejected captions receive a private explanation and can be revised until the deadline. Accepted captions are final. Submission does not close early when everyone answers; the host can use **Close captions now**. An empty round is cancelled without points.
5. Selection depends on format:
   - **Small room:** Every accepted, nonremoved caption becomes an anonymous voting option. No manual approval gate. Use this for a manageable number of entries; all options remain available on phones.
   - **Large audience:** Captions are private to the submitting player and host until the host approves them and chooses **Open audience voting**. The host can review while captions arrive or after time expires. Unapproved and removed entries never reach the audience. About five to ten finalists is recommended, not an enforced limit.
   - **Poolside:** One randomly selected judge per group of up to ten participants is assigned each round. Incomplete groups are balanced: 11 players form groups of 6 and 5, not 10 and 1. Judges rotate, favoring those with the fewest turns and excluding the previous round's judges when enough players remain. With an unchanged roster, everyone gets a turn before reuse. Judges also submit their own captions, but their own caption and other groups' captions are never in their private selection list. Each judge has 30 seconds after captions close to choose one other member's accepted, nonremoved caption. When all groups with eligible choices nominate, voting starts immediately. At the deadline, only actual nominations advance; absent judges and groups with no eligible choice are skipped, not auto-selected by the server. The host can open voting early using the nominations already made.
6. Anonymous finalists appear on phones and the Main Display. Every registered player can cast one final vote, including a judge, but never for their own caption. Mid-round joins can vote but cannot caption or become judges until the next round. Voting lasts 30 seconds; **Close voting & show results** can end it early. The Main Display cycles through six finalists at a time every eight seconds; phones show the full list and stable caption numbers. Individual vote totals stay hidden until results.
7. When voting closes, finalist Silly Names, votes and points appear. Positive-vote captions receive 5/4/3/2/1 points by competition rank. Ties share rank and skip occupied places; votes 3/3/1 earn 5/5/3 points. Ranks below fifth and zero-vote entries earn zero, never negative points. Scoring happens once and updates game and event totals. Use **Round results**, **Show scoreboard**, another round, or **Conclude game** as appropriate.

The host can remove a caption during collection, selection or voting in all formats. Removal cannot be undone in that round. If a removed caption already has ballots, those ballots are withdrawn and affected players may choose another remaining finalist. This is an explicit moderation withdrawal, not an extra counted vote. There is no host override that restores an automatically rejected caption. An unscored round can be cancelled without awarding points.

Keep `/host` private; project only `/display`. In particular, do not project the host's raw review queue or safety settings.

#### Caption safety policy and maintenance

Filtering runs locally on the server and does not send captions to an external AI or moderation service. It uses the English `naughty-words` vocabulary, extra inappropriate/discriminatory expressions, political office/party terms and names, and derogatory-term combinations for racial/religious communities, other protected groups, Florida, conservatives, resorts, salespeople and timeshares. Political people/offices/party references are excluded even when complimentary; neutral references to Florida, religious communities and the resort industry may pass. Case, common leetspeak, separators, repeated letters, zero-width characters and common Unicode lookalikes are normalized. Non-Latin text the filter cannot review is rejected with a request for English text.

This is **best-effort filtering, not semantic understanding or a guarantee**. Novel insults, sarcasm, euphemisms, ambiguous surnames and new political figures can evade a rules-based filter; innocent language can also be rejected. Use Large audience mode whenever every public caption must receive human review. Small-room and poolside modes retain their requested automatic/player selection flows and therefore do not have a guaranteed human safety gate.

In the host's **Image library & safety**, add venue-specific blocked names, phrases or newly discovered evasions, one phrase per line, up to 100 phrases / 4,000 characters, then save before opening captions. These additions cannot remove built-in restrictions and survive new events. Changes apply to subsequent submissions; remove an already accepted caption separately if necessary. Rejected raw captions are not persisted or broadcast.

`lib/political-names.json` contains public-domain (CC0) full-name aliases from the `unitedstates/congress-legislators` current roster, with its source and import date. The filter also includes presidential, common political, and Florida political aliases in `lib/caption-filter.js`. It does not retrieve a live politician list during an event. After elections, appointments or vacancies, refresh the roster in a development checkout:

```sh
npm ci
node scripts/import-political-names.js
npm test
```

The importer needs internet access and the development-only `yaml` dependency. Review the generated roster and update presidential/Florida aliases as necessary before deploying outside event hours. Full names and curated aliases are used rather than indiscriminately banning common surnames such as King or Scott. Host additions can cover local names and nicknames between releases.

### Names and word assets

Family-friendly Silly Names are generated locally from the lists in `lib/engine.js` and made unique within the event. The compound-word pack is in `lib/words.js`: each entry is `[answer, firstPart, secondPart]`. No external name or word service is required. Words are not repeated until the entire pack has been used; a long event then starts another cycle without resetting scores or registrations and avoids immediately repeating the previous word. Review additions for all-ages English suitability, keep the answer equal to the two parts combined, and run `npm test` before deploying asset changes.

## Recovery, maintenance, and deploys

### During a live event

Do not deploy during a live event. The snapshot backend is single-instance, and a rolling deployment can run overlapping processes against the same snapshot. A restart can interrupt active play even though the saved snapshot is persistent. If an urgent update is unavoidable, end the event safely and wait until the service is no longer processing a round before deploying. After the deploy, check the service health before starting another event.

On recovery, expired timers are processed instead of silently extended. In Get The Picture, the loading stage and large-audience review stage wait for the host. Expired captions proceed to the appropriate selection stage or voting, with a new full timer for that next stage; empty rounds are cancelled. Expired judging opens voting using saved nominations only. Expired voting scores saved ballots once. Accepted captions, groups, judges, nominations, votes and judge-rotation counts persist. Image links are generated afresh when requested rather than saving expiring credentials in the event.

In Family Cards, expired submissions reveal the accepted finalists and begin a fresh 30-second voting period, or skip an empty round. Expired voting scores the saved ballots once and reveals results; hands and votes persist. In Big Draw, if recovery finds an artist still in the 4-second selection slot, that artist receives a full 30-second drawing attempt. An expired nonblank drawing is frozen for private host review. An expired blank drawing follows the normal attempt rules: the same artist retries the same part with a fresh 30 seconds on the first failure; after a second failure, the artist is excluded for the game and a replacement is selected for that part when available. An expired guessing period closes guess input and waits for the host to choose **Reveal answer**. Confirm the recovered round state with the host and players before continuing.

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
- Test guest joining and WebSocket updates with multiple devices, a typical venue Wi-Fi connection, and the projection display before the event. The automated Get The Picture integration test exercises 100 local WebSocket connections; that does not verify venue Wi-Fi, real mobile browsers or live R2 credentials. Rehearse on the intended network before a large session; do not add multiple live instances to handle the load.
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
| Get The Picture uploads unavailable | Set all four R2 variables on the games Render service and redeploy outside event hours. Starter images do not require R2. |
| Upload fails or R2 image will not load | Check bucket name, account ID, bucket-scoped Object Read & Write credentials and Render logs. Confirm the file is a supported still image within the size limits. Use the actual S3 key pair, not a Cloudflare bearer token. |
| Captions remain closed on phones | Start a new round to load the image, then use **Start 30-second caption timer**. Guests who joined mid-round wait until the next round to caption. |
| Large-audience round waits after captions close | Approve suitable captions privately, then choose **Open audience voting**. No submissions are published merely because the timer expired. |
| Poolside group has no finalist | Its judge did not nominate before the deadline, or there was no other eligible caption. The judge cannot nominate their own answer; no automatic substitute is chosen. |
| A caption is rejected unexpectedly or unsuitable text slips through | Use host safety additions and removal controls, review `lib/caption-filter.js`, and use Large audience mode for a human gate. Filtering is best-effort, not a guarantee. |

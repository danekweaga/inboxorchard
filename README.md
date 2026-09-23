# Inbox Orchard

Inbox Orchard is an Instagram-first, self-hosted conversation automation platform for creators. It turns eligible Instagram comments and inbound messages into durable conversations, tracked resource deliveries, lightweight CRM records, email subscribers, and measurable conversions.

It uses official Meta APIs only. There is no central Inbox Orchard service: each installation owns its Cloudflare account, credentials, database, queue, files, and provider accounts.

> Status: the core application, mock mode, workflow engine, inbox, CRM, resources, email queue, integrations, analytics, and administration UI are implemented. Real Meta, Resend, Gmail, Brevo, Google Sheets, and remote Cloudflare behavior must be verified with the deployer's own credentials. See [Platform limitations](docs/platform-limitations.md) before publishing an automation.

## Start here (non-technical guide)

Inbox Orchard is self-hosted. That means you get your own private copy instead of creating an account on somebody else's service. You do **not** need to know how to program, but you do need a computer and about 30–60 minutes to connect the accounts.

Choose the path that matches your goal:

| I want to… | Use this section |
| --- | --- |
| Look around safely without connecting Instagram | [Try it on your computer](#try-it-on-your-computer) |
| Run real Instagram automations | [Publish your own copy](#publish-your-own-copy) |
| Help develop the project | [Developer commands](#developer-commands) |

The live Instagram setup cannot be reduced to one click because Meta requires every owner to create and approve their own app. Never share your Meta secret, owner password, or email API key with anyone.

## What works

- Single-owner dashboard authentication with an HTTP-only signed session
- Instagram Professional account OAuth, encrypted token storage, refresh, disconnect, and capability status
- Signed, durable, idempotent webhook ingestion with queue processing, retries, failure visibility, and replay
- Inbox, contacts, tags, typed custom fields, timelines, source attribution, messaging-window status, and manual actions
- Versioned structured automations with deterministic trigger priority and duplicate-run protection
- Real pause/resume state for questions, delayed work, and waiting runs
- Keyword, comment, keyword-filtered Story reply, Story mention, AI intent, webhook, schedule, tag, field, manual, and sequence triggers
- React Flow editor, validation, immutable publishing, run logs, natural-language proposal, and no-send simulator
- R2-backed uploads, link resources, tracked redirects, clicks, and conversion events
- Queue-first Resend, Brevo, Gmail, or mock email delivery with daily/monthly safety thresholds, safe failover, retry, and sequences
- Optional Workers AI intent classification, grounded replies, and workflow generation
- Google Sheets append actions and signed custom inbound webhooks
- Real database-backed dashboard/content analytics, CSV export, JSON automation export/import, and secret-free backup/restore
- FREE MODE and an explicit mock mode that cannot call Instagram

The starter UI includes ten structured workflow templates. Portable examples live in [`templates/`](templates/).

## Architecture

```text
Instagram → signed webhook → D1 event record → Cloudflare Queue
                                               ↓
Browser → Hono Worker → automation engine → policy layer → provider adapters
             ↓                 ↓                              ↓
             D1          durable run state            Instagram / email /
             R2          and execution logs           AI / Sheets / HTTPS
```

See [Architecture](docs/architecture.md) for component boundaries, data flow, and reliability behavior.

## What you need

- A Windows, macOS, or Linux computer (setup cannot be completed only on a phone)
- [Node.js 22 or newer](https://nodejs.org/en/download)
- A free [Cloudflare account](https://dash.cloudflare.com/sign-up) for a live deployment
- For real Instagram messages: an Instagram Professional account and a [Meta developer account](https://developers.facebook.com/)
- Optional for email: a Resend, Gmail, or Brevo account

The default architecture has no mandatory paid service and no mandatory custom domain. Provider free allocations and policies can change; check each provider dashboard before deploying.

## Try it on your computer

This safe demo does not contact Instagram or send real messages.

### 1. Download the project

On this GitHub page, click **Code → Download ZIP**, unzip it, and open the `inboxorchard` folder. You can also use GitHub Desktop or Git if you already have either one.

### 2. Open a terminal in the folder

- **Windows:** open the folder in File Explorer, click the address bar, type `powershell`, and press Enter.
- **macOS:** Control-click the folder in Finder and choose **New Terminal at Folder**.

### 3. Install it

```bash
npm install
```

Wait until the command finishes. Warnings are usually fine; stop only if the terminal says the installation failed.

### 4. Create the private settings file

On Windows:

```powershell
Copy-Item .env.example .dev.vars
notepad .dev.vars
```

On macOS or Linux:

```bash
cp .env.example .dev.vars
```

Open `.dev.vars` in a text editor. Replace the three placeholder values below with three different long phrases that only you know:

```text
OWNER_TOKEN=your-private-dashboard-password
SESSION_SECRET=a-different-long-random-phrase
ENCRYPTION_KEY=another-different-long-random-phrase
```

Add this line at the bottom so the local copy stays in safe demo mode:

```text
MOCK_MODE=true
```

Save the file. `.dev.vars` is ignored by Git; never post or upload it.

### 5. Start the demo

Run these commands one at a time:

```bash
npm run db:migrate:local
npm run dev
```

Open `http://127.0.0.1:5173` in your browser. Sign in with the value you put after `OWNER_TOKEN=`. Use the Simulator to test workflows without sending anything.

To stop the app, return to the terminal and press **Ctrl+C**. The next time you want to use it, open a terminal in the folder and run `npm run dev`.

## Publish your own copy

Cloudflare hosts both the dashboard and the backend, so Vercel is not required. Complete the local demo first; it confirms that Node.js and the downloaded project work.

### 1. Sign in to Cloudflare

From the project folder, run:

```bash
npx wrangler login
```

Your browser will open. Approve the connection, then return to the terminal.

### 2. Create the storage and message queues

Run each command separately:

```bash
npx wrangler d1 create chatmany
npx wrangler queues create dmflow-tasks
npx wrangler queues create dmflow-dead-letter
```

The first command prints a `database_id`. Copy that ID.

Optional: if you want users to upload files directly instead of only sharing links, also run:

```bash
npx wrangler r2 bucket create dmflow-resources
```

Then uncomment the `r2_buckets` section in `wrangler.jsonc`.

### 3. Point the project at your Cloudflare account

Open `wrangler.jsonc` in a text editor.

1. Replace the existing `database_id` with the ID Cloudflare just gave you.
2. Change the first `name` value from `chatmany` to a unique Worker name, such as `yourname-inbox-orchard`.
3. Do not rename the bindings `DB`, `TASK_QUEUE`, `RESOURCES`, or `AI`.

Save the file, then create the database tables:

```bash
npm run db:migrate:remote
```

### 4. Add private security values

Run each command below. Wrangler will ask you to paste a value; the terminal may hide what you type. Use a different long random value for every item.

```bash
npx wrangler secret put OWNER_TOKEN
npx wrangler secret put SESSION_SECRET
npx wrangler secret put ENCRYPTION_KEY
npx wrangler secret put META_APP_ID
npx wrangler secret put META_APP_SECRET
npx wrangler secret put META_VERIFY_TOKEN
```

- `OWNER_TOKEN` is the password you will use to open your dashboard.
- `META_APP_ID` and `META_APP_SECRET` come from your Meta app's Instagram API setup page.
- `META_VERIFY_TOKEN` is a random phrase you create and later enter in Meta's webhook form.

### 5. Deploy once and copy your address

```bash
npm run deploy
```

At the end, Cloudflare prints an address similar to `https://yourname-inbox-orchard.workers.dev`. Copy it.

Open `wrangler.jsonc` again and replace the old `chatmany.danekweaga.workers.dev` address everywhere with your new Worker address. For the simplest Cloudflare-only installation, also set `PUBLIC_APP_ORIGIN` to that same address. Save the file and deploy again:

```bash
npm run deploy
```

Your private copy is now online. Open the Worker address and sign in with your `OWNER_TOKEN`.

### 6. Connect Instagram

1. In [Meta for Developers](https://developers.facebook.com/apps/), create an app with the Instagram messaging/content use case.
2. Add your Instagram Professional account as a tester while the app is in development mode.
3. Set the OAuth redirect URL to `https://YOUR-WORKER.workers.dev/auth/callback`.
4. Set the webhook callback URL to `https://YOUR-WORKER.workers.dev/webhook`.
5. Enter the same random phrase you used for `META_VERIFY_TOKEN` as the webhook verification token.
6. Enable the Instagram permissions and webhook fields required by the automations you plan to use.
7. Open your Inbox Orchard dashboard, go to **Integrations → Instagram**, and connect the account.

Meta controls which permissions and messaging windows are available. Test with accounts that have a role on the Meta app before requesting Live mode or App Review.

### 7. Optional email setup

You only need one email provider to start. The easiest option is Resend:

1. Create a Resend account and verify a sending domain.
2. Create a sending-only API key.
3. In Inbox Orchard, open **Integrations → Resend**.
4. Paste the key and add an address from your verified domain.
5. Send a test email before publishing an email automation.

Gmail and Brevo instructions are farther down this README.

### Updating later

Download the newest release or pull the newest GitHub version, then run:

```bash
npm install
npm run db:migrate:remote
npm run deploy
```

Back up your data first. Do not replace `.dev.vars`, and do not copy another person's secrets or database ID.

## Developer commands

Optional demo records are never seeded automatically:

```bash
npm run db:seed:demo
```

Useful checks:

```bash
npm test
npm run typecheck
npm run lint
npm run build
node scripts/smoke.mjs
```

The smoke script expects the local server on port 5173, owner token `dev-owner-token-change-me`, mock mode, and the local Meta test secret from the example configuration. Override those with `DMFLOW_SMOKE_URL`, `DMFLOW_OWNER_TOKEN`, and `DMFLOW_META_APP_SECRET`.

### Optional production secrets

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put BREVO_API_KEY
```

Inbox Orchard never creates or upgrades a paid plan. Cloudflare and provider dashboards remain the source of truth for quota and billing.

### Optional Vercel frontend

The complete backend must remain on Cloudflare because it uses D1, Queues, cron, R2, and Workers AI bindings. Cloudflare already serves the full app, so most people should skip Vercel. If you use Vercel, replace every maintainer Worker address in [`vercel.json`](vercel.json) with your Worker address and set `PUBLIC_APP_ORIGIN` in `wrangler.jsonc` to the final Vercel address before redeploying the Worker. Vercel is only a frontend; it does not replace the Cloudflare backend.

## Meta / Instagram setup

1. Create a Meta app using the Instagram messaging/content use case.
2. Use the Instagram app ID and secret from the Instagram API setup, not an unrelated Facebook App ID pair.
3. Add the permissions needed by the features you will use, including `instagram_business_basic`, `instagram_business_manage_messages`, and comment access where applicable.
4. Register `https://YOUR-WORKER.workers.dev/auth/callback` as the OAuth redirect.
5. Configure the webhook callback as `https://YOUR-WORKER.workers.dev/webhook`, using the exact `META_VERIFY_TOKEN` secret.
6. Subscribe only to webhook fields your app has access to and complete Meta review/Live-mode requirements for accounts outside tester roles.
7. Open Inbox Orchard → Integrations → Instagram and connect the Professional account.

The send API generally requires the recipient to have contacted the professional account first. A qualifying comment can receive one private reply within Meta's allowed window; automated follow-ups require the recipient to respond and then remain within the normal messaging window. Inbox Orchard's policy layer blocks sends it knows are ineligible. Details and current official references are in [Platform limitations](docs/platform-limitations.md).

## Gmail and Google Sheets

1. Create a Google Cloud project and OAuth web client.
2. Enable Gmail API and Google Sheets API as needed.
3. Register `https://YOUR-WORKER.workers.dev/auth/google/callback`.
4. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI`.
5. In Inbox Orchard → Integrations, connect Gmail or provide a Sheet ID/range and connect Sheets.

Refresh tokens are encrypted server-side. Gmail delivery uses a conservative per-sender threshold; messages remain queued when the threshold is reached. Google may require consent-screen configuration or verification depending on who uses the OAuth app.

## Resend

1. Verify a sending domain in Resend.
2. Create a Sending access API key restricted to that domain.
3. Open Inbox Orchard → Integrations → Resend and enter the API key plus an address on the verified domain.
4. Keep the displayed daily and monthly limits aligned with the limits shown in your Resend account.

Resend is the default primary sender when connected. You can also connect Brevo and Gmail as fallbacks. Inbox Orchard only switches providers after a definite quota or authorization rejection; uncertain network failures retry with the same idempotency key so a message is not duplicated across providers.

## Brevo

Set `BREVO_API_KEY` as a Worker secret or enter a key from Inbox Orchard → Integrations with a verified sender address. The key is validated before the encrypted sender record is saved. Queue state and failures remain visible under Email.

## Workers AI

The `AI` binding and `AI_MODEL` in `wrangler.jsonc` enable optional intent classification, grounded suggestions, and workflow proposals. If AI is missing, fails, or is quota constrained, deterministic keyword/comment automation continues. Generated workflows are schema- and capability-validated and are never automatically published.

## Database and migrations

SQL migrations live in [`schema/`](schema/). Never edit an already-applied migration in a shared deployment; add a new numbered migration instead.

```bash
npm run db:migrate:local
npm run db:migrate:remote
```

The legacy `chatmany` tables remain as a compatibility path. New product domains are in `0004_dmflow_platform.sql`.

## Backup and portability

- Contacts and analytics can be downloaded as CSV.
- Each automation can be exported as normal schema-v1 JSON and imported through the automation API/UI workflow.
- Backup exports include configuration, immutable versions, resource metadata, email templates/sequences, AI configuration, and settings.
- Backup exports deliberately exclude Meta/Google/Resend/Brevo tokens and encrypted provider credentials.
- Restore validates the schema, limits the number of rows, and merges only whitelisted configuration tables.
- R2 file bytes are not embedded in JSON backups; copy the bucket separately when migrating uploaded files.

## FREE MODE behavior

`FREE_MODE=true` protects core operations in this priority order: webhook ingestion, messaging, automation execution, persistence, email queue, basic analytics, then optional analytics/AI enrichment. It does not purchase capacity or infer provider quota. Usage values are labelled as exact local counts or locally tracked estimates.

## Security

- Keep `.dev.vars`, Worker secrets, tokens, and backups out of version control.
- Use HTTPS in production and unique high-entropy values for all owner/security secrets.
- Rotate `OWNER_TOKEN`, `SESSION_SECRET`, and `ENCRYPTION_KEY` independently.
- Outbound workflow URLs require public HTTPS destinations and block obvious private-network/localhost targets.
- Uploads have size and MIME controls; webhook signatures and OAuth state are validated.

Read [`SECURITY.md`](SECURITY.md) before exposing an instance publicly.

## Platform limitations

Meta capabilities depend on account type, app mode, permissions, review status, recipient interaction, and messaging windows. Story fields and UI messaging features may not be available to every installation. Inbox Orchard shows unavailable/access-dependent capabilities rather than using scraping or browser automation. See [Platform limitations](docs/platform-limitations.md).

## Contributing and license

Issues and pull requests are welcome; read [`CONTRIBUTING.md`](CONTRIBUTING.md). Inbox Orchard is licensed under the [`MIT License`](LICENSE).

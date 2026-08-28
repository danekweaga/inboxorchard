# Inbox Orchard

Inbox Orchard is an Instagram-first, self-hosted conversation automation platform for creators. It turns eligible Instagram comments and inbound messages into durable conversations, tracked resource deliveries, lightweight CRM records, email subscribers, and measurable conversions.

It uses official Meta APIs only. There is no central Inbox Orchard service: each installation owns its Cloudflare account, credentials, database, queue, files, and provider accounts.

> Status: the core application, mock mode, workflow engine, inbox, CRM, resources, email queue, integrations, analytics, and administration UI are implemented. Real Meta, Gmail, Brevo, Google Sheets, and remote Cloudflare behavior must be verified with the deployer's own credentials. See [Platform limitations](docs/platform-limitations.md) before publishing an automation.

## What works

- Single-owner dashboard authentication with an HTTP-only signed session
- Instagram Professional account OAuth, encrypted token storage, refresh, disconnect, and capability status
- Signed, durable, idempotent webhook ingestion with queue processing, retries, failure visibility, and replay
- Inbox, contacts, tags, typed custom fields, timelines, source attribution, messaging-window status, and manual actions
- Versioned structured automations with deterministic trigger priority and duplicate-run protection
- Real pause/resume state for questions, delayed work, and waiting runs
- Keyword, comment, Story access-dependent, AI intent, webhook, schedule, tag, field, manual, and sequence triggers
- React Flow editor, validation, immutable publishing, run logs, natural-language proposal, and no-send simulator
- R2-backed uploads, link resources, tracked redirects, clicks, and conversion events
- Queue-first Gmail, Brevo, or mock email delivery with daily safety thresholds, retry, and sequences
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

## Requirements

- Node.js 22 or newer
- A Cloudflare account with Workers, D1, Queues, and R2 available
- For live Instagram: a Professional Instagram account and a Meta developer app configured for Instagram messaging
- Optional: Google OAuth credentials for Gmail/Sheets and/or a Brevo API key

The default architecture has no mandatory paid service and no mandatory custom domain. Provider free allocations and policies can change; check each provider dashboard before deploying.

## Local development

```bash
npm install
copy .env.example .dev.vars
npm run db:migrate:local
npm run dev
```

On macOS/Linux, replace `copy` with `cp`. Set strong local values for `OWNER_TOKEN`, `SESSION_SECRET`, and `ENCRYPTION_KEY` in `.dev.vars`. Keep `MOCK_MODE=true` while developing without real Instagram credentials.

Open `http://127.0.0.1:5173`, enter the `OWNER_TOKEN`, and use Simulator or the mock-event controls. Optional demo records are never seeded automatically:

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

## Cloudflare setup

Authenticate and create the resources in your own account:

```bash
npx wrangler login
npx wrangler d1 create chatmany
npx wrangler r2 bucket create dmflow-resources
npx wrangler queues create dmflow-tasks
npx wrangler queues create dmflow-dead-letter
```

Copy the D1 `database_id` returned by Wrangler into [`wrangler.jsonc`](wrangler.jsonc). Resource names can be changed, but the binding names `DB`, `RESOURCES`, `TASK_QUEUE`, and `AI` must continue to match the code unless you update both sides.

Apply remote migrations:

```bash
npm run db:migrate:remote
```

Set secrets. Use different, randomly generated values for the three owner/security secrets:

```bash
npx wrangler secret put META_APP_ID
npx wrangler secret put META_APP_SECRET
npx wrangler secret put META_VERIFY_TOKEN
npx wrangler secret put OWNER_TOKEN
npx wrangler secret put SESSION_SECRET
npx wrangler secret put ENCRYPTION_KEY
```

Optional integrations:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put BREVO_API_KEY
```

Update `REDIRECT_URI`, `GOOGLE_REDIRECT_URI`, and `PUBLIC_BASE_URL` in `wrangler.jsonc` for the final Worker address. Then deploy:

```bash
npm run deploy
```

Inbox Orchard never creates or upgrades a paid plan. Cloudflare and provider dashboards remain the source of truth for quota and billing.

### Optional Vercel frontend

The complete backend must remain on Cloudflare because it uses D1, Queues, cron, R2, and Workers AI bindings. [`vercel.json`](vercel.json) can host the built React client on Vercel and securely reverse-proxy application routes to your Worker. Replace its Worker hostname and set the same Vercel production origin in `PUBLIC_APP_ORIGIN` before deployment. This is a frontend edge only—not a replacement for the Cloudflare backend.

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
- Backup exports deliberately exclude Meta/Google/Brevo tokens and encrypted provider credentials.
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

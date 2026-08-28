# Contributing

Thanks for helping improve DMFlow Community Edition.

## Development

Use Node.js 22 or newer, install dependencies, copy `.env.example` to `.dev.vars`, keep `MOCK_MODE=true`, apply local migrations, and start Vite:

```bash
npm install
npm run db:migrate:local
npm run dev
```

Before submitting a pull request, run:

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

For runtime changes, also run `node scripts/smoke.mjs` against a local mock-mode server.

## Project rules

- Use official provider APIs only. Do not add scraping, browser automation, private APIs, or policy bypasses.
- Preserve single-tenant self-hosting and avoid mandatory SaaS dependencies.
- Do not make deterministic messaging depend on AI.
- Add a numbered migration instead of editing a migration that deployments may have applied.
- Validate untrusted input at HTTP/provider boundaries and keep provider secrets server-side.
- Store automations as versioned structured definitions, not hard-coded one-off flows.
- Add focused tests for reliability, policy, matching, execution state, and provider error behavior.
- Keep mock mode unable to send real Instagram messages.

## Pull requests

Explain the creator problem, the behavior change, migrations/configuration required, tests run, and which external behavior was mocked versus tested live. Do not include real contact data, tokens, account IDs, or screenshots containing private messages.

Security reports should follow [`SECURITY.md`](SECURITY.md), not public issues.

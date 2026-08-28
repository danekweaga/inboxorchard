# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting for this repository, or contact the repository owner privately if that feature is unavailable. Include the affected version, impact, reproduction steps, and a minimal proof of concept with all credentials and personal data removed.

## Deployment responsibilities

Inbox Orchard is self-hosted. The deployer is responsible for Cloudflare account security, Meta/Google/Brevo app configuration, legal notices, data retention, backups, and incident response.

- Store production credentials with `wrangler secret put`; never commit `.dev.vars` or tokens.
- Generate independent high-entropy values for `OWNER_TOKEN`, `SESSION_SECRET`, and `ENCRYPTION_KEY`.
- Use HTTPS and protect access to the owner token. Rotate the owner/session secrets if dashboard access is suspected.
- Back up the current encrypted database before rotating `ENCRYPTION_KEY`; existing encrypted provider credentials cannot be opened with a different key and must be reconnected.
- Restrict Meta/Google redirect URIs to the exact deployed origin.
- Review Cloudflare logs carefully; never add raw tokens, webhook bodies containing personal data, or decrypted credentials to logs.
- Keep dependencies and the Cloudflare compatibility date current, and rerun the complete verification suite after upgrades.

## Existing controls

Provider credentials remain server-side and are encrypted at rest before D1 storage. Owner sessions are HTTP-only, SameSite cookies; mutating cookie-authenticated API calls require the expected origin. Meta webhooks are verified against the raw request body and deduplicated before processing. OAuth state is short-lived and one-use. SQL uses parameterized values. Workflow webhooks use HTTPS allow-listing with private-network protections. File resources have type/size checks and are served through the Worker. Normal backups exclude credentials and tokens.

These controls reduce risk but do not make an internet-facing deployment maintenance-free. Review your provider dashboards and revoke credentials immediately after a suspected compromise.

# Platform and free-tier limitations

This document describes deliberate product limits, not workarounds. Meta and other providers can change access, pricing, and review requirements. Confirm current behavior in the linked official documentation before a production launch.

## Instagram account and permission requirements

- Instagram messaging APIs require a Professional account (Business or Creator), not a personal account.
- The app needs the official Instagram permissions for the operations it performs, including `instagram_business_manage_messages`; comment and media features need their corresponding access.
- Development-mode/tester access and production access are different. Accounts outside tester/developer roles can require Live mode, business verification, and Meta App Review/Advanced Access.
- A connected account's exact capabilities depend on permissions, webhook subscriptions, account/app configuration, and Meta rollout. DMFlow exposes these as supported, access-dependent, or unavailable.

Official reference: [Instagram API collection and permission requirements](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api?entity=request-23987686-23eacf45-3728-4e41-bcc7-6d164959327c).

## Messaging initiation and windows

- A Professional account generally cannot cold-DM arbitrary Instagram users through the Send API. The recipient must first have sent a message or otherwise opened an eligible conversation.
- Standard automated follow-ups are limited to the normal messaging window after a user's inbound message. DMFlow currently enforces 24 hours.
- Meta's Human Agent allowance is for human support, not automated follow-up. DMFlow does not use it to extend automations.
- A comment private reply is limited to one private message per qualifying comment and must be sent within Meta's allowed period (currently documented as seven days). Further messages require the recipient to respond; normal-window policy then applies.

Official references: [Instagram Send API](https://www.postman.com/meta/instagram/folder/uxudqu0/send-api), [Private replies to comments](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api?entity=request-23987686-af579d08-121e-4897-8f45-5fd41ace49df).

This is the main reason Instagram automation can feel harder than it did previously: account access, review status, conversation entry points, and time windows are now unavoidable parts of a correct implementation. DMFlow blocks or labels ineligible sends instead of scraping or bypassing the platform.

## Feature availability

Quick replies, buttons, media, icebreakers, Story-related events, referrals, reactions, reads/delivery events, and template/card behavior can vary by API surface and access level. A ManyChat feature is not proof that the same feature is exposed to every independent Meta app. DMFlow only enables a provider action when the official channel adapter and capability matrix support it.

Story reply/mention triggers are marked access-dependent. Unsupported fields remain visible as limitations rather than being simulated in production. Mock mode exists only for development and is clearly identified.

## Meta review and test behavior

Real verification needs two accounts: the connected Professional account and an eligible external/test account. Verify OAuth, webhook subscription, public comment reply, private reply, subsequent user response, standard-window follow-up, and token refresh on the deployed HTTPS URL. A passing local mock does not prove Meta has granted production access.

## Gmail

- Gmail OAuth requires the deployer's Google Cloud project, OAuth consent configuration, scopes, and redirect URI.
- Google may limit test users or require verification for wider use.
- Gmail/provider quota is authoritative in the provider dashboard. DMFlow's sender safety threshold is deliberately conservative and locally tracked; it is not a claim about Google's exact remaining quota.
- At the safety threshold or on retryable failure, queued email is retained and rescheduled. It is not silently dropped.

## Brevo and Google Sheets

Brevo requires the owner's API key and a provider-verified sender. Google Sheets requires OAuth and edit access to the selected spreadsheet. These services can change free allocations. Provider failure is isolated from Instagram ingestion and deterministic workflow state.

## Cloudflare free allocations

The configured Worker, D1, Queue, R2, cron, and optional Workers AI resources are intended to fit small single-creator deployments within available free allocations. DMFlow cannot guarantee that provider allocations remain free or that a given creator's traffic fits them. It never automatically buys capacity or enables a paid tier. The Usage page shows local counts/estimates; Cloudflare's dashboard is authoritative.

## Backups

JSON configuration backups omit access tokens, refresh tokens, provider keys, encrypted credentials, conversations, and R2 object bytes. Copy R2 separately if uploaded files must migrate. Restoring a backup merges whitelisted configuration rows and may replace rows with matching IDs.

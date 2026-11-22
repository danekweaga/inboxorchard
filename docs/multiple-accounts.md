# Connect another Instagram account

With the shared Meta app, deploy the Worker and dashboard together with the supplied `IG_ACCOUNTS` SQLite Durable Object binding and migration. Keep the existing main account's D1 binding, Meta credentials, callback URL, and secrets. Leave `WORKSPACES` unset for automatic onboarding.

Open the dashboard account selector, choose **Add Instagram account**, sign in to the additional professional profile, and approve Instagram access. Choose **Open this workspace** on the success page. The same owner login manages all linked profiles. New profiles have automatically provisioned storage; the main profile continues to use its original D1 database. Meta permissions and tester roles still apply to the shared app.

## Alternative for manually configured Meta apps

Each additional account uses the same Worker and dashboard code, with its own hostname, Meta app and D1 database. The existing account uses the original bindings and URLs. Sign in with the owner token on each hostname.

1. Create a new D1 database. Add it to the same Worker's Wrangler configuration with binding `SECOND_DB`, its own database ID and `"migrations_dir": "schema"`. Apply the schema with `npx wrangler d1 migrations apply SECOND_DB --remote`. Use a fresh database for each account.
2. Route a separate HTTPS custom domain such as `second.example.com` directly to this Worker. For uploaded resources, bind a separate bucket as `SECOND_RESOURCES`. Link resources need no bucket.
3. In the second Meta app, register `https://second.example.com/auth/callback` for Instagram login and `https://second.example.com/webhook` for Instagram notifications. Configure the comment and messaging subscriptions. Get the professional account's numeric Instagram user ID.
4. Set Worker secrets with `npx wrangler secret put NAME`, using `SECOND_META_APP_ID`, `SECOND_META_APP_SECRET`, `SECOND_META_VERIFY_TOKEN` and `SECOND_ENCRYPTION_KEY`. Use the second app's credentials, its webhook verification token, and a fresh encryption secret.
5. Set the Worker variable `WORKSPACES` to the following JSON **string**, replacing the example origin and Instagram ID. The key determines the binding and secret prefix. Keep the key stable because queued jobs use it.

   ```json
   [{"key":"SECOND","label":"Second brand","origin":"https://second.example.com","instagramId":"123456789"}]
   ```

6. Deploy the updated Worker and dashboard, choose the new workspace in the top bar, and connect Instagram under Integrations. Send a test keyword from a tester account and check that only the second workspace records it. Email senders are configured separately in that workspace.

# e-conomic MCP proxy

A tiny [Cloudflare Worker](https://developers.cloudflare.com/workers/) that lets
people use the e-conomic MCP server **without their own app and without ever
seeing the app secret token**.

The Worker holds the app secret token as an encrypted Cloudflare secret. For
each request it adds the `X-AppSecretToken` header and forwards to the e-conomic
REST API, passing through the caller's own `X-AgreementGrantToken`. So users only
need to run `e-conomic-mcp auth connect` (which gives them a grant token) — the
secret stays on your infrastructure.

```
MCP client ──(grant token)──▶  Worker ──(grant + secret)──▶  restapi.e-conomic.com
```

## Deploy

```bash
cd proxy
npm install

# Log in to Cloudflare (opens a browser the first time)
npx wrangler login

# Store the app secret token as an encrypted secret (paste it when prompted)
npx wrangler secret put ECONOMIC_APP_SECRET_TOKEN

# Deploy
npx wrangler deploy
```

`wrangler deploy` prints the Worker URL, e.g.
`https://e-conomic-mcp-proxy.<your-subdomain>.workers.dev`.

## Wire it up

Set that URL as the default base URL the MCP client uses, in
[`../src/appCredentials.ts`](../src/appCredentials.ts):

```ts
export const BUNDLED_PROXY_URL = "https://e-conomic-mcp-proxy.<your-subdomain>.workers.dev";
```

Rebuild/publish the package, and from then on `auth connect` + the server work
with just a grant token. Verify with `e-conomic-mcp doctor`.

## Health check

```bash
curl "https://<your-worker-url>/?health" -H "X-AgreementGrantToken: x"
# → ok
```

## Notes & hardening

- The Worker only ever forwards to the fixed e-conomic upstream — it is **not** an
  open proxy to arbitrary hosts.
- Anyone with a valid e-conomic grant token can route through the Worker, but a
  grant token only unlocks that caller's own agreement, so they can't reach other
  customers' data. To curb abuse of your app's quota you can add a Cloudflare
  [rate limit](https://developers.cloudflare.com/waf/rate-limiting-rules/) or a
  WAF rule in front of the Worker.
- Rotating the secret: run `wrangler secret put ECONOMIC_APP_SECRET_TOKEN` again
  with the new value, then `wrangler deploy`.

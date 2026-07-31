# Skywatch

Skywatch is a small, Cloudflare-native control plane for Workers and Cloudflare Access. It shows every Worker in an account, whether it is public or protected, and the email selectors attached to its Access policies. Access applications created by Skywatch can be switched between public and protected from the dashboard.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kodin00/skywatch)

## What gets deployed

- One TypeScript Cloudflare Worker serving the React dashboard and same-origin API routes.
- One automatically provisioned D1 database for encrypted configuration and browser sessions.
- One AES-256-GCM `secret_key` binding created during first-run setup. Cloudflare does not expose the key after it is stored.

D1 is provisioned and bound by Wrangler during deployment. After the API token is submitted, Skywatch initializes its tables, generates the Worker-only encryption key, encrypts the token, stores only ciphertext and its IV in D1, and creates an HttpOnly browser session.

## Required API token permissions

Create a custom token scoped to exactly one Cloudflare account:

- Account → Workers Scripts → Read
- Account → Workers Scripts → Edit
- Account → Access: Apps and Policies → Edit
- User → Memberships → Read

Workers Scripts Edit is required once during setup so Skywatch can add its own non-readable encryption-key binding. Access edits are limited to applications named and created by Skywatch; existing Access applications are displayed but not overwritten.

## Deploy

The button above creates the Worker, D1 binding, and Workers Builds connection. Keep the Worker name as `skywatch`, or update `SKYWATCH_WORKER_NAME` to the chosen deployment name.

For a manual deployment:

```bash
npm ci
npm run check
npm run deploy
```

After deployment, open the Worker URL and paste the scoped API token. The token is never returned to the browser or written to logs.

### First-run security

The first successful setup claims the installation and issues a session to that browser. Open the deployment immediately after creating it, or temporarily protect the fresh Worker with Cloudflare Access while onboarding. After setup, other browsers must prove possession of the same API token to unlock Skywatch.

## Local development

```bash
npm ci
npm run build
npx wrangler dev
```

Wrangler uses a local D1 database by default. The full encryption-key bootstrap calls the Cloudflare API and is intended for a deployed `skywatch` Worker, so do not submit a production token from local development unless that is intentional.

## Commands

```bash
npm run dev          # Vite frontend development
npm run build        # TypeScript + production frontend bundle
npm run cf-typegen   # Regenerate types from wrangler.jsonc
npm run check        # Types, build inputs, and Wrangler dry run
npm run deploy       # Build and deploy to Cloudflare
```

## Security model

- API tokens are encrypted with AES-256-GCM and authenticated additional data before being written to D1.
- The wrapping key is held as a Cloudflare Worker `secret_key` binding, separate from D1.
- Browser sessions are random, hashed in D1, HttpOnly, Secure, SameSite=Strict, and expire after 30 days.
- API mutations enforce same-origin requests.
- A D1-only leak does not reveal the API token. An actor with Workers Scripts Edit can still replace Worker code, so keep account membership and API-token access tightly controlled.

## License

MIT

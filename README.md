# Skywatch

Skywatch is a Cloudflare-native control plane for managing Workers, Access policies, and connected VPS infrastructure from one dashboard. It shows every Worker in an account, whether it is public or protected, the email selectors attached to its Access policies, and active Zero Trust seat usage. Access applications created by Skywatch can be switched between public and protected, while the optional VPS agent adds live host metrics and bounded Docker controls.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kodin00/skywatch)

### Manage a VPS too

After deploying Skywatch, install the optional agent on a Linux VPS with Docker and systemd:

```bash
curl -fsSL https://raw.githubusercontent.com/kodin00/skywatch/master/agent/install.sh | sudo bash
```

The installer prints the pairing key needed by the Servers view. See [`agent/README.md`](./agent/README.md) for initialization, systemd installation, and transport-specific setup.

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
- Account → Access: Audit Logs → Read
- User → Memberships → Read
- User → User Details → Read

Workers Scripts Edit is required once during setup so Skywatch can add its own non-readable encryption-key binding. User Details Read lets setup identify the token owner's email and automatically put Cloudflare Access in front of the Skywatch Worker with an owner-only policy. Access Audit Logs Read is used only to count active Access and Gateway seats; user records are counted inside the Worker and are not returned to the browser. Access edits are limited to applications named and created by Skywatch; existing Access applications are displayed but not overwritten.

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

The first successful setup claims the installation, issues a session to that browser, reads the token owner's email, and creates a Cloudflare Access application for the Skywatch Worker with an Allow policy for exactly that email. Open the deployment immediately after creating it because this protection is installed only after the setup token has been validated.

## Local development

```bash
npm ci
npm run build
npx wrangler dev
```

Wrangler uses a local D1 database by default. The full encryption-key bootstrap calls the Cloudflare API and is intended for a deployed `skywatch` Worker, so do not submit a production token from local development unless that is intentional.

### Reproducible toolchains with mise

Skywatch pins Node.js and Rust in `mise.toml`. To prepare both the dashboard and the VPS agent:

```bash
mise install
mise run setup
mise run web:dev
```

Run `mise run agent:dev` in a second terminal after generating a development agent configuration with `mise run agent:init`.

## VPS agent

The optional Rust agent in [`agent/`](./agent/) adds live host metrics and bounded Docker controls to the Servers view. Register multiple VPS nodes and switch between them from the server rack; only the selected node is polled. The browser never talks to an agent directly: Skywatch's Worker signs every request and uses that server's configured transport without automatic fallback.

The installer downloads a checksum-verified static binary from the current versioned GitHub Release, installs the hardened systemd service, and prints the pairing key needed by the Servers view. It binds to `127.0.0.1:8788` unless explicitly configured otherwise. If a release is temporarily unavailable, it falls back to a pinned Docker build.

After installation, manage the service with `skywatch status`, `skywatch stop`,
`skywatch restart`, `skywatch logs`, or `skywatch update`. Run `skywatch help` for the full,
safety-checked command list, including uninstall and permanent deletion.

- **Workers VPC Service:** private Worker-to-agent routing through `cloudflared`. The agent can remain on `127.0.0.1:8788`.
- **Public Cloudflare Tunnel URL:** normal HTTPS `fetch()` through a public tunnel hostname to the same loopback listener.
- **Public VPS IP over HTTP:** an explicit unsafe escape hatch. It requires opt-in on both the agent and dashboard and does not encrypt metrics, logs, or action metadata.

Direct HTTPS supports multiple independently paired servers. The committed `VPS_AGENT` binding is
fixed to one VPC Service, so one registered server can use VPC in this version; use distinct public
Cloudflare Tunnel hostnames for additional private-origin agents.

Follow [`agent/README.md`](./agent/README.md) for agent initialization, systemd installation, and transport-specific setup. The signing key is shown only during initialization; paste it into the Servers connection form, where Skywatch encrypts it using the same Worker-only key separation used for the Cloudflare token.

### Workers VPC binding

VPC Service IDs are installation-specific, so Skywatch does not commit a placeholder binding. After creating an HTTP VPC Service for `localhost:8788`, add its ID to the deployed Worker's Wrangler configuration or binding settings:

```jsonc
{
  "vpc_services": [
    {
      "binding": "VPS_AGENT",
      "service_id": "<YOUR_VPC_SERVICE_ID>",
      "remote": true
    }
  ]
}
```

Creating a VPC Service requires the Connectivity Directory Admin role; binding an existing service requires Connectivity Directory Bind. This is provisioned separately, so the Cloudflare API token stored by Skywatch does not need those additional permissions.

## Commands

```bash
npm run dev          # Vite frontend development
npm run build        # TypeScript + production frontend bundle
npm run test         # Worker and dashboard tests
npm run cf-typegen   # Regenerate types from wrangler.jsonc
npm run check        # Types, build inputs, and Wrangler dry run
npm run deploy       # Build and deploy to Cloudflare
mise run check       # Verify the Worker, dashboard, and Rust agent
```

## Security model

- API tokens are encrypted with AES-256-GCM and authenticated additional data before being written to D1.
- The wrapping key is held as a Cloudflare Worker `secret_key` binding, separate from D1.
- Browser sessions are random, hashed in D1, HttpOnly, Secure, SameSite=Strict, and expire after 30 days.
- API mutations enforce same-origin requests.
- A D1-only leak does not reveal the API token. An actor with Workers Scripts Edit can still replace Worker code, so keep account membership and API-token access tightly controlled.

## License

MIT

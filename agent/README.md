# Skywatch Agent

The Skywatch agent is a deliberately narrow host-side service. It reports CPU, memory,
storage, and Docker state and exposes only six Docker capabilities: list, inspect,
finite logs, start, stop, and restart. It does not proxy the Docker API and has no shell,
exec, image, volume, file, Compose, create, remove, or host-command endpoint.

Docker socket access is effectively root access. The API boundary reduces what a remote
controller can ask for, but it does not make membership in the docker group unprivileged.

## One-line installation

On a Linux VPS with Docker and systemd, this command downloads a checksum-verified static
binary from the current versioned GitHub Release, installs the hardened service, starts it, and
prints the pairing key:

    curl -fsSL https://raw.githubusercontent.com/kodin00/skywatch/master/agent/install.sh | sudo bash

The agent binds to 127.0.0.1:8788 by default. Releases include static Linux binaries for
x86_64 and arm64. If a release asset is temporarily unavailable, the installer falls
back to building with the pinned Rust Docker image. Review [`install.sh`](./install.sh)
before piping it to a root shell if you have not audited this repository. Re-running the
installer updates the binary and systemd unit, restarts the service, and preserves the existing
node UUID and pairing key.

## Management command

The installer adds a `skywatch` command for routine agent administration:

    skywatch status
    skywatch start
    skywatch stop
    skywatch restart
    skywatch logs 200
    skywatch logs --follow
    skywatch update
    skywatch config
    skywatch pairing-key

`skywatch disable` stops the service and prevents it from starting at boot; `skywatch enable`
re-enables and starts it. `skywatch uninstall` removes the service and commands while preserving
the node identity and pairing key for a later reinstall. `skywatch delete` permanently purges
that state and requires typing `DELETE`; unattended deletion additionally requires `--yes`.
Commands that mutate the installation request sudo automatically when needed.

Release assets are built by [the agent release workflow](../.github/workflows/agent-release.yml)
when an `agent-v*` tag is pushed. Unlike temporary Actions artifacts, they remain attached
to the versioned GitHub Release along with their SHA-256 files.

## Build and initialize

The repository pins Rust through mise. From the agent directory:

    mise x rust@1.97.1 -- cargo build --release
    sudo install -m 0755 target/release/skywatch-agent /usr/local/bin/
    sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin skywatch-agent
    sudo install -d -o root -g skywatch-agent -m 0750 /etc/skywatch-agent
    sudo /usr/local/bin/skywatch-agent init \
      --config /etc/skywatch-agent/config.toml \
      --key-file /etc/skywatch-agent/controller.key \
      --node-name my-vps
    sudo chown root:skywatch-agent /etc/skywatch-agent/config.toml \
      /etc/skywatch-agent/controller.key
    sudo chmod 0640 /etc/skywatch-agent/config.toml \
      /etc/skywatch-agent/controller.key

Init refuses to overwrite either file, writes both with mode 0600, and prints one pairing
value as a UUID key ID, a dot, and a base64url-without-padding 32-byte key. Paste that
value into Skywatch. It tests a signed health request and stores the key encrypted. The
raw secret is not served by any agent endpoint.

Then copy the supplied systemd unit, grant the locked user Docker socket access, and
start it:

    sudo usermod -aG docker skywatch-agent
    sudo install -m 0644 packaging/systemd/skywatch-agent.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now skywatch-agent

The unit has no writable filesystem paths. Key rotation happens outside the running
service followed by a service restart.

## VPC and direct transports

The protocol is identical for every transport:

- For Workers VPC, keep the default 127.0.0.1:8788 listener. Run cloudflared on the same
  host, register http://127.0.0.1:8788 as a fixed-scope HTTP VPC Service, and attach that
  service to the Worker as the VPS_AGENT binding. The Worker configuration shape is:

      "vpc_services": [
        { "binding": "VPS_AGENT", "service_id": "YOUR_SERVICE_ID", "remote": true }
      ]

  Tunnel, VPC Service creation, and the binding are manual deployment steps; the agent
  does not need or receive a Cloudflare API token.

- For an ordinary public Cloudflare Tunnel, keep the loopback listener and map a hostname
  to the agent in cloudflared:

      ingress:
        - hostname: agent.example.com
          service: http://127.0.0.1:8788
        - service: http_status:404

  Select direct transport in Skywatch with https://agent.example.com. This opens no VPS
  inbound port and Cloudflare terminates public TLS.

- For direct mode through a public reverse proxy, keep the agent on loopback and put
  Caddy, nginx, or another HTTPS proxy on the public address. Skywatch's endpoint must
  use HTTPS and its certificate must cover the configured hostname or literal IP.

For exceptional environments, a public plaintext listener can be enabled with both a
non-loopback listen value and allow_insecure_public_http = true, or the matching init
flag. This is intentionally noisy and is not recommended. HMAC prevents command forgery
and response tampering, but plaintext exposes metrics, container names, and logs to
observers. Firewall it tightly and migrate to HTTPS or VPC as soon as possible.

The explicit public-IP initialization form is:

    sudo /usr/local/bin/skywatch-agent init \
      --config /etc/skywatch-agent/config.toml \
      --key-file /etc/skywatch-agent/controller.key \
      --node-name my-vps \
      --listen 0.0.0.0:8788 \
      --allow-insecure-public-http

Before starting it, use the VPS firewall and provider security group to permit the agent
port only from the smallest feasible source range. Source filtering is defense in depth,
not a substitute for HMAC, and broad Cloudflare IP ranges do not identify one Worker.

The agent requires synchronized time. Signed requests outside the configured 60-second
window are rejected.

## Signed protocol

Every route requires these headers:

    X-Skywatch-Key-Id
    X-Skywatch-Timestamp
    X-Skywatch-Nonce
    X-Skywatch-Content-Sha256
    X-Skywatch-Signature

The timestamp is Unix seconds, the nonce is a UUID used once, the body digest is lowercase
SHA-256 hex, and the signature is base64url without padding. Request signatures cover:

    skywatch-agent-v1
    METHOD
    /exact/path?query
    timestamp
    nonce
    bodySha256Hex

The agent caches accepted nonces for at least twice the clock window. Every response to a
valid request echoes the key ID and nonce, supplies a new timestamp/digest, and signs:

    skywatch-agent-response-v1
    requestNonce
    numericStatus
    timestamp
    bodySha256Hex

Authentication failures are deliberately unsigned. Secrets and signing headers are marked
sensitive and never included in structured logs.

## API and limits

- GET /v1/health
- GET /v1/system
- GET /v1/containers
- GET /v1/containers/:canonical-64-hex-id
- GET /v1/containers/:canonical-64-hex-id/logs?tail=200
- POST /v1/containers/:canonical-64-hex-id/start
- POST /v1/containers/:canonical-64-hex-id/stop
- POST /v1/containers/:canonical-64-hex-id/restart

Responses contain normalized allowlisted fields. Raw inspect data, environment variables,
labels, mount source paths, and daemon error text are never returned. Log snapshots default
to 200 lines, allow at most 1,000, and stop at 1 MiB. Logs can still contain application
secrets; Skywatch does not persist them.

Metrics are sampled in the background every five seconds. Container stats use single-shot
Docker reads with bounded concurrency. Docker failure degrades health while system metrics
remain available.

## Development checks

    cargo fmt --all -- --check
    cargo clippy --all-targets --all-features -- -D warnings
    cargo test
    cargo build --release

Tests do not require a Docker daemon. A deployment should also smoke-test signed health,
inventory, a finite log read, and idempotent start/stop against a disposable container.

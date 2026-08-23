# PortUp

> Your local apps, up.

PortUp is a small utility for tracking, exposing, and later managing services running on one machine. It is meant for developers and coding agents that need to make a local server reachable without setting up a hosting platform.

The official domain is `portup.dev`.

The first version answers one question:

> Can one command turn a local server into a checkable, shareable service?

## First workflow

A developer or agent starts a server using its normal tools, then registers it:

```sh
portup add api http://127.0.0.1:3000
portup share api
```

PortUp confirms the origin responds, opens a tunnel, and reports:

```json
{
  "name": "api",
  "shared": true,
  "originStatus": "online",
  "tunnelStatus": "connected",
  "publicStatus": "unknown",
  "localUrl": "http://127.0.0.1:3000",
  "publicUrl": "https://example.trycloudflare.com",
  "checkedAt": "2026-08-23T12:00:00Z"
}
```

The dashboard shows the same state and lets the user open or remove the public URL.

## MVP

The first version includes:

- Register and remove local HTTP services.
- Check whether each origin responds.
- Share a service through a Cloudflare Quick Tunnel, or through the machine's named tunnel when one is configured.
- Check the tunnel and public URL separately from the origin.
- List services through a small web dashboard.
- Support `--json` on every CLI command for machine-readable output.
- Persist registrations and share intent across daemon restarts.

The core commands are:

```sh
portup daemon [--detach]
portup add <name> <url>
portup share <name> [--hostname <hostname>]
portup status [name] [--json]
portup unshare <name>
portup remove <name>
portup daemon stop
```

## Basic design

PortUp ships as one binary. `portup daemon` runs the background daemon; every other subcommand is a thin HTTP client to it. The daemon runs in the foreground by default (`--detach` backgrounds it with a pidfile) and serves the JSON API and the dashboard from a single localhost HTTP server on port 4700, overridable by flag or environment variable. A SQLite database stores registered services and share intent.

There is no auto-spawn: commands fail with a clear error when the daemon is not running.

### Status model

Each service tracks three independent states:

- `originStatus` (`online` | `offline`): whether the local server responds. Any well-formed HTTP response counts as online, including 500s; connection refused, reset, or timeout is offline. PortUp judges reachability, not app correctness.
- `tunnelStatus` (`connected` | `connecting` | `error`): whether cloudflared is connected. Only meaningful while shared.
- `publicStatus` (`reachable` | `unreachable` | `unknown`): whether the public URL responds. `unknown` until the first check completes.

Keeping these separate makes failures understandable. A healthy service can have a broken tunnel, and a connected tunnel can point to a stopped service.

The daemon polls all three statuses every 10 seconds; the dashboard reads that cache, and CLI `status` forces a fresh check before answering. Every service carries a `checkedAt` timestamp so consumers can see how fresh the data is.

### Share semantics

`share` refuses while the origin is offline: start the app first, then share. After a successful share the statuses are independent, so an origin that later dies shows `originStatus: "offline"` under a still-connected tunnel.

Share intent persists. When the daemon restarts, it re-opens tunnels for every shared service. In quick-tunnel mode this assigns a new public URL, because Quick Tunnel URLs are random per cloudflared process and cannot be reserved; `status` reports the new one.

### CLI contract

Output is human-readable by default; `--json` prints JSON only. Failures exit nonzero, and with `--json` they print a structured error object with a stable code:

```json
{ "error": { "code": "origin_offline", "message": "api did not respond at http://127.0.0.1:3000" } }
```

Agents branch on exit status or `error.code`, never on prose.

## Tunnels

PortUp shells out to `cloudflared`, which the install script installs alongside the binary. Mode is machine-level:

- **Quick Tunnels** are the default: no account, no DNS, a random `trycloudflare.com` URL per share. They have no uptime guarantee, do not support Server-Sent Events (the trycloudflare edge buffers `text/event-stream`), and limit concurrent in-flight requests. Good for the experiment, not production.
- **Named tunnel**, once configured, takes over all shares. After a one-time `cloudflared tunnel login` and a base domain setting, PortUp creates one locally-managed tunnel for the machine, writes ingress rules, and adds DNS routes itself. `share api` yields `api.<base domain>` by default; `--hostname` overrides it. This requires a Cloudflare account and a domain on Cloudflare, and URLs survive restarts.

An ngrok adapter can later follow the same interface for users who prefer its assigned development domains, local agent API, TCP endpoints, or traffic policies. Alchemy may eventually provision access policies and richer ingress on top of the named tunnel; PortUp works without it.

## Implementation

- The daemon and CLI are one standalone executable, built from the Bun project in `engine/`.
- The dashboard is a TypeScript app in `web/`; its built assets are embedded in the binary and served by the daemon.
- Distribution is an install script (`curl portup.dev/install.sh | sh`) that installs the portup binary and cloudflared together.

## Not in the first version

- Starting or supervising application processes.
- Docker or Docker Compose.
- Git deployments and builds.
- Caddy or another reverse proxy.
- Cloudflare access policies or Alchemy-provisioned infrastructure.
- Multiple machines, teams, databases, metrics history, or app templates.

These only enter the project after the attach-and-expose workflow proves useful.

## Success criteria

The experiment works if:

- An agent can expose an existing local service with one command.
- PortUp returns a working public URL within about ten seconds.
- The CLI output is reliable enough for an agent to parse without reading logs.
- The dashboard makes origin and tunnel failures obvious.
- Several registered services can coexist.
- We choose PortUp over invoking `cloudflared` by hand during normal development.

If a shell alias around `cloudflared` feels just as good, the experiment has answered its question and should stop there.

## Possible next steps

If the MVP earns continued use, add managed commands first:

```sh
portup run api --cwd ./api -- bun run dev
```

PortUp would own the process, capture logs, detect or accept its port, wait for it to become healthy, and expose it. Docker can then become another execution driver without changing the service model or CLI.

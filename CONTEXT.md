# PortUp

Tracks and exposes apps already running on one machine: register a local HTTP server, open a public tunnel to it, and observe whether each piece is working.

## Language

**Service**:
A named registration of a local origin URL. PortUp does not own or start the process behind it.
_Avoid_: App, endpoint, site

**Origin**:
The local HTTP server a service points at, identified by its local URL.
_Avoid_: Upstream, backend, target

**Share**:
The act of exposing a service publicly by opening a tunnel to its origin. A service is either shared or unshared.
_Avoid_: Publish, expose, deploy

**Tunnel**:
The cloudflared-managed connection that carries public traffic to an origin. Either a Quick Tunnel or the machine's Named Tunnel.
_Avoid_: Proxy, connection

**Quick Tunnel**:
An ephemeral, account-free tunnel with a random trycloudflare.com public URL that dies with its cloudflared process. The default when no Named Tunnel is configured.
_Avoid_: Temp tunnel, trycloudflare

**Named Tunnel**:
The machine's single locally-managed Cloudflare tunnel, created after a one-time cloudflared login. Gives services stable hostnames under the base domain.
_Avoid_: Permanent tunnel, custom tunnel

**Base domain**:
The Cloudflare-hosted domain configured once for Named Tunnel mode; each shared service defaults to the hostname `<service>.<base domain>`.
_Avoid_: Root domain, zone

**Public URL**:
The internet-reachable URL a tunnel assigns to a shared service. Quick Tunnel public URLs are ephemeral: each tunnel process gets a new random one.
_Avoid_: Share link, external URL

**Origin status**:
Whether the origin responds locally. Independent of tunnel and public status.

**Tunnel status**:
Whether cloudflared is connected for a service. Independent of origin and public status.

**Public status**:
Whether the public URL responds from the internet side. Independent of origin and tunnel status.

**Daemon**:
The single background process that owns tunnels, runs status checks, persists state, and serves the local API and dashboard. Started explicitly with `portup daemon`.
_Avoid_: Server, agent, engine

# portup

PortUp registers, lists, and removes local services through a local daemon.

The daemon and CLI compile to a single executable containing the Bun runtime:

```sh
pnpm install
pnpm --dir engine build
./engine/dist/portup daemon
```

In another terminal:

```sh
./engine/dist/portup add web http://127.0.0.1:3000
./engine/dist/portup status
./engine/dist/portup remove web
```

Pass `--json` for machine-readable output. The daemon listens on port 4700 by default; `--port` or `PORTUP_PORT` overrides it.

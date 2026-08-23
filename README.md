# portup

PortUp gives local services stable public URLs.

The daemon and CLI are a single Rust binary:

```sh
cargo build --manifest-path engine/Cargo.toml
./engine/target/debug/portup daemon
```

In another terminal:

```sh
./engine/target/debug/portup add web http://127.0.0.1:3000
./engine/target/debug/portup status
./engine/target/debug/portup remove web
```

Pass `--json` for machine-readable output. The daemon listens on port 4700 by default; `--port` or `PORTUP_PORT` overrides it.

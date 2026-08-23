import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { clientLayer, PortupClient } from "./client.ts";
import type { RemoveResult, ServiceList } from "./client.ts";
import { createDaemon } from "./daemon.ts";
import { PortupFailure } from "./error.ts";
import type { Service } from "./service.ts";

const VERSION = "0.0.1";

interface RuntimeOptions {
  json: boolean;
  port: number;
}

interface RuntimeFlags {
  json: boolean;
  port: Option.Option<number>;
}

type JsonOutput =
  | RemoveResult
  | Service
  | ServiceList
  | Readonly<{ address: string }>;

const runtimeFlags = {
  json: Flag.boolean("json").pipe(
    Flag.withDescription("Print JSON only"),
    Flag.withDefault(false)
  ),
  port: Flag.integer("port").pipe(
    Flag.withDescription("Daemon port (default: 4700, env: PORTUP_PORT)"),
    Flag.optional
  ),
};

const invalidPort = () =>
  new PortupFailure({
    code: "invalid_port",
    message: "port must be an integer between 1 and 65535",
  });

const resolveOptions = (
  flags: RuntimeFlags
): Effect.Effect<RuntimeOptions, PortupFailure> =>
  Effect.try({
    catch: (error) =>
      error instanceof PortupFailure
        ? error
        : new PortupFailure({
            code: "internal_error",
            message: error instanceof Error ? error.message : "PortUp failed",
          }),
    try: () => {
      const portText = process.env.PORTUP_PORT ?? "4700";
      const port = Option.isSome(flags.port)
        ? flags.port.value
        : Number(portText);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw invalidPort();
      }
      return { json: flags.json, port };
    },
  });

const databasePath = () => {
  if (process.env.PORTUP_DB_PATH) {
    return process.env.PORTUP_DB_PATH;
  }
  const dataDirectory =
    process.platform === "win32"
      ? (process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming"))
      : (process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share"));
  return path.join(dataDirectory, "portup", "portup.db");
};

const output = (value: string) => Effect.sync(() => console.log(value));

const formatService = (service: Service) =>
  `${service.name}  ${service.localUrl}  public: ${service.publicStatus}`;

const formatServices = ({ services }: ServiceList) =>
  services.length === 0
    ? "No services registered."
    : services.map(formatService).join("\n");

const print = (json: boolean, value: JsonOutput, human: string) =>
  output(json ? JSON.stringify(value) : human);

const handleFailure = (json: boolean) => (error: PortupFailure) =>
  Effect.sync(() => {
    if (json) {
      console.error(
        JSON.stringify({ error: { code: error.code, message: error.message } })
      );
    } else {
      console.error(`Error: ${error.message}`);
    }
    process.exitCode = 1;
  });

const runHandled = <A>(
  options: RuntimeOptions,
  program: Effect.Effect<A, PortupFailure, PortupClient>
) =>
  program.pipe(
    Effect.provide(clientLayer(options.port)),
    Effect.matchEffect({
      onFailure: handleFailure(options.json),
      onSuccess: Effect.succeed,
    })
  );

const portup = Command.make("portup").pipe(
  Command.withSharedFlags(runtimeFlags),
  Command.withDescription("Share local services through stable public URLs")
);

const withRuntimeOptions = <A>(
  run: (
    options: RuntimeOptions
  ) => Effect.Effect<A, PortupFailure, PortupClient>
) =>
  Effect.gen(function* resolveCommandOptions() {
    const flags = yield* portup;
    const options = yield* resolveOptions(flags);
    yield* runHandled(options, run(options));
  });

const daemon = Command.make("daemon", {}, () =>
  withRuntimeOptions((options) =>
    Effect.acquireUseRelease(
      Effect.try({
        catch: (error) =>
          new PortupFailure({
            code: "internal_error",
            message: error instanceof Error ? error.message : "PortUp failed",
          }),
        try: () => {
          const database = databasePath();
          mkdirSync(path.dirname(database), { recursive: true });
          return createDaemon(database, options.port);
        },
      }),
      (server) =>
        print(
          options.json,
          { address: `127.0.0.1:${server.port}` },
          `PortUp daemon listening on http://127.0.0.1:${server.port}`
        ).pipe(Effect.andThen(Effect.never)),
      (server) => Effect.promise(() => server.stop(true))
    )
  )
).pipe(Command.withDescription("Run the local daemon in the foreground"));

const add = Command.make(
  "add",
  {
    name: Argument.string("name").pipe(
      Argument.withDescription("Service name")
    ),
    url: Argument.string("url").pipe(
      Argument.withDescription("Local HTTP URL")
    ),
  },
  ({ name, url }) =>
    withRuntimeOptions((options) =>
      Effect.gen(function* addService() {
        const client = yield* PortupClient;
        const service = yield* client.add(name, url);
        yield* print(
          options.json,
          service,
          `Added ${service.name} at ${service.localUrl}`
        );
      })
    )
).pipe(Command.withDescription("Register a local service"));

const remove = Command.make(
  "remove",
  {
    name: Argument.string("name").pipe(
      Argument.withDescription("Service name")
    ),
  },
  ({ name }) =>
    withRuntimeOptions((options) =>
      Effect.gen(function* removeService() {
        const client = yield* PortupClient;
        const removed = yield* client.remove(name);
        yield* print(options.json, removed, `Removed ${removed.name}`);
      })
    )
).pipe(Command.withDescription("Remove a registered service"));

const status = Command.make(
  "status",
  {
    name: Argument.string("name").pipe(
      Argument.withDescription("Service name"),
      Argument.optional
    ),
  },
  ({ name }) =>
    withRuntimeOptions((options) =>
      Effect.gen(function* showStatus() {
        const client = yield* PortupClient;
        if (Option.isSome(name)) {
          const service = yield* client.status(name.value);
          yield* print(options.json, service, formatService(service));
        } else {
          const services = yield* client.list();
          yield* print(options.json, services, formatServices(services));
        }
      })
    )
).pipe(Command.withDescription("Show one service or list all services"));

const command = portup.pipe(
  Command.withSubcommands([daemon, add, remove, status])
);

const cli = Command.run(command, { version: VERSION });

if (import.meta.main) {
  cli.pipe(
    Effect.provide(BunServices.layer),
    Effect.matchEffect({
      onFailure: () =>
        Effect.sync(() => {
          process.exitCode = 1;
        }),
      onSuccess: Effect.succeed,
    }),
    BunRuntime.runMain({ disableErrorReporting: true })
  );
}

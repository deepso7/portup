import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { Effect } from "effect";

import { clientLayer, PortupClient } from "./client.ts";
import type { RemoveResult, ServiceList } from "./client.ts";
import { createDaemon } from "./daemon.ts";
import { PortupFailure } from "./error.ts";
import type { Service } from "./service.ts";

const VERSION = "0.0.1";

interface Options {
  command: string[];
  json: boolean;
  port: number;
}

type JsonOutput =
  | RemoveResult
  | Service
  | ServiceList
  | Readonly<{ address: string }>;

const invalidPort = () =>
  new PortupFailure({
    code: "invalid_port",
    message: "port must be an integer between 1 and 65535",
  });

const readPort = (arguments_: string[]) => {
  let portText = process.env.PORTUP_PORT ?? "4700";
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--port") {
      const value = arguments_[index + 1];
      if (value === undefined) {
        throw invalidPort();
      }
      portText = value;
      index += 1;
    } else if (argument?.startsWith("--port=")) {
      portText = argument.slice("--port=".length);
    }
  }

  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw invalidPort();
  }
  return port;
};

const parseArguments = (arguments_: string[]): Options => {
  const port = readPort(arguments_);
  let json = false;
  const command: string[] = [];

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--json") {
      json = true;
    } else if (argument === "--port") {
      index += 1;
    } else if (argument !== undefined && !argument.startsWith("--port=")) {
      command.push(argument);
    }
  }
  return { command, json, port };
};

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

const helpText = () => `PortUp ${VERSION}

Usage:
  portup daemon
  portup add <name> <url>
  portup remove <name>
  portup status [name]

Options:
  --json         Print JSON only
  --port <port>  Daemon port (default: 4700, env: PORTUP_PORT)
  --help         Print help
  --version      Print version`;

const waitForSignal = () =>
  Effect.async<null>((resume) => {
    const stop = () => resume(Effect.succeed(null));
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return Effect.sync(() => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    });
  });

const runDaemon = ({ json, port }: Options) =>
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
        return createDaemon(database, port);
      },
    }),
    (daemon) =>
      Effect.gen(function* runForegroundDaemon() {
        yield* print(
          json,
          { address: `127.0.0.1:${daemon.port}` },
          `PortUp daemon listening on http://127.0.0.1:${daemon.port}`
        );
        yield* waitForSignal();
      }),
    (daemon) => Effect.promise(() => daemon.stop(true))
  );

const run = (options: Options) => {
  const [name, ...arguments_] = options.command;
  if (name === "--help" || name === "help") {
    return output(helpText());
  }
  if (name === "--version") {
    return output(VERSION);
  }
  if (name === "daemon" && arguments_.length === 0) {
    return runDaemon(options);
  }

  return Effect.gen(function* runCommand() {
    const client = yield* PortupClient;
    const [first, second] = arguments_;
    if (name === "add" && first !== undefined && second !== undefined) {
      const service = yield* client.add(first, second);
      yield* print(
        options.json,
        service,
        `Added ${service.name} at ${service.localUrl}`
      );
      return;
    }
    if (name === "remove" && arguments_.length === 1 && first !== undefined) {
      const removed = yield* client.remove(first);
      yield* print(options.json, removed, `Removed ${removed.name}`);
      return;
    }
    if (name === "status" && arguments_.length === 1 && first !== undefined) {
      const service = yield* client.status(first);
      yield* print(options.json, service, formatService(service));
      return;
    }
    if (name === "status" && arguments_.length === 0) {
      const services = yield* client.list();
      yield* print(options.json, services, formatServices(services));
      return;
    }

    return yield* new PortupFailure({
      code: "invalid_arguments",
      message: "invalid command; run 'portup --help' for usage",
    });
  });
};

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

const main = async () => {
  const arguments_ = process.argv.slice(2);
  const json = arguments_.includes("--json");
  const program = Effect.try({
    catch: (error) =>
      error instanceof PortupFailure
        ? error
        : new PortupFailure({
            code: "internal_error",
            message: error instanceof Error ? error.message : "PortUp failed",
          }),
    try: () => parseArguments(arguments_),
  }).pipe(
    Effect.flatMap((options) =>
      run(options).pipe(Effect.provide(clientLayer(options.port)))
    ),
    Effect.catchAll(handleFailure(json))
  );
  await Effect.runPromise(program);
};

if (import.meta.main) {
  await main();
}

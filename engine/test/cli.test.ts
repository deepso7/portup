import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Schema } from "effect";

import { createDaemon } from "../src/daemon.ts";
import type { Daemon } from "../src/daemon.ts";
import { ServiceSchema } from "../src/service.ts";

const executable = path.join(import.meta.dir, "../dist/portup");
const servers: Daemon[] = [];
const hungServers: Bun.Server<unknown>[] = [];
const directories: string[] = [];
const tokens = new Map<number, string>();

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
  await Promise.all(hungServers.splice(0).map((server) => server.stop(true)));
  tokens.clear();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const startDaemon = async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "portup-"));
  directories.push(directory);
  const server = await createDaemon(path.join(directory, "portup.db"), 0);
  servers.push(server);
  tokens.set(server.port, server.token);
  return server.port;
};

const runExecutable = async (
  arguments_: string[],
  environment: Readonly<Record<string, string | undefined>> = {}
) => {
  const child = Bun.spawn([executable, ...arguments_], {
    env: { ...process.env, ...environment },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
};

const runPortup = (port: number, ...arguments_: string[]) =>
  runExecutable(["--port", `${port}`, ...arguments_], {
    PORTUP_TOKEN: tokens.get(port),
  });

describe("compiled CLI", () => {
  test("generates root help", async () => {
    const help = await runPortup(4700, "--help");

    expect(help.exitCode).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain("COMMANDS");
    expect(help.stdout).toContain("add");
    expect(help.stdout).toContain("daemon");
    expect(help.stdout).toContain("remove");
    expect(help.stdout).toContain("status");
  });

  test("generates help for every subcommand", async () => {
    const commands = ["add", "daemon", "remove", "status"];
    const results = await Promise.all(
      commands.map(async (command) => ({
        command,
        help: await runPortup(4700, command, "--help"),
      }))
    );

    for (const { command, help } of results) {
      expect(help.exitCode).toBe(0);
      expect(help.stderr).toBe("");
      expect(help.stdout).toContain(command);
    }
  });

  test("round-trips JSON through the daemon", async () => {
    const port = await startDaemon();
    const added = await runPortup(
      port,
      "--json",
      "add",
      "api",
      "http://127.0.0.1:3000"
    );
    expect(added.exitCode).toBe(0);
    expect(added.stderr).toBe("");
    const service = Schema.decodeUnknownSync(ServiceSchema)(
      JSON.parse(added.stdout)
    );
    expect(service).toMatchObject({
      localUrl: "http://127.0.0.1:3000",
      name: "api",
      publicStatus: "unknown",
    });
    expect(Object.keys(service)).toHaveLength(8);

    const status = await runPortup(port, "--json", "status", "api");
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toEqual(service);

    const removed = await runPortup(port, "--json", "remove", "api");
    expect(removed.exitCode).toBe(0);
    expect(JSON.parse(removed.stdout)).toEqual({
      name: "api",
      removed: true,
    });
  });

  test("uses human-readable output by default", async () => {
    const port = await startDaemon();
    const added = await runPortup(port, "add", "web", "http://127.0.0.1:3000");

    expect(added.exitCode).toBe(0);
    expect(added.stdout).toBe("Added web at http://127.0.0.1:3000\n");
    expect(added.stderr).toBe("");
  });

  test("returns a stable JSON error when the daemon is down", async () => {
    const port = await startDaemon();
    const server = servers.pop();
    if (!server) {
      throw new Error("test daemon was not started");
    }
    await server.stop(true);

    const status = await runPortup(port, "--json", "status");
    expect(status.exitCode).not.toBe(0);
    expect(status.stdout).toBe("");
    expect(JSON.parse(status.stderr)).toEqual({
      error: {
        code: "daemon_not_running",
        message: `PortUp daemon is not running at http://127.0.0.1:${port}`,
      },
    });
  });

  test("reports a daemon timeout separately from a connection failure", async () => {
    const server = Bun.serve({
      fetch: async () => {
        await Bun.sleep(5500);
        return new Response();
      },
      hostname: "127.0.0.1",
      port: 0,
    });
    hungServers.push(server);
    if (server.port === undefined) {
      throw new Error("hung test server has no port");
    }

    const status = await runPortup(server.port, "--json", "status");
    expect(status.exitCode).not.toBe(0);
    expect(status.stdout).toBe("");
    expect(JSON.parse(status.stderr)).toEqual({
      error: {
        code: "daemon_timeout",
        message: `PortUp daemon at http://127.0.0.1:${server.port} did not respond within 5 seconds`,
      },
    });
  }, 7000);

  test("preserves an HTTP error envelope from the daemon", async () => {
    const port = await startDaemon();
    const first = await runPortup(
      port,
      "--json",
      "add",
      "api",
      "http://127.0.0.1:3000"
    );
    expect(first.exitCode).toBe(0);

    const duplicate = await runPortup(
      port,
      "--json",
      "add",
      "api",
      "http://127.0.0.1:3001"
    );
    expect(duplicate.exitCode).not.toBe(0);
    expect(duplicate.stdout).toBe("");
    expect(JSON.parse(duplicate.stderr)).toEqual({
      error: {
        code: "service_already_exists",
        message: "service 'api' is already registered",
      },
    });
  });

  test("returns a stable JSON error for an invalid port", async () => {
    const status = await runPortup(0, "--json", "status");

    expect(status.exitCode).not.toBe(0);
    expect(status.stdout).toBe("");
    expect(JSON.parse(status.stderr)).toEqual({
      error: {
        code: "invalid_port",
        message: "port must be an integer between 1 and 65535",
      },
    });
  });

  test("rejects a non-decimal environment port", async () => {
    const status = await runExecutable(["--json", "status"], {
      PORTUP_PORT: "0x125C",
    });

    expect(status.exitCode).not.toBe(0);
    expect(status.stdout).toBe("");
    expect(JSON.parse(status.stderr)).toEqual({
      error: {
        code: "invalid_port",
        message: "port must be an integer between 1 and 65535",
      },
    });
  });

  test("returns only JSON when command arguments are invalid", async () => {
    const add = await runPortup(4700, "--json", "add");

    expect(add.exitCode).not.toBe(0);
    expect(add.stdout).toBe("");
    expect(JSON.parse(add.stderr)).toEqual({
      error: {
        code: "invalid_arguments",
        message: "invalid command arguments",
      },
    });
  });

  test("runs a foreground daemon on the environment port", async () => {
    const port = await startDaemon();
    const reservation = servers.pop();
    if (!reservation) {
      throw new Error("test daemon was not started");
    }
    await reservation.stop(true);
    const directory = directories.at(-1);
    if (!directory) {
      throw new Error("test directory was not created");
    }

    const database = path.join(directory, "compiled-portup.db");
    const child = Bun.spawn([executable, "daemon", "--json"], {
      env: {
        ...process.env,
        PORTUP_DB_PATH: database,
        PORTUP_PORT: `${port}`,
        PORTUP_TOKEN: undefined,
      },
      stderr: "pipe",
      stdout: "pipe",
    });

    try {
      const reader = child.stdout.getReader();
      const startup = await reader.read();
      reader.releaseLock();
      expect(startup.done).toBe(false);
      expect(
        JSON.parse(new TextDecoder().decode(startup.value).trim())
      ).toEqual({
        address: `127.0.0.1:${port}`,
      });

      const tokenPath = `${database}.token`;
      const token = readFileSync(tokenPath, "utf-8");
      expect(token).toHaveLength(43);
      expect(statSync(directory).mode % 0o1000).toBe(0o700);
      expect(statSync(database).mode % 0o1000).toBe(0o600);
      expect(statSync(tokenPath).mode % 0o1000).toBe(0o600);

      const status = await runExecutable(
        ["--port", `${port}`, "--json", "status"],
        { PORTUP_TOKEN: token }
      );
      expect(status.exitCode).toBe(0);
      expect(JSON.parse(status.stdout)).toEqual({ services: [] });
    } finally {
      child.kill();
      await child.exited;
    }
  });
});

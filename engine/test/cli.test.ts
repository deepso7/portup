import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDaemon } from "../src/daemon.ts";
import type { Daemon } from "../src/daemon.ts";

const executable = path.join(import.meta.dir, "../dist/portup");
const servers: Daemon[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const startDaemon = () => {
  const directory = mkdtempSync(path.join(tmpdir(), "portup-"));
  directories.push(directory);
  const server = createDaemon(path.join(directory, "portup.db"), 0);
  servers.push(server);
  return server.port;
};

const runPortup = async (port: number, ...arguments_: string[]) => {
  const child = Bun.spawn([executable, "--port", `${port}`, ...arguments_], {
    env: { ...process.env },
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

describe("compiled CLI", () => {
  test("round-trips JSON through the daemon", async () => {
    const port = startDaemon();
    const added = await runPortup(
      port,
      "--json",
      "add",
      "api",
      "http://127.0.0.1:3000"
    );
    expect(added.exitCode).toBe(0);
    expect(added.stderr).toBe("");
    const service = JSON.parse(added.stdout);
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
    const port = startDaemon();
    const added = await runPortup(port, "add", "web", "http://127.0.0.1:3000");

    expect(added.exitCode).toBe(0);
    expect(added.stdout).toBe("Added web at http://127.0.0.1:3000\n");
    expect(added.stderr).toBe("");
  });

  test("returns a stable JSON error when the daemon is down", async () => {
    const port = startDaemon();
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

  test("runs a foreground daemon on the environment port", async () => {
    const port = startDaemon();
    const reservation = servers.pop();
    if (!reservation) {
      throw new Error("test daemon was not started");
    }
    await reservation.stop(true);
    const directory = directories.at(-1);
    if (!directory) {
      throw new Error("test directory was not created");
    }

    const child = Bun.spawn([executable, "daemon", "--json"], {
      env: {
        ...process.env,
        PORTUP_DB_PATH: path.join(directory, "compiled-portup.db"),
        PORTUP_PORT: `${port}`,
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

      const status = await runPortup(port, "--json", "status");
      expect(status.exitCode).toBe(0);
      expect(JSON.parse(status.stdout)).toEqual({ services: [] });
    } finally {
      child.kill();
      await child.exited;
    }
  });
});

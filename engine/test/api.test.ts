import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDaemon } from "../src/daemon.ts";
import type { Daemon } from "../src/daemon.ts";

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
  return `http://127.0.0.1:${server.port}`;
};

describe("daemon HTTP interface", () => {
  test("registers a service and returns its full status", async () => {
    const baseUrl = startDaemon();
    const registration = await fetch(`${baseUrl}/api/services`, {
      body: JSON.stringify({
        localUrl: "http://127.0.0.1:3000",
        name: "api",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(registration.status).toBe(201);
    const created = await registration.json();
    expect(created).toEqual({
      checkedAt: null,
      localUrl: "http://127.0.0.1:3000",
      name: "api",
      originStatus: null,
      publicStatus: "unknown",
      publicUrl: null,
      shared: false,
      tunnelStatus: null,
    });

    const status = await fetch(`${baseUrl}/api/services/api`);
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual(created);
  });

  test("lists and removes several services independently", async () => {
    const baseUrl = startDaemon();
    const registrations = await Promise.all(
      [
        ["web", "http://127.0.0.1:3000"],
        ["api", "http://127.0.0.1:4000"],
      ].map(([name, localUrl]) =>
        fetch(`${baseUrl}/api/services`, {
          body: JSON.stringify({ localUrl, name }),
          headers: { "content-type": "application/json" },
          method: "POST",
        })
      )
    );
    expect(registrations.every(({ status }) => status === 201)).toBe(true);

    const list = await fetch(`${baseUrl}/api/services`);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      services: [{ name: "api" }, { name: "web" }],
    });

    const removed = await fetch(`${baseUrl}/api/services/api`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ name: "api", removed: true });

    const missing = await fetch(`${baseUrl}/api/services/api`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: {
        code: "service_not_found",
        message: "service 'api' is not registered",
      },
    });

    const remaining = await fetch(`${baseUrl}/api/services/web`);
    expect(remaining.status).toBe(200);
    expect(await remaining.json()).toMatchObject({
      name: "web",
    });
  });

  test("keeps registrations across a daemon restart", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "portup-"));
    directories.push(directory);
    const databasePath = path.join(directory, "portup.db");
    const first = createDaemon(databasePath, 0);

    const registration = await fetch(
      `http://127.0.0.1:${first.port}/api/services`,
      {
        body: JSON.stringify({
          localUrl: "http://127.0.0.1:3000",
          name: "api",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }
    );
    expect(registration.status).toBe(201);
    await first.stop(true);

    const second = createDaemon(databasePath, 0);
    servers.push(second);
    const status = await fetch(
      `http://127.0.0.1:${second.port}/api/services/api`
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      localUrl: "http://127.0.0.1:3000",
      name: "api",
    });
  });

  test("returns stable validation and duplicate errors", async () => {
    const baseUrl = startDaemon();
    await Promise.all(
      [
        [
          { localUrl: "http://127.0.0.1:3000", name: "Bad Name" },
          "invalid_service_name",
        ],
        [{ localUrl: "not a URL", name: "api" }, "invalid_local_url"],
      ].map(async ([body, code]) => {
        const response = await fetch(`${baseUrl}/api/services`, {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code } });
      })
    );

    const body = { localUrl: "http://127.0.0.1:3000", name: "api" };
    await fetch(`${baseUrl}/api/services`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const duplicate = await fetch(`${baseUrl}/api/services`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({
      error: {
        code: "service_already_exists",
        message: "service 'api' is already registered",
      },
    });
  });
});

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

const startDaemon = async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "portup-"));
  directories.push(directory);
  const server = await createDaemon(path.join(directory, "portup.db"), 0);
  servers.push(server);
  return server;
};

const request = (server: Daemon, pathname: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${server.port}${pathname}`, {
    ...init,
    headers: {
      ...init.headers,
      authorization: `Bearer ${server.token}`,
    },
  });

describe("daemon HTTP interface", () => {
  test("registers a service and returns its full status", async () => {
    const server = await startDaemon();
    const registration = await request(server, "/api/services", {
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

    const status = await request(server, "/api/services/api");
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual(created);
  });

  test("requires a bearer token and a loopback Host header", async () => {
    const server = await startDaemon();
    const baseUrl = `http://127.0.0.1:${server.port}`;

    const unauthenticated = await fetch(`${baseUrl}/api/services`);
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toEqual({
      error: {
        code: "unauthorized",
        message: "a valid daemon bearer token is required",
      },
    });

    const rebound = await fetch(`${baseUrl}/api/services`, {
      headers: {
        authorization: `Bearer ${server.token}`,
        host: "evil.example",
      },
    });
    expect(rebound.status).toBe(403);
    expect(await rebound.json()).toEqual({
      error: {
        code: "invalid_host",
        message: "Host must identify a loopback address",
      },
    });

    const disguisedHost = await fetch(`${baseUrl}/api/services`, {
      headers: {
        authorization: `Bearer ${server.token}`,
        host: "evil.example@127.0.0.1",
      },
    });
    expect(disguisedHost.status).toBe(403);
  });

  test("lists and removes several services independently", async () => {
    const server = await startDaemon();
    const registrations = await Promise.all(
      [
        ["web", "http://127.0.0.1:3000"],
        ["api", "http://127.0.0.1:4000"],
      ].map(([name, localUrl]) =>
        request(server, "/api/services", {
          body: JSON.stringify({ localUrl, name }),
          headers: { "content-type": "application/json" },
          method: "POST",
        })
      )
    );
    expect(registrations.every(({ status }) => status === 201)).toBe(true);

    const list = await request(server, "/api/services");
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      services: [
        { localUrl: "http://127.0.0.1:4000", name: "api" },
        { localUrl: "http://127.0.0.1:3000", name: "web" },
      ],
    });

    const removed = await request(server, "/api/services/api", {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ name: "api", removed: true });

    const missing = await request(server, "/api/services/api");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: {
        code: "service_not_found",
        message: "service 'api' is not registered",
      },
    });

    const remaining = await request(server, "/api/services/web");
    expect(remaining.status).toBe(200);
    expect(await remaining.json()).toMatchObject({
      localUrl: "http://127.0.0.1:3000",
      name: "web",
    });
  });

  test("keeps registrations across a daemon restart", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "portup-"));
    directories.push(directory);
    const databasePath = path.join(directory, "portup.db");
    const first = await createDaemon(databasePath, 0);

    const registration = await request(first, "/api/services", {
      body: JSON.stringify({
        localUrl: "http://127.0.0.1:3000",
        name: "api",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(registration.status).toBe(201);
    await first.stop(true);

    const second = await createDaemon(databasePath, 0);
    servers.push(second);
    const status = await request(second, "/api/services/api");
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      localUrl: "http://127.0.0.1:3000",
      name: "api",
    });
  });

  test("returns stable validation and duplicate errors", async () => {
    const server = await startDaemon();
    const invalidRegistrations = [
      {
        body: { localUrl: "http://127.0.0.1:3000", name: "Bad Name" },
        error: {
          code: "invalid_service_name",
          message: "service name must be a lowercase DNS label",
        },
      },
      {
        body: { localUrl: "not a URL", name: "api" },
        error: {
          code: "invalid_local_url",
          message:
            "local URL must use http or https and a loopback host with a usable port",
        },
      },
    ];

    await Promise.all(
      invalidRegistrations.map(async ({ body, error }) => {
        const response = await request(server, "/api/services", {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error });
      })
    );

    const body = { localUrl: "http://127.0.0.1:3000", name: "api" };
    await request(server, "/api/services", {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const duplicate = await request(server, "/api/services", {
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

  test("only registers usable loopback HTTP URLs", async () => {
    const server = await startDaemon();
    const rejectedUrls = [
      "http://evil.example:3000",
      "http://169.254.169.254/latest/meta-data",
      "http://192.168.1.10:3000",
      "http://127.0.0.1:0",
    ];

    await Promise.all(
      rejectedUrls.map(async (localUrl, index) => {
        const response = await request(server, "/api/services", {
          body: JSON.stringify({ localUrl, name: `service-${index}` }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: {
            code: "invalid_local_url",
            message:
              "local URL must use http or https and a loopback host with a usable port",
          },
        });
      })
    );
  });

  test("returns stable errors for malformed and empty service paths", async () => {
    const server = await startDaemon();
    const malformed = await request(server, "/api/services/%zz");

    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      error: {
        code: "invalid_request",
        message: "service path must use valid percent encoding",
      },
    });

    await Promise.all(
      ["GET", "DELETE"].map(async (method) => {
        const empty = await request(server, "/api/services/", { method });
        expect(empty.status).toBe(400);
        expect(await empty.json()).toEqual({
          error: {
            code: "invalid_request",
            message: "service path must contain a valid service name",
          },
        });
      })
    );
  });
});

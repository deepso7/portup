import { Option, Schema } from "effect";

import { Store } from "./store.ts";

const RegistrationSchema = Schema.Struct({
  localUrl: Schema.String,
  name: Schema.String,
});

export interface Daemon {
  readonly port: number;
  readonly stop: (closeActiveConnections?: boolean) => Promise<void>;
}

const errorResponse = (
  status: number,
  code: string,
  message: string
): Response => Response.json({ error: { code, message } }, { status });

const isServiceName = (name: string) =>
  /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(name);

const isLocalUrl = (value: string) => {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname.length > 0 &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.hash.length === 0
    );
  } catch {
    return false;
  }
};

const addService = async (request: Request, store: Store) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(
      400,
      "invalid_request",
      "request body must be valid service JSON"
    );
  }

  const decoded = Schema.decodeUnknownOption(RegistrationSchema)(body);
  if (Option.isNone(decoded)) {
    return errorResponse(
      400,
      "invalid_request",
      "request body must be valid service JSON"
    );
  }
  const registration = decoded.value;
  if (!isServiceName(registration.name)) {
    return errorResponse(
      400,
      "invalid_service_name",
      "service name must be a lowercase DNS label"
    );
  }
  if (!isLocalUrl(registration.localUrl)) {
    return errorResponse(
      400,
      "invalid_local_url",
      "local URL must be an http or https URL with a host"
    );
  }

  const service = store.add(registration.name, registration.localUrl);
  return service
    ? Response.json(service, { status: 201 })
    : errorResponse(
        409,
        "service_already_exists",
        `service '${registration.name}' is already registered`
      );
};

const route = (
  request: Request,
  store: Store
): Response | Promise<Response> => {
  const { pathname } = new URL(request.url);
  if (request.method === "POST" && pathname === "/api/services") {
    return addService(request, store);
  }
  if (request.method === "GET" && pathname === "/api/services") {
    return Response.json({ services: store.list() });
  }
  if (
    (request.method === "GET" || request.method === "DELETE") &&
    pathname.startsWith("/api/services/")
  ) {
    let name: string;
    try {
      name = decodeURIComponent(pathname.slice("/api/services/".length));
    } catch {
      return errorResponse(
        400,
        "invalid_request",
        "service path must use valid percent encoding"
      );
    }

    if (request.method === "GET") {
      const service = store.get(name);
      if (service) {
        return Response.json(service);
      }
    } else if (store.remove(name)) {
      return Response.json({ name, removed: true });
    }

    return errorResponse(
      404,
      "service_not_found",
      `service '${name}' is not registered`
    );
  }
  return errorResponse(400, "invalid_request", "unknown route");
};

export const createDaemon = (databasePath: string, port: number): Daemon => {
  const store = new Store(databasePath);
  const server = Bun.serve({
    fetch: (request) => route(request, store),
    hostname: "127.0.0.1",
    port,
  });
  if (server.port === undefined) {
    void server.stop(true);
    store.close();
    throw new Error("daemon did not bind a TCP port");
  }

  return {
    port: server.port,
    stop: async (closeActiveConnections) => {
      await server.stop(closeActiveConnections);
      store.close();
    },
  };
};

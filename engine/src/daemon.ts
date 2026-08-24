import { Effect, ManagedRuntime, Option, Schema } from "effect";

import { Store, storeLayer } from "./store.ts";

const catchEffect = Effect.catch;

const RegistrationSchema = Schema.Struct({
  localUrl: Schema.String,
  name: Schema.String,
});

export interface Daemon {
  readonly port: number;
  readonly token: string;
  readonly stop: (closeActiveConnections?: boolean) => Promise<void>;
}

const errorResponse = (
  status: number,
  code: string,
  message: string
): Response => Response.json({ error: { code, message } }, { status });

const isServiceName = (name: string) =>
  /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(name);

const isLoopbackHostname = (hostname: string) => {
  if (hostname === "localhost" || hostname === "[::1]") {
    return true;
  }
  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255)
  );
};

const isLoopbackHost = (host: string) => {
  try {
    const url = new URL(`http://${host}`);
    return (
      isLoopbackHostname(url.hostname) &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.pathname === "/" &&
      url.search.length === 0 &&
      url.hash.length === 0
    );
  } catch {
    return false;
  }
};

const isLocalUrl = (value: string) => {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      isLoopbackHostname(url.hostname) &&
      url.port !== "0" &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.hash.length === 0
    );
  } catch {
    return false;
  }
};

const addService = (request: Request) =>
  Effect.gen(function* addServiceEffect() {
    const body = yield* Effect.tryPromise({
      catch: () => null,
      try: () => request.json(),
    }).pipe(catchEffect(() => Effect.succeed(null)));

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
        "local URL must use http or https and a loopback host with a usable port"
      );
    }

    const store = yield* Store;
    const service = yield* store.add(registration.name, registration.localUrl);
    return service
      ? Response.json(service, { status: 201 })
      : errorResponse(
          409,
          "service_already_exists",
          `service '${registration.name}' is already registered`
        );
  });

const route = (request: Request, token: string) =>
  Effect.gen(function* routeEffect() {
    const host = request.headers.get("host");
    if (!host || !isLoopbackHost(host)) {
      return errorResponse(
        403,
        "invalid_host",
        "Host must identify a loopback address"
      );
    }

    if (request.headers.get("authorization") !== `Bearer ${token}`) {
      return errorResponse(
        401,
        "unauthorized",
        "a valid daemon bearer token is required"
      );
    }

    const { pathname } = new URL(request.url);
    if (request.method === "POST" && pathname === "/api/services") {
      return yield* addService(request);
    }
    if (request.method === "GET" && pathname === "/api/services") {
      const store = yield* Store;
      return Response.json({ services: yield* store.list() });
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
      if (!isServiceName(name)) {
        return errorResponse(
          400,
          "invalid_request",
          "service path must contain a valid service name"
        );
      }

      const store = yield* Store;
      if (request.method === "GET") {
        const service = yield* store.get(name);
        if (service) {
          return Response.json(service);
        }
      } else if (yield* store.remove(name)) {
        return Response.json({ name, removed: true });
      }

      return errorResponse(
        404,
        "service_not_found",
        `service '${name}' is not registered`
      );
    }
    return errorResponse(400, "invalid_request", "unknown route");
  });

export const createDaemon = async (
  databasePath: string,
  port: number,
  token: string = crypto.randomUUID()
): Promise<Daemon> => {
  const runtime = ManagedRuntime.make(storeLayer(databasePath));
  try {
    // Build the layer before binding so startup reports schema failures.
    await runtime.runPromise(Store);
  } catch (error) {
    await runtime.dispose();
    throw error;
  }

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      fetch: (request) =>
        runtime.runPromise(
          route(request, token).pipe(
            catchEffect(() =>
              Effect.succeed(
                errorResponse(500, "internal_error", "PortUp daemon failed")
              )
            )
          )
        ),
      hostname: "127.0.0.1",
      port,
    });
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
  if (server.port === undefined) {
    try {
      await server.stop(true);
    } finally {
      await runtime.dispose();
    }
    throw new Error("daemon did not bind a TCP port");
  }

  return {
    port: server.port,
    stop: async (closeActiveConnections) => {
      try {
        await server.stop(closeActiveConnections);
      } finally {
        await runtime.dispose();
      }
    },
    token,
  };
};

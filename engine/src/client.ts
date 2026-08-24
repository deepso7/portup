import { Context, Effect, Layer, Schema } from "effect";

import { PortupFailure } from "./error.ts";
import { ServiceSchema } from "./service.ts";
import type { Service } from "./service.ts";

const ErrorEnvelopeSchema = Schema.Struct({
  error: Schema.Struct({ code: Schema.String, message: Schema.String }),
});
const ServiceListSchema = Schema.Struct({
  services: Schema.Array(ServiceSchema),
});
const RemoveResultSchema = Schema.Struct({
  name: Schema.String,
  removed: Schema.Boolean,
});

export type ServiceList = Schema.Schema.Type<typeof ServiceListSchema>;

export type RemoveResult = Schema.Schema.Type<typeof RemoveResultSchema>;

export interface PortupClientService {
  readonly add: (
    name: string,
    localUrl: string
  ) => Effect.Effect<Service, PortupFailure>;
  readonly list: () => Effect.Effect<ServiceList, PortupFailure>;
  readonly remove: (name: string) => Effect.Effect<RemoveResult, PortupFailure>;
  readonly status: (name: string) => Effect.Effect<Service, PortupFailure>;
}

export class PortupClient extends Context.Service<
  PortupClient,
  PortupClientService
>()("@portup/PortupClient") {}

const invalidResponse = (message: string) =>
  new PortupFailure({ code: "invalid_daemon_response", message });

export const clientLayer = (port: number, token?: string) => {
  const address = `http://127.0.0.1:${port}`;
  const request = <T>(
    schema: Schema.ConstraintDecoder<T, never>,
    path: string,
    init?: RequestInit
  ) => {
    const timeoutFailure = new PortupFailure({
      code: "daemon_timeout",
      message: `PortUp daemon at ${address} did not respond within 5 seconds`,
    });
    return Effect.tryPromise({
      catch: (error) =>
        error === timeoutFailure ||
        (error instanceof DOMException &&
          (error.name === "AbortError" || error.name === "TimeoutError"))
          ? timeoutFailure
          : new PortupFailure({
              code: "daemon_not_running",
              message: `PortUp daemon is not running at ${address}`,
            }),
      try: async () => {
        const headers = new Headers(init?.headers);
        if (token) {
          headers.set("authorization", `Bearer ${token}`);
        }
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(timeoutFailure),
          5000
        );
        try {
          return await fetch(`${address}${path}`, {
            ...init,
            headers,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }
      },
    }).pipe(
      Effect.flatMap((response) =>
        Effect.tryPromise({
          catch: () => invalidResponse("PortUp daemon returned invalid JSON"),
          try: async () => ({ body: await response.json(), response }),
        })
      ),
      Effect.flatMap(({ body, response }) => {
        if (response.ok) {
          return Schema.decodeUnknownEffect(schema)(body).pipe(
            Effect.mapError(() =>
              invalidResponse("PortUp daemon returned invalid JSON")
            )
          );
        }
        return Schema.decodeUnknownEffect(ErrorEnvelopeSchema)(body).pipe(
          Effect.mapError(() =>
            invalidResponse("PortUp daemon returned an invalid error response")
          ),
          Effect.flatMap(({ error }) => Effect.fail(new PortupFailure(error)))
        );
      })
    );
  };

  return Layer.succeed(PortupClient, {
    add: (name, localUrl) =>
      request(ServiceSchema, "/api/services", {
        body: JSON.stringify({ localUrl, name }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    list: () => request(ServiceListSchema, "/api/services"),
    remove: (name) =>
      request(RemoveResultSchema, `/api/services/${encodeURIComponent(name)}`, {
        method: "DELETE",
      }),
    status: (name) =>
      request(ServiceSchema, `/api/services/${encodeURIComponent(name)}`),
  });
};

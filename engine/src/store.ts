import { SqliteClient } from "@effect/sql-sqlite-bun";
import { eq } from "drizzle-orm";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors";
import { makeWithDefaults } from "drizzle-orm/effect-sqlite-bun";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Context, Effect, Layer } from "effect";

import { registeredService } from "./service.ts";
import type { Service } from "./service.ts";

const services = sqliteTable("services", {
  localUrl: text("local_url").notNull(),
  name: text().primaryKey(),
});

interface StoreService {
  readonly add: (
    name: string,
    localUrl: string
  ) => Effect.Effect<Service | null, EffectDrizzleQueryError>;
  readonly get: (
    name: string
  ) => Effect.Effect<Service | null, EffectDrizzleQueryError>;
  readonly list: () => Effect.Effect<Service[], EffectDrizzleQueryError>;
  readonly remove: (
    name: string
  ) => Effect.Effect<boolean, EffectDrizzleQueryError>;
}

export class Store extends Context.Service<Store, StoreService>()(
  "@portup/Store"
) {}

const makeStore = Effect.gen(function* makeStore() {
  const database = yield* makeWithDefaults();
  const { user_version: version } = yield* database.get<{
    user_version: number;
  }>("PRAGMA user_version");

  if (version === 0) {
    yield* database.transaction((transaction) =>
      Effect.gen(function* migrate() {
        yield* transaction.run(`
          CREATE TABLE services (
            name TEXT PRIMARY KEY NOT NULL,
            local_url TEXT NOT NULL
          ) STRICT
        `);
        yield* transaction.run("PRAGMA user_version = 1");
      })
    );
  } else if (version !== 1) {
    return yield* Effect.fail(
      new Error(`unsupported database schema version ${version}`)
    );
  }

  const add = Effect.fn("Store.add")(function* addService(
    name: string,
    localUrl: string
  ) {
    const [row] = yield* database
      .insert(services)
      .values({ localUrl, name })
      .onConflictDoNothing()
      .returning();
    return row ? registeredService(row.name, row.localUrl) : null;
  });

  const get = Effect.fn("Store.get")(function* getService(name: string) {
    const [row] = yield* database
      .select()
      .from(services)
      .where(eq(services.name, name))
      .limit(1);
    return row ? registeredService(row.name, row.localUrl) : null;
  });

  const list = Effect.fn("Store.list")(function* listServices() {
    const rows = yield* database.select().from(services).orderBy(services.name);
    return rows.map((row) => registeredService(row.name, row.localUrl));
  });

  const remove = Effect.fn("Store.remove")(function* removeService(
    name: string
  ) {
    const removed = yield* database
      .delete(services)
      .where(eq(services.name, name))
      .returning({ name: services.name });
    return removed.length === 1;
  });

  return Store.of({ add, get, list, remove });
});

export const storeLayer = (path: string) =>
  Layer.effect(Store, makeStore).pipe(
    Layer.provide(
      SqliteClient.layer({
        // bun:sqlite is synchronous, so waiting on a lock blocks the daemon.
        busyTimeout: 0,
        filename: path,
      })
    )
  );

import { SqliteClient } from "@effect/sql-sqlite-bun";
import { eq } from "drizzle-orm";
import { makeWithDefaults } from "drizzle-orm/effect-sqlite-bun";
import type { EffectSQLiteBunDatabase } from "drizzle-orm/effect-sqlite-bun";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Effect, ManagedRuntime } from "effect";

import { registeredService } from "./service.ts";
import type { Service } from "./service.ts";

const services = sqliteTable("services", {
  localUrl: text("local_url").notNull(),
  name: text().primaryKey(),
});

const makeRuntime = (path: string) =>
  ManagedRuntime.make(SqliteClient.layer({ filename: path }));

export class Store {
  readonly #database: EffectSQLiteBunDatabase;
  readonly #runtime: ReturnType<typeof makeRuntime>;

  constructor(path: string) {
    this.#runtime = makeRuntime(path);
    this.#database = this.#runtime.runSync(makeWithDefaults());
    const version = this.#runtime.runSync(
      this.#database.get<{ user_version: number }>("PRAGMA user_version")
    ).user_version;

    if (version === 0) {
      this.#runtime.runSync(
        this.#database.transaction((transaction) =>
          Effect.gen(function* migrate() {
            yield* transaction.run(`
              CREATE TABLE services (
                name TEXT PRIMARY KEY NOT NULL,
                local_url TEXT NOT NULL
              ) STRICT
            `);
            yield* transaction.run("PRAGMA user_version = 1");
          })
        )
      );
    } else if (version !== 1) {
      throw new Error(`unsupported database schema version ${version}`);
    }
  }

  add(name: string, localUrl: string): Service | null {
    const [row] = this.#runtime.runSync(
      this.#database
        .insert(services)
        .values({ localUrl, name })
        .onConflictDoNothing()
        .returning()
    );
    return row ? registeredService(row.name, row.localUrl) : null;
  }

  get(name: string): Service | null {
    const [row] = this.#runtime.runSync(
      this.#database
        .select()
        .from(services)
        .where(eq(services.name, name))
        .limit(1)
    );
    return row ? registeredService(row.name, row.localUrl) : null;
  }

  list(): Service[] {
    return this.#runtime
      .runSync(this.#database.select().from(services).orderBy(services.name))
      .map((row) => registeredService(row.name, row.localUrl));
  }

  remove(name: string): boolean {
    const removed = this.#runtime.runSync(
      this.#database
        .delete(services)
        .where(eq(services.name, name))
        .returning({ name: services.name })
    );
    return removed.length === 1;
  }

  close() {
    return this.#runtime.dispose();
  }
}

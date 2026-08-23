import { Database } from "bun:sqlite";

import { registeredService } from "./service.ts";
import type { Service } from "./service.ts";

interface ServiceRow {
  local_url: string;
  name: string;
}

export class Store {
  readonly #database: Database;

  constructor(path: string) {
    this.#database = new Database(path, { create: true });
    const version = this.#database
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()?.user_version;

    if (version === 0) {
      this.#database.exec(`
        BEGIN;
        CREATE TABLE services (
          name TEXT PRIMARY KEY NOT NULL,
          local_url TEXT NOT NULL
        ) STRICT;
        PRAGMA user_version = 1;
        COMMIT;
      `);
    } else if (version !== 1) {
      throw new Error(`unsupported database schema version ${version}`);
    }
  }

  add(name: string, localUrl: string): Service | null {
    try {
      this.#database
        .query("INSERT INTO services (name, local_url) VALUES (?1, ?2)")
        .run(name, localUrl);
      return registeredService(name, localUrl);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("UNIQUE constraint failed")
      ) {
        return null;
      }
      throw error;
    }
  }

  get(name: string): Service | null {
    const row = this.#database
      .query<ServiceRow, [string]>(
        "SELECT name, local_url FROM services WHERE name = ?1"
      )
      .get(name);
    return row ? registeredService(row.name, row.local_url) : null;
  }

  list(): Service[] {
    return this.#database
      .query<ServiceRow, []>(
        "SELECT name, local_url FROM services ORDER BY name"
      )
      .all()
      .map((row) => registeredService(row.name, row.local_url));
  }

  remove(name: string): boolean {
    return (
      this.#database.query("DELETE FROM services WHERE name = ?1").run(name)
        .changes === 1
    );
  }

  close() {
    this.#database.close();
  }
}

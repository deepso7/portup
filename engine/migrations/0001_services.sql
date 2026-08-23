BEGIN;

CREATE TABLE services (
    name TEXT PRIMARY KEY NOT NULL,
    local_url TEXT NOT NULL
) STRICT;

PRAGMA user_version = 1;

COMMIT;

use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};
use thiserror::Error;

use crate::service::Service;

pub struct Store {
    connection: Connection,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        let connection = Connection::open(path)?;
        let version = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;

        match version {
            0 => connection.execute_batch(include_str!("../migrations/0001_services.sql"))?,
            1 => {}
            version => return Err(StoreError::UnsupportedSchema(version)),
        }

        Ok(Self { connection })
    }

    pub fn add(&self, name: &str, local_url: &str) -> Result<Service, StoreError> {
        let result = self.connection.execute(
            "INSERT INTO services (name, local_url) VALUES (?1, ?2)",
            params![name, local_url],
        );

        match result {
            Ok(_) => {}
            Err(rusqlite::Error::SqliteFailure(error, _))
                if error.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                return Err(StoreError::AlreadyExists);
            }
            Err(error) => return Err(error.into()),
        }

        Ok(Service::registered(name.to_owned(), local_url.to_owned()))
    }

    pub fn get(&self, name: &str) -> Result<Option<Service>, StoreError> {
        self.connection
            .query_row(
                "SELECT name, local_url FROM services WHERE name = ?1",
                [name],
                |row| Ok(Service::registered(row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn list(&self) -> Result<Vec<Service>, StoreError> {
        let mut statement = self
            .connection
            .prepare("SELECT name, local_url FROM services ORDER BY name")?;
        let services = statement
            .query_map([], |row| Ok(Service::registered(row.get(0)?, row.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(services)
    }

    pub fn remove(&self, name: &str) -> Result<bool, StoreError> {
        self.connection
            .execute("DELETE FROM services WHERE name = ?1", [name])
            .map(|removed| removed == 1)
            .map_err(Into::into)
    }
}

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("service is already registered")]
    AlreadyExists,
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("database schema version {0} is newer than this version of PortUp")]
    UnsupportedSchema(i64),
}

use std::io;
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, JoinHandle};

use thiserror::Error;

use crate::http::handle_connection;
use crate::store::{Store, StoreError};

pub struct Daemon {
    address: SocketAddr,
    running: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Daemon {
    pub fn spawn(listener: TcpListener, database_path: PathBuf) -> Result<Self, DaemonError> {
        let address = listener.local_addr()?;
        let store = Store::open(&database_path)?;
        let running = Arc::new(AtomicBool::new(true));
        let daemon_running = Arc::clone(&running);
        let thread = thread::spawn(move || run(listener, store, &daemon_running));

        Ok(Self {
            address,
            running,
            thread: Some(thread),
        })
    }

    pub fn address(&self) -> SocketAddr {
        self.address
    }

    pub fn shutdown(mut self) {
        self.stop();
    }

    fn stop(&mut self) {
        self.running.store(false, Ordering::Release);
        let _ = TcpStream::connect(self.address);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Serves requests on the current thread until the process is stopped.
pub fn serve(listener: TcpListener, database_path: PathBuf) -> Result<(), DaemonError> {
    let store = Store::open(&database_path)?;
    for connection in listener.incoming() {
        handle_connection(connection?, &store);
    }
    Ok(())
}

impl Drop for Daemon {
    fn drop(&mut self) {
        self.stop();
    }
}

fn run(listener: TcpListener, store: Store, running: &AtomicBool) {
    while running.load(Ordering::Acquire) {
        let Ok((stream, _)) = listener.accept() else {
            continue;
        };
        if !running.load(Ordering::Acquire) {
            break;
        }
        handle_connection(stream, &store);
    }
}

#[derive(Debug, Error)]
pub enum DaemonError {
    #[error("could not open daemon listener: {0}")]
    Io(#[from] io::Error),
    #[error("could not open PortUp database: {0}")]
    Store(#[from] StoreError),
}

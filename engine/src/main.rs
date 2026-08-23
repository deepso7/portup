use std::env;
use std::io::{self, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use directories::ProjectDirs;
use portup::client::{Client, ClientError, ServiceList};
use portup::{PublicStatus, Service, daemon};
use serde::Serialize;

#[derive(Parser)]
#[command(version, about = "Share local services through stable public URLs")]
struct Cli {
    #[arg(long, global = true)]
    json: bool,

    #[arg(long, env = "PORTUP_PORT", default_value_t = 4700, global = true)]
    port: u16,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run the local PortUp daemon in the foreground.
    Daemon,
    /// Register a local service.
    Add { name: String, url: String },
    /// Remove a registered service.
    Remove { name: String },
    /// Show one service or list all services.
    Status { name: Option<String> },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(&cli) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            if cli.json {
                let envelope = ErrorEnvelope { error };
                let _ = serde_json::to_writer(io::stderr(), &envelope);
                eprintln!();
            } else {
                eprintln!("Error: {}", error.message);
            }
            ExitCode::FAILURE
        }
    }
}

fn run(cli: &Cli) -> Result<(), ClientError> {
    if matches!(cli.command, Command::Daemon) {
        return run_daemon(cli.port, cli.json);
    }

    let client = Client::localhost(cli.port);
    match &cli.command {
        Command::Add { name, url } => {
            let service = client.add(name, url)?;
            if cli.json {
                print_json(&service)?;
            } else {
                println!("Added {} at {}", service.name, service.local_url);
            }
        }
        Command::Remove { name } => {
            let removed = client.remove(name)?;
            if cli.json {
                print_json(&removed)?;
            } else {
                println!("Removed {}", removed.name);
            }
        }
        Command::Status { name: Some(name) } => {
            let service = client.status(name)?;
            if cli.json {
                print_json(&service)?;
            } else {
                print_service(&service);
            }
        }
        Command::Status { name: None } => {
            let services = client.list()?;
            if cli.json {
                print_json(&services)?;
            } else {
                print_services(&services);
            }
        }
        Command::Daemon => unreachable!(),
    }
    Ok(())
}

fn run_daemon(port: u16, json: bool) -> Result<(), ClientError> {
    let database_path = database_path()?;
    if let Some(parent) = database_path.parent() {
        std::fs::create_dir_all(parent).map_err(daemon_error)?;
    }
    let address = format!("127.0.0.1:{port}");
    let listener = TcpListener::bind(&address).map_err(daemon_error)?;

    if json {
        print_json(&DaemonStarted { address: &address })?;
    } else {
        println!("PortUp daemon listening on http://{address}");
        io::stdout().flush().map_err(output_error)?;
    }

    daemon::serve(listener, database_path).map_err(daemon_error)
}

fn database_path() -> Result<PathBuf, ClientError> {
    if let Some(path) = env::var_os("PORTUP_DB_PATH") {
        return Ok(path.into());
    }
    ProjectDirs::from("dev", "PortUp", "portup")
        .map(|directories| directories.data_dir().join("portup.db"))
        .ok_or_else(|| ClientError {
            code: "data_directory_unavailable".to_owned(),
            message: "could not determine the PortUp data directory".to_owned(),
        })
}

fn print_json(value: &impl Serialize) -> Result<(), ClientError> {
    serde_json::to_writer(io::stdout(), value).map_err(output_error)?;
    println!();
    io::stdout().flush().map_err(output_error)?;
    Ok(())
}

fn print_services(list: &ServiceList) {
    if list.services.is_empty() {
        println!("No services registered.");
    } else {
        for service in &list.services {
            print_service(service);
        }
    }
}

fn print_service(service: &Service) {
    println!(
        "{}  {}  public: {}",
        service.name,
        service.local_url,
        match service.public_status {
            PublicStatus::Unknown => "unknown",
            PublicStatus::Reachable => "reachable",
            PublicStatus::Unreachable => "unreachable",
        }
    );
}

fn daemon_error(error: impl std::fmt::Display) -> ClientError {
    ClientError {
        code: "daemon_error".to_owned(),
        message: error.to_string(),
    }
}

fn output_error(error: impl std::fmt::Display) -> ClientError {
    ClientError {
        code: "output_error".to_owned(),
        message: error.to_string(),
    }
}

#[derive(Serialize)]
struct ErrorEnvelope {
    error: ClientError,
}

#[derive(Serialize)]
struct DaemonStarted<'a> {
    address: &'a str,
}

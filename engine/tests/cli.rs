use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use assert_cmd::cargo::{cargo_bin, cargo_bin_cmd};
use portup::daemon::Daemon;
use serde_json::{Value, json};

struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn test_daemon() -> (tempfile::TempDir, Daemon) {
    let directory = tempfile::tempdir().expect("create temporary directory");
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind test daemon");
    let daemon =
        Daemon::spawn(listener, directory.path().join("portup.db")).expect("start test daemon");
    (directory, daemon)
}

fn run_json(port: u16, arguments: &[&str]) -> std::process::Output {
    cargo_bin_cmd!("portup")
        .arg("--port")
        .arg(port.to_string())
        .arg("--json")
        .args(arguments)
        .output()
        .expect("run portup")
}

#[test]
fn cli_round_trips_through_the_daemon() {
    let (_directory, daemon) = test_daemon();
    let port = daemon.address().port();

    let added = run_json(port, &["add", "api", "http://127.0.0.1:3000"]);
    assert!(added.status.success());
    assert!(added.stderr.is_empty());
    let added: Value = serde_json::from_slice(&added.stdout).expect("parse add output");
    assert_eq!(added["name"], "api");
    assert_eq!(added["publicStatus"], "unknown");
    assert_eq!(added.as_object().expect("service object").len(), 8);

    let status = run_json(port, &["status", "api"]);
    assert!(
        status.status.success(),
        "{}",
        String::from_utf8_lossy(&status.stderr)
    );
    assert!(status.stderr.is_empty());
    assert_eq!(
        serde_json::from_slice::<Value>(&status.stdout).expect("parse status output"),
        added
    );

    let removed = run_json(port, &["remove", "api"]);
    assert!(removed.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&removed.stdout).expect("parse remove output"),
        json!({ "name": "api", "removed": true })
    );
}

#[test]
fn human_output_is_the_default() {
    let (_directory, daemon) = test_daemon();
    let output = cargo_bin_cmd!("portup")
        .args([
            "--port",
            &daemon.address().port().to_string(),
            "add",
            "web",
            "http://127.0.0.1:3000",
        ])
        .output()
        .expect("run portup");

    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).expect("utf-8 output"),
        "Added web at http://127.0.0.1:3000\n"
    );
    assert!(output.stderr.is_empty());
}

#[test]
fn daemon_down_has_a_stable_json_error() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("reserve unused port");
    let port = listener.local_addr().expect("read port").port();
    drop(listener);

    let output = run_json(port, &["status"]);
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    let error: Value = serde_json::from_slice(&output.stderr).expect("parse error output");
    assert_eq!(error["error"]["code"], "daemon_not_running");
}

#[test]
fn daemon_honors_the_port_environment_variable() {
    let directory = tempfile::tempdir().expect("create temporary directory");
    let listener = TcpListener::bind("127.0.0.1:0").expect("reserve daemon port");
    let port = listener.local_addr().expect("read port").port();
    drop(listener);

    let mut child = Command::new(cargo_bin!("portup"))
        .arg("daemon")
        .arg("--json")
        .env("PORTUP_PORT", port.to_string())
        .env("PORTUP_DB_PATH", directory.path().join("portup.db"))
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("start daemon process");
    let stdout = child.stdout.take().expect("capture daemon output");
    let _child = ChildGuard(child);

    let mut startup = String::new();
    BufReader::new(stdout)
        .read_line(&mut startup)
        .expect("read daemon startup output");
    assert_eq!(
        serde_json::from_str::<Value>(&startup).expect("parse daemon startup output"),
        json!({ "address": format!("127.0.0.1:{port}") })
    );

    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let output = run_json(port, &["status"]);
        if output.status.success() {
            assert_eq!(
                serde_json::from_slice::<Value>(&output.stdout).expect("parse service list"),
                json!({ "services": [] })
            );
            break;
        }
        assert!(Instant::now() < deadline, "daemon did not start in time");
        thread::sleep(Duration::from_millis(20));
    }
}

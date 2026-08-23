use std::net::TcpListener;

use portup::daemon::Daemon;
use serde_json::{Value, json};
use tempfile::TempDir;

struct TestDaemon {
    _directory: TempDir,
    daemon: Daemon,
}

impl TestDaemon {
    fn start() -> Self {
        let directory = tempfile::tempdir().expect("create temporary directory");
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test daemon");
        let daemon =
            Daemon::spawn(listener, directory.path().join("portup.db")).expect("start test daemon");

        Self {
            _directory: directory,
            daemon,
        }
    }

    fn url(&self, path: &str) -> String {
        format!("http://{}{}", self.daemon.address(), path)
    }
}

#[test]
fn registered_service_is_available_over_http() {
    let daemon = TestDaemon::start();

    let created: Value = ureq::post(daemon.url("/api/services"))
        .send_json(json!({
            "name": "api",
            "localUrl": "http://127.0.0.1:3000"
        }))
        .expect("register service")
        .body_mut()
        .read_json()
        .expect("read registration response");

    assert_eq!(
        created,
        json!({
            "name": "api",
            "shared": false,
            "originStatus": null,
            "tunnelStatus": null,
            "publicStatus": "unknown",
            "localUrl": "http://127.0.0.1:3000",
            "publicUrl": null,
            "checkedAt": null
        })
    );

    let status: Value = ureq::get(daemon.url("/api/services/api"))
        .call()
        .expect("fetch service")
        .body_mut()
        .read_json()
        .expect("read status response");

    assert_eq!(status, created);
}

#[test]
fn several_services_can_be_listed_and_removed_independently() {
    let daemon = TestDaemon::start();

    for (name, local_url) in [
        ("web", "http://127.0.0.1:3000"),
        ("api", "http://127.0.0.1:4000"),
    ] {
        ureq::post(daemon.url("/api/services"))
            .send_json(json!({ "name": name, "localUrl": local_url }))
            .expect("register service");
    }

    let services: Value = ureq::get(daemon.url("/api/services"))
        .call()
        .expect("list services")
        .body_mut()
        .read_json()
        .expect("read service list");
    assert_eq!(services["services"][0]["name"], "api");
    assert_eq!(services["services"][1]["name"], "web");

    let removed: Value = ureq::delete(daemon.url("/api/services/api"))
        .call()
        .expect("remove service")
        .body_mut()
        .read_json()
        .expect("read remove response");
    assert_eq!(removed, json!({ "name": "api", "removed": true }));

    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .build()
        .into();
    let mut missing = agent
        .get(daemon.url("/api/services/api"))
        .call()
        .expect("fetch missing service response");
    assert_eq!(missing.status().as_u16(), 404);
    assert_eq!(
        missing.body_mut().read_json::<Value>().expect("read error"),
        json!({
            "error": {
                "code": "service_not_found",
                "message": "service 'api' is not registered"
            }
        })
    );

    let remaining: Value = ureq::get(daemon.url("/api/services/web"))
        .call()
        .expect("fetch remaining service")
        .body_mut()
        .read_json()
        .expect("read remaining service");
    assert_eq!(remaining["name"], "web");
}

#[test]
fn registrations_survive_a_daemon_restart() {
    let directory = tempfile::tempdir().expect("create temporary directory");
    let database_path = directory.path().join("portup.db");

    let first_listener = TcpListener::bind("127.0.0.1:0").expect("bind first daemon");
    let first = Daemon::spawn(first_listener, database_path.clone()).expect("start first daemon");
    ureq::post(format!("http://{}/api/services", first.address()))
        .send_json(json!({
            "name": "api",
            "localUrl": "http://127.0.0.1:3000"
        }))
        .expect("register service");
    first.shutdown();

    let second_listener = TcpListener::bind("127.0.0.1:0").expect("bind second daemon");
    let second = Daemon::spawn(second_listener, database_path).expect("restart daemon");
    let persisted: Value = ureq::get(format!("http://{}/api/services/api", second.address()))
        .call()
        .expect("fetch persisted service")
        .body_mut()
        .read_json()
        .expect("read persisted service");

    assert_eq!(persisted["name"], "api");
    assert_eq!(persisted["localUrl"], "http://127.0.0.1:3000");
}

#[test]
fn invalid_and_duplicate_registrations_have_stable_errors() {
    let daemon = TestDaemon::start();
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .build()
        .into();

    let cases = [
        (
            json!({ "name": "Bad Name", "localUrl": "http://127.0.0.1:3000" }),
            "invalid_service_name",
        ),
        (
            json!({ "name": "api", "localUrl": "not a URL" }),
            "invalid_local_url",
        ),
    ];

    for (body, expected_code) in cases {
        let mut response = agent
            .post(daemon.url("/api/services"))
            .send_json(body)
            .expect("receive validation response");
        assert_eq!(response.status().as_u16(), 400);
        let error: Value = response.body_mut().read_json().expect("read error");
        assert_eq!(error["error"]["code"], expected_code);
    }

    let service = json!({ "name": "api", "localUrl": "http://127.0.0.1:3000" });
    agent
        .post(daemon.url("/api/services"))
        .send_json(&service)
        .expect("register service");
    let mut duplicate = agent
        .post(daemon.url("/api/services"))
        .send_json(service)
        .expect("receive duplicate response");
    assert_eq!(duplicate.status().as_u16(), 409);
    assert_eq!(
        duplicate
            .body_mut()
            .read_json::<Value>()
            .expect("read error"),
        json!({
            "error": {
                "code": "service_already_exists",
                "message": "service 'api' is already registered"
            }
        })
    );
}

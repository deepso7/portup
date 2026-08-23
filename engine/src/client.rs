use std::time::Duration;

use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::Service;

pub struct Client {
    address: String,
    agent: ureq::Agent,
}

impl Client {
    pub fn localhost(port: u16) -> Self {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(5)))
            .build()
            .into();
        Self {
            address: format!("http://127.0.0.1:{port}"),
            agent,
        }
    }

    pub fn add(&self, name: &str, local_url: &str) -> Result<Service, ClientError> {
        let response = self
            .agent
            .post(format!("{}/api/services", self.address))
            .send_json(AddRequest { name, local_url })
            .map_err(|_| self.daemon_not_running())?;
        parse_response(response)
    }

    pub fn status(&self, name: &str) -> Result<Service, ClientError> {
        let response = self
            .agent
            .get(self.service_url(name))
            .call()
            .map_err(|_| self.daemon_not_running())?;
        parse_response(response)
    }

    pub fn list(&self) -> Result<ServiceList, ClientError> {
        let response = self
            .agent
            .get(format!("{}/api/services", self.address))
            .call()
            .map_err(|_| self.daemon_not_running())?;
        parse_response(response)
    }

    pub fn remove(&self, name: &str) -> Result<RemoveResult, ClientError> {
        let response = self
            .agent
            .delete(self.service_url(name))
            .call()
            .map_err(|_| self.daemon_not_running())?;
        parse_response(response)
    }

    fn service_url(&self, name: &str) -> String {
        let mut url = url::Url::parse(&format!("{}/api/services/", self.address))
            .expect("valid localhost daemon URL");
        url.path_segments_mut()
            .expect("localhost URL supports path segments")
            .pop_if_empty()
            .push(name);
        url.into()
    }

    fn daemon_not_running(&self) -> ClientError {
        ClientError {
            code: "daemon_not_running".to_owned(),
            message: format!("PortUp daemon is not running at {}", self.address),
        }
    }
}

fn parse_response<T: DeserializeOwned>(
    mut response: ureq::http::Response<ureq::Body>,
) -> Result<T, ClientError> {
    if response.status().is_success() {
        response.body_mut().read_json().map_err(|_| ClientError {
            code: "invalid_daemon_response".to_owned(),
            message: "PortUp daemon returned invalid JSON".to_owned(),
        })
    } else {
        response
            .body_mut()
            .read_json::<ErrorEnvelope>()
            .map(|envelope| Err(envelope.error))
            .unwrap_or_else(|_| {
                Err(ClientError {
                    code: "invalid_daemon_response".to_owned(),
                    message: "PortUp daemon returned an invalid error response".to_owned(),
                })
            })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AddRequest<'a> {
    name: &'a str,
    local_url: &'a str,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ServiceList {
    pub services: Vec<Service>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct RemoveResult {
    pub name: String,
    pub removed: bool,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ClientError {
    pub code: String,
    pub message: String,
}

#[derive(Deserialize)]
struct ErrorEnvelope {
    error: ClientError,
}

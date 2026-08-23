use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddService {
    pub name: String,
    pub local_url: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Service {
    pub name: String,
    pub shared: bool,
    pub origin_status: Option<OriginStatus>,
    pub tunnel_status: Option<TunnelStatus>,
    pub public_status: PublicStatus,
    pub local_url: String,
    pub public_url: Option<String>,
    pub checked_at: Option<String>,
}

impl Service {
    pub fn registered(name: String, local_url: String) -> Self {
        Self {
            name,
            shared: false,
            origin_status: None,
            tunnel_status: None,
            public_status: PublicStatus::Unknown,
            local_url,
            public_url: None,
            checked_at: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OriginStatus {
    Online,
    Offline,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TunnelStatus {
    Connected,
    Connecting,
    Error,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PublicStatus {
    Unknown,
    Reachable,
    Unreachable,
}

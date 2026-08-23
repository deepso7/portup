use serde::Serialize;

#[derive(Debug)]
pub struct ApiError {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
}

impl ApiError {
    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self {
            status: 400,
            code: "invalid_request",
            message: message.into(),
        }
    }

    pub fn bad_request(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: 400,
            code,
            message: message.into(),
        }
    }

    pub fn already_exists(name: &str) -> Self {
        Self {
            status: 409,
            code: "service_already_exists",
            message: format!("service '{name}' is already registered"),
        }
    }

    pub fn not_found(name: &str) -> Self {
        Self {
            status: 404,
            code: "service_not_found",
            message: format!("service '{name}' is not registered"),
        }
    }

    pub fn internal() -> Self {
        Self {
            status: 500,
            code: "internal_error",
            message: "PortUp could not complete the request".to_owned(),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct ErrorEnvelope {
    pub error: ErrorPayload,
}

#[derive(Debug, Serialize)]
pub struct ErrorPayload {
    pub code: &'static str,
    pub message: String,
}

impl From<ApiError> for ErrorEnvelope {
    fn from(error: ApiError) -> Self {
        Self {
            error: ErrorPayload {
                code: error.code,
                message: error.message,
            },
        }
    }
}

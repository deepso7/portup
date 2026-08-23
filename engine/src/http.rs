use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use serde::Serialize;

use crate::error::{ApiError, ErrorEnvelope};
use crate::service::AddService;
use crate::store::Store;

const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_BODY_BYTES: usize = 1024 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(5);

pub fn handle_connection(mut stream: TcpStream, store: &Store) {
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));

    let response = match read_request(&mut stream) {
        Ok(request) => route(request, store),
        Err(error) => Response::error(error),
    };

    let _ = response.write_to(&mut stream);
}

struct Request {
    method: String,
    path: String,
    body: Vec<u8>,
}

fn read_request(stream: &mut TcpStream) -> Result<Request, ApiError> {
    let mut buffer = Vec::with_capacity(4096);
    let (method, path, header_bytes, body_bytes) = loop {
        let mut chunk = [0_u8; 4096];
        let read = stream
            .read(&mut chunk)
            .map_err(|_| ApiError::invalid_request("could not read HTTP request"))?;

        if read == 0 {
            return Err(ApiError::invalid_request("incomplete HTTP request"));
        }

        buffer.extend_from_slice(&chunk[..read]);

        let mut headers = [httparse::EMPTY_HEADER; 32];
        let mut parsed = httparse::Request::new(&mut headers);
        let header_bytes = match parsed
            .parse(&buffer)
            .map_err(|_| ApiError::invalid_request("malformed HTTP request"))?
        {
            httparse::Status::Partial if buffer.len() > MAX_HEADER_BYTES => {
                return Err(ApiError::invalid_request("HTTP headers exceed 16 KiB"));
            }
            httparse::Status::Partial => continue,
            httparse::Status::Complete(bytes) => bytes,
        };

        if header_bytes > MAX_HEADER_BYTES {
            return Err(ApiError::invalid_request("HTTP headers exceed 16 KiB"));
        }

        let method = parsed
            .method
            .ok_or_else(|| ApiError::invalid_request("HTTP method is missing"))?
            .to_owned();
        let path = parsed
            .path
            .ok_or_else(|| ApiError::invalid_request("HTTP path is missing"))?
            .to_owned();

        let mut content_length = None;
        for header in parsed.headers {
            if header.name.eq_ignore_ascii_case("transfer-encoding") {
                return Err(ApiError::invalid_request(
                    "Transfer-Encoding request bodies are not supported",
                ));
            }

            if header.name.eq_ignore_ascii_case("content-length") {
                if content_length.is_some() {
                    return Err(ApiError::invalid_request("duplicate Content-Length header"));
                }

                let value = std::str::from_utf8(header.value)
                    .ok()
                    .and_then(|value| value.parse::<usize>().ok())
                    .ok_or_else(|| ApiError::invalid_request("invalid Content-Length header"))?;
                content_length = Some(value);
            }
        }

        break (method, path, header_bytes, content_length.unwrap_or(0));
    };

    if body_bytes > MAX_BODY_BYTES {
        return Err(ApiError::invalid_request("HTTP body exceeds 1 MiB"));
    }

    while buffer.len() < header_bytes + body_bytes {
        let mut chunk = [0_u8; 4096];
        let read = stream
            .read(&mut chunk)
            .map_err(|_| ApiError::invalid_request("could not read HTTP body"))?;
        if read == 0 {
            return Err(ApiError::invalid_request("incomplete HTTP body"));
        }
        buffer.extend_from_slice(&chunk[..read]);
    }

    Ok(Request {
        method,
        path,
        body: buffer[header_bytes..header_bytes + body_bytes].to_vec(),
    })
}

fn route(request: Request, store: &Store) -> Response {
    let result = match (request.method.as_str(), request.path.as_str()) {
        ("POST", "/api/services") => add_service(&request.body, store),
        ("GET", "/api/services") => list_services(store),
        ("GET", path) if path.starts_with("/api/services/") => {
            let name = &path["/api/services/".len()..];
            get_service(name, store)
        }
        ("DELETE", path) if path.starts_with("/api/services/") => {
            let name = &path["/api/services/".len()..];
            remove_service(name, store)
        }
        _ => Err(ApiError::invalid_request("unknown route")),
    };

    match result {
        Ok(response) => response,
        Err(error) => Response::error(error),
    }
}

fn list_services(store: &Store) -> Result<Response, ApiError> {
    let services = store.list().map_err(|_| ApiError::internal())?;
    Ok(Response::json(200, &ServiceList { services }))
}

fn add_service(body: &[u8], store: &Store) -> Result<Response, ApiError> {
    let service: AddService = serde_json::from_slice(body)
        .map_err(|_| ApiError::invalid_request("request body must be valid service JSON"))?;
    validate_name(&service.name)?;
    validate_local_url(&service.local_url)?;
    let created = match store.add(&service.name, &service.local_url) {
        Ok(service) => service,
        Err(crate::store::StoreError::AlreadyExists) => {
            return Err(ApiError::already_exists(&service.name));
        }
        Err(_) => return Err(ApiError::internal()),
    };

    Ok(Response::json(201, &created))
}

fn validate_name(name: &str) -> Result<(), ApiError> {
    let valid = !name.is_empty()
        && name.len() <= 63
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && name
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && name
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_alphanumeric);

    if valid {
        Ok(())
    } else {
        Err(ApiError::bad_request(
            "invalid_service_name",
            "service name must be a lowercase DNS label",
        ))
    }
}

fn validate_local_url(local_url: &str) -> Result<(), ApiError> {
    let valid = url::Url::parse(local_url).is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && url.host().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none()
    });

    if valid {
        Ok(())
    } else {
        Err(ApiError::bad_request(
            "invalid_local_url",
            "local URL must be an http or https URL with a host",
        ))
    }
}

fn get_service(name: &str, store: &Store) -> Result<Response, ApiError> {
    let service = store
        .get(name)
        .map_err(|_| ApiError::internal())?
        .ok_or_else(|| ApiError::not_found(name))?;

    Ok(Response::json(200, &service))
}

fn remove_service(name: &str, store: &Store) -> Result<Response, ApiError> {
    if !store.remove(name).map_err(|_| ApiError::internal())? {
        return Err(ApiError::not_found(name));
    }

    Ok(Response::json(
        200,
        &RemoveService {
            name,
            removed: true,
        },
    ))
}

#[derive(Serialize)]
struct ServiceList<T> {
    services: Vec<T>,
}

#[derive(Serialize)]
struct RemoveService<'a> {
    name: &'a str,
    removed: bool,
}

struct Response {
    status: u16,
    body: Vec<u8>,
}

impl Response {
    fn json(status: u16, value: &impl Serialize) -> Self {
        Self {
            status,
            body: serde_json::to_vec(value).expect("serializable HTTP response"),
        }
    }

    fn error(error: ApiError) -> Self {
        let status = error.status;
        Self::json(status, &ErrorEnvelope::from(error))
    }

    fn write_to(self, stream: &mut TcpStream) -> io::Result<()> {
        let reason = match self.status {
            200 => "OK",
            201 => "Created",
            400 => "Bad Request",
            404 => "Not Found",
            409 => "Conflict",
            _ => "Internal Server Error",
        };
        let headers = format!(
            "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            self.status,
            reason,
            self.body.len()
        );

        stream.write_all(headers.as_bytes())?;
        stream.write_all(&self.body)
    }
}

use std::{
    collections::HashMap,
    fs,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use axum::{
    Json,
    body::{Body, to_bytes},
    extract::{Request, State},
    http::{HeaderName, HeaderValue, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::{
    config::{Config, ConfigError},
    models::{ErrorBody, ErrorEnvelope},
};

const KEY_ID: &str = "x-skywatch-key-id";
const TIMESTAMP: &str = "x-skywatch-timestamp";
const NONCE: &str = "x-skywatch-nonce";
const CONTENT_SHA256: &str = "x-skywatch-content-sha256";
const SIGNATURE: &str = "x-skywatch-signature";
const MAX_REQUEST_BODY: usize = 16 * 1024;
const MAX_SIGNED_RESPONSE: usize = 2 * 1024 * 1024 + 64 * 1024;

type HmacSha256 = Hmac<Sha256>;

pub struct Authenticator {
    key_id: String,
    key: [u8; 32],
    clock_skew: Duration,
    nonce_ttl: Duration,
    nonce_capacity: usize,
    nonces: Mutex<HashMap<Uuid, Instant>>,
}

#[derive(Debug)]
struct AuthContext {
    nonce: Uuid,
}

#[derive(Clone)]
pub struct VerifiedRequestId(pub String);

struct AuthFailure {
    status: StatusCode,
    code: &'static str,
    message: &'static str,
    request_id: String,
}

impl Authenticator {
    pub fn from_config(config: &Config) -> Result<Self, ConfigError> {
        let encoded = fs::read_to_string(&config.key_file).map_err(|source| ConfigError::Read {
            path: config.key_file.clone(),
            source,
        })?;
        let decoded = URL_SAFE_NO_PAD.decode(encoded.trim()).map_err(|_| {
            ConfigError::Invalid("key_file is not base64url without padding".into())
        })?;
        let key: [u8; 32] = decoded
            .try_into()
            .map_err(|_| ConfigError::Invalid("key_file must decode to exactly 32 bytes".into()))?;
        Ok(Self {
            key_id: config.key_id.to_string(),
            key,
            clock_skew: Duration::from_secs(config.clock_skew_seconds),
            nonce_ttl: Duration::from_secs(config.nonce_ttl_seconds),
            nonce_capacity: config.nonce_capacity,
            nonces: Mutex::new(HashMap::new()),
        })
    }

    #[cfg(test)]
    pub fn for_test(key_id: Uuid, key: [u8; 32]) -> Self {
        Self {
            key_id: key_id.to_string(),
            key,
            clock_skew: Duration::from_secs(60),
            nonce_ttl: Duration::from_secs(120),
            nonce_capacity: 100,
            nonces: Mutex::new(HashMap::new()),
        }
    }

    async fn authenticate(
        &self,
        parts: &axum::http::request::Parts,
        body: &[u8],
    ) -> Result<AuthContext, AuthFailure> {
        let request_id = Uuid::new_v4().to_string();
        let key_id = required_header(parts, KEY_ID, &request_id)?;
        let timestamp = required_header(parts, TIMESTAMP, &request_id)?;
        let nonce_text = required_header(parts, NONCE, &request_id)?;
        let content_digest = required_header(parts, CONTENT_SHA256, &request_id)?;
        let signature = required_header(parts, SIGNATURE, &request_id)?;

        if key_id != self.key_id {
            return Err(unauthorized(
                "Signing key ID is not recognized.",
                request_id,
            ));
        }
        if timestamp.len() != 10 || !timestamp.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(unauthorized("Request timestamp is invalid.", request_id));
        }
        let timestamp_value = timestamp
            .parse::<u64>()
            .map_err(|_| unauthorized("Request timestamp is invalid.", request_id.clone()))?;
        let now = unix_timestamp();
        if now.abs_diff(timestamp_value) > self.clock_skew.as_secs() {
            return Err(unauthorized(
                "Request timestamp is outside the allowed window.",
                request_id,
            ));
        }
        let nonce = Uuid::parse_str(nonce_text)
            .map_err(|_| unauthorized("Request nonce is invalid.", request_id.clone()))?;
        let actual_digest = sha256_hex(body);
        if content_digest.len() != 64
            || !content_digest
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            || !constant_time_equal(content_digest.as_bytes(), actual_digest.as_bytes())
        {
            return Err(unauthorized("Request body digest is invalid.", request_id));
        }
        let path_and_query = parts
            .uri
            .path_and_query()
            .map(|value| value.as_str())
            .unwrap_or(parts.uri.path());
        let canonical = format!(
            "skywatch-agent-v1\n{}\n{}\n{}\n{}\n{}",
            parts.method.as_str(),
            path_and_query,
            timestamp,
            nonce_text,
            actual_digest
        );
        let supplied = URL_SAFE_NO_PAD
            .decode(signature)
            .map_err(|_| unauthorized("Request signature is invalid.", request_id.clone()))?;
        let mut mac = HmacSha256::new_from_slice(&self.key).expect("HMAC accepts any key size");
        mac.update(canonical.as_bytes());
        if mac.verify_slice(&supplied).is_err() {
            return Err(unauthorized("Request signature is invalid.", request_id));
        }

        let now_instant = Instant::now();
        let mut nonces = self.nonces.lock().await;
        nonces.retain(|_, seen| now_instant.duration_since(*seen) < self.nonce_ttl);
        if nonces.contains_key(&nonce) {
            return Err(unauthorized(
                "Request nonce was already used.",
                nonce.to_string(),
            ));
        }
        if nonces.len() >= self.nonce_capacity {
            return Err(AuthFailure {
                status: StatusCode::SERVICE_UNAVAILABLE,
                code: "nonce_cache_full",
                message: "Authentication is temporarily busy.",
                request_id: nonce.to_string(),
            });
        }
        nonces.insert(nonce, now_instant);
        Ok(AuthContext { nonce })
    }

    fn sign_response(&self, nonce: Uuid, mut response: Response, body: &[u8]) -> Response {
        let timestamp = unix_timestamp().to_string();
        let digest = sha256_hex(body);
        let canonical = format!(
            "skywatch-agent-response-v1\n{}\n{}\n{}\n{}",
            nonce,
            response.status().as_u16(),
            timestamp,
            digest
        );
        let mut mac = HmacSha256::new_from_slice(&self.key).expect("HMAC accepts any key size");
        mac.update(canonical.as_bytes());
        let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        let headers = response.headers_mut();
        insert_header(headers, KEY_ID, &self.key_id);
        insert_header(headers, TIMESTAMP, &timestamp);
        insert_header(headers, NONCE, &nonce.to_string());
        insert_header(headers, CONTENT_SHA256, &digest);
        insert_header(headers, SIGNATURE, &signature);
        response
    }
}

pub async fn authenticate_and_sign(
    State(auth): State<Arc<Authenticator>>,
    request: Request,
    next: Next,
) -> Response {
    let (parts, body) = request.into_parts();
    let body = match to_bytes(body, MAX_REQUEST_BODY).await {
        Ok(body) => body,
        Err(_) => {
            return error_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                "request_too_large",
                "Request body exceeds 16 KiB.",
                Uuid::new_v4().to_string(),
            );
        }
    };
    let context = match auth.authenticate(&parts, &body).await {
        Ok(context) => context,
        Err(error) => {
            return error_response(error.status, error.code, error.message, error.request_id);
        }
    };
    let mut request = Request::from_parts(parts, Body::from(body));
    request
        .extensions_mut()
        .insert(VerifiedRequestId(context.nonce.to_string()));
    let response = next.run(request).await;
    let (parts, body) = response.into_parts();
    let bytes = match to_bytes(body, MAX_SIGNED_RESPONSE).await {
        Ok(bytes) => bytes,
        Err(_) => {
            let fallback = error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "response_too_large",
                "Agent response exceeded its configured limit.",
                context.nonce.to_string(),
            );
            let (parts, body) = fallback.into_parts();
            let bytes = to_bytes(body, 64 * 1024).await.unwrap_or_default();
            let response = Response::from_parts(parts, Body::from(bytes.clone()));
            return auth.sign_response(context.nonce, response, &bytes);
        }
    };
    let response = Response::from_parts(parts, Body::from(bytes.clone()));
    auth.sign_response(context.nonce, response, &bytes)
}

fn required_header<'a>(
    parts: &'a axum::http::request::Parts,
    name: &str,
    request_id: &str,
) -> Result<&'a str, AuthFailure> {
    parts
        .headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| {
            unauthorized(
                "Required authentication headers are missing.",
                request_id.into(),
            )
        })
}

fn unauthorized(message: &'static str, request_id: String) -> AuthFailure {
    AuthFailure {
        status: StatusCode::UNAUTHORIZED,
        code: "authentication_failed",
        message,
        request_id,
    }
}

fn error_response(
    status: StatusCode,
    code: &'static str,
    message: impl Into<String>,
    request_id: String,
) -> Response {
    (
        status,
        Json(ErrorEnvelope {
            error: ErrorBody {
                code,
                message: message.into(),
                request_id,
            },
        }),
    )
        .into_response()
}

fn insert_header(headers: &mut axum::http::HeaderMap, name: &'static str, value: &str) {
    if let Ok(value) = HeaderValue::from_str(value) {
        headers.insert(HeaderName::from_static(name), value);
    }
}

pub fn sha256_hex(body: &[u8]) -> String {
    Sha256::digest(body)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signed_parts(
        key_id: Uuid,
        key: &[u8; 32],
        timestamp: u64,
        nonce: Uuid,
    ) -> axum::http::request::Parts {
        let digest = sha256_hex(b"");
        let canonical =
            format!("skywatch-agent-v1\nGET\n/v1/health\n{timestamp}\n{nonce}\n{digest}");
        let mut mac = HmacSha256::new_from_slice(key).unwrap();
        mac.update(canonical.as_bytes());
        let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        let request = Request::builder()
            .method("GET")
            .uri("/v1/health")
            .header(KEY_ID, key_id.to_string())
            .header(TIMESTAMP, timestamp.to_string())
            .header(NONCE, nonce.to_string())
            .header(CONTENT_SHA256, digest)
            .header(SIGNATURE, signature)
            .body(Body::empty())
            .unwrap();
        request.into_parts().0
    }

    #[test]
    fn digest_matches_known_value() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[tokio::test]
    async fn valid_signature_is_accepted_once() {
        let key_id = Uuid::new_v4();
        let key = [7_u8; 32];
        let auth = Authenticator::for_test(key_id, key);
        let nonce = Uuid::new_v4();
        let parts = signed_parts(key_id, &key, unix_timestamp(), nonce);
        assert!(auth.authenticate(&parts, b"").await.is_ok());
        let replay = auth.authenticate(&parts, b"").await.unwrap_err();
        assert_eq!(replay.message, "Request nonce was already used.");
    }

    #[tokio::test]
    async fn rejects_timestamp_outside_clock_window() {
        let key_id = Uuid::new_v4();
        let key = [9_u8; 32];
        let auth = Authenticator::for_test(key_id, key);
        let parts = signed_parts(key_id, &key, unix_timestamp() - 61, Uuid::new_v4());
        let error = auth.authenticate(&parts, b"").await.unwrap_err();
        assert_eq!(
            error.message,
            "Request timestamp is outside the allowed window."
        );
    }

    #[test]
    fn response_signature_covers_nonce_status_timestamp_and_body() {
        let key_id = Uuid::new_v4();
        let key = [11_u8; 32];
        let auth = Authenticator::for_test(key_id, key);
        let nonce = Uuid::new_v4();
        let body = br#"{"status":"ok"}"#;
        let response = Response::builder()
            .status(StatusCode::OK)
            .body(Body::from(body.as_slice()))
            .unwrap();
        let response = auth.sign_response(nonce, response, body);
        let headers = response.headers();
        assert_eq!(headers[KEY_ID], key_id.to_string());
        assert_eq!(headers[NONCE], nonce.to_string());
        let timestamp = headers[TIMESTAMP].to_str().unwrap();
        let digest = sha256_hex(body);
        assert_eq!(headers[CONTENT_SHA256], digest);
        let canonical = format!("skywatch-agent-response-v1\n{nonce}\n200\n{timestamp}\n{digest}");
        let signature = URL_SAFE_NO_PAD
            .decode(headers[SIGNATURE].as_bytes())
            .unwrap();
        let mut mac = HmacSha256::new_from_slice(&key).unwrap();
        mac.update(canonical.as_bytes());
        assert!(mac.verify_slice(&signature).is_ok());
    }
}

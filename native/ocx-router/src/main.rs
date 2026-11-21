//! ocx-router — loopback request router for the OpenCode provider family.
//!
//! Division of labour (see docs/OPENCODEX_ROUTER_DESIGN.md §8):
//!   * Node decides *what* to send: logical upstream, wire protocol, credential,
//!     model id, cache identity. It passes those as request headers.
//!   * Rust executes: header injection, one bounded retry, error taxonomy, SSE relay.
//!
//! Endpoints (all loopback):
//!   POST /v1/responses            responses protocol
//!   POST /v1/chat/completions     chat-completions protocol
//!   POST /v1/messages             anthropic messages protocol
//!   GET  /health                  readiness + catalog version
//!   POST /internal/catalog        Node pushes the model catalogue snapshot
//!   GET  /v1/models               the pushed catalogue
//!
//! Control headers (set by Node, never by clients):
//!   x-ocx-upstream   go | zen | zen-free
//!   x-ocx-protocol   responses | chat | messages
//!   x-ocx-model      bare upstream model id
//!   x-ocx-session    stable session id (`ses_…`); forwarded as x-opencode-session
//!   authorization    bearer for the selected credential, forwarded verbatim

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

const DEFAULT_PORT: u16 = 8790;
const DEFAULT_TIMEOUT_SECS: u64 = 180;
const MAX_ATTEMPTS: usize = 3;
const RETRY_BUDGET: Duration = Duration::from_secs(240);
const MAX_ERROR_BODY: usize = 8 * 1024;

#[derive(Clone, Serialize, Deserialize, Default)]
struct CatalogEntry {
    id: String,
    upstream: String,
    protocol: String,
    #[serde(default)]
    context_window: Option<u64>,
    #[serde(default)]
    free: bool,
}

#[derive(Clone, Serialize, Deserialize, Default)]
struct Catalog {
    #[serde(default)]
    version: String,
    #[serde(default)]
    models: Vec<CatalogEntry>,
}

#[derive(Clone)]
struct AppState {
    client: reqwest::Client,
    roots: HashMap<String, String>,
    catalog: Arc<RwLock<Catalog>>,
    timeout: Duration,
}

/// Wire protocol of one request.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Wire {
    Responses,
    Chat,
    Messages,
}

impl Wire {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "responses" => Some(Wire::Responses),
            "chat" | "chat-completions" | "chat_completions" => Some(Wire::Chat),
            "messages" => Some(Wire::Messages),
            _ => None,
        }
    }

    /// Path appended to the logical upstream root.
    fn path(self) -> &'static str {
        match self {
            Wire::Responses => "/openai/v1/responses",
            Wire::Chat => "/openai/v1/chat/completions",
            Wire::Messages => "/anthropic/v1/messages",
        }
    }
}

#[tokio::main]
async fn main() {
    let args = Args::parse(std::env::args().skip(1));
    let port = args.port.or_else(|| env_u16("OCX_ROUTER_PORT")).unwrap_or(DEFAULT_PORT);
    let timeout_secs = env_u64("OCX_ROUTER_TIMEOUT_SECS").unwrap_or(DEFAULT_TIMEOUT_SECS);

    let mut roots = HashMap::new();
    roots.insert(
        "go".to_string(),
        std::env::var("OCX_UPSTREAM_GO").unwrap_or_else(|_| "https://opencode.ai/inference/go".into()),
    );
    roots.insert(
        "zen".to_string(),
        std::env::var("OCX_UPSTREAM_ZEN").unwrap_or_else(|_| "https://opencode.ai/inference".into()),
    );

    let state = AppState {
        client: reqwest::Client::builder()
            .timeout(Duration::from_secs(timeout_secs))
            .build()
            .expect("build http client"),
        roots,
        catalog: Arc::new(RwLock::new(Catalog::default())),
        timeout: Duration::from_secs(timeout_secs),
    };

    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/responses", post(responses))
        .route("/v1/chat/completions", post(chat))
        .route("/v1/messages", post(messages))
        .route("/internal/catalog", post(put_catalog))
        .route("/v1/models", get(models))
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("ocx-router: failed to bind {addr}: {error}");
            std::process::exit(1);
        }
    };
    println!("ocx-router listening on http://{addr}");
    let shutdown = shutdown_signal();
    if let Err(error) = axum::serve(listener, app).with_graceful_shutdown(shutdown).await {
        eprintln!("ocx-router: server error: {error}");
        std::process::exit(1);
    }
}

struct Args {
    port: Option<u16>,
}

impl Args {
    fn parse(mut values: impl Iterator<Item = String>) -> Self {
        let mut port = None;
        while let Some(flag) = values.next() {
            match flag.as_str() {
                "--port" | "-p" => port = values.next().and_then(|value| value.parse().ok()),
                "--help" | "-h" => {
                    println!("ocx-router [--port <port>]");
                    std::process::exit(0);
                }
                other => {
                    if let Some(rest) = other.strip_prefix("--port=") {
                        port = rest.parse().ok();
                    }
                }
            }
        }
        Self { port }
    }
}

fn env_u16(key: &str) -> Option<u16> {
    std::env::var(key).ok().and_then(|value| value.parse().ok())
}

fn env_u64(key: &str) -> Option<u64> {
    std::env::var(key).ok().and_then(|value| value.parse().ok())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    println!("ocx-router: shutting down");
}

async fn health(State(state): State<AppState>) -> impl IntoResponse {
    let catalog = state.catalog.read().await;
    Json(serde_json::json!({
        "status": "ok",
        "catalogVersion": catalog.version,
        "models": catalog.models.len(),
        "upstreams": state.roots.keys().cloned().collect::<Vec<_>>(),
    }))
}

async fn put_catalog(State(state): State<AppState>, Json(catalog): Json<Catalog>) -> impl IntoResponse {
    let models = catalog.models.len();
    let version = catalog.version.clone();
    *state.catalog.write().await = catalog;
    Json(serde_json::json!({ "ok": true, "models": models, "version": version }))
}

async fn models(State(state): State<AppState>) -> impl IntoResponse {
    let catalog = state.catalog.read().await;
    Json(serde_json::json!({
        "object": "list",
        "data": catalog.models.iter().map(|entry| serde_json::json!({
            "id": entry.id,
            "object": "model",
            "owned_by": entry.upstream,
            "native_protocol": entry.protocol,
            "context_window": entry.context_window,
            "free": entry.free,
        })).collect::<Vec<_>>(),
    }))
}

async fn responses(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    forward(state, headers, body, Wire::Responses).await
}

async fn chat(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    forward(state, headers, body, Wire::Chat).await
}

async fn messages(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    forward(state, headers, body, Wire::Messages).await
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

/// One request lifecycle: resolve target, inject headers, bounded retry, relay.
async fn forward(state: AppState, headers: HeaderMap, body: Bytes, expected: Wire) -> Response {
    let protocol = header_str(&headers, "x-ocx-protocol")
        .and_then(Wire::parse)
        .unwrap_or(expected);
    let upstream = header_str(&headers, "x-ocx-upstream").unwrap_or("zen").to_string();
    let model = header_str(&headers, "x-ocx-model").map(str::to_string);
    let session = header_str(&headers, "x-ocx-session").map(str::to_string);

    // zen-free shares the zen host; it only differs in which models may be requested.
    let root_key = if upstream == "zen-free" { "zen" } else { upstream.as_str() };
    let root = match state.roots.get(root_key) {
        Some(root) => root.trim_end_matches('/').to_string(),
        None => {
            return error_response(StatusCode::BAD_REQUEST, "unknown_upstream", &format!("unknown upstream {upstream}"))
        }
    };
    let url = format!("{root}{}", protocol.path());

    let payload = match rewrite_model(&body, model.as_deref()) {
        Ok(bytes) => bytes,
        Err(message) => return error_response(StatusCode::BAD_REQUEST, "invalid_json", &message),
    };

    let authorization = header_str(&headers, "authorization").unwrap_or("").to_string();
    let started = Instant::now();
    let mut last_error: Option<Response> = None;

    for attempt in 0..MAX_ATTEMPTS {
        if started.elapsed() > RETRY_BUDGET {
            break;
        }
        let mut request = state
            .client
            .post(&url)
            .header("content-type", "application/json")
            .header("accept", "text/event-stream")
            .body(payload.clone());
        if !authorization.is_empty() {
            request = request.header("authorization", authorization.clone());
        }
        if let Some(session) = session.as_deref() {
            request = request
                .header("x-opencode-session", session)
                .header("x-opencode-client", "cli")
                .header("user-agent", "opencode/1.0.0");
        }

        let response = match tokio::time::timeout(state.timeout, request.send()).await {
            Err(_) => {
                return error_response(StatusCode::GATEWAY_TIMEOUT, "request_timeout", "upstream timed out");
            }
            Ok(Err(error)) => {
                if attempt + 1 >= MAX_ATTEMPTS {
                    return error_response(
                        StatusCode::BAD_GATEWAY,
                        "upstream_unreachable",
                        &format!("cannot reach upstream: {error}"),
                    );
                }
                tokio::time::sleep(backoff(attempt)).await;
                continue;
            }
            Ok(Ok(response)) => response,
        };

        let status = response.status();
        if status.is_success() {
            return relay(response).await;
        }

        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse::<u64>().ok());
        let body_text = read_error_body(response).await;
        last_error = Some(mapped_response(status, body_text, retry_after));

        // Only retry the classes where a retry can plausibly help.
        let retryable = matches!(status.as_u16(), 429 | 500 | 502 | 503 | 504);
        if !retryable || attempt + 1 >= MAX_ATTEMPTS {
            break;
        }
        let wait = retry_after
            .filter(|seconds| *seconds <= 30)
            .map(Duration::from_secs)
            .unwrap_or_else(|| backoff(attempt));
        tokio::time::sleep(wait).await;
    }

    last_error.unwrap_or_else(|| error_response(StatusCode::BAD_GATEWAY, "upstream_error", "upstream failed"))
}

fn backoff(attempt: usize) -> Duration {
    Duration::from_millis(250 * 2u64.pow(attempt as u32))
}

/// Replace the request `model` with the bare upstream id when Node supplied one.
fn rewrite_model(body: &Bytes, model: Option<&str>) -> Result<Bytes, String> {
    let Some(model) = model else { return Ok(body.clone()) };
    let mut value: serde_json::Value =
        serde_json::from_slice(body).map_err(|error| format!("request body is not JSON: {error}"))?;
    match value.get_mut("model") {
        Some(slot) => *slot = serde_json::Value::String(model.to_string()),
        None => return Err("request body has no model field".to_string()),
    }
    serde_json::to_vec(&value)
        .map(Bytes::from)
        .map_err(|error| format!("cannot serialise request: {error}"))
}

/// Relay a successful upstream response, streaming SSE bodies unchanged.
async fn relay(response: reqwest::Response) -> Response {
    let status = response.status();
    let mut builder = Response::builder().status(StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::OK));
    if let Some(content_type) = response.headers().get("content-type") {
        builder = builder.header("content-type", content_type);
    }
    let stream = response.bytes_stream().map(|chunk| chunk.map_err(std::io::Error::other));
    builder.body(Body::from_stream(stream)).unwrap_or_else(|_| {
        error_response(StatusCode::BAD_GATEWAY, "relay_failed", "cannot build response").into_response()
    })
}

async fn read_error_body(response: reqwest::Response) -> String {
    let mut text = String::new();
    let mut stream = response.bytes_stream();
    let mut size = 0usize;
    while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else { break };
        size += chunk.len();
        text.push_str(&String::from_utf8_lossy(&chunk));
        if size >= MAX_ERROR_BODY {
            break;
        }
    }
    text
}

/// Error taxonomy shared with the Node side: `{type:"error",error:{type,code,message}}`.
fn map_failure(status: u16, body: &str) -> &'static str {
    let lowered = body.to_ascii_lowercase();
    if lowered.contains("freeusagelimit") || lowered.contains("free usage limit") {
        return "free_limit";
    }
    if lowered.contains("missingsessionid") {
        return "missing_session";
    }
    if lowered.contains("autherror") || lowered.contains("missing api key") {
        return "invalid_key";
    }
    match status {
        401 => "invalid_key",
        402 => "quota_exhausted",
        403 => "model_denied",
        429 => "rate_limited",
        404 => "model_not_found",
        400 => "bad_request",
        408 => "timeout",
        _ => "upstream_error",
    }
}

fn mapped_response(upstream_status: reqwest::StatusCode, body: String, retry_after: Option<u64>) -> Response {
    let code = map_failure(upstream_status.as_u16(), &body);
    // 5xx collapses to 502 so clients retry instead of treating it as their fault.
    let status = if upstream_status.is_server_error() {
        StatusCode::BAD_GATEWAY
    } else {
        StatusCode::from_u16(upstream_status.as_u16()).unwrap_or(StatusCode::BAD_REQUEST)
    };
    let message = extract_message(&body).unwrap_or_else(|| format!("upstream returned {upstream_status}"));
    let payload = serde_json::json!({
        "type": "error",
        "error": { "type": "upstream_error", "code": format!("opencode_{code}"), "message": message },
    });
    let mut builder = Response::builder().status(status).header("content-type", "application/json");
    if let Some(seconds) = retry_after {
        builder = builder.header("retry-after", HeaderValue::from_str(&seconds.to_string()).unwrap_or(HeaderValue::from_static("1")));
    }
    builder
        .body(Body::from(payload.to_string()))
        .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
}

fn extract_message(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let error = value.get("error")?;
    error
        .get("message")
        .or_else(|| error.get("type"))
        .and_then(|value| value.as_str())
        .map(|value| value.chars().take(300).collect())
}

fn error_response(status: StatusCode, code: &str, message: &str) -> Response {
    let payload = serde_json::json!({
        "type": "error",
        "error": { "type": "router_error", "code": format!("ocx_{code}"), "message": message },
    });
    (status, Json(payload)).into_response()
}

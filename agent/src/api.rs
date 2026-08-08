use std::{sync::Arc, time::Duration};

use axum::{
    Extension, Json, Router,
    extract::{Path, Query, State},
    http::{HeaderName, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use tokio::{sync::Semaphore, time::timeout};
use tower::limit::ConcurrencyLimitLayer;
use tower_http::{
    catch_panic::CatchPanicLayer, sensitive_headers::SetSensitiveRequestHeadersLayer,
    timeout::TimeoutLayer, trace::TraceLayer,
};
use tracing::{info, warn};

use crate::{
    auth::{Authenticator, VerifiedRequestId, authenticate_and_sign},
    config::Config,
    deployments::{
        DeploymentRecord, DeploymentStore, log_tail, persist_record, request_shape, run_deploy,
        teardown, validate_deploy_request,
    },
    docker::{DockerBackend, DockerError},
    metrics::{MetricsSampler, now_rfc3339},
    models::{
        ActionResponse, DeployAccepted, DeployRequest, DeploymentResponse, DeploymentState,
        DeploymentsResponse, ErrorBody, ErrorEnvelope, HealthResponse, LogsResponse, NodeIdentity,
        OkResponse,
    },
};

#[derive(Clone)]
pub struct AppState {
    config: Arc<Config>,
    authenticator: Arc<Authenticator>,
    docker: Arc<dyn DockerBackend>,
    metrics: Arc<MetricsSampler>,
    deployments: DeploymentStore,
    mutations: Arc<Semaphore>,
}

impl AppState {
    pub fn new(
        config: Arc<Config>,
        authenticator: Arc<Authenticator>,
        docker: Arc<dyn DockerBackend>,
        metrics: Arc<MetricsSampler>,
        deployments: DeploymentStore,
    ) -> Self {
        Self {
            config,
            authenticator,
            docker,
            metrics,
            deployments,
            mutations: Arc::new(Semaphore::new(1)),
        }
    }
}

pub fn build_router(state: AppState) -> Router {
    let auth = state.authenticator.clone();
    let timeout_duration = Duration::from_secs(state.config.request_timeout_seconds);
    let request_concurrency = state.config.request_concurrency;
    Router::new()
        .route("/v1/health", get(health))
        .route("/v1/system", get(system))
        .route("/v1/containers", get(containers))
        .route("/v1/containers/{id}", get(inspect))
        .route("/v1/containers/{id}/logs", get(logs))
        .route("/v1/containers/{id}/start", post(start))
        .route("/v1/containers/{id}/stop", post(stop))
        .route("/v1/containers/{id}/restart", post(restart))
        .route(
            "/v1/deployments",
            post(create_deployment).get(list_deployments),
        )
        .route(
            "/v1/deployments/{id}",
            get(get_deployment).delete(delete_deployment),
        )
        .fallback(not_found)
        .layer(TraceLayer::new_for_http())
        .layer(CatchPanicLayer::new())
        .layer(TimeoutLayer::with_status_code(
            StatusCode::GATEWAY_TIMEOUT,
            timeout_duration,
        ))
        .layer(ConcurrencyLimitLayer::new(request_concurrency))
        .layer(SetSensitiveRequestHeadersLayer::new([
            HeaderName::from_static("x-skywatch-signature"),
            HeaderName::from_static("x-skywatch-content-sha256"),
            HeaderName::from_static("x-skywatch-key-id"),
        ]))
        // Authentication is outermost so every response to a valid request is signed.
        .layer(middleware::from_fn_with_state(auth, authenticate_and_sign))
        .with_state(state)
}

async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    let system = state.metrics.system().await;
    let docker_available = state.metrics.docker_available();
    let node = NodeIdentity {
        id: state.config.node_id.to_string(),
        name: state.config.node_name.clone(),
        agent_version: env!("CARGO_PKG_VERSION").into(),
    };
    Json(HealthResponse {
        api_version: "v1",
        agent_version: env!("CARGO_PKG_VERSION"),
        node_id: state.config.node_id.to_string(),
        node,
        status: if docker_available { "ok" } else { "degraded" },
        docker_available,
        uptime_seconds: system.uptime_seconds,
        sampled_at: system.sampled_at,
    })
}

async fn system(State(state): State<AppState>) -> Json<crate::models::SystemSnapshot> {
    Json(state.metrics.system().await)
}

async fn containers(State(state): State<AppState>) -> Json<crate::models::ContainersResponse> {
    Json(state.metrics.containers().await)
}

async fn inspect(
    State(state): State<AppState>,
    Extension(request_id): Extension<VerifiedRequestId>,
    Path(id): Path<String>,
) -> Result<Json<crate::models::ContainerDetail>, ApiError> {
    validate_container_id(&id, &request_id.0)?;
    let detail = timeout(state.config.docker_timeout(), state.docker.inspect(&id))
        .await
        .map_err(|_| ApiError::timeout(request_id.0.clone()))?
        .map_err(|error| ApiError::docker(error, request_id.0.clone()))?;
    Ok(Json(detail))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LogsQuery {
    tail: Option<usize>,
}

async fn logs(
    State(state): State<AppState>,
    Extension(request_id): Extension<VerifiedRequestId>,
    Path(id): Path<String>,
    Query(query): Query<LogsQuery>,
) -> Result<Json<LogsResponse>, ApiError> {
    validate_container_id(&id, &request_id.0)?;
    let tail = query.tail.unwrap_or(state.config.log_tail_default);
    if tail == 0 || tail > state.config.log_tail_max {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_log_tail",
            format!("tail must be between 1 and {}", state.config.log_tail_max),
            request_id.0,
        ));
    }
    let (entries, truncated) = timeout(
        state.config.docker_timeout(),
        state.docker.logs(&id, tail, state.config.log_bytes_max),
    )
    .await
    .map_err(|_| ApiError::timeout(request_id.0.clone()))?
    .map_err(|error| ApiError::docker(error, request_id.0.clone()))?;
    let mut response = LogsResponse {
        container_id: id,
        tail,
        truncated,
        entries,
        logs: String::new(),
        collected_at: now_rfc3339(),
    };
    rebuild_joined_logs(&mut response);
    while serde_json::to_vec(&response)
        .map(|body| body.len() > state.config.log_bytes_max)
        .unwrap_or(true)
        && !response.entries.is_empty()
    {
        response.entries.pop();
        response.truncated = true;
        rebuild_joined_logs(&mut response);
    }
    Ok(Json(response))
}

fn rebuild_joined_logs(response: &mut LogsResponse) {
    response.logs.clear();
    for entry in &response.entries {
        response.logs.push_str(&entry.message);
    }
}

async fn start(
    State(state): State<AppState>,
    Extension(request_id): Extension<VerifiedRequestId>,
    Path(id): Path<String>,
) -> Result<Json<ActionResponse>, ApiError> {
    mutate(state, request_id.0, id, "start").await
}

async fn stop(
    State(state): State<AppState>,
    Extension(request_id): Extension<VerifiedRequestId>,
    Path(id): Path<String>,
) -> Result<Json<ActionResponse>, ApiError> {
    mutate(state, request_id.0, id, "stop").await
}

async fn restart(
    State(state): State<AppState>,
    Extension(request_id): Extension<VerifiedRequestId>,
    Path(id): Path<String>,
) -> Result<Json<ActionResponse>, ApiError> {
    mutate(state, request_id.0, id, "restart").await
}

async fn create_deployment(
    State(state): State<AppState>,
    Extension(request_id): Extension<VerifiedRequestId>,
    Json(request): Json<DeployRequest>,
) -> Result<(StatusCode, Json<DeployAccepted>), ApiError> {
    let slug = validate_deploy_request(&request).map_err(|(code, message)| {
        ApiError::new(StatusCode::BAD_REQUEST, code, message, request_id.0.clone())
    })?;
    if state.deployments.contains(&request.deployment_id).await {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "deployment_conflict",
            "A deployment with this ID already exists.",
            request_id.0,
        ));
    }
    let workdir = state.config.deployments_dir.join(&request.deployment_id);
    tokio::fs::create_dir_all(&workdir).await.map_err(|error| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "deployment_io_error",
            format!("could not create the deployment work directory: {error}"),
            request_id.0.clone(),
        )
    })?;
    let (source_type, teardown) = request_shape(&request);
    let now = now_rfc3339();
    let record = DeploymentRecord {
        deployment_id: request.deployment_id.clone(),
        name: request.name.clone(),
        slug: slug.clone(),
        source_type,
        teardown,
        status: DeploymentState::Running,
        detail: "deployment queued".into(),
        created_at: now.clone(),
        updated_at: now,
    };
    state.deployments.insert(record.clone()).await;
    if let Err(error) = persist_record(&workdir, &record).await {
        warn!(
            event = "deployment_state_persist_failed",
            deployment_id = %record.deployment_id,
            %error,
            "could not persist deployment state"
        );
    }
    info!(
        event = "deployment_accepted",
        request_id = %request_id.0,
        deployment_id = %record.deployment_id,
        name = %record.name,
        slug = %record.slug,
        "deployment accepted"
    );
    let task_state = state.clone();
    let task_workdir = workdir.clone();
    tokio::spawn(async move {
        execute_deployment(task_state, task_workdir, request, slug).await;
    });
    Ok((
        StatusCode::ACCEPTED,
        Json(DeployAccepted {
            deployment_id: record.deployment_id,
            status: DeploymentState::Running,
        }),
    ))
}

/// Runs inside a spawned task so the POST responds immediately. The deploy
/// work itself is serialized through the mutations semaphore.
async fn execute_deployment(
    state: AppState,
    workdir: std::path::PathBuf,
    request: DeployRequest,
    slug: String,
) {
    let deployment_id = request.deployment_id.clone();
    let Ok(_permit) = state.mutations.acquire().await else {
        let _ = state
            .deployments
            .finish(
                &deployment_id,
                DeploymentState::Failed,
                "agent is shutting down".into(),
            )
            .await;
        return;
    };
    let started = std::time::Instant::now();
    let result = run_deploy(&state.deployments, &workdir, &request, &slug).await;
    let (status, detail) = match result {
        Ok(detail) => (DeploymentState::Success, detail),
        Err(detail) => (DeploymentState::Failed, detail),
    };
    if let Some(record) = state
        .deployments
        .finish(&deployment_id, status, detail)
        .await
        && let Err(error) = persist_record(&workdir, &record).await
    {
        warn!(
            event = "deployment_state_persist_failed",
            deployment_id,
            %error,
            "could not persist deployment state"
        );
    }
    info!(
        event = "deployment_finished",
        deployment_id,
        status = ?status,
        duration_ms = started.elapsed().as_millis(),
        "deployment finished"
    );
}

async fn list_deployments(State(state): State<AppState>) -> Json<DeploymentsResponse> {
    let deployments = state
        .deployments
        .list()
        .await
        .iter()
        .map(DeploymentRecord::status_view)
        .collect();
    Json(DeploymentsResponse { deployments })
}

async fn get_deployment(
    State(state): State<AppState>,
    Extension(request_id): Extension<VerifiedRequestId>,
    Path(id): Path<String>,
) -> Result<Json<DeploymentResponse>, ApiError> {
    let record = lookup_deployment(&state, &id, &request_id.0).await?;
    let mut status = record.status_view();
    if record.status == DeploymentState::Running {
        let log_path = state.config.deployments_dir.join(&id).join("deploy.log");
        let tail = log_tail(&log_path).await;
        if !tail.is_empty() {
            status.detail = tail;
        }
    }
    Ok(Json(DeploymentResponse { deployment: status }))
}

async fn delete_deployment(
    State(state): State<AppState>,
    Extension(request_id): Extension<VerifiedRequestId>,
    Path(id): Path<String>,
) -> Result<Json<OkResponse>, ApiError> {
    let record = lookup_deployment(&state, &id, &request_id.0).await?;
    let _permit = state.mutations.acquire().await.map_err(|_| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "agent_shutting_down",
            "Agent is shutting down.",
            request_id.0.clone(),
        )
    })?;
    let workdir = state.config.deployments_dir.join(&id);
    teardown(&record, &workdir).await;
    state.deployments.remove(&id).await;
    if let Err(error) = tokio::fs::remove_dir_all(&workdir).await {
        warn!(
            event = "deployment_workdir_removal_failed",
            deployment_id = %id,
            %error,
            "could not remove deployment work directory"
        );
    }
    info!(
        event = "deployment_deleted",
        request_id = %request_id.0,
        deployment_id = %id,
        "deployment deleted"
    );
    Ok(Json(OkResponse { ok: true }))
}

async fn lookup_deployment(
    state: &AppState,
    id: &str,
    request_id: &str,
) -> Result<DeploymentRecord, ApiError> {
    if uuid::Uuid::parse_str(id).is_err() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_deployment_id",
            "Deployment ID must be a UUID.",
            request_id.to_owned(),
        ));
    }
    state.deployments.get(id).await.ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            "deployment_not_found",
            "Deployment was not found.",
            request_id.to_owned(),
        )
    })
}

async fn mutate(
    state: AppState,
    request_id: String,
    id: String,
    action: &'static str,
) -> Result<Json<ActionResponse>, ApiError> {
    validate_container_id(&id, &request_id)?;
    let _permit = state.mutations.acquire().await.map_err(|_| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "agent_shutting_down",
            "Agent is shutting down.",
            request_id.clone(),
        )
    })?;
    let started = std::time::Instant::now();
    let operation = match action {
        "start" => state.docker.start(&id).await,
        "stop" => state.docker.stop(&id, state.config.docker_timeout()).await,
        "restart" => {
            state
                .docker
                .restart(&id, state.config.docker_timeout())
                .await
        }
        _ => unreachable!("action routes are fixed"),
    };
    let changed = operation.map_err(|error| ApiError::docker(error, request_id.clone()))?;
    let detail = state
        .docker
        .inspect(&id)
        .await
        .map_err(|error| ApiError::docker(error, request_id.clone()))?;
    info!(
        event = "container_mutation",
        request_id,
        action,
        container_id = id,
        changed,
        duration_ms = started.elapsed().as_millis(),
        "bounded Docker action completed"
    );
    Ok(Json(ActionResponse {
        action,
        changed,
        container: detail.container,
        completed_at: now_rfc3339(),
    }))
}

async fn not_found(Extension(request_id): Extension<VerifiedRequestId>) -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "not_found",
        "Route not found.",
        request_id.0,
    )
}

fn validate_container_id(id: &str, request_id: &str) -> Result<(), ApiError> {
    if id.len() == 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        Ok(())
    } else {
        Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_container_id",
            "Container ID must be a canonical 64-character lowercase hexadecimal ID.",
            request_id.to_owned(),
        ))
    }
}

pub struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
    request_id: String,
}

impl ApiError {
    fn new(
        status: StatusCode,
        code: &'static str,
        message: impl Into<String>,
        request_id: String,
    ) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            request_id,
        }
    }

    fn timeout(request_id: String) -> Self {
        Self::new(
            StatusCode::GATEWAY_TIMEOUT,
            "docker_timeout",
            "Docker did not respond before the operation timeout.",
            request_id,
        )
    }

    fn docker(error: DockerError, request_id: String) -> Self {
        match error {
            DockerError::NotFound => Self::new(
                StatusCode::NOT_FOUND,
                "container_not_found",
                "Container was not found.",
                request_id,
            ),
            DockerError::Conflict => Self::new(
                StatusCode::CONFLICT,
                "container_conflict",
                "Container state conflicts with the requested operation.",
                request_id,
            ),
            DockerError::Unavailable => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "docker_unavailable",
                "Docker is unavailable.",
                request_id,
            ),
            DockerError::Operation => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "docker_operation_failed",
                "Docker could not complete the operation.",
                request_id,
            ),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorEnvelope {
                error: ErrorBody {
                    code: self.code,
                    message: self.message,
                    request_id: self.request_id,
                },
            }),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_canonical_container_ids() {
        let valid = "a".repeat(64);
        assert!(validate_container_id(&valid, "request").is_ok());
        assert!(validate_container_id("nginx", "request").is_err());
        assert!(validate_container_id(&"A".repeat(64), "request").is_err());
    }
}

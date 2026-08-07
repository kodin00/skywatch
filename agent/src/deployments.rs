use std::{collections::HashMap, path::Path, process::Stdio, sync::Arc};

use serde::{Deserialize, Serialize};
use tokio::{fs, io::AsyncWriteExt, process::Command, sync::Mutex};
use tracing::{info, warn};
use uuid::Uuid;

use crate::{
    metrics::now_rfc3339,
    models::{DeployRequest, DeploySource, DeploymentState, DeploymentStatus, GithubBuildMode},
};

const MAX_NAME_LEN: usize = 80;
const MAX_REFERENCE_LEN: usize = 512;
const MAX_SOURCE_BYTES: usize = 256 * 1024;
const MAX_ENV_BYTES: usize = 64 * 1024;
const DETAIL_BYTES: usize = 4 * 1024;
const STDERR_TAIL_BYTES: usize = 2 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceType {
    Compose,
    Github,
    Image,
}

/// How a deployment is torn down when it is deleted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TeardownKind {
    /// `docker compose down` against the stored compose file.
    Compose,
    /// `docker rm -f` of the slug-named container.
    Container,
    /// Command builds manage their own processes; nothing to tear down.
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentRecord {
    pub deployment_id: String,
    pub name: String,
    pub slug: String,
    pub source_type: SourceType,
    pub teardown: TeardownKind,
    pub status: DeploymentState,
    pub detail: String,
    pub created_at: String,
    pub updated_at: String,
}

impl DeploymentRecord {
    pub fn status_view(&self) -> DeploymentStatus {
        DeploymentStatus {
            deployment_id: self.deployment_id.clone(),
            name: self.name.clone(),
            status: self.status,
            detail: self.detail.clone(),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
        }
    }
}

#[derive(Clone, Default)]
pub struct DeploymentStore {
    records: Arc<Mutex<HashMap<String, DeploymentRecord>>>,
}

impl DeploymentStore {
    /// Reload records persisted under the deployments directory. Records that
    /// were still running when the agent stopped are marked failed.
    pub fn load(deployments_dir: &Path) -> Self {
        let mut records = HashMap::new();
        if let Ok(entries) = std::fs::read_dir(deployments_dir) {
            for entry in entries.flatten() {
                let workdir = entry.path();
                let state_path = workdir.join("state.json");
                let Ok(raw) = std::fs::read_to_string(&state_path) else {
                    continue;
                };
                let Ok(mut record) = serde_json::from_str::<DeploymentRecord>(&raw) else {
                    warn!(
                        event = "deployment_state_unreadable",
                        path = %state_path.display(),
                        "ignoring unreadable deployment record"
                    );
                    continue;
                };
                if record.status == DeploymentState::Running {
                    record.status = DeploymentState::Failed;
                    record.detail = "agent restarted during deployment".into();
                    record.updated_at = now_rfc3339();
                    if let Err(error) = persist_record_sync(&workdir, &record) {
                        warn!(
                            event = "deployment_state_persist_failed",
                            deployment_id = %record.deployment_id,
                            %error,
                            "could not persist restarted deployment state"
                        );
                    }
                }
                records.insert(record.deployment_id.clone(), record);
            }
        }
        Self {
            records: Arc::new(Mutex::new(records)),
        }
    }

    pub async fn contains(&self, deployment_id: &str) -> bool {
        self.records.lock().await.contains_key(deployment_id)
    }

    pub async fn insert(&self, record: DeploymentRecord) {
        self.records
            .lock()
            .await
            .insert(record.deployment_id.clone(), record);
    }

    pub async fn get(&self, deployment_id: &str) -> Option<DeploymentRecord> {
        self.records.lock().await.get(deployment_id).cloned()
    }

    pub async fn list(&self) -> Vec<DeploymentRecord> {
        let mut records: Vec<DeploymentRecord> =
            self.records.lock().await.values().cloned().collect();
        records.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.deployment_id.cmp(&right.deployment_id))
        });
        records
    }

    pub async fn update_detail(&self, deployment_id: &str, detail: String) {
        if let Some(record) = self.records.lock().await.get_mut(deployment_id) {
            record.detail = cap_detail(&detail);
            record.updated_at = now_rfc3339();
        }
    }

    pub async fn finish(
        &self,
        deployment_id: &str,
        status: DeploymentState,
        detail: String,
    ) -> Option<DeploymentRecord> {
        let mut records = self.records.lock().await;
        let record = records.get_mut(deployment_id)?;
        record.status = status;
        record.detail = cap_detail(&detail);
        record.updated_at = now_rfc3339();
        Some(record.clone())
    }

    pub async fn remove(&self, deployment_id: &str) -> Option<DeploymentRecord> {
        self.records.lock().await.remove(deployment_id)
    }
}

pub async fn persist_record(workdir: &Path, record: &DeploymentRecord) -> std::io::Result<()> {
    let body = serde_json::to_vec_pretty(record)?;
    fs::write(workdir.join("state.json"), body).await
}

fn persist_record_sync(workdir: &Path, record: &DeploymentRecord) -> std::io::Result<()> {
    let body = serde_json::to_vec_pretty(record)?;
    std::fs::write(workdir.join("state.json"), body)
}

/// Validate a deploy request and return the derived container/compose slug.
pub fn validate_deploy_request(request: &DeployRequest) -> Result<String, (&'static str, String)> {
    if Uuid::parse_str(&request.deployment_id).is_err() {
        return Err((
            "invalid_deployment_id",
            "deploymentId must be a UUID.".into(),
        ));
    }
    if request.name.is_empty() || request.name.chars().count() > MAX_NAME_LEN {
        return Err((
            "invalid_name",
            format!("name must be between 1 and {MAX_NAME_LEN} characters."),
        ));
    }
    if request.env.len() > MAX_ENV_BYTES {
        return Err((
            "invalid_source",
            format!("env must be at most {MAX_ENV_BYTES} bytes."),
        ));
    }
    match &request.source {
        DeploySource::Compose(source) => {
            if source.compose.is_empty() || source.compose.len() > MAX_SOURCE_BYTES {
                return Err((
                    "invalid_source",
                    format!("compose must be between 1 and {MAX_SOURCE_BYTES} bytes."),
                ));
            }
        }
        DeploySource::Github(source) => {
            if source.repo_url.len() > MAX_REFERENCE_LEN
                || !(source.repo_url.starts_with("https://")
                    || source.repo_url.starts_with("git@")
                    || source.repo_url.starts_with("ssh://"))
            {
                return Err((
                    "invalid_source",
                    "repoUrl must be at most 512 characters and start with https://, git@, or ssh://."
                        .into(),
                ));
            }
            if let Some(path) = &source.dockerfile_path {
                let candidate = Path::new(path);
                if path.len() > MAX_REFERENCE_LEN
                    || candidate.is_absolute()
                    || candidate
                        .components()
                        .any(|component| matches!(component, std::path::Component::ParentDir))
                {
                    return Err((
                        "invalid_source",
                        "dockerfilePath must be a relative path inside the repository.".into(),
                    ));
                }
            }
            match source.build_mode {
                GithubBuildMode::Docker => {}
                GithubBuildMode::Command => {
                    let command = source.build_command.as_deref().unwrap_or_default();
                    if command.is_empty() || command.len() > MAX_SOURCE_BYTES {
                        return Err((
                            "invalid_source",
                            format!(
                                "buildCommand is required for command builds and must be at most {MAX_SOURCE_BYTES} bytes."
                            ),
                        ));
                    }
                }
            }
        }
        DeploySource::Image(source) => {
            if source.image.is_empty() || source.image.len() > MAX_REFERENCE_LEN {
                return Err((
                    "invalid_source",
                    format!("image must be between 1 and {MAX_REFERENCE_LEN} characters."),
                ));
            }
        }
    }
    Ok(slugify(&request.name))
}

/// Source type and teardown strategy for a validated request.
pub fn request_shape(request: &DeployRequest) -> (SourceType, TeardownKind) {
    match &request.source {
        DeploySource::Compose(_) => (SourceType::Compose, TeardownKind::Compose),
        DeploySource::Github(source) => (
            SourceType::Github,
            match source.build_mode {
                GithubBuildMode::Docker => TeardownKind::Container,
                GithubBuildMode::Command => TeardownKind::None,
            },
        ),
        DeploySource::Image(_) => (SourceType::Image, TeardownKind::Container),
    }
}

/// Derive the container/compose project name from a deployment name:
/// lowercase, non-alphanumeric runs replaced with '-', leading/trailing '-'
/// trimmed, at most 40 characters, "app" when nothing remains, prefixed with
/// `skywatch-`.
pub fn slugify(name: &str) -> String {
    let slug = raw_slug(name);
    format!("skywatch-{slug}")
}

fn raw_slug(name: &str) -> String {
    let mut slug = String::new();
    let mut pending_dash = false;
    for character in name.chars().flat_map(char::to_lowercase) {
        if character.is_ascii_alphanumeric() {
            if pending_dash && !slug.is_empty() {
                slug.push('-');
            }
            pending_dash = false;
            slug.push(character);
        } else {
            pending_dash = true;
        }
    }
    slug.truncate(40);
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() { "app".into() } else { slug }
}

/// Run every deploy step, appending to deploy.log and refreshing the record's
/// detail as steps complete. Returns the final detail on success or the
/// failing step and its stderr tail on failure. Never logs the GitHub token.
pub async fn run_deploy(
    store: &DeploymentStore,
    workdir: &Path,
    request: &DeployRequest,
    slug: &str,
) -> Result<String, String> {
    let log_path = workdir.join("deploy.log");
    if !request.env.is_empty() {
        write_private(&workdir.join(".env"), request.env.as_bytes())
            .await
            .map_err(|error| format!("could not write .env: {error}"))?;
        append_log(&log_path, "wrote .env").await;
    }
    let result = match &request.source {
        DeploySource::Compose(source) => deploy_compose(workdir, &log_path, source, slug).await,
        DeploySource::Github(source) => {
            deploy_github(workdir, &log_path, source, request, slug).await
        }
        DeploySource::Image(source) => deploy_image(workdir, &log_path, &source.image, slug).await,
    };
    refresh_detail(store, &request.deployment_id, &log_path).await;
    result?;
    Ok(log_tail(&log_path).await)
}

async fn deploy_compose(
    workdir: &Path,
    log_path: &Path,
    source: &crate::models::ComposeSource,
    slug: &str,
) -> Result<(), String> {
    ensure_binary(log_path, "docker").await?;
    fs::write(workdir.join("compose.yaml"), &source.compose)
        .await
        .map_err(|error| format!("could not write compose.yaml: {error}"))?;
    append_log(log_path, "wrote compose.yaml").await;
    let display = format!("docker compose -p {slug} -f compose.yaml up -d");
    let mut command = Command::new("docker");
    command.args(["compose", "-p", slug, "-f", "compose.yaml", "up", "-d"]);
    run_step(workdir, log_path, &display, &mut command, None).await?;
    Ok(())
}

async fn deploy_github(
    workdir: &Path,
    log_path: &Path,
    source: &crate::models::GithubSource,
    request: &DeployRequest,
    slug: &str,
) -> Result<(), String> {
    ensure_binary(log_path, "git").await?;
    if source.build_mode == GithubBuildMode::Docker {
        ensure_binary(log_path, "docker").await?;
    }
    let (clone_url, display_url) =
        credentialed_url(&source.repo_url, request.github_token.as_deref());
    let secret = request
        .github_token
        .as_deref()
        .filter(|_| clone_url != display_url);
    let mut args: Vec<String> = vec!["clone".into(), "--depth".into(), "1".into()];
    if let Some(branch) = &source.branch {
        args.push("--branch".into());
        args.push(branch.clone());
    }
    args.push(clone_url);
    args.push("repo".into());
    let mut display_args = args.clone();
    let url_index = display_args.len() - 2;
    display_args[url_index] = display_url;
    let display = format!("git {}", display_args.join(" "));
    let mut command = Command::new("git");
    command.args(&args);
    run_step(workdir, log_path, &display, &mut command, secret).await?;

    let repo = workdir.join("repo");
    if !request.env.is_empty() {
        write_private(&repo.join(".env"), request.env.as_bytes())
            .await
            .map_err(|error| format!("could not write repo .env: {error}"))?;
        append_log(log_path, "wrote repo/.env").await;
    }
    match source.build_mode {
        GithubBuildMode::Docker => {
            let dockerfile = source.dockerfile_path.as_deref().unwrap_or("Dockerfile");
            let image_tag = format!("{slug}:latest");
            let display = format!("docker build -f {dockerfile} -t {image_tag} .");
            let mut build = Command::new("docker");
            build.args(["build", "-f", dockerfile, "-t", &image_tag, "."]);
            run_step(&repo, log_path, &display, &mut build, None).await?;
            remove_container(&repo, log_path, slug).await;
            let mut run_args: Vec<String> = vec![
                "run".into(),
                "-d".into(),
                "--name".into(),
                slug.into(),
                "--restart".into(),
                "unless-stopped".into(),
            ];
            if !request.env.is_empty() {
                run_args.push("--env-file".into());
                run_args.push(".env".into());
            }
            run_args.push(image_tag);
            let display = format!("docker {}", run_args.join(" "));
            let mut run = Command::new("docker");
            run.args(&run_args);
            run_step(&repo, log_path, &display, &mut run, None).await?;
        }
        GithubBuildMode::Command => {
            let build_command = source.build_command.as_deref().unwrap_or_default();
            let display = format!("sh -c {build_command}");
            let mut command = Command::new("sh");
            command.arg("-c").arg(build_command);
            for (key, value) in parse_env(&request.env) {
                command.env(key, value);
            }
            run_step(&repo, log_path, &display, &mut command, None).await?;
        }
    }
    Ok(())
}

async fn deploy_image(
    workdir: &Path,
    log_path: &Path,
    image: &str,
    slug: &str,
) -> Result<(), String> {
    ensure_binary(log_path, "docker").await?;
    let display = format!("docker pull {image}");
    let mut pull = Command::new("docker");
    pull.args(["pull", image]);
    run_step(workdir, log_path, &display, &mut pull, None).await?;
    remove_container(workdir, log_path, slug).await;
    let env_file = workdir.join(".env");
    let mut run_args: Vec<String> = vec![
        "run".into(),
        "-d".into(),
        "--name".into(),
        slug.into(),
        "--restart".into(),
        "unless-stopped".into(),
    ];
    if env_file.exists() {
        run_args.push("--env-file".into());
        run_args.push(env_file.display().to_string());
    }
    run_args.push(image.into());
    let display = format!("docker {}", run_args.join(" "));
    let mut run = Command::new("docker");
    run.args(&run_args);
    run_step(workdir, log_path, &display, &mut run, None).await?;
    Ok(())
}

/// Tear a deployment down according to its recorded strategy. Best-effort:
/// failures are logged but not reported.
pub async fn teardown(record: &DeploymentRecord, workdir: &Path) {
    let log_path = workdir.join("deploy.log");
    match record.teardown {
        TeardownKind::Compose => {
            let compose = workdir.join("compose.yaml");
            if compose.exists() {
                let display = format!(
                    "docker compose -p {} -f compose.yaml down --remove-orphans",
                    record.slug
                );
                let mut command = Command::new("docker");
                command.args([
                    "compose",
                    "-p",
                    &record.slug,
                    "-f",
                    "compose.yaml",
                    "down",
                    "--remove-orphans",
                ]);
                let _ = run_step(workdir, &log_path, &display, &mut command, None).await;
            }
        }
        TeardownKind::Container => {
            remove_container(workdir, &log_path, &record.slug).await;
        }
        TeardownKind::None => {
            info!(
                event = "deployment_teardown_skipped",
                deployment_id = %record.deployment_id,
                "command deployment manages its own processes; nothing to tear down"
            );
        }
    }
}

async fn remove_container(dir: &Path, log_path: &Path, slug: &str) {
    let display = format!("docker rm -f {slug}");
    let mut command = Command::new("docker");
    command.args(["rm", "-f", slug]);
    let _ = run_step(dir, log_path, &display, &mut command, None).await;
}

/// Verify a required CLI exists before any real work starts.
async fn ensure_binary(log_path: &Path, binary: &str) -> Result<(), String> {
    let available = Command::new(binary)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|status| status.success())
        .unwrap_or(false);
    if available {
        append_log(log_path, &format!("checked `{binary}` is available")).await;
        Ok(())
    } else {
        Err(format!(
            "required binary `{binary}` is not installed or not on PATH"
        ))
    }
}

/// Inject GitHub credentials into an HTTPS clone URL. Returns the URL to use
/// and the redacted URL that is safe to log. The token is never written to
/// disk or the deploy log.
fn credentialed_url(repo_url: &str, token: Option<&str>) -> (String, String) {
    match token {
        Some(token) if repo_url.starts_with("https://") => {
            let rest = &repo_url["https://".len()..];
            (
                format!("https://x-access-token:{token}@{rest}"),
                format!("https://x-access-token:***@{rest}"),
            )
        }
        _ => (repo_url.to_string(), repo_url.to_string()),
    }
}

/// Run one deploy step, appending the (redacted) command line and its
/// timestamped stdout/stderr to the deploy log. Any occurrence of `secret` in
/// the output is replaced before it reaches the log or the error detail.
async fn run_step(
    dir: &Path,
    log_path: &Path,
    display: &str,
    command: &mut Command,
    secret: Option<&str>,
) -> Result<std::process::Output, String> {
    append_log(log_path, &format!("$ {display}")).await;
    let output = command
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|error| format!("could not start `{display}`: {error}"))?;
    let stdout = redact(String::from_utf8_lossy(&output.stdout).into_owned(), secret);
    let stderr = redact(String::from_utf8_lossy(&output.stderr).into_owned(), secret);
    let mut block = String::new();
    if !stdout.is_empty() {
        block.push_str(&format!("[{}] [stdout]\n{stdout}\n", now_rfc3339()));
    }
    if !stderr.is_empty() {
        block.push_str(&format!("[{}] [stderr]\n{stderr}\n", now_rfc3339()));
    }
    if !block.is_empty() {
        append_raw(log_path, &block).await;
    }
    if output.status.success() {
        Ok(output)
    } else {
        let status = output
            .status
            .code()
            .map(|code| format!("exit code {code}"))
            .unwrap_or_else(|| "termination by signal".into());
        Err(format!(
            "step `{display}` failed with {status}: {}",
            tail_str(&stderr, STDERR_TAIL_BYTES)
        ))
    }
}

fn redact(text: String, secret: Option<&str>) -> String {
    match secret {
        Some(secret) if !secret.is_empty() => text.replace(secret, "***"),
        _ => text,
    }
}

async fn refresh_detail(store: &DeploymentStore, deployment_id: &str, log_path: &Path) {
    let detail = log_tail(log_path).await;
    if !detail.is_empty() {
        store.update_detail(deployment_id, detail).await;
    }
}

/// Last ~4 KB of the deployment's deploy log, empty when no log exists yet.
pub async fn log_tail(log_path: &Path) -> String {
    match fs::read(log_path).await {
        Ok(bytes) => tail_str(&String::from_utf8_lossy(&bytes), DETAIL_BYTES),
        Err(_) => String::new(),
    }
}

fn tail_str(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut start = text.len() - max_bytes;
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].to_string()
}

fn cap_detail(detail: &str) -> String {
    tail_str(detail, DETAIL_BYTES)
}

fn parse_env(content: &str) -> Vec<(String, String)> {
    content
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let (key, value) = line.split_once('=')?;
            let key = key.trim();
            if key.is_empty() {
                return None;
            }
            let value = value.trim();
            let value = value
                .strip_prefix('"')
                .and_then(|inner| inner.strip_suffix('"'))
                .or_else(|| {
                    value
                        .strip_prefix('\'')
                        .and_then(|inner| inner.strip_suffix('\''))
                })
                .unwrap_or(value);
            Some((key.to_string(), value.to_string()))
        })
        .collect()
}

async fn write_private(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(path).await?;
    file.write_all(contents).await?;
    file.sync_all().await
}

async fn append_log(log_path: &Path, line: &str) {
    append_raw(log_path, &format!("[{}] {line}\n", now_rfc3339())).await;
}

async fn append_raw(log_path: &Path, text: &str) {
    let result = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .await;
    match result {
        Ok(mut file) => {
            if let Err(error) = file.write_all(text.as_bytes()).await {
                warn!(
                    event = "deploy_log_write_failed",
                    path = %log_path.display(),
                    %error,
                    "could not append to deploy log"
                );
            }
        }
        Err(error) => {
            warn!(
                event = "deploy_log_write_failed",
                path = %log_path.display(),
                %error,
                "could not open deploy log"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ComposeSource, GithubSource, ImageSource};

    fn compose_request() -> DeployRequest {
        DeployRequest {
            deployment_id: Uuid::new_v4().to_string(),
            name: "my-app".into(),
            source: DeploySource::Compose(ComposeSource {
                compose: "services: {}".into(),
            }),
            env: String::new(),
            github_token: None,
        }
    }

    #[test]
    fn slugify_normalizes_names() {
        assert_eq!(slugify("My App"), "skywatch-my-app");
        assert_eq!(slugify("  weird__NAME!!  "), "skywatch-weird-name");
        assert_eq!(slugify("---"), "skywatch-app");
        assert_eq!(slugify(""), "skywatch-app");
        assert_eq!(slugify("émojis 🚀 only"), "skywatch-mojis-only");
        let long = slugify(&"a".repeat(100));
        assert_eq!(long.len(), "skywatch-".len() + 40);
        let trailing = slugify(&format!("{}!x", "a".repeat(39)));
        assert_eq!(trailing, format!("skywatch-{}", "a".repeat(39)));
    }

    #[test]
    fn validation_rejects_bad_deployment_id() {
        let mut request = compose_request();
        request.deployment_id = "not-a-uuid".into();
        let (code, _) = validate_deploy_request(&request).unwrap_err();
        assert_eq!(code, "invalid_deployment_id");
    }

    #[test]
    fn validation_rejects_bad_names() {
        let mut request = compose_request();
        request.name = String::new();
        assert!(validate_deploy_request(&request).is_err());
        request.name = "x".repeat(81);
        assert!(validate_deploy_request(&request).is_err());
        request.name = "ok".into();
        assert!(validate_deploy_request(&request).is_ok());
    }

    #[test]
    fn validation_enforces_size_caps() {
        let mut request = compose_request();
        request.env = "x".repeat(MAX_ENV_BYTES + 1);
        assert!(validate_deploy_request(&request).is_err());

        let mut request = compose_request();
        request.source = DeploySource::Compose(ComposeSource {
            compose: "x".repeat(MAX_SOURCE_BYTES + 1),
        });
        assert!(validate_deploy_request(&request).is_err());

        request.source = DeploySource::Image(ImageSource {
            image: "x".repeat(MAX_REFERENCE_LEN + 1),
        });
        assert!(validate_deploy_request(&request).is_err());
    }

    #[test]
    fn validation_rejects_untrusted_repo_urls() {
        let github = |repo_url: &str, build_command: Option<&str>| DeployRequest {
            source: DeploySource::Github(GithubSource {
                repo_url: repo_url.into(),
                branch: None,
                build_mode: if build_command.is_some() {
                    GithubBuildMode::Command
                } else {
                    GithubBuildMode::Docker
                },
                dockerfile_path: None,
                build_command: build_command.map(str::to_string),
            }),
            ..compose_request()
        };
        for url in [
            "http://example.com/repo.git",
            "ftp://example.com/repo.git",
            "file:///etc/passwd",
            "example.com/repo.git",
        ] {
            let (code, _) = validate_deploy_request(&github(url, None)).unwrap_err();
            assert_eq!(code, "invalid_source", "url {url} must be rejected");
        }
        assert!(validate_deploy_request(&github("https://github.com/a/b", None)).is_ok());
        assert!(validate_deploy_request(&github("git@github.com:a/b.git", None)).is_ok());
        assert!(validate_deploy_request(&github("ssh://git@github.com/a/b", None)).is_ok());
        assert!(validate_deploy_request(&github("https://github.com/a/b", None)).is_ok());
        assert!(validate_deploy_request(&github("https://github.com/a/b", Some(""))).is_err());
        assert!(validate_deploy_request(&github("https://github.com/a/b", Some("make"))).is_ok());
    }

    #[test]
    fn credentialed_urls_hide_tokens() {
        let (actual, display) = credentialed_url("https://github.com/a/b", Some("secret"));
        assert_eq!(actual, "https://x-access-token:secret@github.com/a/b");
        assert_eq!(display, "https://x-access-token:***@github.com/a/b");
        assert!(!display.contains("secret"));
        let (actual, display) = credentialed_url("git@github.com:a/b.git", Some("secret"));
        assert_eq!(actual, display);
        let redacted = redact("fatal: secret happened".into(), Some("secret"));
        assert_eq!(redacted, "fatal: *** happened");
    }

    #[test]
    fn parse_env_handles_quotes_and_comments() {
        let entries = parse_env("# comment\nA=1\nB=\"two\"\nC='three'\n\nbadline\n=");
        assert_eq!(
            entries,
            vec![
                ("A".to_string(), "1".to_string()),
                ("B".to_string(), "two".to_string()),
                ("C".to_string(), "three".to_string()),
            ]
        );
    }

    #[test]
    fn tail_str_respects_byte_budget_and_boundaries() {
        assert_eq!(tail_str("hello", 10), "hello");
        assert_eq!(tail_str("hello world", 5), "world");
        let multibyte = "é".repeat(10);
        assert_eq!(tail_str(&multibyte, 5).chars().count(), 2);
    }

    #[test]
    fn deploy_request_parses_worker_json() {
        let compose: DeployRequest = serde_json::from_value(serde_json::json!({
            "deploymentId": Uuid::new_v4(),
            "name": "My App",
            "sourceType": "compose",
            "sourceConfig": { "compose": "services: {}" },
            "env": "A=1"
        }))
        .unwrap();
        assert!(matches!(compose.source, DeploySource::Compose(_)));
        assert_eq!(compose.env, "A=1");
        assert!(compose.github_token.is_none());

        let github: DeployRequest = serde_json::from_value(serde_json::json!({
            "deploymentId": Uuid::new_v4(),
            "name": "repo app",
            "sourceType": "github",
            "sourceConfig": {
                "repoUrl": "https://github.com/a/b",
                "branch": "main",
                "buildMode": "command",
                "buildCommand": "make run"
            },
            "env": "",
            "githubToken": "secret"
        }))
        .unwrap();
        match &github.source {
            DeploySource::Github(source) => {
                assert_eq!(source.build_mode, GithubBuildMode::Command);
                assert_eq!(source.branch.as_deref(), Some("main"));
            }
            _ => panic!("expected github source"),
        }
        assert_eq!(github.github_token.as_deref(), Some("secret"));

        let image: DeployRequest = serde_json::from_value(serde_json::json!({
            "deploymentId": Uuid::new_v4(),
            "name": "nginx",
            "sourceType": "image",
            "sourceConfig": { "image": "nginx:alpine" }
        }))
        .unwrap();
        assert!(matches!(image.source, DeploySource::Image(_)));
        assert!(image.env.is_empty());
    }

    #[test]
    fn deployment_status_serializes_camel_case() {
        let record = DeploymentRecord {
            deployment_id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d".into(),
            name: "demo".into(),
            slug: "demo".into(),
            source_type: SourceType::Image,
            teardown: TeardownKind::Container,
            status: DeploymentState::Running,
            detail: "pulling".into(),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:01Z".into(),
        };
        let value = serde_json::to_value(record.status_view()).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "deploymentId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
                "name": "demo",
                "status": "running",
                "detail": "pulling",
                "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": "2026-01-01T00:00:01Z",
            })
        );
    }

    #[tokio::test]
    async fn persisted_records_survive_reload() {
        let directory = tempfile::tempdir().unwrap();
        let workdir = directory.path().join(Uuid::new_v4().to_string());
        fs::create_dir_all(&workdir).await.unwrap();
        let record = DeploymentRecord {
            deployment_id: Uuid::new_v4().to_string(),
            name: "demo".into(),
            slug: "demo".into(),
            source_type: SourceType::Image,
            teardown: TeardownKind::Container,
            status: DeploymentState::Success,
            detail: "done".into(),
            created_at: now_rfc3339(),
            updated_at: now_rfc3339(),
        };
        persist_record(&workdir, &record).await.unwrap();

        let store = DeploymentStore::load(directory.path());
        let loaded = store.get(&record.deployment_id).await.unwrap();
        assert_eq!(loaded, record);
    }

    #[tokio::test]
    async fn running_records_fail_on_reload() {
        let directory = tempfile::tempdir().unwrap();
        let workdir = directory.path().join(Uuid::new_v4().to_string());
        fs::create_dir_all(&workdir).await.unwrap();
        let mut record = DeploymentRecord {
            deployment_id: Uuid::new_v4().to_string(),
            name: "demo".into(),
            slug: "demo".into(),
            source_type: SourceType::Compose,
            teardown: TeardownKind::Compose,
            status: DeploymentState::Running,
            detail: "working".into(),
            created_at: now_rfc3339(),
            updated_at: now_rfc3339(),
        };
        persist_record(&workdir, &record).await.unwrap();

        let store = DeploymentStore::load(directory.path());
        let loaded = store.get(&record.deployment_id).await.unwrap();
        assert_eq!(loaded.status, DeploymentState::Failed);
        assert_eq!(loaded.detail, "agent restarted during deployment");
        record.status = DeploymentState::Failed;
        let reloaded = DeploymentStore::load(directory.path());
        assert_eq!(
            reloaded.get(&record.deployment_id).await.unwrap().status,
            DeploymentState::Failed
        );
    }
}

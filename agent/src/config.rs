use std::{
    fs::{self, OpenOptions},
    io::Write,
    net::SocketAddr,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
use serde::Deserialize;
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub node_id: Uuid,
    pub node_name: String,
    pub listen: SocketAddr,
    pub allow_insecure_public_http: bool,
    pub key_id: Uuid,
    pub key_file: PathBuf,
    pub docker_socket: PathBuf,
    pub sample_interval_seconds: u64,
    pub clock_skew_seconds: u64,
    pub nonce_ttl_seconds: u64,
    pub nonce_capacity: usize,
    pub request_timeout_seconds: u64,
    pub docker_timeout_seconds: u64,
    pub request_concurrency: usize,
    pub stats_concurrency: usize,
    pub log_tail_default: usize,
    pub log_tail_max: usize,
    pub log_bytes_max: usize,
    /// Root directory for deployment work directories (`<deployments_dir>/<deploymentId>/`).
    /// Relative paths resolve against the directory of the config file, so the
    /// default is a `deployments` directory next to the config.
    pub deployments_dir: PathBuf,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            node_id: Uuid::nil(),
            node_name: String::new(),
            listen: "127.0.0.1:8788".parse().expect("literal socket address"),
            allow_insecure_public_http: false,
            key_id: Uuid::nil(),
            key_file: PathBuf::from("skywatch-agent.key"),
            docker_socket: PathBuf::from("/var/run/docker.sock"),
            sample_interval_seconds: 5,
            clock_skew_seconds: 60,
            nonce_ttl_seconds: 120,
            nonce_capacity: 10_000,
            request_timeout_seconds: 15,
            docker_timeout_seconds: 30,
            request_concurrency: 32,
            stats_concurrency: 4,
            log_tail_default: 200,
            log_tail_max: 1_000,
            log_bytes_max: 1_048_576,
            deployments_dir: PathBuf::from("deployments"),
        }
    }
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("could not read configuration {path}: {source}")]
    Read {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("configuration is not valid TOML: {0}")]
    Parse(#[from] toml::de::Error),
    #[error("invalid configuration: {0}")]
    Invalid(String),
    #[error("could not initialize {path}: {source}")]
    Initialize {
        path: PathBuf,
        source: std::io::Error,
    },
}

impl Config {
    pub fn load(path: &Path) -> Result<Self, ConfigError> {
        let raw = fs::read_to_string(path).map_err(|source| ConfigError::Read {
            path: path.to_owned(),
            source,
        })?;
        let mut config: Self = toml::from_str(&raw)?;
        if config.key_file.is_relative() {
            config.key_file = path
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join(&config.key_file);
        }
        if config.deployments_dir.is_relative() {
            config.deployments_dir = path
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join(&config.deployments_dir);
        }
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<(), ConfigError> {
        if self.node_id.is_nil() || self.key_id.is_nil() {
            return Err(ConfigError::Invalid(
                "node_id and key_id must be non-nil UUIDs".into(),
            ));
        }
        if self.node_name.is_empty()
            || self.node_name.len() > 128
            || !self
                .node_name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_.:-".contains(&byte))
        {
            return Err(ConfigError::Invalid(
                "node_name must be 1..128 characters using letters, digits, _, ., :, or -".into(),
            ));
        }
        if !self.listen.ip().is_loopback() && !self.allow_insecure_public_http {
            return Err(ConfigError::Invalid(
                "listen must be loopback; expose direct mode through an HTTPS reverse proxy".into(),
            ));
        }
        if !(1..=300).contains(&self.sample_interval_seconds) {
            return Err(ConfigError::Invalid(
                "sample_interval_seconds must be between 1 and 300".into(),
            ));
        }
        if !(10..=300).contains(&self.clock_skew_seconds)
            || self.nonce_ttl_seconds < self.clock_skew_seconds * 2
        {
            return Err(ConfigError::Invalid(
                "clock skew must be 10..300 seconds and nonce TTL at least twice the skew".into(),
            ));
        }
        if !(100..=100_000).contains(&self.nonce_capacity) {
            return Err(ConfigError::Invalid(
                "nonce_capacity must be between 100 and 100000".into(),
            ));
        }
        if !(1..=120).contains(&self.request_timeout_seconds)
            || !(1..=120).contains(&self.docker_timeout_seconds)
        {
            return Err(ConfigError::Invalid(
                "timeouts must be between 1 and 120 seconds".into(),
            ));
        }
        if !(1..=256).contains(&self.request_concurrency)
            || !(1..=32).contains(&self.stats_concurrency)
        {
            return Err(ConfigError::Invalid(
                "request_concurrency must be 1..256 and stats_concurrency 1..32".into(),
            ));
        }
        if self.log_tail_default == 0
            || self.log_tail_default > self.log_tail_max
            || self.log_tail_max > 10_000
            || !(1_024..=8_388_608).contains(&self.log_bytes_max)
        {
            return Err(ConfigError::Invalid("log limits are invalid".into()));
        }
        if self.deployments_dir.as_os_str().is_empty() {
            return Err(ConfigError::Invalid(
                "deployments_dir must not be empty".into(),
            ));
        }
        Ok(())
    }

    pub fn sample_interval(&self) -> Duration {
        Duration::from_secs(self.sample_interval_seconds)
    }

    pub fn docker_timeout(&self) -> Duration {
        Duration::from_secs(self.docker_timeout_seconds)
    }
}

pub fn initialize(
    config_path: &Path,
    key_path: &Path,
    listen: &str,
    requested_name: Option<&str>,
    allow_insecure_public_http: bool,
) -> Result<String, ConfigError> {
    if config_path.exists() || key_path.exists() {
        return Err(ConfigError::Invalid(
            "config or key file already exists; refusing to overwrite it".into(),
        ));
    }
    let listen: SocketAddr = listen
        .parse()
        .map_err(|_| ConfigError::Invalid("--listen is not a valid socket address".into()))?;
    if !listen.ip().is_loopback() && !allow_insecure_public_http {
        return Err(ConfigError::Invalid(
            "--listen must use loopback; put an HTTPS reverse proxy in front for direct mode"
                .into(),
        ));
    }

    let node_id = Uuid::new_v4();
    let key_id = Uuid::new_v4();
    let node_name = requested_name
        .map(str::to_owned)
        .or_else(sysinfo::System::host_name)
        .unwrap_or_else(|| format!("node-{node_id}"));
    Config {
        node_id,
        node_name: node_name.clone(),
        listen,
        allow_insecure_public_http,
        key_id,
        key_file: key_path.to_owned(),
        ..Config::default()
    }
    .validate()?;
    let mut key = [0_u8; 32];
    rand::rng().fill_bytes(&mut key);
    let encoded_key = URL_SAFE_NO_PAD.encode(key);

    create_parent(config_path)?;
    create_parent(key_path)?;
    write_new_private(key_path, format!("{encoded_key}\n").as_bytes())?;
    let key_reference = relative_key_reference(config_path, key_path);
    let contents = render_config(
        node_id,
        &node_name,
        listen,
        allow_insecure_public_http,
        key_id,
        &key_reference,
    );
    if let Err(error) = write_new_private(config_path, contents.as_bytes()) {
        let _ = fs::remove_file(key_path);
        return Err(error);
    }
    Ok(format!("{key_id}.{encoded_key}"))
}

fn render_config(
    node_id: Uuid,
    node_name: &str,
    listen: SocketAddr,
    allow_insecure_public_http: bool,
    key_id: Uuid,
    key_file: &Path,
) -> String {
    format!(
        r#"node_id = "{node_id}"
node_name = {node_name:?}
listen = "{listen}"
allow_insecure_public_http = {allow_insecure_public_http}
key_id = "{key_id}"
key_file = {key_file:?}
docker_socket = "/var/run/docker.sock"

sample_interval_seconds = 5
clock_skew_seconds = 60
nonce_ttl_seconds = 120
nonce_capacity = 10000
request_timeout_seconds = 15
docker_timeout_seconds = 30
request_concurrency = 32
stats_concurrency = 4
log_tail_default = 200
log_tail_max = 1000
log_bytes_max = 1048576
deployments_dir = "deployments"
"#,
        node_name = node_name,
        key_file = key_file.display().to_string(),
    )
}

fn create_parent(path: &Path) -> Result<(), ConfigError> {
    if let Some(parent) = path.parent().filter(|path| !path.as_os_str().is_empty()) {
        fs::create_dir_all(parent).map_err(|source| ConfigError::Initialize {
            path: parent.to_owned(),
            source,
        })?;
    }
    Ok(())
}

fn write_new_private(path: &Path, contents: &[u8]) -> Result<(), ConfigError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|source| ConfigError::Initialize {
            path: path.to_owned(),
            source,
        })?;
    file.write_all(contents)
        .and_then(|_| file.sync_all())
        .map_err(|source| ConfigError::Initialize {
            path: path.to_owned(),
            source,
        })?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|source| {
        ConfigError::Initialize {
            path: path.to_owned(),
            source,
        }
    })?;
    Ok(())
}

fn relative_key_reference(config: &Path, key: &Path) -> PathBuf {
    let config_parent = config.parent().unwrap_or_else(|| Path::new("."));
    match key.strip_prefix(config_parent) {
        Ok(relative) if !relative.as_os_str().is_empty() => relative.to_owned(),
        _ => key.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_public_listener() {
        let config = Config {
            node_id: Uuid::new_v4(),
            node_name: "test-node".into(),
            key_id: Uuid::new_v4(),
            listen: "0.0.0.0:8788".parse().unwrap(),
            allow_insecure_public_http: false,
            ..Config::default()
        };
        assert!(config.validate().is_err());
    }

    #[test]
    fn init_is_private_and_non_destructive() {
        let directory = tempfile::tempdir().unwrap();
        let config = directory.path().join("agent.toml");
        let key = directory.path().join("agent.key");
        let token = initialize(&config, &key, "127.0.0.1:8788", Some("test-node"), false).unwrap();
        assert_eq!(token.split('.').count(), 2);
        assert_eq!(
            fs::metadata(&config).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&key).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(initialize(&config, &key, "127.0.0.1:8788", None, false).is_err());
    }

    #[test]
    fn public_listener_requires_explicit_opt_in() {
        let config = Config {
            node_id: Uuid::new_v4(),
            node_name: "test-node".into(),
            key_id: Uuid::new_v4(),
            listen: "0.0.0.0:8788".parse().unwrap(),
            allow_insecure_public_http: true,
            ..Config::default()
        };
        assert!(config.validate().is_ok());
    }

    #[test]
    fn invalid_name_does_not_create_files() {
        let directory = tempfile::tempdir().unwrap();
        let config = directory.path().join("agent.toml");
        let key = directory.path().join("agent.key");
        assert!(initialize(&config, &key, "127.0.0.1:8788", Some("bad name"), false).is_err());
        assert!(!config.exists());
        assert!(!key.exists());
    }
}

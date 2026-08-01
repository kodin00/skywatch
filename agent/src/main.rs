mod api;
mod auth;
mod config;
mod docker;
mod metrics;
mod models;

use std::{path::PathBuf, sync::Arc};

use clap::{Parser, Subcommand};
use tokio::net::TcpListener;
use tracing::info;

use crate::{
    api::{AppState, build_router},
    auth::Authenticator,
    config::{Config, initialize},
    docker::{BollardDocker, DockerBackend},
    metrics::MetricsSampler,
};

#[derive(Debug, Parser)]
#[command(name = "skywatch-agent", version, about)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Generate a node identity, signing key, and starter configuration.
    Init {
        #[arg(long, default_value = "config.toml")]
        config: PathBuf,
        #[arg(long, default_value = "skywatch-agent.key")]
        key_file: PathBuf,
        #[arg(long, default_value = "127.0.0.1:8788")]
        listen: String,
        /// Deliberately allow plaintext HTTP on a non-loopback listener.
        #[arg(long)]
        allow_insecure_public_http: bool,
        #[arg(long)]
        node_name: Option<String>,
    },
    /// Start the authenticated HTTP agent.
    Serve {
        #[arg(long, default_value = "config.toml")]
        config: PathBuf,
    },
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    match Cli::parse().command {
        Command::Init {
            config,
            key_file,
            listen,
            allow_insecure_public_http,
            node_name,
        } => {
            let pairing_token = initialize(
                &config,
                &key_file,
                &listen,
                node_name.as_deref(),
                allow_insecure_public_http,
            )?;
            println!("Skywatch agent initialized.");
            println!("Config: {}", config.display());
            println!("Pairing key (shown once): {pairing_token}");
            println!("Keep this value secret and paste it into Skywatch's agent setup.");
            Ok(())
        }
        Command::Serve { config } => serve(config).await,
    }
}

async fn serve(path: PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    init_tracing();
    let config = Arc::new(Config::load(&path)?);
    if !config.listen.ip().is_loopback() {
        tracing::warn!(
            event = "insecure_public_http_enabled",
            listen = %config.listen,
            "agent authentication and responses are signed but transport confidentiality is disabled"
        );
    }
    let authenticator = Arc::new(Authenticator::from_config(&config)?);
    let docker: Arc<dyn DockerBackend> = Arc::new(BollardDocker::connect(&config.docker_socket)?);
    let metrics = MetricsSampler::start(
        docker.clone(),
        config.sample_interval(),
        config.docker_timeout(),
        config.stats_concurrency,
    );
    let state = AppState::new(config.clone(), authenticator, docker, metrics);
    let app = build_router(state);
    let listener = TcpListener::bind(config.listen).await?;

    info!(
        event = "agent_started",
        node_id = %config.node_id,
        node_name = %config.node_name,
        listen = %config.listen,
        "Skywatch agent listening"
    );
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    info!(event = "agent_stopped", "Skywatch agent stopped");
    Ok(())
}

fn init_tracing() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "skywatch_agent=info,tower_http=info".into());
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .json()
        .with_current_span(false)
        .init();
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

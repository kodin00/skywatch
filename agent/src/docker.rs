use std::{path::Path, time::Duration};

use async_trait::async_trait;
use bollard::{
    API_DEFAULT_VERSION, Docker,
    container::LogOutput,
    errors::Error as BollardError,
    query_parameters::{
        InspectContainerOptions, ListContainersOptionsBuilder, LogsOptionsBuilder,
        RestartContainerOptionsBuilder, StartContainerOptions, StatsOptionsBuilder,
        StopContainerOptionsBuilder,
    },
};
use futures_util::StreamExt;
use serde_json::Value;
use thiserror::Error;

use crate::models::{
    ContainerDetail, ContainerStats, ContainerSummary, LogEntry, LogStream, PortBinding,
};

#[derive(Debug, Error)]
pub enum DockerError {
    #[error("container was not found")]
    NotFound,
    #[error("container state conflicts with the requested action")]
    Conflict,
    #[error("Docker is unavailable")]
    Unavailable,
    #[error("Docker operation failed")]
    Operation,
}

#[async_trait]
pub trait DockerBackend: Send + Sync {
    async fn list(&self) -> Result<Vec<ContainerSummary>, DockerError>;
    async fn inspect(&self, id: &str) -> Result<ContainerDetail, DockerError>;
    async fn stats(&self, id: &str) -> Result<ContainerStats, DockerError>;
    async fn logs(
        &self,
        id: &str,
        tail: usize,
        max_bytes: usize,
    ) -> Result<(Vec<LogEntry>, bool), DockerError>;
    async fn start(&self, id: &str) -> Result<bool, DockerError>;
    async fn stop(&self, id: &str, timeout: Duration) -> Result<bool, DockerError>;
    async fn restart(&self, id: &str, timeout: Duration) -> Result<bool, DockerError>;
}

pub struct BollardDocker {
    docker: Docker,
}

impl BollardDocker {
    pub fn connect(socket: &Path) -> Result<Self, DockerError> {
        let socket = socket.to_string_lossy();
        let docker =
            Docker::connect_with_socket(&socket, 120, API_DEFAULT_VERSION).map_err(map_error)?;
        Ok(Self { docker })
    }
}

#[async_trait]
impl DockerBackend for BollardDocker {
    async fn list(&self) -> Result<Vec<ContainerSummary>, DockerError> {
        let options = ListContainersOptionsBuilder::default().all(true).build();
        let containers = self
            .docker
            .list_containers(Some(options))
            .await
            .map_err(map_error)?;
        containers
            .into_iter()
            .map(|container| {
                serde_json::to_value(container)
                    .map(|value| summary_from_list(&value))
                    .map_err(|_| DockerError::Operation)
            })
            .collect()
    }

    async fn inspect(&self, id: &str) -> Result<ContainerDetail, DockerError> {
        let inspect = self
            .docker
            .inspect_container(id, None::<InspectContainerOptions>)
            .await
            .map_err(map_error)?;
        let value = serde_json::to_value(inspect).map_err(|_| DockerError::Operation)?;
        Ok(detail_from_inspect(id, &value))
    }

    async fn stats(&self, id: &str) -> Result<ContainerStats, DockerError> {
        let options = StatsOptionsBuilder::default().stream(false).build();
        let mut stream = self.docker.stats(id, Some(options));
        let stats = stream
            .next()
            .await
            .ok_or(DockerError::Operation)?
            .map_err(map_error)?;
        let value = serde_json::to_value(stats).map_err(|_| DockerError::Operation)?;
        Ok(stats_from_value(&value))
    }

    async fn logs(
        &self,
        id: &str,
        tail: usize,
        max_bytes: usize,
    ) -> Result<(Vec<LogEntry>, bool), DockerError> {
        // Inspect first so an unknown ID maps to a deterministic 404 instead of an empty stream.
        self.docker
            .inspect_container(id, None::<InspectContainerOptions>)
            .await
            .map_err(map_error)?;
        let options = LogsOptionsBuilder::default()
            .stdout(true)
            .stderr(true)
            .timestamps(false)
            .tail(&tail.to_string())
            .build();
        let mut logs = self.docker.logs(id, Some(options));
        let mut entries = Vec::new();
        let mut used = 0_usize;
        let mut truncated = false;
        while let Some(output) = logs.next().await {
            let output = output.map_err(map_error)?;
            let (stream, bytes) = match output {
                LogOutput::StdOut { message } => (LogStream::Stdout, message),
                LogOutput::StdErr { message } => (LogStream::Stderr, message),
                LogOutput::Console { message } | LogOutput::StdIn { message } => {
                    (LogStream::Console, message)
                }
            };
            if used >= max_bytes {
                truncated = true;
                break;
            }
            let remaining = max_bytes - used;
            let slice = if bytes.len() > remaining {
                truncated = true;
                &bytes[..remaining]
            } else {
                &bytes
            };
            used += slice.len();
            entries.push(LogEntry {
                stream,
                message: String::from_utf8_lossy(slice).into_owned(),
            });
            if truncated {
                break;
            }
        }
        Ok((entries, truncated))
    }

    async fn start(&self, id: &str) -> Result<bool, DockerError> {
        match self
            .docker
            .start_container(id, None::<StartContainerOptions>)
            .await
        {
            Ok(()) => Ok(true),
            Err(error) if response_status(&error) == Some(304) => Ok(false),
            Err(error) => Err(map_error(error)),
        }
    }

    async fn stop(&self, id: &str, timeout: Duration) -> Result<bool, DockerError> {
        let options = StopContainerOptionsBuilder::default()
            .t(timeout.as_secs() as i32)
            .build();
        match self.docker.stop_container(id, Some(options)).await {
            Ok(()) => Ok(true),
            Err(error) if response_status(&error) == Some(304) => Ok(false),
            Err(error) => Err(map_error(error)),
        }
    }

    async fn restart(&self, id: &str, timeout: Duration) -> Result<bool, DockerError> {
        let options = RestartContainerOptionsBuilder::default()
            .t(timeout.as_secs() as i32)
            .build();
        self.docker
            .restart_container(id, Some(options))
            .await
            .map(|_| true)
            .map_err(map_error)
    }
}

fn summary_from_list(value: &Value) -> ContainerSummary {
    let names = value
        .get("Names")
        .or_else(|| value.get("names"))
        .and_then(Value::as_array);
    let name = names
        .and_then(|names| names.first())
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim_start_matches('/')
        .to_owned();
    let status = string(value, &["Status", "status"]);
    ContainerSummary {
        id: string(value, &["Id", "ID", "id"]),
        name,
        image: string(value, &["Image", "image"]),
        state: string(value, &["State", "state"]).to_ascii_lowercase(),
        health: health_from_status(&status),
        status,
        created_at: integer(value, &["Created", "created"]),
        stats: None,
        ports: ports_from_value(value.get("Ports").or_else(|| value.get("ports"))),
    }
}

fn detail_from_inspect(id: &str, value: &Value) -> ContainerDetail {
    let state = value.get("State").or_else(|| value.get("state"));
    let config = value.get("Config").or_else(|| value.get("config"));
    let health = state
        .and_then(|state| state.get("Health").or_else(|| state.get("health")))
        .and_then(|health| health.get("Status").or_else(|| health.get("status")))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let status = state
        .and_then(|state| state.get("Status").or_else(|| state.get("status")))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let ports = value
        .get("NetworkSettings")
        .or_else(|| value.get("network_settings"))
        .and_then(|settings| settings.get("Ports").or_else(|| settings.get("ports")));
    ContainerDetail {
        container: ContainerSummary {
            id: value
                .get("Id")
                .or_else(|| value.get("id"))
                .and_then(Value::as_str)
                .unwrap_or(id)
                .to_owned(),
            name: value
                .get("Name")
                .or_else(|| value.get("name"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim_start_matches('/')
                .to_owned(),
            image: config
                .and_then(|config| config.get("Image").or_else(|| config.get("image")))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            state: status.clone(),
            status,
            health,
            created_at: None,
            stats: None,
            ports: inspect_ports(ports),
        },
        restart_count: value
            .get("RestartCount")
            .or_else(|| value.get("restart_count"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
    }
}

fn stats_from_value(value: &Value) -> ContainerStats {
    let cpu = child(value, &["cpu_stats", "cpuStats"]);
    let previous_cpu = child(value, &["precpu_stats", "preCpuStats"]);
    let total = path_u64(cpu, &["cpu_usage", "total_usage"]);
    let previous_total = path_u64(previous_cpu, &["cpu_usage", "total_usage"]);
    let system = value_u64(cpu, &["system_cpu_usage", "systemCpuUsage"]);
    let previous_system = value_u64(previous_cpu, &["system_cpu_usage", "systemCpuUsage"]);
    let online = value_u64(cpu, &["online_cpus", "onlineCpus"]).max(1);
    let cpu_delta = total.saturating_sub(previous_total);
    let system_delta = system.saturating_sub(previous_system);
    let cpu_percent = if system_delta == 0 {
        0.0
    } else {
        cpu_delta as f64 / system_delta as f64 * online as f64 * 100.0
    };

    let memory = child(value, &["memory_stats", "memoryStats"]);
    let memory_usage = value_u64(memory, &["usage"]);
    let memory_limit = value_u64(memory, &["limit"]);
    let memory_percent = if memory_limit == 0 {
        0.0
    } else {
        memory_usage as f64 / memory_limit as f64 * 100.0
    };

    let mut network_rx = 0;
    let mut network_tx = 0;
    if let Some(networks) = value.get("networks").and_then(Value::as_object) {
        for network in networks.values() {
            network_rx += value_u64(network, &["rx_bytes", "rxBytes"]);
            network_tx += value_u64(network, &["tx_bytes", "txBytes"]);
        }
    }

    let mut block_read = 0;
    let mut block_write = 0;
    let blkio = child(value, &["blkio_stats", "blkioStats"]);
    if let Some(entries) = blkio
        .get("io_service_bytes_recursive")
        .or_else(|| blkio.get("ioServiceBytesRecursive"))
        .and_then(Value::as_array)
    {
        for entry in entries {
            let amount = value_u64(entry, &["value"]);
            match string(entry, &["op"]).to_ascii_lowercase().as_str() {
                "read" => block_read += amount,
                "write" => block_write += amount,
                _ => {}
            }
        }
    }

    ContainerStats {
        cpu_percent,
        memory_usage_bytes: memory_usage,
        memory_limit_bytes: memory_limit,
        memory_percent,
        network_rx_bytes: network_rx,
        network_tx_bytes: network_tx,
        block_read_bytes: block_read,
        block_write_bytes: block_write,
    }
}

fn ports_from_value(value: Option<&Value>) -> Vec<PortBinding> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|port| {
            let private = value_u64(port, &["PrivatePort", "private_port", "privatePort"]);
            u16::try_from(private).ok().map(|private_port| PortBinding {
                private_port,
                public_port: u16::try_from(value_u64(
                    port,
                    &["PublicPort", "public_port", "publicPort"],
                ))
                .ok()
                .filter(|port| *port != 0),
                protocol: string(port, &["Type", "typ", "type"]).to_ascii_lowercase(),
                host_ip: None,
            })
        })
        .collect()
}

fn inspect_ports(value: Option<&Value>) -> Vec<PortBinding> {
    let mut result = Vec::new();
    let Some(ports) = value.and_then(Value::as_object) else {
        return result;
    };
    for (port_and_protocol, bindings) in ports {
        let Some((private, protocol)) = port_and_protocol.split_once('/') else {
            continue;
        };
        let Ok(private_port) = private.parse() else {
            continue;
        };
        let bindings = bindings.as_array().cloned().unwrap_or_default();
        if bindings.is_empty() {
            result.push(PortBinding {
                private_port,
                public_port: None,
                protocol: protocol.to_owned(),
                host_ip: None,
            });
        } else {
            for binding in bindings {
                result.push(PortBinding {
                    private_port,
                    public_port: binding
                        .get("HostPort")
                        .or_else(|| binding.get("host_port"))
                        .and_then(Value::as_str)
                        .and_then(|port| port.parse().ok()),
                    protocol: protocol.to_owned(),
                    host_ip: binding
                        .get("HostIp")
                        .or_else(|| binding.get("host_ip"))
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                });
            }
        }
    }
    result
}

fn health_from_status(status: &str) -> Option<String> {
    ["healthy", "unhealthy", "starting"]
        .into_iter()
        .find(|health| status.to_ascii_lowercase().contains(&format!("({health})")))
        .map(str::to_owned)
}

fn child<'a>(value: &'a Value, names: &[&str]) -> &'a Value {
    names
        .iter()
        .find_map(|name| value.get(name))
        .unwrap_or(&Value::Null)
}

fn path_u64(value: &Value, path: &[&str]) -> u64 {
    path.iter()
        .try_fold(value, |current, key| current.get(*key))
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

fn value_u64(value: &Value, names: &[&str]) -> u64 {
    names
        .iter()
        .find_map(|name| value.get(name))
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

fn string(value: &Value, names: &[&str]) -> String {
    names
        .iter()
        .find_map(|name| value.get(name))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn integer(value: &Value, names: &[&str]) -> Option<i64> {
    names
        .iter()
        .find_map(|name| value.get(name))
        .and_then(Value::as_i64)
}

fn response_status(error: &BollardError) -> Option<u16> {
    match error {
        BollardError::DockerResponseServerError { status_code, .. } => Some(*status_code),
        _ => None,
    }
}

fn map_error(error: BollardError) -> DockerError {
    match response_status(&error) {
        Some(404) => DockerError::NotFound,
        Some(304 | 409) => DockerError::Conflict,
        Some(_) => DockerError::Operation,
        None => DockerError::Unavailable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_stats_from_docker_json() {
        let value = serde_json::json!({
            "cpu_stats":{"cpu_usage":{"total_usage":300},"system_cpu_usage":1000,"online_cpus":2},
            "precpu_stats":{"cpu_usage":{"total_usage":100},"system_cpu_usage":500},
            "memory_stats":{"usage":50,"limit":200},
            "networks":{"eth0":{"rx_bytes":3,"tx_bytes":4}},
            "blkio_stats":{"io_service_bytes_recursive":[{"op":"Read","value":5},{"op":"Write","value":6}]}
        });
        let stats = stats_from_value(&value);
        assert_eq!(stats.cpu_percent, 80.0);
        assert_eq!(stats.memory_percent, 25.0);
        assert_eq!(stats.network_rx_bytes, 3);
        assert_eq!(stats.block_write_bytes, 6);
    }

    #[test]
    fn normalized_list_omits_raw_sensitive_fields() {
        let value = serde_json::json!({
            "Id":"abc","Names":["/web"],"Image":"nginx","State":"running",
            "Status":"Up 2m (healthy)","Labels":{"secret":"value"},
            "Mounts":[{"Source":"/sensitive"}]
        });
        let summary = summary_from_list(&value);
        let output = serde_json::to_value(summary).unwrap();
        assert!(output.get("labels").is_none());
        assert!(output.get("mounts").is_none());
        assert_eq!(output["name"], "web");
        assert_eq!(output["health"], "healthy");
    }
}

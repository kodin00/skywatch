use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeIdentity {
    pub id: String,
    pub name: String,
    pub agent_version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    pub api_version: &'static str,
    pub agent_version: &'static str,
    pub node_id: String,
    pub node: NodeIdentity,
    pub status: &'static str,
    pub docker_available: bool,
    pub uptime_seconds: u64,
    pub sampled_at: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadAverage {
    pub one: f64,
    pub five: f64,
    pub fifteen: f64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuMetrics {
    pub usage_percent: f32,
    pub logical_cores: usize,
    pub cores: usize,
    pub load_average: LoadAverage,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryMetrics {
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub available_bytes: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskMetrics {
    pub name: String,
    pub mount_point: String,
    pub file_system: String,
    pub total_bytes: u64,
    pub available_bytes: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageMetrics {
    pub name: String,
    pub mount: String,
    pub file_system: String,
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub available_bytes: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemSnapshot {
    pub sampled_at: String,
    pub collected_at: String,
    pub hostname: String,
    pub os_name: Option<String>,
    pub os_version: Option<String>,
    pub kernel_version: Option<String>,
    pub uptime_seconds: u64,
    pub cpu: CpuMetrics,
    pub memory: MemoryMetrics,
    pub disks: Vec<DiskMetrics>,
    pub storage: Vec<StorageMetrics>,
    pub load: LoadAverage,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerStats {
    pub cpu_percent: f64,
    pub memory_usage_bytes: u64,
    pub memory_limit_bytes: u64,
    pub memory_percent: f64,
    pub network_rx_bytes: u64,
    pub network_tx_bytes: u64,
    pub block_read_bytes: u64,
    pub block_write_bytes: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortBinding {
    pub private_port: u16,
    pub public_port: Option<u16>,
    #[serde(rename = "type")]
    pub protocol: String,
    pub host_ip: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerSummary {
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: String,
    pub status: String,
    pub health: Option<String>,
    pub created_at: Option<i64>,
    pub stats: Option<ContainerStats>,
    pub ports: Vec<PortBinding>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerDetail {
    #[serde(flatten)]
    pub container: ContainerSummary,
    pub restart_count: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainersResponse {
    pub sampled_at: String,
    pub collected_at: String,
    pub containers: Vec<ContainerSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LogStream {
    Stdout,
    Stderr,
    Console,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub stream: LogStream,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogsResponse {
    pub container_id: String,
    pub tail: usize,
    pub truncated: bool,
    pub entries: Vec<LogEntry>,
    pub logs: String,
    pub collected_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResponse {
    pub action: &'static str,
    pub changed: bool,
    pub container: ContainerSummary,
    pub completed_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ErrorEnvelope {
    pub error: ErrorBody,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorBody {
    pub code: &'static str,
    pub message: String,
    pub request_id: String,
}

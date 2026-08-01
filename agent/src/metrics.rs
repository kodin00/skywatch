use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use futures_util::{StreamExt, stream};
use sysinfo::{Disks, System};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::{sync::RwLock, time::timeout};
use tracing::warn;

use crate::{
    docker::DockerBackend,
    models::{
        ContainersResponse, CpuMetrics, DiskMetrics, LoadAverage, MemoryMetrics, StorageMetrics,
        SystemSnapshot,
    },
};

pub struct MetricsSampler {
    system: RwLock<SystemSnapshot>,
    containers: RwLock<ContainersResponse>,
    docker_available: AtomicBool,
}

impl MetricsSampler {
    pub fn start(
        docker: Arc<dyn DockerBackend>,
        interval: Duration,
        docker_timeout: Duration,
        stats_concurrency: usize,
    ) -> Arc<Self> {
        let sampled_at = now_rfc3339();
        let sampler = Self {
            system: RwLock::new(SystemSnapshot {
                sampled_at: sampled_at.clone(),
                collected_at: sampled_at.clone(),
                ..SystemSnapshot::default()
            }),
            containers: RwLock::new(ContainersResponse {
                sampled_at: sampled_at.clone(),
                collected_at: sampled_at,
                containers: Vec::new(),
            }),
            docker_available: AtomicBool::new(false),
        };
        let sampler = Arc::new(sampler);
        let background = sampler.clone();
        tokio::spawn(async move {
            let mut system = System::new_all();
            let mut disks = Disks::new_with_refreshed_list();
            loop {
                background.sample_system(&mut system, &mut disks).await;
                background
                    .sample_containers(docker.clone(), docker_timeout, stats_concurrency)
                    .await;
                tokio::time::sleep(interval).await;
            }
        });
        sampler
    }

    pub async fn system(&self) -> SystemSnapshot {
        self.system.read().await.clone()
    }

    pub async fn containers(&self) -> ContainersResponse {
        self.containers.read().await.clone()
    }

    pub fn docker_available(&self) -> bool {
        self.docker_available.load(Ordering::Relaxed)
    }

    async fn sample_system(&self, system: &mut System, disks: &mut Disks) {
        system.refresh_cpu_usage();
        system.refresh_memory();
        disks.refresh(true);
        let load = System::load_average();
        let load = LoadAverage {
            one: load.one,
            five: load.five,
            fifteen: load.fifteen,
        };
        let disk_metrics: Vec<DiskMetrics> = disks
            .list()
            .iter()
            .map(|disk| DiskMetrics {
                name: disk.name().to_string_lossy().into_owned(),
                mount_point: disk.mount_point().to_string_lossy().into_owned(),
                file_system: disk.file_system().to_string_lossy().into_owned(),
                total_bytes: disk.total_space(),
                available_bytes: disk.available_space(),
            })
            .collect();
        let storage = disk_metrics
            .iter()
            .map(|disk| StorageMetrics {
                name: disk.name.clone(),
                mount: disk.mount_point.clone(),
                file_system: disk.file_system.clone(),
                total_bytes: disk.total_bytes,
                used_bytes: disk.total_bytes.saturating_sub(disk.available_bytes),
                available_bytes: disk.available_bytes,
            })
            .collect();
        let sampled_at = now_rfc3339();
        let snapshot = SystemSnapshot {
            sampled_at: sampled_at.clone(),
            collected_at: sampled_at,
            hostname: System::host_name().unwrap_or_else(|| "unknown".into()),
            os_name: System::name(),
            os_version: System::os_version(),
            kernel_version: System::kernel_version(),
            uptime_seconds: System::uptime(),
            cpu: CpuMetrics {
                usage_percent: system.global_cpu_usage(),
                logical_cores: system.cpus().len(),
                cores: system.cpus().len(),
                load_average: load.clone(),
            },
            memory: MemoryMetrics {
                total_bytes: system.total_memory(),
                used_bytes: system.used_memory(),
                available_bytes: system.available_memory(),
            },
            disks: disk_metrics,
            storage,
            load,
        };
        *self.system.write().await = snapshot;
    }

    async fn sample_containers(
        &self,
        docker: Arc<dyn DockerBackend>,
        docker_timeout: Duration,
        stats_concurrency: usize,
    ) {
        let listed = timeout(docker_timeout, docker.list()).await;
        let Ok(Ok(containers)) = listed else {
            self.docker_available.store(false, Ordering::Relaxed);
            warn!(
                event = "docker_sample_failed",
                "Docker inventory could not be sampled"
            );
            return;
        };
        self.docker_available.store(true, Ordering::Relaxed);
        let docker_for_stats = docker.clone();
        let mut containers = stream::iter(containers.into_iter().map(move |mut container| {
            let docker = docker_for_stats.clone();
            async move {
                if container.state.eq_ignore_ascii_case("running")
                    && let Ok(Ok(stats)) =
                        timeout(docker_timeout, docker.stats(&container.id)).await
                {
                    container.stats = Some(stats);
                }
                container
            }
        }))
        .buffer_unordered(stats_concurrency)
        .collect::<Vec<_>>()
        .await;
        sort_containers(&mut containers);
        let sampled_at = now_rfc3339();
        *self.containers.write().await = ContainersResponse {
            sampled_at: sampled_at.clone(),
            collected_at: sampled_at,
            containers,
        };
    }
}

fn sort_containers(containers: &mut [crate::models::ContainerSummary]) {
    containers.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
            .then_with(|| left.name.cmp(&right.name))
            .then_with(|| left.id.cmp(&right.id))
    });
}

pub fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ContainerSummary;

    #[test]
    fn container_order_is_stable_by_name_then_id() {
        let mut containers = vec![
            ContainerSummary {
                id: "b".repeat(64),
                name: "web".into(),
                ..ContainerSummary::default()
            },
            ContainerSummary {
                id: "c".repeat(64),
                name: "API".into(),
                ..ContainerSummary::default()
            },
            ContainerSummary {
                id: "a".repeat(64),
                name: "api".into(),
                ..ContainerSummary::default()
            },
        ];

        sort_containers(&mut containers);

        assert_eq!(
            containers
                .iter()
                .map(|container| container.id.as_str())
                .collect::<Vec<_>>(),
            vec!["c".repeat(64), "a".repeat(64), "b".repeat(64)]
        );
    }

    #[test]
    fn systemd_sandbox_keeps_host_metric_proc_files_visible() {
        let unit = include_str!("../packaging/systemd/skywatch-agent.service");
        assert!(unit.contains("ProtectProc=invisible"));
        assert!(!unit.contains("ProcSubset=pid"));
    }
}

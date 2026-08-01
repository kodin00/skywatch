#!/usr/bin/env bash

set -Eeuo pipefail

readonly REPOSITORY="kodin00/skywatch"
readonly SOURCE_REF="${SKYWATCH_REF:-master}"
readonly RUST_IMAGE="rust:1.97.1-alpine"
readonly RELEASE_TAG="${SKYWATCH_AGENT_VERSION:-agent-v0.1.2}"
readonly RELEASE_BASE="https://github.com/${REPOSITORY}/releases/download/${RELEASE_TAG}"
readonly AGENT_USER="skywatch-agent"
readonly AGENT_GROUP="skywatch-agent"
readonly INSTALL_ROOT="/etc/skywatch-agent"
readonly CONFIG_PATH="${INSTALL_ROOT}/config.toml"
readonly KEY_PATH="${INSTALL_ROOT}/controller.key"
readonly BINARY_PATH="/usr/local/bin/skywatch-agent"
readonly COMMAND_PATH="/usr/local/bin/skywatch"
readonly UNIT_PATH="/etc/systemd/system/skywatch-agent.service"

fail() {
  printf 'skywatch-agent installer: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

if [[ "${EUID}" -ne 0 ]]; then
  fail "run this installer as root (for example: curl ... | sudo bash)"
fi

for command in curl tar docker systemctl groupadd useradd usermod install getent hostname find sha256sum; do
  require_command "${command}"
done

[[ "$(uname -s)" == "Linux" ]] || fail "only Linux hosts are supported"
getent group docker >/dev/null 2>&1 || fail "Docker's 'docker' group does not exist"
docker info >/dev/null 2>&1 || fail "Docker is installed but its daemon is not available"

if [[ -e "${CONFIG_PATH}" || -e "${KEY_PATH}" ]]; then
  [[ -f "${CONFIG_PATH}" && -f "${KEY_PATH}" ]] \
    || fail "only one of ${CONFIG_PATH} and ${KEY_PATH} exists; repair the installation before retrying"
  initialize_agent=0
else
  initialize_agent=1
fi

work_directory="$(mktemp -d)"
cleanup() {
  rm -rf -- "${work_directory}"
}
trap cleanup EXIT

case "$(uname -m)" in
  x86_64 | amd64)
    release_target="x86_64-unknown-linux-musl"
    ;;
  aarch64 | arm64)
    release_target="aarch64-unknown-linux-musl"
    ;;
  *)
    release_target=""
    ;;
esac

binary_source=""
unit_source=""
command_source=""
if [[ -n "${release_target}" ]]; then
  release_asset="skywatch-agent-${release_target}.tar.gz"
  release_archive="${work_directory}/${release_asset}"
  printf 'Downloading Skywatch agent %s for %s...\n' "${RELEASE_TAG}" "${release_target}"
  if curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
    --retry 3 --output "${release_archive}" "${RELEASE_BASE}/${release_asset}"; then
    curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
      --retry 3 --output "${release_archive}.sha256" "${RELEASE_BASE}/${release_asset}.sha256"
    (
      cd "${work_directory}"
      sha256sum --check "${release_asset}.sha256"
    ) || fail "the downloaded release failed SHA-256 verification"
    release_directory="${work_directory}/release"
    mkdir "${release_directory}"
    tar -xzf "${release_archive}" -C "${release_directory}"
    binary_source="${release_directory}/skywatch-agent"
    unit_source="${release_directory}/skywatch-agent.service"
    command_source="${release_directory}/skywatch"
  else
    printf 'No release binary is available yet; falling back to a pinned source build.\n'
  fi
fi

if [[ -z "${binary_source}" ]]; then
  archive_path="${work_directory}/skywatch.tar.gz"
  source_url="https://github.com/${REPOSITORY}/archive/${SOURCE_REF}.tar.gz"
  printf 'Downloading Skywatch agent source (%s)...\n' "${SOURCE_REF}"
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
    --retry 3 --output "${archive_path}" "${source_url}"
  tar -xzf "${archive_path}" -C "${work_directory}"

  source_root="$(find "${work_directory}" -mindepth 1 -maxdepth 1 -type d -name 'skywatch-*' -print -quit)"
  [[ -n "${source_root}" && -f "${source_root}/agent/Cargo.lock" ]] \
    || fail "downloaded source archive does not contain the Rust agent"

  printf 'Building the pinned Rust agent in Docker...\n'
  docker run --rm \
    --volume "${source_root}/agent:/build" \
    --workdir /build \
    "${RUST_IMAGE}" \
    cargo build --locked --release

  binary_source="${source_root}/agent/target/release/skywatch-agent"
  unit_source="${source_root}/agent/packaging/systemd/skywatch-agent.service"
  command_source="${source_root}/agent/packaging/skywatch"
fi

[[ -x "${binary_source}" ]] || fail "installation source does not contain an executable agent binary"
[[ -f "${unit_source}" ]] || fail "installation source does not contain the systemd unit"
[[ -f "${command_source}" ]] || fail "installation source does not contain the management command"

if ! getent group "${AGENT_GROUP}" >/dev/null 2>&1; then
  groupadd --system "${AGENT_GROUP}"
fi
if ! id -u "${AGENT_USER}" >/dev/null 2>&1; then
  useradd --system --gid "${AGENT_GROUP}" --home-dir /nonexistent --shell /usr/sbin/nologin "${AGENT_USER}"
fi
usermod --gid "${AGENT_GROUP}" --append --groups docker "${AGENT_USER}"

install -m 0755 "${binary_source}" "${BINARY_PATH}"
install -m 0755 "${command_source}" "${COMMAND_PATH}"
install -d -o root -g "${AGENT_GROUP}" -m 0750 "${INSTALL_ROOT}"

if [[ "${initialize_agent}" -eq 1 ]]; then
  node_name="${SKYWATCH_NODE_NAME:-$(hostname -s)}"
  listen_address="${SKYWATCH_LISTEN:-127.0.0.1:8788}"
  init_arguments=(
    init
    --config "${CONFIG_PATH}"
    --key-file "${KEY_PATH}"
    --node-name "${node_name}"
    --listen "${listen_address}"
  )
  if [[ "${SKYWATCH_ALLOW_INSECURE_PUBLIC_HTTP:-0}" == "1" ]]; then
    init_arguments+=(--allow-insecure-public-http)
  fi
  initialization_output="$("${BINARY_PATH}" "${init_arguments[@]}")"
  chown root:"${AGENT_GROUP}" "${CONFIG_PATH}" "${KEY_PATH}"
  chmod 0640 "${CONFIG_PATH}" "${KEY_PATH}"
else
  initialization_output="Existing node identity and pairing key were preserved."
fi

install -m 0644 "${unit_source}" "${UNIT_PATH}"
systemctl daemon-reload
systemctl enable skywatch-agent.service >/dev/null
systemctl restart skywatch-agent.service

printf '\n%s\n' "${initialization_output}"
printf '\nSkywatch agent is running. Manage it with:\n  skywatch status\n  skywatch help\n'

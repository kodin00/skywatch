#!/usr/bin/env bash

set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly COMMAND="${SCRIPT_DIR}/skywatch"
test_directory="$(mktemp -d)"

cleanup() {
  rm -rf -- "${test_directory}"
}
trap cleanup EXIT

expect_success() {
  local name="$1"
  shift
  if ! "$@" >"${test_directory}/${name}.out" 2>"${test_directory}/${name}.err"; then
    printf 'expected success: %s\n' "${name}" >&2
    return 1
  fi
}

expect_failure() {
  local name="$1"
  local expected="$2"
  shift 2
  if "$@" >"${test_directory}/${name}.out" 2>"${test_directory}/${name}.err"; then
    printf 'expected failure: %s\n' "${name}" >&2
    return 1
  fi
  grep -Fq -- "${expected}" "${test_directory}/${name}.err" || {
    printf 'missing failure message for %s: %s\n' "${name}" "${expected}" >&2
    return 1
  }
}

expect_success help bash "${COMMAND}" help
grep -Fq -- '  update [agent-vX.Y.Z]' "${test_directory}/help.out"
grep -Fq -- '  delete [--yes]' "${test_directory}/help.out"

expect_failure extra-help 'help does not accept arguments' bash "${COMMAND}" help extra
expect_failure invalid-release 'release must look like agent-v1.2.3' bash "${COMMAND}" update latest
expect_failure noninteractive-delete 'delete requires an interactive terminal or the explicit --yes flag' \
  bash "${COMMAND}" delete

printf 'skywatch management command tests passed\n'

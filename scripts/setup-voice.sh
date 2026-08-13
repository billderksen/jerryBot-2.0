#!/usr/bin/env bash
#
# setup-voice.sh - Provisions the local voice stack for "Hey Jerry":
#   - Piper TTS binary + a Dutch (nl_NL) medium-quality voice
#   - A Python venv with openWakeWord + onnxruntime
#   - The pretrained hey_jarvis wake-word model (+ shared melspectrogram/embedding models)
#
# All artifacts are written under tools/, which is gitignored (this repo is public).
# Idempotent: re-running skips any artifact that already exists.
#
# Usage: scripts/setup-voice.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS_DIR="${ROOT_DIR}/tools"
PIPER_DIR="${TOOLS_DIR}/piper"
VENV_DIR="${TOOLS_DIR}/wakeword-venv"
MODELS_DIR="${TOOLS_DIR}/models"

# --- Piper release (rhasspy/piper). The upstream project's active successor,
# OHF-Voice/piper1-gpl, now ships only as a pip wheel (`pip install piper-tts`)
# with no standalone binary tarball, so it can't produce the single
# `tools/piper/piper` executable this script's downstream tasks expect.
# The classic rhasspy/piper release below still hosts a working, self-contained
# Linux x86_64 binary tarball (verified live before writing this script) and
# matches the filesystem contract, so it's used here instead.
PIPER_VERSION="2023.11.14-2"
PIPER_URL="https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_x86_64.tar.gz"

# --- Dutch (nl_NL) medium-quality voice from rhasspy/piper-voices on HuggingFace.
VOICE_NAME="nl_NL-mls-medium"
VOICE_BASE_URL="https://huggingface.co/rhasspy/piper-voices/resolve/main/nl/nl_NL/mls/medium"
VOICE_ONNX_URL="${VOICE_BASE_URL}/${VOICE_NAME}.onnx"
VOICE_JSON_URL="${VOICE_BASE_URL}/${VOICE_NAME}.onnx.json"

# --- openWakeWord pretrained models (dscripka/openWakeWord GitHub release v0.5.1).
# This is the release the openwakeword pip package's own download_models()
# utility pulls from; fetched directly here for idempotency and explicit control.
OWW_RELEASE_URL="https://github.com/dscripka/openWakeWord/releases/download/v0.5.1"
OWW_MODELS=("hey_jarvis_v0.1.onnx" "melspectrogram.onnx" "embedding_model.onnx")

log() { echo "[setup-voice] $*"; }

download() {
  local url="$1" dest="$2"
  if [[ -s "${dest}" ]]; then
    log "Already exists, skipping download: ${dest}"
    return 0
  fi
  log "Downloading ${url} -> ${dest}"
  curl -fL --retry 3 --retry-delay 2 -o "${dest}.part" "${url}"
  mv "${dest}.part" "${dest}"
}

mkdir -p "${TOOLS_DIR}" "${PIPER_DIR}" "${MODELS_DIR}"

# --- 1. Piper binary ---------------------------------------------------------
if [[ -x "${PIPER_DIR}/piper" ]]; then
  log "Piper binary already present, skipping: ${PIPER_DIR}/piper"
else
  PIPER_TARBALL="${TOOLS_DIR}/piper_linux_x86_64.tar.gz"
  download "${PIPER_URL}" "${PIPER_TARBALL}"
  log "Extracting Piper to ${PIPER_DIR}"
  # The tarball's top-level entry is "piper/" (binary + its .so deps + espeak-ng-data
  # as siblings), which extracts directly to TOOLS_DIR/piper == PIPER_DIR.
  tar -xzf "${PIPER_TARBALL}" -C "${TOOLS_DIR}"
  rm -f "${PIPER_TARBALL}"
  chmod +x "${PIPER_DIR}/piper"
fi

# --- 2. Dutch Piper voice -----------------------------------------------------
download "${VOICE_ONNX_URL}" "${PIPER_DIR}/nl_voice.onnx"
download "${VOICE_JSON_URL}" "${PIPER_DIR}/nl_voice.onnx.json"

# --- 3. Python venv for openWakeWord ------------------------------------------
if [[ -x "${VENV_DIR}/bin/python" ]]; then
  log "wakeword-venv already present, skipping creation: ${VENV_DIR}"
else
  log "Creating venv at ${VENV_DIR}"
  python3 -m venv "${VENV_DIR}"
fi

log "Installing openwakeword + onnxruntime (CPU) into wakeword-venv"
"${VENV_DIR}/bin/pip" install --quiet --upgrade pip
"${VENV_DIR}/bin/pip" install --quiet openwakeword onnxruntime

# --- 4. openWakeWord pretrained models -----------------------------------------
for model in "${OWW_MODELS[@]}"; do
  download "${OWW_RELEASE_URL}/${model}" "${MODELS_DIR}/${model}"
done

log "Done."
log "  Piper binary:  ${PIPER_DIR}/piper"
log "  Dutch voice:   ${PIPER_DIR}/nl_voice.onnx (+ .json)"
log "  Venv python:   ${VENV_DIR}/bin/python"
log "  Wake models:   ${MODELS_DIR}/"

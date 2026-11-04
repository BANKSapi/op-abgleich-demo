#!/usr/bin/env bash
# Startet einen Lauf in einem frischen Container.
#
#   ./run.sh <name> <claude|codex> <modell|standard> <mit|ohne> [effort] [prompt-datei]
#
# Beispiel: ./run.sh opus-5.5-high-mcp claude claude-opus-5-5 mit high
#
# Der Container sieht nur einen frischen Klon des Baseline-Tags (runs/<name>/workspace),
# ein leeres Home-Verzeichnis (runs/<name>/home) und die nötigen Zugangsdaten.
# Ein zweiter Aufruf mit -f setzt einen Lauf fort: ./run.sh -f <name> "<Nachricht>"
set -euo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
IMAGE=op-abgleich-runner
APP_REPO=${APP_REPO:-$ROOT/../op-abgleich-demo}
SECRETS=${SECRETS_DIR:?SECRETS_DIR zeigt auf den Ordner mit claude-oauth.env und workspace.env}

follow_up=false
if [[ ${1:-} == -f ]]; then follow_up=true; shift; fi

NAME=$1
RUN=$ROOT/runs/$NAME

if $follow_up; then
  MESSAGE=$2
  # shellcheck disable=SC1091
  source "$RUN/run.env"
  n=$(ls "$RUN"/transcript*.jsonl | wc -l | tr -d ' ')
  OUT=$RUN/transcript-$((n + 1)).jsonl
  PROMPT=$MESSAGE
else
  AGENT=$2 MODEL=$3 MCP=$4 EFFORT=${5:-high} PROMPT_FILE=${6:-$ROOT/prompt.txt}
  [[ -e $RUN ]] && { echo "Lauf $NAME existiert schon" >&2; exit 1; }
  mkdir -p "$RUN/home"
  ref=${BASELINE_REF:-baseline}
  git clone -q --depth 1 --branch "$ref" "file://$APP_REPO" "$RUN/workspace"
  git -C "$RUN/workspace" remote remove origin
  git -C "$RUN/workspace" checkout -q -B main
  git -C "$RUN/workspace" tag -d "$ref" >/dev/null 2>&1 || true
  cp "$SECRETS/workspace.env" "$RUN/workspace/.env"
  printf 'AGENT=%q\nMODEL=%q\nMCP=%q\nEFFORT=%q\n' "$AGENT" "$MODEL" "$MCP" "$EFFORT" > "$RUN/run.env"
  cp "$PROMPT_FILE" "$RUN/prompt.txt"
  PROMPT=$(cat "$PROMPT_FILE")
  OUT=$RUN/transcript.jsonl
fi

mounts=(-v "$RUN/workspace:/workspace" -v "$RUN/home:/home/node")
started=$(date -u +%FT%TZ)
set +e
case $AGENT in
  claude)
    args=(-p "$PROMPT" --effort "$EFFORT" --output-format stream-json --verbose
          --permission-mode bypassPermissions --strict-mcp-config)
    [[ $MODEL != standard ]] && args+=(--model "$MODEL")
    if [[ $MCP == mit ]]; then
      mounts+=(-v "$ROOT/mcp-docs.json:/etc/op/mcp.json:ro")
      args+=(--mcp-config /etc/op/mcp.json)
    fi
    if $follow_up; then
      session=$(jq -r 'select(.type=="system" and .subtype=="init") | .session_id' "$RUN/transcript.jsonl" | head -1)
      args+=(--resume "$session")
    fi
    docker run --rm --name "op-$NAME" "${mounts[@]}" --env-file "$SECRETS/claude-oauth.env" \
      "$IMAGE" claude "${args[@]}" > "$OUT" 2>> "$RUN/stderr.log"
    status=$?
    ;;
  codex)
    mkdir -p "$RUN/home/.codex"
    if ! $follow_up; then
      {
        echo "model_reasoning_effort = \"$EFFORT\""
        # Keine Connectoren/Plugins aus dem ChatGPT-Workspace, keine Memories (wie bei Claude: nur der Docs MCP)
        printf '\n[features]\napps = false\nplugins = false\nremote_plugin = false\nmemories = false\n'
        if [[ $MCP == mit ]]; then
          printf '\n[mcp_servers.banksapi-docs]\nurl = "https://banksapi.io/docs-mcp"\n'
        fi
      } > "$RUN/home/.codex/config.toml"
    fi
    # Eigener ChatGPT-Login (codex login mit separatem CODEX_HOME), unabhängig vom Codex auf dem Host.
    # Nach dem Lauf zurückkopieren, falls Codex die Tokens erneuert hat.
    (umask 077; cp "$SECRETS/codex-auth.json" "$RUN/home/.codex/auth.json")
    model_args=""
    [[ $MODEL != standard ]] && model_args="-m $MODEL"
    sub="exec"
    $follow_up && sub="exec resume --last"
    docker run --rm --name "op-$NAME" "${mounts[@]}" "$IMAGE" bash -c '
      exec codex '"$sub"' --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check '"$model_args"' "$0"
    ' "$PROMPT" > "$OUT" 2>> "$RUN/stderr.log"
    status=$?
    if [[ $RUN/home/.codex/auth.json -nt $SECRETS/codex-auth.json ]]; then
      (umask 077; cp "$RUN/home/.codex/auth.json" "$SECRETS/codex-auth.json")
    fi
    ;;
esac
set -e
finished=$(date -u +%FT%TZ)

jq -n --arg name "$NAME" --arg agent "$AGENT" --arg model "$MODEL" --arg mcp "$MCP" --arg effort "$EFFORT" \
  --arg started "$started" --arg finished "$finished" --arg out "$(basename "$OUT")" --argjson status "$status" \
  '{name:$name, agent:$agent, model:$model, mcp:$mcp, effort:$effort, transcript:$out, started:$started, finished:$finished, exit:$status}' \
  >> "$RUN/meta.jsonl"
echo "Lauf $NAME beendet (exit $status), Transkript: $OUT"

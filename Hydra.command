#!/bin/zsh
set -u

repo_dir="${0:A:h}"
cli_path="$repo_dir/src/cli.js"
hydra_dir="${CODEX_HOME:-$HOME/.codex}/hydra"
launcher_log="$hydra_dir/launcher.log"

find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi

  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [[ -x "$candidate" ]]; then
      print -r -- "$candidate"
      return 0
    fi
  done

  return 1
}

find_codex() {
  if [[ -n "${HYDRA_CODEX_BIN:-}" ]]; then
    if [[ -x "$HYDRA_CODEX_BIN" ]]; then
      print -r -- "$HYDRA_CODEX_BIN"
      return 0
    fi
    return 1
  fi

  if command -v codex >/dev/null 2>&1; then
    command -v codex
    return 0
  fi

  for candidate in \
    /Applications/ChatGPT.app/Contents/Resources/codex \
    /Applications/Codex.app/Contents/Resources/codex \
    "$HOME/Applications/ChatGPT.app/Contents/Resources/codex" \
    "$HOME/Applications/Codex.app/Contents/Resources/codex" \
    /opt/homebrew/bin/codex \
    /usr/local/bin/codex; do
    if [[ -x "$candidate" ]]; then
      print -r -- "$candidate"
      return 0
    fi
  done

  return 1
}

node_path="$(find_node)" || {
  print -u2 "Hydra could not find Node.js."
  print -u2 "Install Node.js or make sure node is available in PATH."
  print -u2 ""
  print -u2 "Press Return to close this window."
  read -r
  exit 1
}
codex_path="$(find_codex)" || {
  print -u2 "Hydra could not find the Codex command-line helper."
  print -u2 "Install Codex Desktop or set HYDRA_CODEX_BIN to the Codex binary path."
  print -u2 ""
  print -u2 "Press Return to close this window."
  read -r
  exit 1
}

mkdir -p "$hydra_dir"
{
  print -r -- ""
  print -r -- "=== Hydra launcher $(date -u '+%Y-%m-%dT%H:%M:%SZ') ==="
  print -r -- "Repo: $repo_dir"
  print -r -- "Node: $node_path"
  print -r -- "Codex: $codex_path"
} >>"$launcher_log"

cd "$repo_dir" || {
  print -u2 "Hydra could not open $repo_dir"
  print -u2 ""
  print -u2 "Press Return to close this window."
  read -r
  exit 1
}

print -r -- "Installing Hydra configuration..."
if ! "$node_path" "$cli_path" install 2>&1 | tee -a "$launcher_log"; then
  print -u2 ""
  print -u2 "Hydra install failed. See $launcher_log for details."
  print -u2 ""
  print -u2 "Press Return to close this window."
  read -r
  exit 1
fi

print -r -- "Starting Hydra with debug logging..."
nohup "$node_path" "$cli_path" serve --debug-auth --codex-bin "$codex_path" >>"$launcher_log" 2>&1 </dev/null &
serve_pid=$!
disown "$serve_pid" 2>/dev/null || true
print -r -- "Started Hydra process $serve_pid" >>"$launcher_log"

osascript -e 'tell application "Terminal" to set visible to false' >/dev/null 2>&1 || true
exit 0

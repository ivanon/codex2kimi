#!/usr/bin/env bash
set -euo pipefail

LABEL="com.codex2kimi.proxy"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node)"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ -z "$NODE_BIN" ]; then
  echo "node not found in PATH" >&2
  exit 1
fi

echo "Building..."
( cd "$PROJECT_DIR" && npm install && npm run build )

echo "Writing $PLIST_DST"
mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s|__NODE__|$NODE_BIN|g" \
    -e "s|__WORKDIR__|$PROJECT_DIR|g" \
    -e "s|__HOME__|$HOME|g" \
    "$PROJECT_DIR/deploy/$LABEL.plist.template" > "$PLIST_DST"

echo "Validating plist"
plutil -lint "$PLIST_DST"

echo "(Re)loading service"
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST_DST"
launchctl kickstart -k "gui/$UID/$LABEL"

echo "Done. Status: launchctl print gui/$UID/$LABEL"
echo "Logs: $HOME/Library/Logs/codex2kimi.log"

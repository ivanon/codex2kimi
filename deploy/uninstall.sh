#!/usr/bin/env bash
set -euo pipefail

LABEL="com.codex2kimi.proxy"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
rm -f "$PLIST_DST"
echo "Removed $LABEL"

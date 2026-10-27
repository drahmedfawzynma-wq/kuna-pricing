#!/bin/bash
# Kuna Production & Pricing: install or update on macOS.
# Safe to run again after every update (git pull): it rebuilds and restarts the app.
#   • Code stays in this folder (tracked by Git).
#   • Live data:  ~/KunaData/kuna.db   (never inside the code folder, never in iCloud)
#   • Backups:    iCloud Drive/Kuna Backups (daily 12:30 and at every install), or ~/KunaData/backups without iCloud
set -euo pipefail
cd "$(dirname "$0")/.."
APP_DIR="$(pwd)"

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then echo "Node.js is not installed. Install the LTS version from https://nodejs.org and run this again."; exit 1; fi
if ! "$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  echo "Node.js $("$NODE" -v) is too old. Install the LTS version (22.13 or newer) from https://nodejs.org."; exit 1
fi

DATA_DIR="$HOME/KunaData"
ICLOUD="$HOME/Library/Mobile Documents/com~apple~CloudDocs"
if [ -d "$ICLOUD" ]; then BACKUP_DIR="$ICLOUD/Kuna Backups"; else BACKUP_DIR="$DATA_DIR/backups"; fi
mkdir -p "$DATA_DIR" "$BACKUP_DIR"

echo "→ Installing packages and building the interface…"
npm install --no-fund --no-audit --loglevel=error
npm run build --silent

if [ -f "$DATA_DIR/kuna.db" ]; then
  echo "→ Backing up current data before restarting…"
  KUNA_DB_FILE="$DATA_DIR/kuna.db" KUNA_BACKUP_DIR="$BACKUP_DIR" "$NODE" --no-warnings=ExperimentalWarning --import tsx server/cli.ts backup
fi

AGENTS="$HOME/Library/LaunchAgents"
mkdir -p "$AGENTS"
APP_PLIST="$AGENTS/se.kuna.pricing.plist"
BACKUP_PLIST="$AGENTS/se.kuna.backup.plist"

cat > "$APP_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>se.kuna.pricing</string>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>ProgramArguments</key><array>
    <string>$NODE</string><string>--no-warnings=ExperimentalWarning</string><string>--import</string><string>tsx</string><string>server/index.ts</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>KUNA_DB_FILE</key><string>$DATA_DIR/kuna.db</string>
    <key>PORT</key><string>4310</string>
    <key>HOST</key><string>127.0.0.1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DATA_DIR/server.log</string>
  <key>StandardErrorPath</key><string>$DATA_DIR/server.log</string>
</dict></plist>
EOF

cat > "$BACKUP_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>se.kuna.backup</string>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>ProgramArguments</key><array>
    <string>$NODE</string><string>--no-warnings=ExperimentalWarning</string><string>--import</string><string>tsx</string><string>server/cli.ts</string><string>backup</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>KUNA_DB_FILE</key><string>$DATA_DIR/kuna.db</string>
    <key>KUNA_BACKUP_DIR</key><string>$BACKUP_DIR</string>
  </dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>12</integer><key>Minute</key><integer>30</integer></dict>
  <key>StandardOutPath</key><string>$DATA_DIR/backup.log</string>
  <key>StandardErrorPath</key><string>$DATA_DIR/backup.log</string>
</dict></plist>
EOF

echo "→ (Re)starting the background service…"
for P in "$APP_PLIST" "$BACKUP_PLIST"; do
  launchctl bootout "gui/$(id -u)" "$P" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$P"
done

for i in $(seq 1 20); do
  if curl -fs http://127.0.0.1:4310/api/auth/me >/dev/null 2>&1; then
    echo ""
    echo "✓ Kuna Production & Pricing is running: http://127.0.0.1:4310"
    echo "  Data:    $DATA_DIR/kuna.db"
    echo "  Backups: $BACKUP_DIR (daily at 12:30)"
    open http://127.0.0.1:4310
    exit 0
  fi
  sleep 1
done
echo "The service did not respond. Last lines of the log:"; tail -n 20 "$DATA_DIR/server.log" || true; exit 1

#!/bin/bash
# Stops the background app and daily backup. Your data in ~/KunaData and your backups are kept.
for L in se.kuna.pricing se.kuna.backup; do
  launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/$L.plist" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$L.plist"
done
echo "Stopped. Data in ~/KunaData was not touched."

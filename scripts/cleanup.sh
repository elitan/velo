#!/bin/bash
# Remove Velo containers, ZFS datasets, and local data.

set -e

echo "Starting velo cleanup..."

# Stop and remove all velo containers
echo "Removing velo containers..."
docker ps -a | grep "velo-" | awk '{print $1}' | xargs -r docker rm -f 2>/dev/null || true

# Get ZFS pool and dataset base
POOL="tank"
DATASET_BASE="velo/databases"

# Clean up ZFS datasets
echo "Removing ZFS datasets from $POOL/$DATASET_BASE..."
if sudo zfs list -H -o name | grep -q "^$POOL/$DATASET_BASE$"; then
  sudo zfs destroy -r "$POOL/$DATASET_BASE" 2>/dev/null || true
  sudo zfs create "$POOL/$DATASET_BASE" 2>/dev/null || true
else
  echo "Base dataset doesn't exist, creating it..."
  sudo zfs create -p "$POOL/$DATASET_BASE" 2>/dev/null || true
fi

# Remove local app data
echo "Removing local data..."
rm -rf "$HOME/.velo" 2>/dev/null || true

if [ "$(id -u)" -eq 0 ]; then
  rm -rf /root/.velo 2>/dev/null || true
fi

echo "Cleanup complete!"

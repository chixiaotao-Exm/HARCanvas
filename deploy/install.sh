#!/usr/bin/env bash
set -euo pipefail

# Run as root on the Instabox machine. Payload: har-canvas, web/dist,
# deploy/har-canvas.service, and optionally samples/re.har.
if [[ $EUID -ne 0 || $# -lt 2 || $# -gt 3 ]]; then
  echo "Usage: sudo bash install.sh PAYLOAD_DIR ENV_FILE [RELEASE_NAME]" >&2
  exit 1
fi

payload=$(realpath -e -- "$1")
env_file=$(realpath -e -- "$2")
release_name=${3:-$(date -u +%Y%m%dT%H%M%SZ)}
base=/data/workspace/har-canvas
release="$base/releases/$release_name"
if [[ ! $release_name =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$ ]]; then
  echo "Invalid release name" >&2
  exit 1
fi
if [[ ! -f "$payload/har-canvas" || ! -f "$payload/web/dist/index.html" || ! -f "$payload/deploy/har-canvas.service" || ! -f "$env_file" ]]; then
  echo "Payload or environment file is incomplete" >&2
  exit 1
fi
if [[ -e "$release" || -L "$release" || ( -e "$base/current" && ! -L "$base/current" ) ]]; then
  echo "Release exists or current is not a symlink" >&2
  exit 1
fi
# Require authentication before allowing a service intended for publication.
if ! grep -Eq '^HAR_CANVAS_USER=.+$' "$env_file" || ! grep -Eq '^HAR_CANVAS_PASSWORD=.+$' "$env_file"; then
  echo "Environment file must set both HAR_CANVAS_USER and HAR_CANVAS_PASSWORD" >&2
  exit 1
fi

if ! id -u harcanvas >/dev/null 2>&1; then
  useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin harcanvas
fi
install -d -o root -g harcanvas -m 0750 "$base" "$base/releases" "$base/shared" "$release"
install -o root -g harcanvas -m 0750 "$payload/har-canvas" "$release/har-canvas"
cp -R -- "$payload/web" "$release/web"
chown -R root:harcanvas "$release/web"
find "$release/web" -type d -exec chmod 0750 {} +
find "$release/web" -type f -exec chmod 0640 {} +
install -o root -g root -m 0600 "$env_file" "$base/shared/service.env"
if [[ -f "$payload/samples/re.har" ]]; then
  install -o root -g harcanvas -m 0640 "$payload/samples/re.har" "$base/shared/re.har"
fi
install -o root -g root -m 0644 "$payload/deploy/har-canvas.service" /etc/systemd/system/har-canvas.service
ln -sfn -- "$release" "$base/current"
systemctl daemon-reload
systemctl enable har-canvas.service
systemctl restart har-canvas.service
systemctl is-active --quiet har-canvas.service
echo "HAR Canvas installed: $release_name (127.0.0.1:8090)"

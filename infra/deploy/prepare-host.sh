#!/bin/sh
# Install an already-built package. Does not install packages, configure the
# database/HTTPS, change firewall rules, start services or print credentials.
set -eu
if [ "$(id -u)" -ne 0 ]; then
    echo 'Run this installer as root.' >&2
    exit 1
fi
package_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
for item in bin/tomorrow-api bin/tomorrow-worker bin/node services/agent/dist/server.js templates/runtime.env.example; do
    if [ ! -f "$package_dir/$item" ]; then
        echo "Missing package file: $item" >&2
        exit 1
    fi
done
if ! command -v openssl >/dev/null 2>&1; then
    echo 'openssl is required to generate the internal service token.' >&2
    exit 1
fi
if ! getent group tomorrow >/dev/null; then
    groupadd --system tomorrow
fi
if ! id tomorrow >/dev/null 2>&1; then
    useradd --system --gid tomorrow --home-dir /var/lib/tomorrow --shell /usr/sbin/nologin tomorrow
fi
install -d -o root -g root -m 0755 /opt/tomorrow /opt/tomorrow/bin /opt/tomorrow/services
install -d -o root -g root -m 0700 /etc/tomorrow
install -d -o tomorrow -g tomorrow -m 0700 /var/lib/tomorrow /var/lib/tomorrow/uploads
install -o root -g root -m 0755 "$package_dir/bin/tomorrow-api" /opt/tomorrow/bin/tomorrow-api
install -o root -g root -m 0755 "$package_dir/bin/tomorrow-worker" /opt/tomorrow/bin/tomorrow-worker
install -o root -g root -m 0755 "$package_dir/bin/node" /opt/tomorrow/bin/node
# The source package contains only production dependencies. Preserve pnpm links.
cp -a "$package_dir/services/agent" /opt/tomorrow/services/
chown -R root:root /opt/tomorrow/services/agent
chmod -R go-w /opt/tomorrow/services/agent
for service in tomorrow-agent tomorrow-api tomorrow-worker; do
    install -o root -g root -m 0644 "$package_dir/templates/systemd/$service.service" "/etc/systemd/system/$service.service"
done
umask 077
if [ ! -f /etc/tomorrow/runtime.env ]; then
    service_token=$(openssl rand -hex 32)
    sed "s/GENERATE_A_RANDOM_64_HEX_TOKEN/$service_token/" "$package_dir/templates/runtime.env.example" > /etc/tomorrow/runtime.env
    unset service_token
fi
if [ ! -f /etc/tomorrow/model.env ]; then
    cp "$package_dir/templates/model.env.example" /etc/tomorrow/model.env
fi
if [ ! -f /etc/tomorrow/database.env ]; then
    cp "$package_dir/templates/database.env.example" /etc/tomorrow/database.env
fi
chmod 0600 /etc/tomorrow/runtime.env /etc/tomorrow/model.env /etc/tomorrow/database.env
systemctl daemon-reload
echo 'Package installed. Configure private database/model env, database and HTTPS before starting services.'

#!/bin/bash
# EC2 user-data for Amazon Linux 2023. Paste into "Advanced details -> User data" at
# launch; it runs once as root on first boot. Everything here is host preparation only —
# no application code and no secrets, because user-data is readable by anything that can
# reach the instance metadata service.
set -euxo pipefail

dnf update -y
dnf install -y docker git rsync

# Compose v2 ships as a CLI plugin, not in the AL2023 repos.
COMPOSE_VERSION=v2.32.4
mkdir -p /usr/libexec/docker/cli-plugins
curl -fsSL \
  "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-$(uname -m)" \
  -o /usr/libexec/docker/cli-plugins/docker-compose
chmod +x /usr/libexec/docker/cli-plugins/docker-compose

systemctl enable --now docker
usermod -aG docker ec2-user

# Swap. The image build runs `yarn install` across five workspaces plus a Vite build and a
# rollup build; on a 2 GiB instance that is an OOM kill rather than a slow build. Swap is
# what makes the small instance types viable — it is only touched during builds, so the
# steady-state cost is nil.
if [ ! -f /swapfile ]; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi

install -d -o ec2-user -g ec2-user /opt/f5

# Restart the stack on reboot. `docker compose up` is idempotent and the services already
# carry `restart: unless-stopped`, so this only matters for the very first boot after a
# stop/start cycle, where the compose project needs re-creating.
cat >/etc/systemd/system/f5.service <<'UNIT'
[Unit]
Description=f5 stack
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
User=ec2-user
WorkingDirectory=/opt/f5
ExecStart=/usr/bin/docker compose -f deploy/docker-compose.yml up -d
ExecStop=/usr/bin/docker compose -f deploy/docker-compose.yml down

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable f5.service

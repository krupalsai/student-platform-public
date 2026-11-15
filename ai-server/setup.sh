#!/usr/bin/env bash
# One-time setup on a fresh Oracle Cloud Ubuntu (ARM) VM. Run as the default
# `ubuntu` user from inside the ai-server/ folder:   bash setup.sh
set -euo pipefail

echo "==> Installing Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
fi

echo "==> Opening ports 80/443 in the VM firewall"
# Oracle's Ubuntu images ship iptables rules that block everything but SSH,
# even after the cloud Security List allows 80/443.
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save 2>/dev/null || sudo sh -c 'iptables-save > /etc/iptables/rules.v4'

if [ ! -f .env ]; then
  cp .env.example .env
  echo "==> Created .env — edit AI_DOMAIN and AI_TOKEN, then run:"
  echo "    sudo docker compose up -d"
  exit 0
fi

echo "==> Starting"
sudo docker compose up -d
echo "==> Downloading the model (first time takes a few minutes):"
echo "    sudo docker compose logs -f model-pull"

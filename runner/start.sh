#!/bin/bash
# Nothing secret ever reaches this runner through GitHub: the only input is a public key,
# and everything this script publishes (box.json) is public too.
set -euo pipefail

CLOUDFLARED_VERSION=2026.9.3
CLOUDFLARED_SHA256=77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2

[[ $RUNNER_OS == Linux && $(uname -m) == x86_64 ]] || { echo "agent-box supports x86_64 Linux runners only"; exit 1; }
key_re='^ssh-ed25519 [A-Za-z0-9+/]+={0,2}( [A-Za-z0-9._@-]+)?$'
[[ $PUBKEY =~ $key_re ]] || { echo "pubkey must be a single ssh-ed25519 public key"; exit 1; }

box=~/.box
mkdir -p "$box" && chmod 700 "$box"

[[ -x /usr/sbin/sshd ]] || { sudo apt-get update -qq && sudo apt-get install -y -qq openssh-server >/dev/null; }
sudo install -d -m 755 /etc/agent-box
sudo ssh-keygen -q -t ed25519 -N '' -C agent-box -f /etc/agent-box/host_key
printf 'restrict,pty %s\n' "$PUBKEY" | sudo tee /etc/agent-box/authorized_keys >/dev/null
sudo chmod 644 /etc/agent-box/authorized_keys
sudo tee /etc/agent-box/sshd_config >/dev/null <<CONF
Port 2222
ListenAddress 127.0.0.1
HostKey /etc/agent-box/host_key
AuthorizedKeysFile /etc/agent-box/authorized_keys
AuthenticationMethods publickey
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AllowUsers $USER
UsePAM yes
AllowTcpForwarding no
AllowStreamLocalForwarding no
AllowAgentForwarding no
X11Forwarding no
PermitTunnel no
PermitUserEnvironment no
PrintMotd no
PidFile /run/agent-box-sshd.pid
CONF
sudo mkdir -p /run/sshd
sudo /usr/sbin/sshd -t -f /etc/agent-box/sshd_config
sudo /usr/sbin/sshd -f /etc/agent-box/sshd_config

curl -fsSL --retry 3 -o "$box/cloudflared" \
  "https://github.com/cloudflare/cloudflared/releases/download/$CLOUDFLARED_VERSION/cloudflared-linux-amd64"
echo "$CLOUDFLARED_SHA256  $box/cloudflared" | sha256sum -c --quiet
chmod +x "$box/cloudflared"

setsid nohup "$box/cloudflared" tunnel --no-autoupdate --url ssh://127.0.0.1:2222 \
  > "$box/quick.log" 2>&1 < /dev/null &
echo $! > "$box/quick.pid"
host=
for _ in $(seq 90); do
  host=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$box/quick.log" | head -1 || true)
  [[ -n $host ]] && break
  sleep 1
done
[[ -n $host ]] || { echo "quick tunnel did not come up"; exit 1; }

hostkey=$(cut -d' ' -f1,2 /etc/agent-box/host_key.pub)
printf '{"host":"%s","hostKey":"%s","user":"%s"}\n' "${host#https://}" "$hostkey" "$USER" > "$box/box.json"
echo "sshd and tunnel are up"

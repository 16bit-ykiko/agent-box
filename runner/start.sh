#!/bin/bash
# Linux and macOS. Nothing secret ever reaches this runner through GitHub: the only input is
# a public key, and everything this script publishes (box.json) is public too.
set -euo pipefail

CLOUDFLARED_VERSION=2026.10.7
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) asset=cloudflared-linux-amd64 sum=1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872 ;;
  Linux-aarch64) asset=cloudflared-linux-arm64 sum=3df43aedc9ff291d1735b5cb576cb97e0b157488796db2e32b28aecabb445775 ;;
  Darwin-x86_64) asset=cloudflared-darwin-amd64.tgz sum=5c55e77da7012cebca19170357e196176c48c9647cc2ead404702fa125ddbd86 ;;
  Darwin-arm64) asset=cloudflared-darwin-arm64.tgz sum=2136431d5eb467bf447d2ee514b713e192719b143aec1d9e09bf7dc290d5bb12 ;;
  *) echo "unsupported runner: $(uname -s) $(uname -m)"; exit 1 ;;
esac
key_re='^ssh-ed25519 [A-Za-z0-9+/]+={0,2}( [A-Za-z0-9._@-]+)?$'
[[ $PUBKEY =~ $key_re ]] || { echo "pubkey must be a single ssh-ed25519 public key"; exit 1; }

box=~/.box
mkdir -p "$box" && chmod 700 "$box"
install -m 755 "$(dirname "$0")/job.sh" "$box/job"
# The same directory as CI, so absolute paths, and with them compiler cache hits, match.
ln -sfn "$GITHUB_WORKSPACE" ~/src

[[ -x /usr/sbin/sshd ]] || { sudo apt-get update -qq && sudo apt-get install -y -qq openssh-server >/dev/null; }
# box cp streams through zstd; the images have it, but not every image promises to.
if ! command -v zstd >/dev/null; then
  if [[ $(uname -s) == Darwin ]]; then HOMEBREW_NO_AUTO_UPDATE=1 brew install -q zstd; else sudo apt-get update -qq && sudo apt-get install -y -qq zstd >/dev/null; fi
fi
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
PidFile /var/run/agent-box-sshd.pid
CONF
if [[ $(uname -s) == Linux ]]; then sudo mkdir -p /run/sshd; fi
sudo /usr/sbin/sshd -t -f /etc/agent-box/sshd_config
sudo /usr/sbin/sshd -f /etc/agent-box/sshd_config

# The published checksums are of the binary, also for the macOS archives.
curl -fsSL --retry 3 -o "$box/$asset" \
  "https://github.com/cloudflare/cloudflared/releases/download/$CLOUDFLARED_VERSION/$asset"
if [[ $asset == *.tgz ]]; then
  tar -xzf "$box/$asset" -C "$box" cloudflared && rm "$box/$asset"
else
  mv "$box/$asset" "$box/cloudflared"
fi
actual=$( (sha256sum "$box/cloudflared" 2>/dev/null || shasum -a 256 "$box/cloudflared") | grep -oE '[0-9a-f]{64}' | head -1)
[[ $actual == "$sum" ]] || { echo "cloudflared checksum mismatch"; exit 1; }
chmod +x "$box/cloudflared"

nohup "$box/cloudflared" tunnel --no-autoupdate --url ssh://127.0.0.1:2222 > "$box/quick.log" 2>&1 < /dev/null &
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

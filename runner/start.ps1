# Windows. Nothing secret ever reaches this runner through GitHub: the only input is a public
# key, and everything this script publishes (box.json) is public too.
# The image's OpenSSH service crashes when pointed at another config, so it is stopped and
# sshd runs as this user instead (it can then only log in this user, which is all we need),
# on loopback, with our host key, our authorized key and Git Bash as the login shell.
$ErrorActionPreference = 'Stop'
$version = '2026.9.3'
$sha256 = 'f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2'

if ($env:PUBKEY -cnotmatch '^ssh-ed25519 [A-Za-z0-9+/]+={0,2}( [A-Za-z0-9._@-]+)?$') {
  throw 'pubkey must be a single ssh-ed25519 public key'
}
$user = $env:USERNAME.ToLowerInvariant()
if ($user -cnotmatch '^[a-z_][a-z0-9_-]*$') { throw "unexpected user name $user" }

$box = Join-Path $HOME '.box'
$etc = 'C:\ProgramData\agent-box'
New-Item -ItemType Directory -Force $box, $etc | Out-Null

# Windows sshd refuses key files that anyone but SYSTEM and Administrators (and, for
# authorized_keys, the user) can read.
function Lock([string]$path, [string[]]$readers = @()) {
  icacls $path /setowner Administrators | Out-Null
  icacls $path /inheritance:r /grant:r 'SYSTEM:(F)' 'Administrators:(F)' @($readers | ForEach-Object { "${_}:(R)" }) | Out-Null
}

ssh-keygen -q -t ed25519 -N '' -C agent-box -f "$etc\host_key"
if ($LASTEXITCODE -ne 0) { throw 'ssh-keygen failed' }
Lock "$etc\host_key"
Set-Content -Encoding ascii -Path "$etc\authorized_keys" -Value "restrict,pty $env:PUBKEY"
Lock "$etc\authorized_keys" $user

Set-Content -Encoding ascii -Path "$etc\sshd_config" -Value @"
Port 2222
ListenAddress 127.0.0.1
HostKey C:/ProgramData/agent-box/host_key
AuthorizedKeysFile C:/ProgramData/agent-box/authorized_keys
AuthenticationMethods publickey
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
AllowUsers $user
AllowTcpForwarding no
AllowStreamLocalForwarding no
AllowAgentForwarding no
X11Forwarding no
PermitTunnel no
PermitUserEnvironment no
"@
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value 'C:\Program Files\Git\bin\bash.exe' -PropertyType String -Force | Out-Null
Lock "$etc\sshd_config"
Stop-Service sshd
$sshd = "$env:WINDIR\System32\OpenSSH\sshd.exe"
$check = & $sshd -t -f "$etc\sshd_config" 2>&1
if ($LASTEXITCODE -ne 0) { throw "sshd_config rejected: $check" }
$d = Start-Process -FilePath $sshd -ArgumentList '-f', "$etc\sshd_config", '-E', "$box\sshd.log" -WindowStyle Hidden -PassThru
Set-Content -Path "$box\sshd.pid" -Value $d.Id
for ($i = 0; -not (Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 2222 -State Listen -ErrorAction SilentlyContinue); $i++) {
  if ($i -ge 30) { Get-Content "$box\sshd.log" -ErrorAction SilentlyContinue; throw 'sshd is not listening on 127.0.0.1:2222' }
  Start-Sleep 1
}

$exe = "$box\cloudflared.exe"
Invoke-WebRequest -UseBasicParsing -OutFile $exe "https://github.com/cloudflare/cloudflared/releases/download/$version/cloudflared-windows-amd64.exe"
if ((Get-FileHash -Algorithm SHA256 $exe).Hash.ToLowerInvariant() -ne $sha256) { throw 'cloudflared checksum mismatch' }

$p = Start-Process -FilePath $exe -ArgumentList 'tunnel', '--no-autoupdate', '--url', 'ssh://127.0.0.1:2222' `
  -RedirectStandardError "$box\quick.log" -RedirectStandardOutput "$box\quick.out" -WindowStyle Hidden -PassThru
Set-Content -Path "$box\quick.pid" -Value $p.Id
$tunnel = $null
for ($i = 0; $i -lt 90 -and -not $tunnel; $i++) {
  Start-Sleep 1
  $m = Select-String -Path "$box\quick.log" -Pattern 'https://([a-z0-9-]+\.trycloudflare\.com)' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($m) { $tunnel = $m.Matches[0].Groups[1].Value }
}
if (-not $tunnel) { throw 'quick tunnel did not come up' }

$hostkey = ((Get-Content "$etc\host_key.pub" -Raw).Trim() -split ' ')[0..1] -join ' '
Set-Content -Encoding ascii -NoNewline -Path "$box\box.json" -Value (@{ host = $tunnel; hostKey = $hostkey; user = $user } | ConvertTo-Json -Compress)
'sshd and tunnel are up'

# Windows. Nothing secret ever reaches this runner through GitHub: the only input is a public
# key, and everything this script publishes (box.json) is public too.
# The image's OpenSSH service crashes when pointed at another config, so it is stopped and a
# current portable sshd runs as this user instead (it can then only log in this user, which is
# all we need), on loopback, with our host key, our authorized key and Git Bash as the shell.
$ErrorActionPreference = 'Stop'
$version = '2026.10.7'
$sha256 = '2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343'

if ($env:PUBKEY -cnotmatch '^ssh-ed25519 [A-Za-z0-9+/]+={0,2}( [A-Za-z0-9._@-]+)?$') {
  throw 'pubkey must be a single ssh-ed25519 public key'
}
$user = $env:USERNAME.ToLowerInvariant()
if ($user -cnotmatch '^[a-z_][a-z0-9_-]*$') { throw "unexpected user name $user" }

$box = Join-Path $HOME '.box'
$etc = 'C:\ProgramData\agent-box'
New-Item -ItemType Directory -Force $box, $etc | Out-Null
Copy-Item "$PSScriptRoot\job.sh" "$box\job"
Copy-Item "$PSScriptRoot\spawn.ps1" "$box\spawn.ps1"
# The same directory as CI, so absolute paths, and with them compiler cache hits, match.
New-Item -ItemType Junction -Path "$HOME\src" -Target $env:GITHUB_WORKSPACE | Out-Null

# The runner ends every process a step started when the step ends; processes created through
# WMI are not the step's, so sshd and cloudflared outlive this step.
function Spawn([string]$commandLine) {
  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine; CurrentDirectory = $HOME }
  if ($r.ReturnValue -ne 0) { throw "cannot start $commandLine ($($r.ReturnValue))" }
  $r.ProcessId
}

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
Stop-Service sshd -ErrorAction SilentlyContinue
# The image's OpenSSH is 9.5 on x64 and missing on Arm, where installing the Windows capability
# takes over ten minutes; the current release as a portable zip takes seconds.
$zip = @{
  ARM64 = @{ name = 'OpenSSH-ARM64'; sha256 = 'd2b1928225479fec9e0c938f527fdb5ed676446cca1bbcc5af84aca1f272842e' }
  AMD64 = @{ name = 'OpenSSH-Win64'; sha256 = 'b67ff8becd203502190ec42ac7787c24c2cd3325ed7700485fe7a1c83d2a7957' }
}[$env:PROCESSOR_ARCHITECTURE]
Invoke-WebRequest -UseBasicParsing -OutFile "$etc\openssh.zip" "https://github.com/PowerShell/Win32-OpenSSH/releases/download/10.4.0.0p1-Preview/$($zip.name).zip"
if ((Get-FileHash -Algorithm SHA256 "$etc\openssh.zip").Hash.ToLowerInvariant() -ne $zip.sha256) { throw 'OpenSSH checksum mismatch' }
Expand-Archive "$etc\openssh.zip" $etc -Force
$sshd = "$etc\$($zip.name)\sshd.exe"
$check = & $sshd -t -f "$etc\sshd_config" 2>&1
if ($LASTEXITCODE -ne 0) { throw "sshd_config rejected: $check" }
Set-Content -Path "$box\sshd.pid" -Value (Spawn "`"$sshd`" -f `"$etc\sshd_config`" -E `"$box\sshd.log`"")
for ($i = 0; -not (Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 2222 -State Listen -ErrorAction SilentlyContinue); $i++) {
  if ($i -ge 30) { Get-Content "$box\sshd.log" -ErrorAction SilentlyContinue; throw 'sshd is not listening on 127.0.0.1:2222' }
  Start-Sleep 1
}

# cloudflared has no arm64 build; Windows on Arm runs this one emulated.
$exe = "$box\cloudflared.exe"
Invoke-WebRequest -UseBasicParsing -OutFile $exe "https://github.com/cloudflare/cloudflared/releases/download/$version/cloudflared-windows-amd64.exe"
if ((Get-FileHash -Algorithm SHA256 $exe).Hash.ToLowerInvariant() -ne $sha256) { throw 'cloudflared checksum mismatch' }

# box cp streams through zstd; the x64 image has it, the Arm one may not.
if (-not (Get-Command zstd -ErrorAction SilentlyContinue)) {
  Invoke-WebRequest -UseBasicParsing -OutFile "$etc\zstd.zip" 'https://github.com/facebook/zstd/releases/download/v1.5.7/zstd-v1.5.7-win64.zip'
  if ((Get-FileHash -Algorithm SHA256 "$etc\zstd.zip").Hash.ToLowerInvariant() -ne 'acb4e8111511749dc7a3ebedca9b04190e37a17afeb73f55d4425dbf0b90fad9') { throw 'zstd checksum mismatch' }
  Expand-Archive "$etc\zstd.zip" $etc -Force
  Add-Content -Path $env:GITHUB_PATH -Value "$etc\zstd-v1.5.7-win64"
}

Set-Content -Path "$box\quick.pid" -Value (Spawn "`"$exe`" tunnel --no-autoupdate --logfile `"$box\quick.log`" --url ssh://127.0.0.1:2222")
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

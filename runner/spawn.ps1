# Start a bash script outside the calling process tree (see start.ps1 and job.sh).
param([Parameter(Mandatory)][string]$script)
$bash = 'C:\Program Files\Git\bin\bash.exe'
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "`"$bash`" `"$script`""; CurrentDirectory = $HOME }
exit $r.ReturnValue

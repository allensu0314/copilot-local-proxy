param([ValidateRange(1024, 65535)][int]$Port = 39117, [switch]$Desktop)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'Run this installer with pwsh.exe (PowerShell 7).' }
$data = Join-Path $env:LOCALAPPDATA 'CopilotProxy'
$profilePath = Join-Path $env:USERPROFILE '.codex\copilot-local.config.toml'
$taskName = 'CopilotProxy'
$marker = '# Managed by copilot-local-proxy'
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$ghPath = (Get-Command gh.exe -ErrorAction Stop).Source
$powershell = (Get-Command pwsh.exe -ErrorAction Stop).Source
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User.Value
Write-Output 'Checking existing startup and client integration...'
$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existingTask -and $existingTask.Actions.Arguments -notcontains ('-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -WindowStyle Hidden -File "' + (Join-Path $PSScriptRoot 'run.ps1') + '"')) {
    throw 'A different CopilotProxy scheduled task already exists; refusing to replace it.'
}
if ((Test-Path -LiteralPath $profilePath) -and -not (Get-Content -LiteralPath $profilePath -Raw).StartsWith($marker)) {
    throw 'An unmanaged copilot-local Codex profile already exists; refusing to overwrite it.'
}
if ((Test-Path -LiteralPath (Join-Path $data 'installation.json')) -and
    (Get-Content -LiteralPath (Join-Path $data 'installation.json') -Raw | ConvertFrom-Json).sourceDir -ne $PSScriptRoot) {
    throw 'Another proxy installation owns this data directory.'
}
if (-not $existingTask -and (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)) {
    throw "Port $Port is already in use."
}

$null = New-Item -ItemType Directory -Path $data -Force
Write-Output 'Protecting local state and bearer key...'
$directory = [IO.DirectoryInfo]::new($data)
$acl = [IO.FileSystemAclExtensions]::GetAccessControl($directory, [Security.AccessControl.AccessControlSections]::Access)
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))) {
    $null = $acl.RemoveAccessRuleSpecific($rule)
}
foreach ($owner in @($sid, 'S-1-5-18')) {
    $rule = New-Object Security.AccessControl.FileSystemAccessRule(
        (New-Object Security.Principal.SecurityIdentifier($owner)),
        'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
}
[IO.FileSystemAclExtensions]::SetAccessControl($directory, $acl)
$keyPath = Join-Path $data 'local-key.dpapi'
if (-not (Test-Path -LiteralPath $keyPath)) {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $secure = ConvertTo-SecureString ([Convert]::ToBase64String($bytes)) -AsPlainText -Force
    try { ConvertFrom-SecureString $secure | Set-Content -LiteralPath $keyPath -Encoding ASCII }
    finally { $secure.Dispose(); [Array]::Clear($bytes, 0, $bytes.Length) }
}
$config = [ordered]@{ sourceDir = $PSScriptRoot; nodePath = $nodePath; ghPath = $ghPath; port = $Port; taskName = $taskName }
Write-Output 'Writing installation configuration...'
[IO.File]::WriteAllText((Join-Path $data 'installation.json'), ($config | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))

$psToml = $powershell.Replace('\', '\\')
$tokenToml = (Join-Path $PSScriptRoot 'token.ps1').Replace('\', '\\')
$profile = @"
$marker
model = "gpt-6.1-sol"
model_provider = "copilot-local"
model_context_window = 922000
model_reasoning_effort = "medium"
web_search = "disabled"

[model_providers.copilot-local]
name = "Local GitHub Copilot"
base_url = "http://127.0.0.1:$Port/v1"
wire_api = "responses"
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0

[model_providers.copilot-local.auth]
command = "$psToml"
args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-File", "$tokenToml"]
timeout_ms = 10000
refresh_interval_ms = 300000
"@
if (Test-Path -LiteralPath $profilePath) {
    Copy-Item -LiteralPath $profilePath -Destination ($profilePath + '.backup-' + (Get-Date -Format 'yyyyMMdd-HHmmssfff'))
}
Write-Output 'Writing dedicated Codex profile and launcher...'
$null = New-Item -ItemType Directory -Path (Split-Path $profilePath) -Force
[IO.File]::WriteAllText($profilePath, $profile, (New-Object Text.UTF8Encoding($false)))
$bin = Join-Path $data 'bin'
$null = New-Item -ItemType Directory -Path $bin -Force
$launcher = '@echo off' + "`r`n" + '"' + $powershell + '" -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "' + (Join-Path $PSScriptRoot 'codex.ps1') + '" %*' + "`r`n"
[IO.File]::WriteAllText((Join-Path $bin 'codex-copilot.cmd'), $launcher, [Text.Encoding]::ASCII)
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $bin) {
    [Environment]::SetEnvironmentVariable('Path', (([string]$userPath).TrimEnd(';') + ';' + $bin).TrimStart(';'), 'User')
}

$action = New-ScheduledTaskAction -Execute $powershell -Argument ('-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -WindowStyle Hidden -File "' + (Join-Path $PSScriptRoot 'run.ps1') + '"') -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $sid
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -Priority 4 -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Write-Output 'Registering and starting the sign-in task...'
if ($existingTask) { Stop-ScheduledTask -TaskName $taskName }
$null = Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($trigger, $watchdog) -Principal $principal -Settings $settings -Description 'User-local Copilot proxy; sign-in startup, minute watchdog, and worker crash recovery.' -Force
Start-ScheduledTask -TaskName $taskName
$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
        $workerId = [int](Get-Content -LiteralPath (Join-Path $data 'worker.pid') -Raw).Trim()
        $worker = Get-CimInstance Win32_Process -Filter "ProcessId = $workerId"
        $supervisor = if ($worker) { Get-CimInstance Win32_Process -Filter "ProcessId = $($worker.ParentProcessId)" }
        $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
        if ($health.service -eq 'copilot-proxy' -and $health.status -eq 'ok' -and
            $worker.ExecutablePath -eq $nodePath -and $listener.OwningProcess -eq $workerId -and
            $supervisor.CommandLine.Contains((Join-Path $PSScriptRoot 'run.ps1'))) {
            $ready = $true
            break
        }
    } catch {
        # Startup can briefly expose the old listener while replacing an orphan.
    }
    Start-Sleep -Seconds 1
}
if (-not $ready) { throw "Proxy did not become ready. Check $data\service.log and Task Scheduler." }
$localKey = & (Join-Path $PSScriptRoot 'token.ps1')
try {
    $models = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/v1/models" -Headers @{ Authorization = "Bearer $localKey" } -TimeoutSec 30
    if (-not ($models.data | Where-Object id -EQ 'gpt-6.1-sol')) { throw 'The configured Copilot model is not available.' }
}
finally { $localKey = $null }
if ($Desktop -or (Test-Path -LiteralPath (Join-Path $data 'desktop-integration.json'))) {
    & (Join-Path $PSScriptRoot 'configure-desktop.ps1')
}
Write-Output "Installed: http://127.0.0.1:$Port/v1"
Write-Output "Codex: $bin\codex-copilot.cmd (codex-copilot in a new terminal)"
Write-Output "Startup: $taskName at your sign-in, with a minute watchdog and worker crash recovery."

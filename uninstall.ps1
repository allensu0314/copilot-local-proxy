$ErrorActionPreference = 'Stop'
$data = Join-Path $env:LOCALAPPDATA 'CopilotProxy'
$configPath = Join-Path $data 'installation.json'
if (-not (Test-Path -LiteralPath $configPath)) { throw 'This proxy is not installed.' }
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
if ($config.sourceDir -ne $PSScriptRoot) { throw 'Another installation owns this configuration.' }
if (Test-Path -LiteralPath (Join-Path $data 'desktop-integration.json')) {
    & (Join-Path $PSScriptRoot 'configure-desktop.ps1') -Remove
}
$task = Get-ScheduledTask -TaskName $config.taskName -ErrorAction SilentlyContinue
if ($task) {
    $expected = '-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -WindowStyle Hidden -File "' + (Join-Path $PSScriptRoot 'run.ps1') + '"'
    if ($task.Actions.Arguments -notcontains $expected) { throw 'The startup task no longer belongs to this installation.' }
    $null = Disable-ScheduledTask -TaskName $config.taskName
    Stop-ScheduledTask -TaskName $config.taskName
    Unregister-ScheduledTask -TaskName $config.taskName -Confirm:$false
}
$pidPath = Join-Path $data 'worker.pid'
if (Test-Path -LiteralPath $pidPath) {
    $workerId = [int](Get-Content -LiteralPath $pidPath -Raw).Trim()
    $worker = Get-CimInstance Win32_Process -Filter "ProcessId = $workerId"
    if ($worker -and $worker.ExecutablePath -eq $config.nodePath -and $worker.CommandLine.Contains((Join-Path $PSScriptRoot 'server.mjs'))) {
        Stop-Process -Id $workerId
    }
}
$profilePath = Join-Path $env:USERPROFILE '.codex\copilot-local.config.toml'
if ((Test-Path -LiteralPath $profilePath) -and (Get-Content -LiteralPath $profilePath -Raw).StartsWith('# Managed by copilot-local-proxy')) {
    Remove-Item -LiteralPath $profilePath
}
$bin = Join-Path $data 'bin'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
[Environment]::SetEnvironmentVariable('Path', (($userPath -split ';' | Where-Object { $_ -ne $bin }) -join ';'), 'User')
foreach ($path in @((Join-Path $bin 'codex-copilot.cmd'), $pidPath, (Join-Path $data 'local-key.dpapi'), $configPath)) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path }
}
if ((Test-Path -LiteralPath $bin) -and -not (Get-ChildItem -LiteralPath $bin -Force)) { Remove-Item -LiteralPath $bin }
Write-Output 'Uninstalled startup, local key, launcher, and managed Codex profile. Source, logs, and profile backups are retained.'

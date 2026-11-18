$ErrorActionPreference = 'Stop'
$data = Join-Path $env:LOCALAPPDATA 'CopilotProxy'
$configPath = Join-Path $data 'installation.json'
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$mutex = New-Object Threading.Mutex($false, "Local\CopilotProxy-$sid")
if (-not $mutex.WaitOne(0)) { $mutex.Dispose(); exit 0 }

function Write-ProxyLog([string]$Line) {
    $log = Join-Path $data 'service.log'
    if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -ge 2MB) {
        Move-Item -LiteralPath $log -Destination (Join-Path $data 'service.previous.log') -Force
    }
    Add-Content -LiteralPath $log -Value $Line -Encoding UTF8
}

try {
    # A supervisor terminated forcibly can leave its worker alive.
    $pidPath = Join-Path $data 'worker.pid'
    if (Test-Path -LiteralPath $pidPath) {
        $previousId = [int](Get-Content -LiteralPath $pidPath -Raw).Trim()
        $previous = Get-CimInstance Win32_Process -Filter "ProcessId = $previousId"
        if ($previous -and $previous.ExecutablePath -eq $config.nodePath -and $previous.CommandLine.Contains((Join-Path $PSScriptRoot 'server.mjs'))) {
            Stop-Process -Id $previousId -ErrorAction Stop
        }
    }
    $env:COPILOT_PROXY_CONFIG = $configPath
    $env:COPILOT_PROXY_LOCAL_TOKEN = & (Join-Path $PSScriptRoot 'token.ps1')
    foreach ($key in @('GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN')) {
        [Environment]::SetEnvironmentVariable($key, $null, 'Process')
    }
    $delay = 2
    while ($true) {
        $started = Get-Date
        $worker = New-Object Diagnostics.Process
        $worker.StartInfo.FileName = $config.nodePath
        $worker.StartInfo.Arguments = '"' + (Join-Path $PSScriptRoot 'server.mjs') + '"'
        $worker.StartInfo.UseShellExecute = $false
        $worker.StartInfo.CreateNoWindow = $true
        $worker.StartInfo.RedirectStandardOutput = $true
        $worker.StartInfo.RedirectStandardError = $true
        $null = $worker.Start()
        Set-Content -LiteralPath (Join-Path $data 'worker.pid') -Value $worker.Id -Encoding ASCII
        $errors = $worker.StandardError.ReadToEndAsync()
        while ($null -ne ($line = $worker.StandardOutput.ReadLine())) { Write-ProxyLog $line }
        $worker.WaitForExit()
        # Do not persist stderr: a dependency failure can contain credential material.
        if ($errors.GetAwaiter().GetResult()) { Write-ProxyLog ('{"event":"worker_stderr","message":"Worker emitted an error; run npm test and check installation."}') }
        if (((Get-Date) - $started).TotalSeconds -ge 60) { $delay = 2 }
        Write-ProxyLog ('{"event":"worker_exit","exit_code":' + $worker.ExitCode + ',"restart_seconds":' + $delay + '}')
        $worker.Dispose()
        Start-Sleep -Seconds $delay
        $delay = [Math]::Min(60, $delay * 2)
    }
}
finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
    Remove-Item Env:\COPILOT_PROXY_LOCAL_TOKEN -ErrorAction SilentlyContinue
}

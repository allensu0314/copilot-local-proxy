$ErrorActionPreference = 'Stop'
$app = Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object Version -Descending | Select-Object -First 1
$cli = if ($app) { Join-Path $app.InstallLocation 'app\resources\codex.exe' }
if (-not $cli -or -not (Test-Path -LiteralPath $cli)) {
    $command = Get-Command codex.exe -ErrorAction SilentlyContinue
    if (-not $command) { throw 'Installed Codex CLI was not found. Install/repair Codex; this proxy does not install it.' }
    $cli = $command.Source
}
& $cli --profile copilot-local @args
exit $LASTEXITCODE

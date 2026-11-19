# Windows-only, pinned Gitleaks binary. Reports stay outside versioned source.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$version = '8.30.1'
$expectedHash = 'd29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e'
$outputRoot = if ($env:RUNNER_TEMP) { Join-Path $env:RUNNER_TEMP 'ci-secret-scan' } else { Join-Path $PSScriptRoot '../.wrangler/security' }
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
$archive = Join-Path $outputRoot "gitleaks-$version.zip"
$binaryDirectory = Join-Path $outputRoot "gitleaks-$version"
if (-not (Test-Path -LiteralPath $archive)) {
    Invoke-WebRequest -UseBasicParsing "https://github.com/gitleaks/gitleaks/releases/download/v$version/gitleaks_${version}_windows_x64.zip" -OutFile $archive
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
    throw 'Gitleaks SHA-256 verification failed.'
}
Expand-Archive -LiteralPath $archive -DestinationPath $binaryDirectory -Force
$binary = Join-Path $binaryDirectory 'gitleaks.exe'
& $binary git --redact --no-banner --log-opts='--all' --report-format json --report-path (Join-Path $outputRoot 'gitleaks-history.json') (Join-Path $PSScriptRoot '..')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

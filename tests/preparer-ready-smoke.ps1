[CmdletBinding()]
param([string]$Package = '.wrangler/releases/preparador-comercial-insight-1.0.2-win-x64.zip')
$ErrorActionPreference = 'Stop'
$taskWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskZipPath = if ([IO.Path]::IsPathRooted($Package)) { [IO.Path]::GetFullPath($Package) } else { [IO.Path]::GetFullPath((Join-Path $taskWorkspace $Package)) }
$taskRoot = Join-Path $env:TEMP ('ci-ready-smoke-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$taskExtract = Join-Path $taskRoot 'package'
$taskLocalData = Join-Path $taskRoot 'appdata'
$taskInstall = Join-Path $taskLocalData 'ComercialInsight\Preparador'
New-Item -ItemType Directory -Path $taskInstall -Force | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::ExtractToDirectory($taskZipPath, $taskExtract)
$taskSource = Join-Path $taskExtract 'Preparador-Comercial-Insight'
$taskMapping = Join-Path $taskLocalData 'ComercialInsight\mapeamento.json'
[IO.File]::WriteAllText($taskMapping, '{"sourceId":"isolated-synthetic-profile","modelName":"SINTETICO","allowedEmptyTables":[]}', [Text.UTF8Encoding]::new($false))
$taskMappingHash = (Get-FileHash -LiteralPath $taskMapping -Algorithm SHA256).Hash
$taskExe = Join-Path $taskInstall 'ComercialInsight.Preparador.exe'
[IO.File]::WriteAllText($taskExe, 'INERT PREVIOUS SYNTHETIC EXECUTABLE - NEVER LAUNCHED', [Text.Encoding]::ASCII)
$taskOldHash = (Get-FileHash -LiteralPath $taskExe -Algorithm SHA256).Hash
$taskStart = [Diagnostics.ProcessStartInfo]::new()
$taskStart.FileName = $env:ComSpec
$taskStart.Arguments = '/d /s /c ""' + (Join-Path $taskSource 'Atualizar.cmd') + '""'
$taskStart.WorkingDirectory = $taskSource
$taskStart.UseShellExecute = $false
$taskStart.CreateNoWindow = $true
$taskStart.RedirectStandardOutput = $true
$taskStart.RedirectStandardError = $true
$taskStart.RedirectStandardInput = $true
# Only the child updater sees this isolated appdata. The user's environment/install are untouched.
$taskStart.EnvironmentVariables['LOCALAPPDATA'] = $taskLocalData
$taskProcess = [Diagnostics.Process]::new()
$taskProcess.StartInfo = $taskStart
[void]$taskProcess.Start()
$taskProcess.StandardInput.Close()
$taskOutput = $taskProcess.StandardOutput.ReadToEndAsync()
$taskErrors = $taskProcess.StandardError.ReadToEndAsync()
if (-not $taskProcess.WaitForExit(60000)) { $taskProcess.Kill(); throw 'O smoke isolado do atualizador excedeu 60 segundos.' }
$taskStdout = $taskOutput.GetAwaiter().GetResult()
$taskStderr = $taskErrors.GetAwaiter().GetResult()
if ($taskProcess.ExitCode -ne 0) { throw ('Atualizar.cmd falhou no ambiente isolado: ' + $taskStdout + ' ' + $taskStderr) }
if ((Get-FileHash -LiteralPath $taskMapping -Algorithm SHA256).Hash -ne $taskMappingHash) { throw 'O atualizador alterou o perfil sintético.' }
$taskExpectedExeHash = (Get-FileHash -LiteralPath (Join-Path $taskSource 'runtime\ComercialInsight.Preparador.exe') -Algorithm SHA256).Hash
if ((Get-FileHash -LiteralPath $taskExe -Algorithm SHA256).Hash -ne $taskExpectedExeHash) { throw 'O executável pronto não foi ativado no diretório isolado.' }
$taskProof = Get-Content -LiteralPath (Join-Path $taskInstall 'ci-build-validation.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($taskProof.selfTest -ne $true -or $taskProof.executableSha256 -ne $taskExpectedExeHash) { throw 'O executável real não passou no autoteste do atualizador.' }
$taskBackups = @(Get-ChildItem -LiteralPath (Join-Path $taskLocalData 'ComercialInsight') -Directory -Filter 'Preparador.backup-*')
if ($taskBackups.Count -ne 1 -or (Get-FileHash -LiteralPath (Join-Path $taskBackups[0].FullName 'ComercialInsight.Preparador.exe') -Algorithm SHA256).Hash -ne $taskOldHash) { throw 'A instalação sintética anterior não foi preservada.' }
$taskRegistration = Get-Content -LiteralPath (Join-Path $taskSource 'ComercialInsight.pbitool.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$taskRegistrationSuffix = '\' + [IO.Path]::GetFileName($taskRoot) + '\appdata\ComercialInsight\Preparador\ComercialInsight.Preparador.exe'
if (-not $taskRegistration.path.EndsWith($taskRegistrationSuffix, [StringComparison]::OrdinalIgnoreCase) -or (Get-FileHash -LiteralPath $taskRegistration.path -Algorithm SHA256).Hash -ne $taskExpectedExeHash -or $taskRegistration.version -ne '1.0.2' -or $taskRegistration.name -cne 'Preparar atualização Comercial Insight') { throw 'Definição isolada do botão inválida.' }
$taskRuntimeManifest = Get-Content -LiteralPath (Join-Path $taskSource 'runtime\ci-runtime-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($taskFile in $taskRuntimeManifest.files) {
    $taskInstalledFile = Join-Path $taskInstall $taskFile.path
    if ((Get-FileHash -LiteralPath $taskInstalledFile -Algorithm SHA256).Hash -ne $taskFile.sha256) { throw ('Dependência instalada divergente: ' + $taskFile.path) }
}
$taskResult = [PSCustomObject]@{ status = 'passed'; package = $taskZipPath; packageSha256 = (Get-FileHash -LiteralPath $taskZipPath -Algorithm SHA256).Hash.ToLowerInvariant(); executableSha256 = $taskExpectedExeHash.ToLowerInvariant(); runtimeFiles = $taskRuntimeManifest.files.Count; updaterEntryPoint = 'Atualizar.cmd'; realExecutableSelfTest = $true; syntheticProfilePreserved = $true; previousSyntheticInstallPreserved = $true; registrationPerformed = $false; currentUserInstallChanged = $false; testRoot = $taskRoot }
$taskProofDirectory = Join-Path $taskWorkspace '.wrangler\releases'
New-Item -ItemType Directory -Path $taskProofDirectory -Force | Out-Null
$taskResult | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $taskProofDirectory 'preparer-ready-smoke.json') -Encoding UTF8
Write-Output ('Ready Windows updater smoke passed: actual Atualizar.cmd, real self-test, ' + $taskRuntimeManifest.files.Count + ' dependency hashes, synthetic profile and backup preserved; no real install/registration. SHA-256 ' + $taskResult.packageSha256)

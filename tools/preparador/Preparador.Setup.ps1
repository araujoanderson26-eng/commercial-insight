Set-StrictMode -Version 2.0

function Get-CiInstallPath {
    [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'ComercialInsight\Preparador'))
}

function Assert-CiManagedPaths {
    param([string]$InstallPath, [string]$StagePath)
    $taskInstallPath = [IO.Path]::GetFullPath($InstallPath).TrimEnd('\')
    $taskStagePath = [IO.Path]::GetFullPath($StagePath).TrimEnd('\')
    $taskParent = [IO.Path]::GetDirectoryName($taskInstallPath)
    if ([IO.Path]::GetFileName($taskInstallPath) -ne 'Preparador' -or [IO.Path]::GetFileName($taskParent) -ne 'ComercialInsight') {
        throw 'Diretório de instalação inesperado; nenhuma pasta foi alterada.'
    }
    if (-not [string]::Equals([IO.Path]::GetDirectoryName($taskStagePath), $taskParent, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($taskStagePath) -notmatch '^Preparador\.staging-[a-f0-9]{32}$') {
        throw 'O diretório temporário deve ser irmão da instalação e ter identificação própria.'
    }
    foreach ($taskPath in @($taskInstallPath, $taskStagePath, $taskParent)) {
        if ((Test-Path -LiteralPath $taskPath) -and ((Get-Item -LiteralPath $taskPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'A atualização não aceita redirecionamento de diretórios (junction/symlink).'
        }
    }
    [PSCustomObject]@{ Install = $taskInstallPath; Stage = $taskStagePath; Parent = $taskParent }
}

function New-CiRegistration {
    param([string]$ExecutablePath, [string]$OutputPath)
    $taskExecutable = [IO.Path]::GetFullPath($ExecutablePath)
    if ([IO.Path]::GetFileName($taskExecutable) -ne 'ComercialInsight.Preparador.exe') { throw 'Executável inesperado.' }
    $taskDefinition = @{
        version = '1.0.2'
        name = 'Preparar atualização Comercial Insight'
        description = 'Extrai dados e metadados do modelo aberto, em modo de leitura, para uma atualização manual completa.'
        path = $taskExecutable
        arguments = '--server "%server%" --database "%database%"'
        iconData = 'image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
    }
    # Explicit encoding is essential in Windows PowerShell 5.1. The scripts also carry a UTF-8 BOM.
    [IO.File]::WriteAllText([IO.Path]::GetFullPath($OutputPath), ($taskDefinition | ConvertTo-Json), [Text.UTF8Encoding]::new($true))
}

function Assert-CiPreparerClosed {
    if (Get-Process -Name 'ComercialInsight.Preparador' -ErrorAction SilentlyContinue) {
        throw 'Feche a janela do preparador e tente novamente. Não é necessário fechar ou atualizar o PBIX.'
    }
}

function ConvertTo-CiNativePath {
    param([string]$Path)
    if ($Path.StartsWith('\\')) { return '\\?\UNC\' + $Path.Substring(2) }
    return '\\?\' + $Path
}

function Copy-CiRuntimePayload {
    param([string]$RuntimePath, [string]$StagePath)
    $taskRuntimeRoot = [IO.Path]::GetFullPath($RuntimePath).TrimEnd('\')
    $taskStageRoot = [IO.Path]::GetFullPath($StagePath).TrimEnd('\')
    $taskManifestPath = Join-Path $taskRuntimeRoot 'ci-runtime-manifest.json'
    $taskManifestNative = ConvertTo-CiNativePath $taskManifestPath
    if (-not [IO.File]::Exists($taskManifestNative)) { throw 'Pacote Windows incompleto: manifesto do executável ausente. Extraia todo o ZIP novamente.' }
    $taskManifest = [IO.File]::ReadAllText($taskManifestNative, [Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($taskManifest.version -ne '1.0.2' -or $taskManifest.runtime -ne 'win-x64' -or $taskManifest.selfContained -ne $true) { throw 'O pacote não contém a versão Windows x64 esperada.' }
    $taskRequired = @('ComercialInsight.Preparador.exe', 'ComercialInsight.Preparador.dll', 'ComercialInsight.Preparador.deps.json', 'ComercialInsight.Preparador.runtimeconfig.json', 'coreclr.dll', 'System.Windows.Forms.dll', 'Microsoft.AnalysisServices.Core.dll', 'Microsoft.AnalysisServices.Tabular.dll', 'Microsoft.AnalysisServices.AdomdClient.dll')
    $taskNames = @($taskManifest.files | ForEach-Object { [string]$_.path })
    foreach ($taskRequiredName in $taskRequired) {
        if ($taskNames -cnotcontains $taskRequiredName) { throw ('Dependência obrigatória ausente no pacote: ' + $taskRequiredName) }
    }
    if (($taskNames | Select-Object -Unique).Count -ne $taskNames.Count) { throw 'O manifesto contém arquivos repetidos.' }
    $taskCopies = @()
    foreach ($taskFile in $taskManifest.files) {
        $taskName = [string]$taskFile.path
        if ([string]::IsNullOrWhiteSpace($taskName) -or [IO.Path]::IsPathRooted($taskName) -or $taskName.Contains(':')) { throw 'Caminho inválido no pacote Windows.' }
        $taskSource = [IO.Path]::GetFullPath((Join-Path $taskRuntimeRoot $taskName))
        $taskDestination = [IO.Path]::GetFullPath((Join-Path $taskStageRoot $taskName))
        if (-not $taskSource.StartsWith($taskRuntimeRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or -not $taskDestination.StartsWith($taskStageRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Caminho fora do pacote Windows.' }
        $taskNativeSource = ConvertTo-CiNativePath $taskSource
        if (-not [IO.File]::Exists($taskNativeSource)) { throw ('Arquivo ausente no pacote: ' + $taskName + '. Extraia todo o ZIP novamente.') }
        $taskInfo = [IO.FileInfo]::new($taskNativeSource)
        $taskStream = [IO.File]::OpenRead($taskNativeSource)
        $taskHasher = [Security.Cryptography.SHA256]::Create()
        try { $taskHash = [BitConverter]::ToString($taskHasher.ComputeHash($taskStream)).Replace('-', '') }
        finally { $taskStream.Dispose(); $taskHasher.Dispose() }
        if (($taskInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $taskInfo.Length -ne $taskFile.bytes -or $taskHash -ne $taskFile.sha256) { throw ('Arquivo incompleto ou alterado no pacote: ' + $taskName) }
        $taskCopies += [PSCustomObject]@{ Source = $taskSource; Destination = $taskDestination }
    }
    foreach ($taskCopy in $taskCopies) {
        [IO.Directory]::CreateDirectory((ConvertTo-CiNativePath ([IO.Path]::GetDirectoryName($taskCopy.Destination)))) | Out-Null
        # The extracted ZIP or staging directory can be below a long OneDrive path.
        # Extended Windows paths avoid the legacy MAX_PATH limit in PowerShell 5.1.
        $taskCopySource = ConvertTo-CiNativePath $taskCopy.Source
        $taskCopyDestination = ConvertTo-CiNativePath $taskCopy.Destination
        [IO.File]::Copy($taskCopySource, $taskCopyDestination, $false)
    }
}

function New-CiPreparedBuild {
    param([string]$SourcePath, [string]$InstallPath)
    $taskStagePath = Join-Path ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($InstallPath))) ('Preparador.staging-' + [guid]::NewGuid().ToString('N'))
    $taskPaths = Assert-CiManagedPaths $InstallPath $taskStagePath
    $taskRuntime = Join-Path ([IO.Path]::GetFullPath($SourcePath)) 'runtime'
    if ([IO.Directory]::Exists((ConvertTo-CiNativePath $taskRuntime))) {
        Write-Host 'Conferindo o executável Windows pronto e suas dependências. Não é necessário baixar o SDK...'
        Copy-CiRuntimePayload -RuntimePath $taskRuntime -StagePath $taskPaths.Stage
    } else {
    $taskProject = Join-Path ([IO.Path]::GetFullPath($SourcePath)) 'ComercialInsight.Preparador.csproj'
    if (-not (Test-Path -LiteralPath $taskProject) -or -not (Test-Path -LiteralPath (Join-Path $SourcePath 'packages.lock.json'))) {
        throw 'Extraia todos os arquivos do pacote antes de instalar ou atualizar.'
    }
    $taskSdk = Join-Path $env:TEMP 'ci10sdk'
    $taskDotnet = Join-Path $taskSdk 'dotnet.exe'
    if (-not (Test-Path -LiteralPath $taskDotnet)) {
        Write-Host 'Baixando o SDK .NET oficial para compilar o preparador...'
        $taskBootstrap = Join-Path $env:TEMP ('ci-dotnet-install-' + [guid]::NewGuid().ToString('N') + '.ps1')
        Invoke-WebRequest -UseBasicParsing -Uri 'https://dot.net/v1/dotnet-install.ps1' -OutFile $taskBootstrap
        & $taskBootstrap -Version '10.0.404' -InstallDir $taskSdk -NoPath | Out-Host
        if ($LASTEXITCODE -ne 0) { throw 'Não foi possível instalar o SDK .NET oficial.' }
    }
    New-Item -ItemType Directory -Path $taskPaths.Stage -Force | Out-Null
    Write-Host 'Compilando em uma pasta separada. A versão instalada permanece intacta...'
    & $taskDotnet restore $taskProject --locked-mode | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'Falha na restauração dos pacotes Microsoft. A instalação anterior não foi alterada.' }
    & $taskDotnet publish $taskProject -c Release --self-contained true -o $taskPaths.Stage --no-restore | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'A compilação falhou. A instalação anterior não foi alterada.' }
    }
    $taskExe = Join-Path $taskPaths.Stage 'ComercialInsight.Preparador.exe'
    $taskSelfTest = Start-Process -FilePath $taskExe -ArgumentList '--self-test' -WindowStyle Hidden -PassThru
    if (-not $taskSelfTest.WaitForExit(120000)) {
        $taskSelfTest.Kill()
        throw 'O autoteste excedeu o prazo. A instalação anterior não foi alterada.'
    }
    $taskSelfTest.Refresh()
    if ($taskSelfTest.ExitCode -ne 0) { throw 'Os controles internos falharam. A instalação anterior não foi alterada.' }
    @{ selfTest = $true; executableSha256 = (Get-FileHash -LiteralPath $taskExe -Algorithm SHA256).Hash } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskPaths.Stage 'ci-build-validation.json') -Encoding UTF8
    return $taskPaths.Stage
}

function Move-CiPreparedDirectory {
    param([string]$SourcePath, [string]$DestinationPath, [string]$Phase)
    $taskSource = [IO.Path]::GetFullPath($SourcePath).TrimEnd('\')
    $taskDestination = [IO.Path]::GetFullPath($DestinationPath).TrimEnd('\')
    $taskParent = [IO.Path]::GetDirectoryName($taskSource)
    $taskManagedName = '^Preparador(?:\.(?:staging|backup)-[a-f0-9]{32})?$'
    if ([IO.Path]::GetFileName($taskParent) -ne 'ComercialInsight' -or -not [string]::Equals([IO.Path]::GetDirectoryName($taskDestination), $taskParent, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($taskSource) -notmatch $taskManagedName -or [IO.Path]::GetFileName($taskDestination) -notmatch $taskManagedName) {
        throw 'Movimentação recusada: origem e destino devem ser diretórios gerenciados no mesmo pai ComercialInsight.'
    }
    $taskMaxAttempts = 6
    for ($taskAttempt = 1; $taskAttempt -le $taskMaxAttempts; $taskAttempt++) {
        try {
            [IO.Directory]::Move($taskSource, $taskDestination)
            return
        } catch {
            $taskCause = $_.Exception
            while ($taskCause.InnerException) { $taskCause = $taskCause.InnerException }
            $taskNativeCode = $taskCause.HResult -band 65535
            # A scanner/sync client can briefly open a directory without FILE_SHARE_DELETE.
            # Windows can briefly report access-denied after a sharing handle is released.
            # Only retry these native I/O codes; never alter ACLs, elevate or loop indefinitely.
            if ($taskCause -is [IO.IOException] -and $taskNativeCode -in @(5, 32, 33) -and $taskAttempt -lt $taskMaxAttempts) {
                Write-Verbose ('Movimentação ocupada em ' + $Phase + '; código Windows ' + $taskNativeCode + ', tentativa ' + $taskAttempt + '/' + $taskMaxAttempts + '.')
                Start-Sleep -Milliseconds (100 * $taskAttempt)
                continue
            }
            throw [IO.IOException]::new(('Falha ao ' + $Phase + ': ' + $taskCause.GetType().Name + ', código Windows ' + $taskNativeCode + ', tentativa ' + $taskAttempt + '/' + $taskMaxAttempts + '.'), $taskCause)
        }
    }
}

function Set-CiPreparedBuild {
    param([string]$StagePath, [string]$InstallPath)
    $taskPaths = Assert-CiManagedPaths $InstallPath $StagePath
    $taskExe = Join-Path $taskPaths.Stage 'ComercialInsight.Preparador.exe'
    $taskProof = Join-Path $taskPaths.Stage 'ci-build-validation.json'
    if (-not (Test-Path -LiteralPath $taskExe) -or -not (Test-Path -LiteralPath $taskProof)) { throw 'Preparação incompleta; a versão instalada foi preservada.' }
    $taskValidation = Get-Content -LiteralPath $taskProof -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($taskValidation.selfTest -ne $true -or $taskValidation.executableSha256 -ne (Get-FileHash -LiteralPath $taskExe -Algorithm SHA256).Hash) {
        throw 'A preparação não passou no autoteste ou foi alterada após o teste. A instalação anterior foi preservada.'
    }
    Assert-CiPreparerClosed
    $taskBackup = Join-Path $taskPaths.Parent ('Preparador.backup-' + [guid]::NewGuid().ToString('N'))
    # All resolved source/target paths were checked above; directory renames stay in the same named parent.
    if (-not [string]::Equals([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($taskBackup)), $taskPaths.Parent, [StringComparison]::OrdinalIgnoreCase)) { throw 'Destino de recuperação inesperado.' }
    $taskHadPrevious = Test-Path -LiteralPath $taskPaths.Install
    try {
        if ($taskHadPrevious) { Move-CiPreparedDirectory $taskPaths.Install $taskBackup 'preservar a versão anterior' }
        Move-CiPreparedDirectory $taskPaths.Stage $taskPaths.Install 'ativar a nova versão'
    }
    catch {
        $taskActivationFailure = $_.Exception
        $taskRecovery = 'A instalação anterior não foi alterada.'
        if ($taskHadPrevious -and (Test-Path -LiteralPath $taskBackup) -and -not (Test-Path -LiteralPath $taskPaths.Install)) {
            try {
                Move-CiPreparedDirectory $taskBackup $taskPaths.Install 'restaurar a versão anterior'
                $taskRecovery = 'A versão anterior foi restaurada.'
            } catch {
                throw [IO.IOException]::new(('A atualização e a restauração não puderam ser ativadas. Nenhum mapeamento foi alterado. Pasta de recuperação: ' + $taskBackup + '. ' + $_.Exception.Message + ' Falha inicial: ' + $taskActivationFailure.Message), $_.Exception)
            }
        }
        throw [IO.IOException]::new(('Atualização não ativada. ' + $taskRecovery + ' Nenhum mapeamento foi alterado. ' + $taskActivationFailure.Message), $taskActivationFailure)
    }
    return [PSCustomObject]@{ Install = $taskPaths.Install; Backup = $(if ($taskHadPrevious) { $taskBackup } else { $null }) }
}

function Invoke-CiRegister {
    param([string]$SourcePath, [string]$RegistrationPath)
    Write-Host 'O Windows solicitará elevação somente para registrar/reparar o botão do Power BI.'
    $taskRegisterScript = Join-Path $SourcePath 'Registrar.ps1'
    $taskProcess = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $taskRegisterScript + '"'), '-Registration', ('"' + $RegistrationPath + '"')) -Verb RunAs -WindowStyle Hidden -Wait -PassThru
    if ($taskProcess.ExitCode -ne 0) { throw 'O registro do botão não foi concluído. O executável e o mapeamento foram preservados.' }
}

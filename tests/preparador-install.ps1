$ErrorActionPreference = 'Stop'
$taskWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskScripts = Join-Path $taskWorkspace 'tools\preparador'
. (Join-Path $taskScripts 'Preparador.Setup.ps1')
$taskPassed = 0
function Assert-CiTest {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}
function Assert-CiThrows {
    param([scriptblock]$Action, [string]$Message)
    $taskThrew = $false
    try { & $Action | Out-Null } catch { $taskThrew = $true }
    Assert-CiTest $taskThrew $Message
}
foreach ($taskName in @('Instalar.ps1', 'Registrar.ps1', 'Atualizar.ps1', 'Preparador.Setup.ps1')) {
    $taskFile = Join-Path $taskScripts $taskName
    $taskBytes = [IO.File]::ReadAllBytes($taskFile)
    Assert-CiTest ($taskBytes[0] -eq 239 -and $taskBytes[1] -eq 187 -and $taskBytes[2] -eq 191) ('Windows PowerShell 5.1 exige BOM UTF-8: ' + $taskName)
    $taskTokens = $null; $taskErrors = $null
    [void][Management.Automation.Language.Parser]::ParseFile($taskFile, [ref]$taskTokens, [ref]$taskErrors)
    Assert-CiTest ($taskErrors.Count -eq 0) ('Erro de sintaxe em ' + $taskName)
}
$taskPassed++

$taskArea = Join-Path $taskWorkspace ('.wrangler\installer-tests-' + [guid]::NewGuid().ToString('N'))
$taskParent = Join-Path $taskArea 'ComercialInsight'
$taskInstall = Join-Path $taskParent 'Preparador'
New-Item -ItemType Directory -Path $taskInstall -Force | Out-Null
$taskMapping = Join-Path $taskParent 'mapeamento.json'
[IO.File]::WriteAllText($taskMapping, '{"sourceId":"existing-profile","modelName":"Panizzon","factTable":"Faturamento","allowedEmptyTables":[]}', [Text.UTF8Encoding]::new($false))
$taskMappingHash = (Get-FileHash -LiteralPath $taskMapping -Algorithm SHA256).Hash
$taskExe = Join-Path $taskInstall 'ComercialInsight.Preparador.exe'
[IO.File]::WriteAllText($taskExe, 'PREVIOUS TEST BINARY', [Text.Encoding]::ASCII)
$taskRegistration = Join-Path $taskArea 'ComercialInsight.pbitool.json'
New-CiRegistration -ExecutablePath $taskExe -OutputPath $taskRegistration
$taskDefinition = Get-Content -LiteralPath $taskRegistration -Raw -Encoding UTF8 | ConvertFrom-Json
Assert-CiTest ($taskDefinition.name -ceq 'Preparar atualização Comercial Insight') 'Nome do registro sofreu corrupção de caracteres.'
Assert-CiTest ($taskDefinition.arguments -ceq '--server "%server%" --database "%database%"') 'Parâmetros externos foram alterados.'
$taskPassed++

Assert-CiThrows { Assert-CiManagedPaths $taskInstall (Join-Path $taskArea 'Preparador.staging-00000000000000000000000000000000') } 'Aceitou staging fora do pai autorizado.'
Assert-CiThrows { Assert-CiManagedPaths (Join-Path $taskArea 'OutroAplicativo') (Join-Path $taskParent 'Preparador.staging-00000000000000000000000000000000') } 'Aceitou instalação com nome inesperado.'
$taskPassed++

# Ready Windows payload checks use inert dependencies and never launch an executable.
$taskRuntime = Join-Path $taskArea 'runtime'
New-Item -ItemType Directory -Path $taskRuntime -Force | Out-Null
$taskRuntimeNames = @('ComercialInsight.Preparador.exe', 'ComercialInsight.Preparador.dll', 'ComercialInsight.Preparador.deps.json', 'ComercialInsight.Preparador.runtimeconfig.json', 'coreclr.dll', 'System.Windows.Forms.dll', 'Microsoft.AnalysisServices.Core.dll', 'Microsoft.AnalysisServices.Tabular.dll', 'Microsoft.AnalysisServices.AdomdClient.dll')
$taskRuntimeFiles = @()
foreach ($taskRuntimeName in $taskRuntimeNames) {
    $taskRuntimeFile = Join-Path $taskRuntime $taskRuntimeName
    [IO.File]::WriteAllText($taskRuntimeFile, ('INERT TEST ' + $taskRuntimeName), [Text.Encoding]::ASCII)
    $taskRuntimeFiles += @{ path = $taskRuntimeName; bytes = (Get-Item -LiteralPath $taskRuntimeFile).Length; sha256 = (Get-FileHash -LiteralPath $taskRuntimeFile -Algorithm SHA256).Hash }
}
$taskRuntimeManifest = Join-Path $taskRuntime 'ci-runtime-manifest.json'
@{ version = '1.0.2'; runtime = 'win-x64'; selfContained = $true; files = $taskRuntimeFiles } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $taskRuntimeManifest -Encoding UTF8
$taskRuntimeStage = Join-Path $taskParent ('Preparador.staging-' + [guid]::NewGuid().ToString('N'))
Copy-CiRuntimePayload -RuntimePath $taskRuntime -StagePath $taskRuntimeStage
foreach ($taskRuntimeName in $taskRuntimeNames) { Assert-CiTest ([IO.File]::Exists((ConvertTo-CiNativePath (Join-Path $taskRuntimeStage $taskRuntimeName)))) 'O pacote pronto perdeu uma dependência.' }
[IO.File]::AppendAllText((Join-Path $taskRuntime 'coreclr.dll'), 'BROKEN')
Assert-CiThrows { Copy-CiRuntimePayload -RuntimePath $taskRuntime -StagePath (Join-Path $taskParent ('Preparador.staging-' + [guid]::NewGuid().ToString('N'))) } 'O pacote pronto aceitou uma dependência corrompida.'
Assert-CiTest ((Get-FileHash -LiteralPath $taskMapping -Algorithm SHA256).Hash -eq $taskMappingHash) 'A preparação do pacote pronto alterou o perfil.'
$taskPassed++

# A manifest cannot copy files outside the extracted payload or selected staging directory.
$taskRuntimeFiles += @{ path = '..\outside.dll'; bytes = 0; sha256 = ('0' * 64) }
@{ version = '1.0.2'; runtime = 'win-x64'; selfContained = $true; files = $taskRuntimeFiles } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $taskRuntimeManifest -Encoding UTF8
[IO.File]::WriteAllText((Join-Path $taskRuntime 'coreclr.dll'), 'INERT TEST coreclr.dll', [Text.Encoding]::ASCII)
Assert-CiThrows { Copy-CiRuntimePayload -RuntimePath $taskRuntime -StagePath (Join-Path $taskParent ('Preparador.staging-' + [guid]::NewGuid().ToString('N'))) } 'O pacote pronto aceitou um caminho externo.'
$taskPassed++

# Filesystem-only tests use inert text fixtures, never launch an executable or modify the user's install.
function Assert-CiPreparerClosed { }
function New-CiFakeStage {
    param([string]$Contents, [bool]$Validated)
    $taskStage = Join-Path $taskParent ('Preparador.staging-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $taskStage -Force | Out-Null
    $taskStageExe = Join-Path $taskStage 'ComercialInsight.Preparador.exe'
    [IO.File]::WriteAllText($taskStageExe, $Contents, [Text.Encoding]::ASCII)
    @{selfTest = $Validated; executableSha256 = (Get-FileHash -LiteralPath $taskStageExe -Algorithm SHA256).Hash} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskStage 'ci-build-validation.json') -Encoding UTF8
    return $taskStage
}
$taskFailedStage = New-CiFakeStage 'FAILED TEST BINARY' $false
Assert-CiThrows { Set-CiPreparedBuild $taskFailedStage $taskInstall } 'Ativou uma preparação reprovada.'
Assert-CiTest ([IO.File]::ReadAllText($taskExe) -eq 'PREVIOUS TEST BINARY') 'Falha no autoteste alterou a versão instalada.'
$taskPassed++

$taskChangedStage = New-CiFakeStage 'TEST BINARY BEFORE CHANGE' $true
[IO.File]::WriteAllText((Join-Path $taskChangedStage 'ComercialInsight.Preparador.exe'), 'CHANGED AFTER VALIDATION', [Text.Encoding]::ASCII)
Assert-CiThrows { Set-CiPreparedBuild $taskChangedStage $taskInstall } 'Ativou um executável alterado após o teste.'
Assert-CiTest ([IO.File]::ReadAllText($taskExe) -eq 'PREVIOUS TEST BINARY') 'Checksum inválido alterou a versão instalada.'
$taskPassed++

$taskGoodStage = New-CiFakeStage 'NEW TEST BINARY' $true
$taskActivation = Set-CiPreparedBuild $taskGoodStage $taskInstall
Assert-CiTest ([IO.File]::ReadAllText($taskExe) -eq 'NEW TEST BINARY') 'A versão preparada não foi ativada.'
Assert-CiTest ([IO.File]::ReadAllText((Join-Path $taskActivation.Backup 'ComercialInsight.Preparador.exe')) -eq 'PREVIOUS TEST BINARY') 'A versão anterior não foi preservada.'
Assert-CiTest ((Get-FileHash -LiteralPath $taskMapping -Algorithm SHA256).Hash -eq $taskMappingHash) 'A atualização alterou o mapeamento existente.'
$taskPassed++

$taskIncompleteStage = Join-Path $taskParent ('Preparador.staging-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskIncompleteStage -Force | Out-Null
Assert-CiThrows { Set-CiPreparedBuild $taskIncompleteStage $taskInstall } 'Aceitou uma preparação incompleta.'
Assert-CiTest ([IO.File]::ReadAllText($taskExe) -eq 'NEW TEST BINARY') 'Preparação incompleta alterou a versão instalada.'
Assert-CiTest ((Get-FileHash -LiteralPath $taskMapping -Algorithm SHA256).Hash -eq $taskMappingHash) 'O mapeamento foi alterado após uma falha.'
$taskPassed++

# Reproduce real Windows rename contention rather than replacing the file operation with a mock.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32.SafeHandles;
public static class CiInstallerNativeLock {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    public static SafeFileHandle Open(string path) {
        SafeFileHandle handle = CreateFile(path, 0x80000000, 3, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
        if (handle.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        return handle;
    }
    public static void ReleaseAfter(SafeFileHandle handle, int milliseconds) {
        ThreadPool.QueueUserWorkItem(delegate { Thread.Sleep(milliseconds); handle.Dispose(); });
    }
}
'@
$taskTransientStage = New-CiFakeStage 'TRANSIENT LOCK TEST BINARY' $true
$taskLock = [CiInstallerNativeLock]::Open($taskTransientStage)
try {
    $taskProbeDestination = Join-Path $taskParent ('Preparador.backup-' + [guid]::NewGuid().ToString('N'))
    Assert-CiTest ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($taskProbeDestination)) -eq $taskParent) 'Destino do teste nativo fora da área permitida.'
    $taskNativeFailure = $null
    try { [IO.Directory]::Move($taskTransientStage, $taskProbeDestination) }
    catch { $taskNativeFailure = $_.Exception; while ($taskNativeFailure.InnerException) { $taskNativeFailure = $taskNativeFailure.InnerException } }
    Assert-CiTest ($taskNativeFailure -is [IO.IOException] -and ($taskNativeFailure.HResult -band 65535) -eq 32) 'O teste não reproduziu a violação de compartilhamento Windows 32.'
    [CiInstallerNativeLock]::ReleaseAfter($taskLock, 350)
    $taskRecoveredActivation = Set-CiPreparedBuild $taskTransientStage $taskInstall
    Assert-CiTest ([IO.File]::ReadAllText($taskExe) -eq 'TRANSIENT LOCK TEST BINARY') 'Não retomou a troca após liberar um bloqueio transitório.'
    Assert-CiTest ([IO.File]::ReadAllText((Join-Path $taskRecoveredActivation.Backup 'ComercialInsight.Preparador.exe')) -eq 'NEW TEST BINARY') 'Retomada perdeu a versão anterior.'
} finally { $taskLock.Dispose() }
Assert-CiTest ((Get-FileHash -LiteralPath $taskMapping -Algorithm SHA256).Hash -eq $taskMappingHash) 'Retomada alterou o mapeamento existente.'
$taskPassed++

$taskPermanentStage = New-CiFakeStage 'PERMANENT LOCK TEST BINARY' $true
$taskLock = [CiInstallerNativeLock]::Open($taskPermanentStage)
$taskPermanentFailure = $null
try { Set-CiPreparedBuild $taskPermanentStage $taskInstall | Out-Null }
catch { $taskPermanentFailure = $_.Exception }
finally { $taskLock.Dispose() }
Assert-CiTest ($null -ne $taskPermanentFailure -and $taskPermanentFailure.Message.Contains('código Windows 32') -and $taskPermanentFailure.Message.Contains('6/6')) 'O bloqueio persistente não foi encerrado com diagnóstico e limite de tentativas.'
Assert-CiTest ($taskPermanentFailure.Message.Contains('A versão anterior foi restaurada.')) 'Falha de ativação não informou restauração da versão anterior.'
Assert-CiTest ([IO.File]::ReadAllText($taskExe) -eq 'TRANSIENT LOCK TEST BINARY') 'O bloqueio persistente deixou a instalação anterior indisponível.'
Assert-CiTest ((Get-FileHash -LiteralPath $taskMapping -Algorithm SHA256).Hash -eq $taskMappingHash) 'Falha após tentativas alterou o mapeamento existente.'
$taskPassed++
Write-Output ('Installer tests passed: ' + $taskPassed + '; workspace-only, no installation or registration performed.')

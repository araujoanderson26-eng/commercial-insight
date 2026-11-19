[CmdletBinding()]
param([switch]$SemRegistro, [switch]$SomenteRegistro)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
. (Join-Path $PSScriptRoot 'Preparador.Setup.ps1')
$taskInstall = Get-CiInstallPath
if (-not $SomenteRegistro) {
    Assert-CiPreparerClosed
    $taskStage = New-CiPreparedBuild -SourcePath $PSScriptRoot -InstallPath $taskInstall
    $taskResult = Set-CiPreparedBuild -StagePath $taskStage -InstallPath $taskInstall
    if ($taskResult.Backup) { Write-Host ('Versão anterior mantida para recuperação em: ' + $taskResult.Backup) }
}
if (-not (Test-Path -LiteralPath (Join-Path $taskInstall 'ComercialInsight.Preparador.exe'))) { throw 'Instale ou atualize o executável antes de registrar o botão.' }
$taskRegistration = Join-Path $PSScriptRoot 'ComercialInsight.pbitool.json'
New-CiRegistration -ExecutablePath (Join-Path $taskInstall 'ComercialInsight.Preparador.exe') -OutputPath $taskRegistration
if (-not $SemRegistro) { Invoke-CiRegister -SourcePath $PSScriptRoot -RegistrationPath $taskRegistration }
Write-Host 'Preparador pronto. Reinicie o Power BI Desktop somente se o botão foi registrado/reparado.'
Write-Host 'Seu mapeamento existente permanece em %LOCALAPPDATA%\ComercialInsight\mapeamento.json.'
Write-Host 'Desenvolvido por Anderson de Araujo.'

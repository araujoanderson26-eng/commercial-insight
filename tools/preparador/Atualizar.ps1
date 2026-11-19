[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
. (Join-Path $PSScriptRoot 'Preparador.Setup.ps1')
$taskInstall = Get-CiInstallPath
if (-not (Test-Path -LiteralPath (Join-Path $taskInstall 'ComercialInsight.Preparador.exe'))) {
    throw 'Não há instalação anterior neste usuário. Execute Instalar.cmd para a primeira instalação.'
}
Assert-CiPreparerClosed
$taskStage = New-CiPreparedBuild -SourcePath $PSScriptRoot -InstallPath $taskInstall
$taskResult = Set-CiPreparedBuild -StagePath $taskStage -InstallPath $taskInstall
New-CiRegistration -ExecutablePath (Join-Path $taskInstall 'ComercialInsight.Preparador.exe') -OutputPath (Join-Path $PSScriptRoot 'ComercialInsight.pbitool.json')
Write-Host 'Atualização concluída. O botão existente já inicia o executável corrigido.'
Write-Host 'O mapeamento foi preservado. Não houve elevação nem alteração do registro do Power BI.'
Write-Host ('Versão anterior mantida para recuperação em: ' + $taskResult.Backup)
Write-Host 'Se o nome do botão tiver acentos incorretos, use RepararRegistro.cmd; essa reparação opcional solicita elevação.'

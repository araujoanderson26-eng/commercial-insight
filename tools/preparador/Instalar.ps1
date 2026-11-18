[CmdletBinding()]
param([switch]$SemRegistro)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$taskSource = $PSScriptRoot
$taskInstall = Join-Path $env:LOCALAPPDATA 'ComercialInsight\Preparador'
$taskSdk = Join-Path $env:TEMP 'ci10sdk'
$taskDotnet = Join-Path $taskSdk 'dotnet.exe'
if (-not (Test-Path -LiteralPath $taskDotnet)) {
    Write-Host 'Baixando o SDK .NET oficial para compilar o preparador...'
    $taskBootstrap = Join-Path $env:TEMP 'ci-dotnet-install.ps1'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://dot.net/v1/dotnet-install.ps1' -OutFile $taskBootstrap
    & $taskBootstrap -Version '10.0.404' -InstallDir $taskSdk -NoPath
    if ($LASTEXITCODE -ne 0) { throw 'Não foi possível instalar o SDK .NET oficial.' }
}
Write-Host 'Compilando as bibliotecas Microsoft TOM/ADOMD e o preparador...'
& $taskDotnet restore (Join-Path $taskSource 'ComercialInsight.Preparador.csproj') --locked-mode
if ($LASTEXITCODE -ne 0) { throw 'Falha na restauração dos pacotes Microsoft fixados no lockfile.' }
& $taskDotnet publish (Join-Path $taskSource 'ComercialInsight.Preparador.csproj') -c Release --self-contained true -o $taskInstall --no-restore
if ($LASTEXITCODE -ne 0) { throw 'A compilação falhou; o botão do Power BI não foi registrado.' }
$taskSelfTest = Start-Process -FilePath (Join-Path $taskInstall 'ComercialInsight.Preparador.exe') -ArgumentList '--self-test' -WindowStyle Hidden -Wait -PassThru
if ($taskSelfTest.ExitCode -ne 0) { throw 'Os controles internos do preparador falharam.' }
$taskRegistration = Join-Path $taskSource 'ComercialInsight.pbitool.json'
@{
    version = '1.0.0'
    name = 'Preparar atualização Comercial Insight'
    description = 'Extrai dados e metadados do modelo aberto, em modo de leitura, para uma atualização manual completa.'
    path = (Join-Path $taskInstall 'ComercialInsight.Preparador.exe')
    arguments = '--server "%server%" --database "%database%"'
    iconData = 'image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
} | ConvertTo-Json | Set-Content -LiteralPath $taskRegistration -Encoding UTF8
if (-not $SemRegistro) {
    Write-Host 'O Windows solicitará elevação apenas para registrar o botão em Ferramentas externas do Power BI.'
    # The elevated helper receives fixed paths, not arbitrary shell expressions or source data.
    $taskRegisterScript = Join-Path $taskSource 'Registrar.ps1'
    $taskProcess = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $taskRegisterScript + '"'), '-Registration', ('"' + $taskRegistration + '"')) -Verb RunAs -WindowStyle Hidden -Wait -PassThru
    if ($taskProcess.ExitCode -ne 0) { throw 'O registro do botão não foi concluído. Execute Instalar.cmd novamente e aceite a elevação do Windows.' }
}
Write-Host 'Preparador instalado. Reinicie o Power BI Desktop, abra o PBIX e use Ferramentas externas > Preparar atualização Comercial Insight.'
Write-Host 'Desenvolvido por Anderson de Araujo.'

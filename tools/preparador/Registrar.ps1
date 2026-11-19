[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Registration)
$ErrorActionPreference = 'Stop'
$taskRegistration = [IO.Path]::GetFullPath($Registration)
if ([IO.Path]::GetFileName($taskRegistration) -ne 'ComercialInsight.pbitool.json') { throw 'Arquivo de registro inesperado.' }
$taskDefinition = Get-Content -LiteralPath $taskRegistration -Raw -Encoding UTF8 | ConvertFrom-Json
if ($taskDefinition.name -ne 'Preparar atualização Comercial Insight' -or $taskDefinition.arguments -ne '--server "%server%" --database "%database%"') { throw 'Definição de ferramenta inesperada.' }
if (-not [IO.Path]::IsPathRooted($taskDefinition.path) -or [IO.Path]::GetFileName($taskDefinition.path) -ne 'ComercialInsight.Preparador.exe' -or -not (Test-Path -LiteralPath $taskDefinition.path)) { throw 'Executável registrado não encontrado.' }
$taskDestination = Join-Path ${env:CommonProgramFiles(x86)} 'Microsoft Shared\Power BI Desktop\External Tools'
New-Item -ItemType Directory -Path $taskDestination -Force | Out-Null
Copy-Item -LiteralPath $taskRegistration -Destination (Join-Path $taskDestination 'ComercialInsight.pbitool.json') -Force

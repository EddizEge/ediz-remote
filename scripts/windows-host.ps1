param(
    [Parameter(Position = 0)]
    [ValidateSet('build', 'test', 'turn-simulation', 'publish', 'list', 'encoders', 'encoder-probe', 'encode-probe', 'stream-probe', 'probe', 'snapshot')]
    [string]$Command = 'build',

    [int]$Output = 0,
    [int]$Duration = 5,
    [string]$File
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$localDotnet = Join-Path $root '.tools\dotnet\dotnet.exe'
$hostProject = Join-Path $root 'apps\windows-host\EdizRemote.Host.csproj'
$testProject = Join-Path $root 'apps\windows-host.Tests\EdizRemote.Host.Tests.csproj'

if (-not (Test-Path -LiteralPath $localDotnet)) {
    $installDirectory = Split-Path -Parent $localDotnet
    $installer = Join-Path $env:TEMP 'ediz-remote-dotnet-install.ps1'
    Write-Host 'Proje içine taşınabilir .NET 8 SDK indiriliyor...'
    Invoke-WebRequest -UseBasicParsing 'https://dot.net/v1/dotnet-install.ps1' -OutFile $installer
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer `
        -Channel 8.0 -Quality GA -InstallDir $installDirectory -NoPath
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:NUGET_PACKAGES = Join-Path $root '.tools\nuget'

switch ($Command) {
    'build' {
        & $localDotnet build $testProject -c Release
    }
    'test' {
        & $localDotnet test $testProject -c Release
    }
    'turn-simulation' {
        & $localDotnet test $testProject -c Release `
            --filter 'FullyQualifiedName~TurnRelaySimulationTests'
    }
    'publish' {
        $publishDirectory = Join-Path $root 'artifacts\windows-host\win-x64'
        & $localDotnet publish $hostProject -c Release -r win-x64 --self-contained true `
            -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
            -o $publishDirectory
        if ($LASTEXITCODE -eq 0) {
            Write-Host "Windows host paketi: $publishDirectory"
        }
    }
    'list' {
        & $localDotnet run --project $hostProject -c Release -- list
    }
    'encoders' {
        & $localDotnet run --project $hostProject -c Release -- encoders
    }
    'encoder-probe' {
        & $localDotnet run --project $hostProject -c Release -- `
            encoder-probe --output $Output
    }
    'encode-probe' {
        if ([string]::IsNullOrWhiteSpace($File)) {
            throw 'encode-probe komutu için -File zorunludur.'
        }
        & $localDotnet run --project $hostProject -c Release -- `
            encode-probe --output $Output --duration $Duration --file $File
    }
    'stream-probe' {
        & $localDotnet run --project $hostProject -c Release -- `
            stream-probe --output $Output --duration $Duration
    }
    'probe' {
        & $localDotnet run --project $hostProject -c Release -- `
            probe --output $Output --duration $Duration
    }
    'snapshot' {
        if ([string]::IsNullOrWhiteSpace($File)) {
            throw 'snapshot komutu için -File zorunludur.'
        }
        & $localDotnet run --project $hostProject -c Release -- `
            snapshot --output $Output --duration $Duration --file $File
    }
}

if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

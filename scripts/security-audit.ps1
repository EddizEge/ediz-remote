[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$localDotnet = Join-Path $repositoryRoot '.tools\dotnet\dotnet.exe'
$projectFiles = @(
    'apps\windows-host\EdizRemote.Host.csproj',
    'apps\windows-host.Tests\EdizRemote.Host.Tests.csproj',
    'apps\windows-desktop\EdizRemote.Desktop.csproj',
    'apps\windows-desktop.Tests\EdizRemote.Desktop.Tests.csproj'
)

if (-not (Test-Path -LiteralPath $localDotnet -PathType Leaf)) {
    throw 'Local .NET SDK is missing. Run npm run native:build first.'
}

Push-Location $repositoryRoot
try {
    & npm.cmd audit --audit-level=moderate
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    $env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
    $env:NUGET_PACKAGES = Join-Path $repositoryRoot '.tools\nuget'
    foreach ($projectFile in $projectFiles) {
        $auditText = & $localDotnet list $projectFile package `
            --vulnerable --include-transitive --format json | Out-String
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        $audit = $auditText | ConvertFrom-Json
        $findings = @(
            foreach ($project in @($audit.projects)) {
                foreach ($framework in @($project.frameworks)) {
                    if ($null -eq $framework) { continue }
                    foreach ($group in @('topLevelPackages', 'transitivePackages')) {
                        foreach ($package in @($framework.$group)) {
                            if ($null -eq $package) { continue }
                            foreach ($vulnerability in @($package.vulnerabilities)) {
                                if ($null -eq $vulnerability) { continue }
                                [PSCustomObject]@{
                                    Project = $projectFile
                                    Package = $package.id
                                    Version = $package.resolvedVersion
                                    Severity = $vulnerability.severity
                                    Advisory = $vulnerability.advisoryurl
                                }
                            }
                        }
                    }
                }
            }
        )
        if ($findings.Count -gt 0) {
            $findings | Format-Table -AutoSize | Out-String | Write-Host
            throw "Vulnerable NuGet package found for $projectFile."
        }
        Write-Host "NuGet audit clean: $projectFile"
    }

    Write-Host 'npm and all four .NET project security audits passed.'
}
finally {
    Pop-Location
}

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('manifest', 'verify', 'sign')]
    [string]$Command = 'verify',

    [string]$ArtifactPath,

    [string]$ManifestPath,

    [string]$CatalogPath,

    [string]$BuildId
)

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) {
    $pwsh = Get-Command 'pwsh.exe' -CommandType Application `
        -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $pwsh) {
        [Console]::Error.WriteLine(
            ('WINDOWS_RELEASE_{0}_FAILED:powershell_version_unsupported' -f
                $Command.ToUpperInvariant()))
        exit 1
    }
    $forwardArguments = @(
        '-NoLogo',
        '-NoProfile',
        '-File',
        $PSCommandPath,
        '-Command',
        $Command
    )
    foreach ($name in @('ArtifactPath', 'ManifestPath', 'CatalogPath', 'BuildId')) {
        if ($PSBoundParameters.ContainsKey($name)) {
            $forwardArguments += @("-$name", [string]$PSBoundParameters[$name])
        }
    }
    & $pwsh.Source @forwardArguments
    exit $LASTEXITCODE
}
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$modulePath = Join-Path $PSScriptRoot 'windows-release-lib.psm1'
Import-Module $modulePath -Force

if ([string]::IsNullOrWhiteSpace($ArtifactPath)) {
    $ArtifactPath = Join-Path $repositoryRoot `
        'artifacts\windows-desktop\win-x64\EdizRemote.exe'
}
if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
    $ManifestPath = Join-Path `
        ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($ArtifactPath))) `
        'EdizRemote.release-manifest.json'
}
if ([string]::IsNullOrWhiteSpace($CatalogPath)) {
    $releaseDirectory = [IO.Path]::GetDirectoryName(
        [IO.Path]::GetFullPath($ArtifactPath))
    $CatalogPath = Join-Path `
        ([IO.Path]::GetDirectoryName($releaseDirectory)) `
        'EdizRemote.win-x64.cat'
}
if ([string]::IsNullOrWhiteSpace($BuildId)) {
    $BuildId = $env:EDIZ_REMOTE_BUILD_ID
}
if ([string]::IsNullOrWhiteSpace($BuildId)) {
    try {
        $package = Get-Content -LiteralPath `
            (Join-Path $repositoryRoot 'package.json') -Raw | ConvertFrom-Json
        $BuildId = 'ediz-remote@{0}' -f $package.version
    }
    catch {
        $BuildId = ''
    }
}

try {
    switch ($Command) {
        'manifest' {
            Write-WindowsReleaseManifest `
                -ArtifactPath $ArtifactPath `
                -ManifestPath $ManifestPath `
                -BuildId $BuildId | Out-Null
            Write-Host 'WINDOWS_RELEASE_MANIFEST_OK'
        }
        'verify' {
            Invoke-WindowsReleaseGate `
                -ArtifactPath $ArtifactPath `
                -ManifestPath $ManifestPath `
                -CatalogPath $CatalogPath
            Write-Host 'WINDOWS_RELEASE_GATE_OK'
        }
        'sign' {
            Invoke-WindowsStoreSigning -ArtifactPath $ArtifactPath
            Write-WindowsReleaseManifest `
                -ArtifactPath $ArtifactPath `
                -ManifestPath $ManifestPath `
                -BuildId $BuildId | Out-Null
            New-WindowsReleaseCatalog `
                -ArtifactPath $ArtifactPath `
                -ManifestPath $ManifestPath `
                -CatalogPath $CatalogPath
            Invoke-WindowsCatalogStoreSigning `
                -ArtifactPath $ArtifactPath `
                -CatalogPath $CatalogPath
            Invoke-WindowsReleaseGate `
                -ArtifactPath $ArtifactPath `
                -ManifestPath $ManifestPath `
                -CatalogPath $CatalogPath
            Write-Host 'WINDOWS_RELEASE_SIGN_AND_VERIFY_OK'
        }
    }
}
catch {
    $code = Get-WindowsReleaseErrorCode -Message $_.Exception.Message
    [Console]::Error.WriteLine(
        ('WINDOWS_RELEASE_{0}_FAILED:{1}' -f $Command.ToUpperInvariant(), $code))
    exit 1
}

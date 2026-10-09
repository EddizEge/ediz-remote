param(
    [Parameter(Position = 0)]
    [ValidateSet('build', 'test', 'run', 'publish', 'validate-web')]
    [string]$Command = 'build',

    [string]$SignalingUrl = 'ws://127.0.0.1:8788/ws',

    [string]$WebRoot
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$localDotnet = Join-Path $root '.tools\dotnet\dotnet.exe'
$desktopProject = Join-Path $root 'apps\windows-desktop\EdizRemote.Desktop.csproj'
$testProject = Join-Path $root 'apps\windows-desktop.Tests\EdizRemote.Desktop.Tests.csproj'
$desktopSettings = Join-Path $root 'apps\windows-desktop\ediz-remote.settings.json'
$webDist = Join-Path $root 'apps\web\dist'

function Get-SafePublishChildPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PublishDirectory,

        [Parameter(Mandatory = $true)]
        [string]$ChildName
    )

    if ([string]::IsNullOrWhiteSpace($ChildName) -or
        $ChildName.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0 -or
        $ChildName.Contains([IO.Path]::DirectorySeparatorChar) -or
        $ChildName.Contains([IO.Path]::AltDirectorySeparatorChar)) {
        throw "Güvenli olmayan publish alt dizini: $ChildName"
    }

    $publishFullPath = [IO.Path]::GetFullPath($PublishDirectory)
    $childFullPath = [IO.Path]::GetFullPath(
        (Join-Path $publishFullPath $ChildName))
    $publishPrefix = $publishFullPath
    if (-not $publishPrefix.EndsWith(
            [string][IO.Path]::DirectorySeparatorChar,
            [StringComparison]::Ordinal)) {
        $publishPrefix += [IO.Path]::DirectorySeparatorChar
    }

    if (-not $childFullPath.StartsWith(
            $publishPrefix,
            [StringComparison]::OrdinalIgnoreCase)) {
        throw "Publish alt dizini hedef kökün dışında: $childFullPath"
    }

    return $childFullPath
}

function Assert-WebPackageReferences {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PackageWebRoot
    )

    $webRootFullPath = [IO.Path]::GetFullPath($PackageWebRoot)
    if (-not (Test-Path -LiteralPath $webRootFullPath -PathType Container)) {
        throw "Web paket dizini bulunamadı: $webRootFullPath"
    }

    $indexPath = Join-Path $webRootFullPath 'index.html'
    if (-not (Test-Path -LiteralPath $indexPath -PathType Leaf)) {
        throw "Web paket index dosyası bulunamadı: $indexPath"
    }

    $webRootPrefix = $webRootFullPath
    if (-not $webRootPrefix.EndsWith(
            [string][IO.Path]::DirectorySeparatorChar,
            [StringComparison]::Ordinal)) {
        $webRootPrefix += [IO.Path]::DirectorySeparatorChar
    }

    $html = [IO.File]::ReadAllText($indexPath)
    $attributePattern =
        '(?is)\b(?<attribute>src|href)\s*=\s*(?<quote>["''])(?<value>.*?)\k<quote>'
    $matches = [regex]::Matches($html, $attributePattern)
    $localReferenceCount = 0
    $hasJavaScript = $false
    $hasStylesheet = $false

    foreach ($match in $matches) {
        $reference = [Net.WebUtility]::HtmlDecode(
            $match.Groups['value'].Value.Trim())
        if ([string]::IsNullOrWhiteSpace($reference) -or
            $reference.StartsWith('#', [StringComparison]::Ordinal) -or
            $reference.StartsWith('//', [StringComparison]::Ordinal) -or
            $reference -match '^[A-Za-z][A-Za-z0-9+.-]*:') {
            continue
        }

        $pathPart = ($reference -split '[?#]', 2)[0]
        if ([string]::IsNullOrWhiteSpace($pathPart)) {
            throw "Web paketinde boş yerel referans var: $reference"
        }

        try {
            $pathPart = [Uri]::UnescapeDataString($pathPart)
        }
        catch {
            throw "Web paketinde çözümlenemeyen referans var: $reference"
        }

        $relativePath = $pathPart -replace '^[\\/]+', ''
        $relativePath = $relativePath.Replace(
            [IO.Path]::AltDirectorySeparatorChar,
            [IO.Path]::DirectorySeparatorChar)
        $referencedPath = [IO.Path]::GetFullPath(
            (Join-Path $webRootFullPath $relativePath))
        if (-not $referencedPath.StartsWith(
                $webRootPrefix,
                [StringComparison]::OrdinalIgnoreCase)) {
            throw "Web paket referansı hedef kökün dışında: $reference"
        }
        if (-not (Test-Path -LiteralPath $referencedPath -PathType Leaf)) {
            throw "WEB_PACKAGE_MISSING_REFERENCE: $reference ($referencedPath)"
        }

        $localReferenceCount += 1
        $extension = [IO.Path]::GetExtension($referencedPath)
        if ($match.Groups['attribute'].Value.Equals(
                'src',
                [StringComparison]::OrdinalIgnoreCase) -and
            $extension.Equals('.js', [StringComparison]::OrdinalIgnoreCase)) {
            $hasJavaScript = $true
        }
        if ($match.Groups['attribute'].Value.Equals(
                'href',
                [StringComparison]::OrdinalIgnoreCase) -and
            $extension.Equals('.css', [StringComparison]::OrdinalIgnoreCase)) {
            $hasStylesheet = $true
        }
    }

    if ($localReferenceCount -eq 0) {
        throw 'Web index dosyasında doğrulanabilir yerel src/href referansı yok.'
    }
    if (-not $hasJavaScript) {
        throw 'Web index dosyasında mevcut bir yerel JavaScript src referansı yok.'
    }
    if (-not $hasStylesheet) {
        throw 'Web index dosyasında mevcut bir yerel CSS href referansı yok.'
    }

    Write-Host "WEB_PACKAGE_OK: $localReferenceCount local references validated."
}

function Copy-WebPackageDeterministically {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SourceWebRoot,

        [Parameter(Mandatory = $true)]
        [string]$PublishDirectory
    )

    Assert-WebPackageReferences -PackageWebRoot $SourceWebRoot
    $publishedWeb = Get-SafePublishChildPath `
        -PublishDirectory $PublishDirectory -ChildName 'Web'
    $stagingWeb = Get-SafePublishChildPath `
        -PublishDirectory $PublishDirectory -ChildName 'Web.publish-staging'

    try {
        if (Test-Path -LiteralPath $stagingWeb) {
            Remove-Item -LiteralPath $stagingWeb -Recurse -Force
        }
        New-Item -ItemType Directory -Path $stagingWeb | Out-Null
        foreach ($entry in Get-ChildItem -LiteralPath $SourceWebRoot -Force) {
            Copy-Item -LiteralPath $entry.FullName -Destination $stagingWeb `
                -Recurse -Force
        }

        Assert-WebPackageReferences -PackageWebRoot $stagingWeb
        if (Test-Path -LiteralPath $publishedWeb) {
            Remove-Item -LiteralPath $publishedWeb -Recurse -Force
        }
        Move-Item -LiteralPath $stagingWeb -Destination $publishedWeb
        Assert-WebPackageReferences -PackageWebRoot $publishedWeb
    }
    finally {
        if (Test-Path -LiteralPath $stagingWeb) {
            Remove-Item -LiteralPath $stagingWeb -Recurse -Force
        }
    }
}

if ($Command -eq 'validate-web') {
    if ([string]::IsNullOrWhiteSpace($WebRoot)) {
        throw 'validate-web komutu için -WebRoot zorunludur.'
    }
    Assert-WebPackageReferences -PackageWebRoot $WebRoot
    exit 0
}

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

# Release kimliği web build'inden önce yakalanır ve EXE sürüm kaynağına gömülür:
# ProductVersion `<sürüm>+<commit>` (kirli ağaçta `.dirty`), FileVersion
# `<sürüm>.<EDIZ_REMOTE_RELEASE_SEQUENCE>`. Sequence verilmezse 0'dır ve paket
# release kapısından geçemez.
$publishIdentityProperties = @()
$publishSourceState = $null
if ($Command -eq 'publish') {
    Import-Module (Join-Path $PSScriptRoot 'windows-release-lib.psm1') -Force
    try {
        $publishSequence = Get-WindowsPublishReleaseSequence
        $publishVersion = Get-WindowsReleasePackageVersion -RepositoryRoot $root
        $publishSourceState = Get-WindowsReleaseSourceState -RepositoryRoot $root
        $publishIdentityProperties = Get-WindowsPublishIdentityProperties `
            -Version $publishVersion `
            -Sequence $publishSequence `
            -SourceState $publishSourceState
    }
    catch {
        throw "Release kimliği hazırlanamadı: $($_.Exception.Message)"
    }
}

Push-Location $root
try {
    npm run build --workspace '@ediz-remote/web'
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    switch ($Command) {
        'build' {
            & $localDotnet build $desktopProject -c Release
        }
        'test' {
            & $localDotnet test $testProject -c Release
        }
        'run' {
            & $localDotnet build $desktopProject -c Release
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
            $executable = Join-Path $root `
                'apps\windows-desktop\bin\Release\net8.0-windows\EdizRemote.exe'
            $previousUrl = $env:EDIZ_REMOTE_SIGNALING_URL
            $env:EDIZ_REMOTE_SIGNALING_URL = $SignalingUrl
            try {
                Start-Process -FilePath $executable
            }
            finally {
                $env:EDIZ_REMOTE_SIGNALING_URL = $previousUrl
            }
        }
        'publish' {
            $publishDirectory = Join-Path $root 'artifacts\windows-desktop\win-x64'
            if (Test-Path -LiteralPath $publishDirectory -PathType Container) {
                # Eski EXE'yi tarif eden manifest yeni pakette bayat kalmamalı.
                $staleManifest = Get-SafePublishChildPath `
                    -PublishDirectory $publishDirectory `
                    -ChildName 'EdizRemote.release-manifest.json'
                if (Test-Path -LiteralPath $staleManifest -PathType Leaf) {
                    Remove-Item -LiteralPath $staleManifest -Force
                }
            }
            & $localDotnet publish $desktopProject -c Release -r win-x64 `
                --self-contained true -p:PublishSingleFile=true `
                -p:IncludeNativeLibrariesForSelfExtract=true `
                @publishIdentityProperties -o $publishDirectory
            if ($LASTEXITCODE -eq 0) {
                Copy-WebPackageDeterministically `
                    -SourceWebRoot $webDist -PublishDirectory $publishDirectory
                Copy-Item -LiteralPath $desktopSettings `
                    -Destination (Join-Path $publishDirectory 'ediz-remote.settings.json') `
                    -Force

                # Build sırasında commit/ağaç değiştiyse gömülü kimlik kaynağı
                # doğru anlatmaz; EXE bırakılmaz.
                $sourceAfterPublish = Get-WindowsReleaseSourceState -RepositoryRoot $root
                if (-not [string]::Equals(
                        $sourceAfterPublish.Revision,
                        $publishSourceState.Revision,
                        [StringComparison]::Ordinal) -or
                    $sourceAfterPublish.Clean -ne $publishSourceState.Clean) {
                    Remove-Item -LiteralPath (Get-SafePublishChildPath `
                            -PublishDirectory $publishDirectory `
                            -ChildName 'EdizRemote.exe') -Force
                    throw 'Kaynak ağacı publish sırasında değişti; paket bırakılmadı.'
                }

                Write-Host "Windows masaüstü paketi: $publishDirectory"
                $treeState = 'temiz'
                if (-not $publishSourceState.Clean) { $treeState = 'kirli' }
                Write-Host ("Release kimliği: sürüm {0}, sequence {1}, commit {2}, ağaç {3}" -f
                    $publishVersion,
                    $publishSequence,
                    $publishSourceState.Revision,
                    $treeState)
            }
        }
    }
}
finally {
    Pop-Location
}

if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

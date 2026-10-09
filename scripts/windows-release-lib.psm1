Set-StrictMode -Version Latest

$script:ReleaseErrorCodes = @(
    'artifact_missing',
    'artifact_name_invalid',
    'artifact_size_mismatch',
    'artifact_hash_mismatch',
    'manifest_path_invalid',
    'manifest_too_large',
    'manifest_invalid',
    'manifest_schema_invalid',
    'manifest_build_invalid',
    'release_path_invalid',
    'release_tree_invalid',
    'release_tree_too_large',
    'release_tree_changed',
    'catalog_path_invalid',
    'catalog_missing',
    'catalog_too_large',
    'catalog_creation_failed',
    'catalog_validation_failed',
    'catalog_hash_algorithm_invalid',
    'powershell_version_unsupported',
    'expected_signer_missing',
    'expected_signer_invalid',
    'signtool_missing',
    'signtool_verify_failed',
    'signature_invalid',
    'signature_type_invalid',
    'signer_missing',
    'signer_mismatch',
    'timestamp_missing',
    'timestamp_invalid',
    'unsafe_private_key_configuration',
    'signing_certificate_missing',
    'signing_certificate_invalid',
    'timestamp_url_invalid',
    'certificate_store_invalid',
    'signing_failed',
    'release_identity_invalid',
    'release_identity_mismatch',
    'release_version_mismatch',
    'release_sequence_invalid',
    'release_floor_missing',
    'release_floor_invalid',
    'release_rollback_rejected',
    'provenance_dirty_source',
    'provenance_revision_mismatch',
    'source_state_unavailable',
    'internal_error'
)

# Release kimliği EXE'nin kendi sürüm kaynağından okunur: ProductVersion
# `<major.minor.patch>+<40 hex git commit>` (kirli ağaçta `.dirty` eki),
# FileVersion `<major.minor.patch>.<release sequence>`. Sequence monoton artan
# anti-rollback sayacıdır; 0 yalnız geliştirme paketidir ve yayınlanamaz.
$script:ReleaseSourceRepository = 'https://github.com/EddizEge/ediz-remote'
$script:ReleaseVersionPattern =
    '\A(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\z'
$script:ReleaseSequencePattern = '\A(0|[1-9][0-9]{0,4})\z'
$script:ReleaseRevisionPattern = '\A[0-9a-f]{40}\z'
$script:ReleaseMaximumVersionPart = 65534
$script:ReleaseMaximumSequence = 65535

function Throw-ReleaseError {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Code
    )

    throw $Code
}

function Get-WindowsReleaseErrorCode {
    param(
        [AllowNull()]
        [string]$Message
    )

    if ($script:ReleaseErrorCodes -contains $Message) {
        return $Message
    }
    return 'internal_error'
}

function Get-EnvironmentSetting {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,

        [AllowNull()]
        [System.Collections.IDictionary]$Environment
    )

    if ($null -ne $Environment) {
        if ($Environment.Contains($Name)) {
            return [string]$Environment[$Name]
        }
        return $null
    }
    return [Environment]::GetEnvironmentVariable($Name)
}

function Assert-ArtifactPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ArtifactPath
    )

    $artifactFullPath = [IO.Path]::GetFullPath($ArtifactPath)
    if (-not [IO.Path]::GetFileName(
            [IO.Path]::GetDirectoryName($artifactFullPath)).Equals(
            'win-x64',
            [StringComparison]::OrdinalIgnoreCase)) {
        Throw-ReleaseError 'release_path_invalid'
    }
    Assert-LocalReleaseDirectory `
        -DirectoryPath ([IO.Path]::GetDirectoryName($artifactFullPath))
    if (-not (Test-Path -LiteralPath $artifactFullPath -PathType Leaf)) {
        Throw-ReleaseError 'artifact_missing'
    }
    if (-not [IO.Path]::GetFileName($artifactFullPath).Equals(
            'EdizRemote.exe',
            [StringComparison]::OrdinalIgnoreCase)) {
        Throw-ReleaseError 'artifact_name_invalid'
    }

    $artifact = Get-Item -LiteralPath $artifactFullPath -Force
    if (($artifact.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        Throw-ReleaseError 'artifact_name_invalid'
    }
    return $artifactFullPath
}

function Assert-ManifestPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ArtifactFullPath,

        [Parameter(Mandatory = $true)]
        [string]$ManifestPath
    )

    $manifestFullPath = [IO.Path]::GetFullPath($ManifestPath)
    $artifactDirectory = [IO.Path]::GetDirectoryName($ArtifactFullPath)
    $manifestDirectory = [IO.Path]::GetDirectoryName($manifestFullPath)
    if (-not [string]::Equals(
            $artifactDirectory,
            $manifestDirectory,
            [StringComparison]::OrdinalIgnoreCase) -or
        -not [IO.Path]::GetFileName($manifestFullPath).Equals(
            'EdizRemote.release-manifest.json',
            [StringComparison]::OrdinalIgnoreCase)) {
        Throw-ReleaseError 'manifest_path_invalid'
    }
    Assert-LocalReleaseDirectory -DirectoryPath $manifestDirectory

    if (Test-Path -LiteralPath $manifestFullPath) {
        $manifest = Get-Item -LiteralPath $manifestFullPath -Force
        if (($manifest.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
            $manifest.PSIsContainer) {
            Throw-ReleaseError 'manifest_path_invalid'
        }
    }
    return $manifestFullPath
}

function Assert-LocalReleaseDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$DirectoryPath
    )

    $fullPath = [IO.Path]::GetFullPath($DirectoryPath)
    if ($fullPath.StartsWith('\\', [StringComparison]::Ordinal)) {
        Throw-ReleaseError 'release_path_invalid'
    }

    $current = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
    while ($null -ne $current) {
        if (-not $current.PSIsContainer -or
            ($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            Throw-ReleaseError 'release_path_invalid'
        }
        $parentPath = [IO.Path]::GetDirectoryName($current.FullName)
        if ([string]::IsNullOrEmpty($parentPath) -or
            [string]::Equals(
                $parentPath,
                $current.FullName,
                [StringComparison]::OrdinalIgnoreCase)) {
            break
        }
        $current = Get-Item -LiteralPath $parentPath -Force -ErrorAction Stop
    }
}

function Assert-WindowsCatalogPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ArtifactFullPath,

        [Parameter(Mandatory = $true)]
        [string]$CatalogPath,

        [switch]$RequireExisting
    )

    try {
        $artifactDirectory = [IO.Path]::GetDirectoryName(
            [IO.Path]::GetFullPath($ArtifactFullPath))
        $catalogFullPath = [IO.Path]::GetFullPath($CatalogPath)
        $catalogDirectory = [IO.Path]::GetDirectoryName($catalogFullPath)
        $expectedCatalogDirectory = [IO.Path]::GetDirectoryName($artifactDirectory)
    }
    catch {
        Throw-ReleaseError 'catalog_path_invalid'
    }

    if ([string]::IsNullOrWhiteSpace($catalogDirectory) -or
        -not [string]::Equals(
            $catalogDirectory,
            $expectedCatalogDirectory,
            [StringComparison]::OrdinalIgnoreCase) -or
        -not [IO.Path]::GetFileName($catalogFullPath).Equals(
            'EdizRemote.win-x64.cat',
            [StringComparison]::OrdinalIgnoreCase)) {
        Throw-ReleaseError 'catalog_path_invalid'
    }

    try {
        Assert-LocalReleaseDirectory -DirectoryPath $catalogDirectory
    }
    catch {
        Throw-ReleaseError 'catalog_path_invalid'
    }

    if (Test-Path -LiteralPath $catalogFullPath) {
        $catalog = Get-Item -LiteralPath $catalogFullPath -Force
        if ($catalog.PSIsContainer -or
            ($catalog.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            Throw-ReleaseError 'catalog_path_invalid'
        }
        if ([int64]$catalog.Length -le 0) {
            Throw-ReleaseError 'catalog_missing'
        }
        if ([int64]$catalog.Length -gt 16777216) {
            Throw-ReleaseError 'catalog_too_large'
        }
    }
    elseif ($RequireExisting) {
        Throw-ReleaseError 'catalog_missing'
    }

    return $catalogFullPath
}

function Get-WindowsReleaseTreeState {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ReleaseDirectory
    )

    try {
        Assert-LocalReleaseDirectory -DirectoryPath $ReleaseDirectory
        $root = [IO.Path]::GetFullPath($ReleaseDirectory)
        $rootPrefix = $root.TrimEnd(
            [IO.Path]::DirectorySeparatorChar,
            [IO.Path]::AltDirectorySeparatorChar) +
            [IO.Path]::DirectorySeparatorChar
        $pending = [Collections.Generic.Queue[string]]::new()
        $pending.Enqueue($root)
        $relativePaths = [Collections.Generic.List[string]]::new()
        $filePaths = [Collections.Generic.List[string]]::new()
        $directoryCount = 0
        $relativePathBytes = 0

        while ($pending.Count -gt 0) {
            $directory = $pending.Dequeue()
            $directoryCount += 1
            if ($directoryCount -gt 1024) {
                Throw-ReleaseError 'release_tree_too_large'
            }
            foreach ($entry in @(Get-ChildItem -LiteralPath $directory -Force |
                    Sort-Object -Property Name)) {
                if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                    Throw-ReleaseError 'release_tree_invalid'
                }
                $entryFullPath = [IO.Path]::GetFullPath($entry.FullName)
                if (-not $entryFullPath.StartsWith(
                        $rootPrefix,
                        [StringComparison]::OrdinalIgnoreCase)) {
                    Throw-ReleaseError 'release_tree_invalid'
                }
                $relativePath = $entryFullPath.Substring($rootPrefix.Length)
                if ([string]::IsNullOrWhiteSpace($relativePath) -or
                    [IO.Path]::IsPathRooted($relativePath) -or
                    $relativePath.StartsWith('..', [StringComparison]::Ordinal) -or
                    $relativePath.Length -gt 1024) {
                    Throw-ReleaseError 'release_tree_invalid'
                }
                $relativePathBytes += [Text.Encoding]::UTF8.GetByteCount($relativePath)
                if ($relativePathBytes -gt 1048576) {
                    Throw-ReleaseError 'release_tree_too_large'
                }
                if ($entry.PSIsContainer) {
                    $pending.Enqueue($entry.FullName)
                    continue
                }
                $relativePaths.Add($relativePath.Replace('/', '\'))
                $filePaths.Add($entry.FullName)
                if ($filePaths.Count -gt 8192) {
                    Throw-ReleaseError 'release_tree_too_large'
                }
            }
        }
        if ($filePaths.Count -eq 0) {
            Throw-ReleaseError 'release_tree_invalid'
        }

        $ordered = @($relativePaths | Sort-Object)
        $orderedFiles = [Collections.Generic.List[string]]::new()
        foreach ($relativePath in $ordered) {
            $orderedFiles.Add((Join-Path $root $relativePath))
        }
        return [PSCustomObject]@{
            Root = $root
            RelativePaths = [string[]]$ordered
            FilePaths = [string[]]$orderedFiles
            Fingerprint = [string]::Join("`n", $ordered)
        }
    }
    catch {
        if ($_.Exception.Message -in @(
                'release_tree_invalid',
                'release_tree_too_large')) {
            throw
        }
        Throw-ReleaseError 'release_tree_invalid'
    }
}

function Open-WindowsReleaseTreeLocks {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ReleaseDirectory
    )

    $locks = [Collections.Generic.List[IDisposable]]::new()
    try {
        $before = Get-WindowsReleaseTreeState -ReleaseDirectory $ReleaseDirectory
        foreach ($filePath in $before.FilePaths) {
            $locks.Add([IO.File]::Open(
                    $filePath,
                    [IO.FileMode]::Open,
                    [IO.FileAccess]::Read,
                    [IO.FileShare]::Read))
        }
        $after = Get-WindowsReleaseTreeState -ReleaseDirectory $ReleaseDirectory
        if (-not [string]::Equals(
                $before.Fingerprint,
                $after.Fingerprint,
                [StringComparison]::Ordinal)) {
            Throw-ReleaseError 'release_tree_changed'
        }
        return [PSCustomObject]@{
            State = $before
            Locks = $locks
        }
    }
    catch {
        foreach ($lock in $locks) { $lock.Dispose() }
        if ($_.Exception.Message -in @(
                'release_tree_invalid',
                'release_tree_too_large',
                'release_tree_changed')) {
            throw
        }
        Throw-ReleaseError 'release_tree_changed'
    }
}

function Close-WindowsReleaseTreeLocks {
    param(
        [AllowNull()]
        [object]$LockedTree
    )

    if ($null -eq $LockedTree) { return }
    foreach ($lock in @($LockedTree.Locks)) {
        if ($null -ne $lock) { $lock.Dispose() }
    }
}

function Get-FileSha256 {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $stream = $null
    $sha256 = $null
    try {
        $stream = [IO.File]::Open(
            $Path,
            [IO.FileMode]::Open,
            [IO.FileAccess]::Read,
            [IO.FileShare]::Read)
        $sha256 = [Security.Cryptography.SHA256]::Create()
        $hash = $sha256.ComputeHash($stream)
        return ([BitConverter]::ToString($hash)).Replace('-', '')
    }
    finally {
        if ($null -ne $sha256) { $sha256.Dispose() }
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function Assert-ExactProperties {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Value,

        [Parameter(Mandatory = $true)]
        [string[]]$Expected
    )

    if ($null -eq $Value) {
        Throw-ReleaseError 'manifest_schema_invalid'
    }
    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    $expectedSorted = @($Expected | Sort-Object)
    if ($actual.Count -ne $expectedSorted.Count) {
        Throw-ReleaseError 'manifest_schema_invalid'
    }
    for ($index = 0; $index -lt $actual.Count; $index += 1) {
        if (-not [string]::Equals(
                $actual[$index],
                $expectedSorted[$index],
                [StringComparison]::Ordinal)) {
            Throw-ReleaseError 'manifest_schema_invalid'
        }
    }
}

function Test-IsIntegralJsonNumber {
    param(
        [AllowNull()]
        [object]$Value
    )

    return $Value -is [byte] -or
        $Value -is [sbyte] -or
        $Value -is [int16] -or
        $Value -is [uint16] -or
        $Value -is [int32] -or
        $Value -is [uint32] -or
        $Value -is [int64] -or
        $Value -is [uint64]
}

function ConvertTo-WindowsReleaseVersion {
    param(
        [AllowNull()]
        [object]$Value
    )

    if ($Value -isnot [string] -or
        $Value -cnotmatch $script:ReleaseVersionPattern) {
        Throw-ReleaseError 'release_identity_invalid'
    }
    foreach ($part in $Value.Split('.')) {
        if ([int]$part -gt $script:ReleaseMaximumVersionPart) {
            Throw-ReleaseError 'release_identity_invalid'
        }
    }
    return [string]$Value
}

function ConvertTo-WindowsReleaseSequence {
    param(
        [AllowNull()]
        [object]$Value,

        [switch]$AllowDevelopment
    )

    if (Test-IsIntegralJsonNumber $Value) {
        $text = ([int64]$Value).ToString(
            [Globalization.CultureInfo]::InvariantCulture)
    }
    elseif ($Value -is [string]) {
        $text = $Value
    }
    else {
        Throw-ReleaseError 'release_sequence_invalid'
    }
    if ($text -cnotmatch $script:ReleaseSequencePattern) {
        Throw-ReleaseError 'release_sequence_invalid'
    }
    $sequence = [int]$text
    if ($sequence -gt $script:ReleaseMaximumSequence -or
        (-not $AllowDevelopment -and $sequence -lt 1)) {
        Throw-ReleaseError 'release_sequence_invalid'
    }
    return $sequence
}

function Get-WindowsReleaseIdentityFacts {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ArtifactPath
    )

    $artifactFullPath = Assert-ArtifactPath -ArtifactPath $ArtifactPath
    try {
        $info = [Diagnostics.FileVersionInfo]::GetVersionInfo($artifactFullPath)
    }
    catch {
        Throw-ReleaseError 'release_identity_invalid'
    }
    return [PSCustomObject]@{
        ProductVersion = [string]$info.ProductVersion
        FileVersion = [string]$info.FileVersion
        FileMajorPart = [int]$info.FileMajorPart
        FileMinorPart = [int]$info.FileMinorPart
        FileBuildPart = [int]$info.FileBuildPart
        FilePrivatePart = [int]$info.FilePrivatePart
    }
}

function ConvertTo-WindowsReleaseIdentity {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Facts
    )

    $productMatch = [regex]::Match(
        [string]$Facts.ProductVersion,
        '\A(?<version>[0-9.]{5,17})\+(?<revision>[0-9a-f]{40})(?<dirty>\.dirty)?\z')
    if (-not $productMatch.Success) {
        Throw-ReleaseError 'release_identity_invalid'
    }
    $version = ConvertTo-WindowsReleaseVersion `
        -Value $productMatch.Groups['version'].Value

    $fileVersion = [string]$Facts.FileVersion
    $fileVersionPrefix = $version + '.'
    if (-not $fileVersion.StartsWith(
            $fileVersionPrefix,
            [StringComparison]::Ordinal)) {
        Throw-ReleaseError 'release_identity_invalid'
    }
    try {
        $sequence = ConvertTo-WindowsReleaseSequence `
            -Value $fileVersion.Substring($fileVersionPrefix.Length) `
            -AllowDevelopment
    }
    catch {
        Throw-ReleaseError 'release_identity_invalid'
    }

    # Metin sürüm alanları ile VS_FIXEDFILEINFO sayısal alanları aynı kimliği
    # söylemiyorsa kaynak elle değiştirilmiş kabul edilir.
    $parts = $version.Split('.')
    if ([int]$Facts.FileMajorPart -ne [int]$parts[0] -or
        [int]$Facts.FileMinorPart -ne [int]$parts[1] -or
        [int]$Facts.FileBuildPart -ne [int]$parts[2] -or
        [int]$Facts.FilePrivatePart -ne $sequence) {
        Throw-ReleaseError 'release_identity_invalid'
    }

    return [PSCustomObject]@{
        Version = $version
        Sequence = $sequence
        SourceRevision = $productMatch.Groups['revision'].Value
        SourceTreeClean = -not $productMatch.Groups['dirty'].Success
    }
}

function Get-WindowsReleaseMinimumSequence {
    param(
        [AllowNull()]
        [System.Collections.IDictionary]$Environment
    )

    $value = Get-EnvironmentSetting `
        -Name 'EDIZ_REMOTE_RELEASE_MINIMUM_SEQUENCE' `
        -Environment $Environment
    if ([string]::IsNullOrWhiteSpace($value)) {
        Throw-ReleaseError 'release_floor_missing'
    }
    try {
        return ConvertTo-WindowsReleaseSequence -Value $value.Trim()
    }
    catch {
        Throw-ReleaseError 'release_floor_invalid'
    }
}

function Get-WindowsPublishReleaseSequence {
    param(
        [AllowNull()]
        [System.Collections.IDictionary]$Environment
    )

    $value = Get-EnvironmentSetting `
        -Name 'EDIZ_REMOTE_RELEASE_SEQUENCE' `
        -Environment $Environment
    if ([string]::IsNullOrWhiteSpace($value)) {
        return 0
    }
    return ConvertTo-WindowsReleaseSequence `
        -Value $value.Trim() `
        -AllowDevelopment
}

function Get-WindowsReleasePackageVersion {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepositoryRoot
    )

    try {
        $packagePath = Join-Path `
            ([IO.Path]::GetFullPath($RepositoryRoot)) `
            'package.json'
        $package = [IO.File]::ReadAllText(
            $packagePath,
            [Text.UTF8Encoding]::new($false, $true)) | ConvertFrom-Json
        $version = $package.version
    }
    catch {
        Throw-ReleaseError 'release_identity_invalid'
    }
    return ConvertTo-WindowsReleaseVersion -Value $version
}

function Get-WindowsReleaseSourceState {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepositoryRoot
    )

    # Windows PowerShell 5.1'de native stderr satırı Stop tercihinde terminating
    # hataya dönüşebilir; karar yalnız git çıkış koduna ve çıktısına dayanır.
    $ErrorActionPreference = 'Continue'
    try {
        $repositoryFullPath = [IO.Path]::GetFullPath($RepositoryRoot).TrimEnd(
            [IO.Path]::DirectorySeparatorChar,
            [IO.Path]::AltDirectorySeparatorChar)
        $topLevelOutput = @(& git -C $repositoryFullPath `
                rev-parse --show-toplevel 2>$null)
        if ($LASTEXITCODE -ne 0 -or $topLevelOutput.Count -ne 1) {
            Throw-ReleaseError 'source_state_unavailable'
        }
        $topLevel = [IO.Path]::GetFullPath(([string]$topLevelOutput[0]).Trim()).TrimEnd(
            [IO.Path]::DirectorySeparatorChar,
            [IO.Path]::AltDirectorySeparatorChar)
        if (-not [string]::Equals(
                $topLevel,
                $repositoryFullPath,
                [StringComparison]::OrdinalIgnoreCase)) {
            Throw-ReleaseError 'source_state_unavailable'
        }

        $revisionOutput = @(& git -C $repositoryFullPath `
                rev-parse --verify --quiet 'HEAD^{commit}' 2>$null)
        if ($LASTEXITCODE -ne 0 -or $revisionOutput.Count -ne 1) {
            Throw-ReleaseError 'source_state_unavailable'
        }
        $revision = ([string]$revisionOutput[0]).Trim()
        if ($revision -cnotmatch $script:ReleaseRevisionPattern) {
            Throw-ReleaseError 'source_state_unavailable'
        }

        # İzlenmeyen dosyalar da build girdisi olabilir (SDK glob, web import);
        # gitignore dışındaki her değişiklik ağacı kirli yapar.
        $statusOutput = @(& git -C $repositoryFullPath --no-optional-locks `
                status --porcelain=v1 --untracked-files=all `
                --ignore-submodules=none 2>$null)
        if ($LASTEXITCODE -ne 0) {
            Throw-ReleaseError 'source_state_unavailable'
        }
        $changes = @($statusOutput | Where-Object {
                -not [string]::IsNullOrWhiteSpace([string]$_)
            })
    }
    catch {
        Throw-ReleaseError 'source_state_unavailable'
    }
    return [PSCustomObject]@{
        Revision = $revision
        Clean = $changes.Count -eq 0
    }
}

function Get-WindowsPublishIdentityProperties {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Version,

        [Parameter(Mandatory = $true)]
        [object]$Sequence,

        [Parameter(Mandatory = $true)]
        [object]$SourceState
    )

    $releaseVersion = ConvertTo-WindowsReleaseVersion -Value $Version
    $releaseSequence = ConvertTo-WindowsReleaseSequence `
        -Value $Sequence `
        -AllowDevelopment
    $revision = [string]$SourceState.Revision
    if ($revision -cnotmatch $script:ReleaseRevisionPattern) {
        Throw-ReleaseError 'source_state_unavailable'
    }
    $metadata = $revision
    if (-not [bool]$SourceState.Clean) {
        $metadata += '.dirty'
    }
    return [string[]]@(
        "-p:Version=$releaseVersion",
        "-p:AssemblyVersion=$releaseVersion.0",
        "-p:FileVersion=$releaseVersion.$releaseSequence",
        "-p:InformationalVersion=$releaseVersion+$metadata",
        '-p:IncludeSourceRevisionInInformationalVersion=false'
    )
}

function Assert-WindowsReleaseSourceState {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Identity,

        [Parameter(Mandatory = $true)]
        [object]$SourceState,

        [Parameter(Mandatory = $true)]
        [string]$PackageVersion
    )

    if (-not [bool]$Identity.SourceTreeClean -or
        -not [bool]$SourceState.Clean) {
        Throw-ReleaseError 'provenance_dirty_source'
    }
    if ([string]$SourceState.Revision -cnotmatch $script:ReleaseRevisionPattern -or
        -not [string]::Equals(
            [string]$SourceState.Revision,
            [string]$Identity.SourceRevision,
            [StringComparison]::Ordinal)) {
        Throw-ReleaseError 'provenance_revision_mismatch'
    }
    if (-not [string]::Equals(
            $PackageVersion,
            [string]$Identity.Version,
            [StringComparison]::Ordinal)) {
        Throw-ReleaseError 'release_version_mismatch'
    }
    if ([int]$Identity.Sequence -lt 1) {
        Throw-ReleaseError 'release_sequence_invalid'
    }
}

function Assert-WindowsReleaseSigningProvenance {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ArtifactPath,

        [Parameter(Mandatory = $true)]
        [string]$RepositoryRoot,

        [AllowNull()]
        [System.Collections.IDictionary]$Environment
    )

    $minimumSequence = Get-WindowsReleaseMinimumSequence -Environment $Environment
    $identity = ConvertTo-WindowsReleaseIdentity `
        -Facts (Get-WindowsReleaseIdentityFacts -ArtifactPath $ArtifactPath)
    $sourceState = Get-WindowsReleaseSourceState -RepositoryRoot $RepositoryRoot
    $packageVersion = Get-WindowsReleasePackageVersion -RepositoryRoot $RepositoryRoot
    Assert-WindowsReleaseSourceState `
        -Identity $identity `
        -SourceState $sourceState `
        -PackageVersion $packageVersion
    if ($identity.Sequence -lt $minimumSequence) {
        Throw-ReleaseError 'release_rollback_rejected'
    }
    return $identity
}

function Assert-WindowsReleaseManifestObject {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Manifest
    )

    Assert-ExactProperties -Value $Manifest -Expected @(
        'schemaVersion',
        'product',
        'buildId',
        'release',
        'provenance',
        'artifact'
    )
    Assert-ExactProperties -Value $Manifest.release -Expected @(
        'version',
        'sequence'
    )
    Assert-ExactProperties -Value $Manifest.provenance -Expected @(
        'sourceRepository',
        'sourceRevision',
        'sourceTreeClean'
    )
    Assert-ExactProperties -Value $Manifest.artifact -Expected @(
        'fileName',
        'sizeBytes',
        'sha256'
    )

    if (-not (Test-IsIntegralJsonNumber $Manifest.schemaVersion) -or
        [int64]$Manifest.schemaVersion -ne 2 -or
        $Manifest.product -isnot [string] -or
        -not [string]::Equals(
            $Manifest.product,
            'Ediz Remote',
            [StringComparison]::Ordinal) -or
        $Manifest.buildId -isnot [string] -or
        $Manifest.buildId -notmatch '\A[A-Za-z0-9][A-Za-z0-9._@+:-]{0,127}\z') {
        Throw-ReleaseError 'manifest_build_invalid'
    }

    try {
        ConvertTo-WindowsReleaseVersion -Value $Manifest.release.version | Out-Null
        if (-not (Test-IsIntegralJsonNumber $Manifest.release.sequence)) {
            Throw-ReleaseError 'release_sequence_invalid'
        }
        ConvertTo-WindowsReleaseSequence `
            -Value $Manifest.release.sequence `
            -AllowDevelopment | Out-Null
    }
    catch {
        Throw-ReleaseError 'manifest_schema_invalid'
    }
    if ($Manifest.provenance.sourceRepository -isnot [string] -or
        -not [string]::Equals(
            $Manifest.provenance.sourceRepository,
            $script:ReleaseSourceRepository,
            [StringComparison]::Ordinal) -or
        $Manifest.provenance.sourceRevision -isnot [string] -or
        $Manifest.provenance.sourceRevision -cnotmatch
            $script:ReleaseRevisionPattern -or
        $Manifest.provenance.sourceTreeClean -isnot [bool]) {
        Throw-ReleaseError 'manifest_schema_invalid'
    }

    if ($Manifest.artifact.fileName -isnot [string] -or
        -not [string]::Equals(
            $Manifest.artifact.fileName,
            'EdizRemote.exe',
            [StringComparison]::Ordinal) -or
        -not (Test-IsIntegralJsonNumber $Manifest.artifact.sizeBytes) -or
        [int64]$Manifest.artifact.sizeBytes -le 0 -or
        $Manifest.artifact.sha256 -isnot [string] -or
        $Manifest.artifact.sha256 -cnotmatch '\A[A-F0-9]{64}\z') {
        Throw-ReleaseError 'manifest_schema_invalid'
    }
}

function Write-WindowsReleaseManifest {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ArtifactPath,

        [Parameter(Mandatory = $true)]
        [string]$ManifestPath,

        [Parameter(Mandatory = $true)]
        [string]$BuildId
    )

    $artifactFullPath = Assert-ArtifactPath -ArtifactPath $ArtifactPath
    $manifestFullPath = Assert-ManifestPath `
        -ArtifactFullPath $artifactFullPath `
        -ManifestPath $ManifestPath
    $identity = ConvertTo-WindowsReleaseIdentity `
        -Facts (Get-WindowsReleaseIdentityFacts -ArtifactPath $artifactFullPath)
    $artifact = Get-Item -LiteralPath $artifactFullPath -Force
    $manifest = [ordered]@{
        schemaVersion = 2
        product = 'Ediz Remote'
        buildId = $BuildId
        release = [ordered]@{
            version = $identity.Version
            sequence = [int]$identity.Sequence
        }
        provenance = [ordered]@{
            sourceRepository = $script:ReleaseSourceRepository
            sourceRevision = $identity.SourceRevision
            sourceTreeClean = [bool]$identity.SourceTreeClean
        }
        artifact = [ordered]@{
            fileName = 'EdizRemote.exe'
            sizeBytes = [int64]$artifact.Length
            sha256 = Get-FileSha256 -Path $artifactFullPath
        }
    }
    Assert-WindowsReleaseManifestObject -Manifest (
        $manifest | ConvertTo-Json -Depth 4 | ConvertFrom-Json)

    $json = ($manifest | ConvertTo-Json -Depth 4) + "`n"
    $temporaryPath = Join-Path `
        ([IO.Path]::GetDirectoryName($manifestFullPath)) `
        ('.EdizRemote.release-manifest.{0}.tmp' -f [guid]::NewGuid().ToString('N'))
    try {
        [IO.File]::WriteAllText(
            $temporaryPath,
            $json,
            [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporaryPath -Destination $manifestFullPath -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporaryPath) {
            Remove-Item -LiteralPath $temporaryPath -Force
        }
    }
    return $manifest
}

function Read-WindowsReleaseManifest {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ArtifactPath,

        [Parameter(Mandatory = $true)]
        [string]$ManifestPath
    )

    $artifactFullPath = Assert-ArtifactPath -ArtifactPath $ArtifactPath
    $manifestFullPath = Assert-ManifestPath `
        -ArtifactFullPath $artifactFullPath `
        -ManifestPath $ManifestPath
    if (-not (Test-Path -LiteralPath $manifestFullPath -PathType Leaf)) {
        Throw-ReleaseError 'manifest_invalid'
    }
    try {
        $stream = $null
        $bytes = $null
        try {
            $stream = [IO.File]::Open(
                $manifestFullPath,
                [IO.FileMode]::Open,
                [IO.FileAccess]::Read,
                [IO.FileShare]::Read)
            if ($stream.Length -gt 16384) {
                Throw-ReleaseError 'manifest_too_large'
            }
            $bytes = [byte[]]::new(16385)
            $total = 0
            while ($total -lt $bytes.Length) {
                $read = $stream.Read($bytes, $total, $bytes.Length - $total)
                if ($read -eq 0) { break }
                $total += $read
            }
            if ($total -gt 16384) {
                Throw-ReleaseError 'manifest_too_large'
            }
            $utf8 = [Text.UTF8Encoding]::new($false, $true)
            $json = $utf8.GetString($bytes, 0, $total)
            $manifest = $json | ConvertFrom-Json
        }
        finally {
            if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
            if ($null -ne $stream) { $stream.Dispose() }
        }
    }
    catch {
        if ($_.Exception.Message -eq 'manifest_too_large') { throw }
        Throw-ReleaseError 'manifest_invalid'
    }
    Assert-WindowsReleaseManifestObject -Manifest $manifest
    return $manifest
}

function Assert-WindowsArtifactMatchesManifest {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ArtifactPath,

        [Parameter(Mandatory = $true)]
        [object]$Manifest
    )

    $artifactFullPath = Assert-ArtifactPath -ArtifactPath $ArtifactPath
    Assert-WindowsReleaseManifestObject -Manifest $Manifest
    $artifact = Get-Item -LiteralPath $artifactFullPath -Force
    if ([int64]$artifact.Length -ne [int64]$Manifest.artifact.sizeBytes) {
        Throw-ReleaseError 'artifact_size_mismatch'
    }
    $actualHash = Get-FileSha256 -Path $artifactFullPath
    if (-not [string]::Equals(
            $actualHash,
            [string]$Manifest.artifact.sha256,
            [StringComparison]::Ordinal)) {
        Throw-ReleaseError 'artifact_hash_mismatch'
    }
}

function Assert-WindowsReleaseIdentityMatchesManifest {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Identity,

        [Parameter(Mandatory = $true)]
        [object]$Manifest
    )

    Assert-WindowsReleaseManifestObject -Manifest $Manifest
    if (-not [string]::Equals(
            [string]$Identity.Version,
            [string]$Manifest.release.version,
            [StringComparison]::Ordinal) -or
        [int64]$Identity.Sequence -ne [int64]$Manifest.release.sequence -or
        -not [string]::Equals(
            [string]$Identity.SourceRevision,
            [string]$Manifest.provenance.sourceRevision,
            [StringComparison]::Ordinal) -or
        [bool]$Identity.SourceTreeClean -ne
            [bool]$Manifest.provenance.sourceTreeClean) {
        Throw-ReleaseError 'release_identity_mismatch'
    }
}

function Assert-WindowsReleaseAntiRollbackPolicy {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Manifest,

        [Parameter(Mandatory = $true)]
        [int]$MinimumSequence
    )

    Assert-WindowsReleaseManifestObject -Manifest $Manifest
    if ($MinimumSequence -lt 1 -or
        $MinimumSequence -gt $script:ReleaseMaximumSequence) {
        Throw-ReleaseError 'release_floor_invalid'
    }
    if (-not [bool]$Manifest.provenance.sourceTreeClean) {
        Throw-ReleaseError 'provenance_dirty_source'
    }
    $sequence = [int64]$Manifest.release.sequence
    if ($sequence -lt 1) {
        Throw-ReleaseError 'release_sequence_invalid'
    }
    if ($sequence -lt $MinimumSequence) {
        Throw-ReleaseError 'release_rollback_rejected'
    }
}

function Get-CertificateSha256 {
    param(
        [Parameter(Mandatory = $true)]
        [Security.Cryptography.X509Certificates.X509Certificate2]$Certificate
    )

    $sha256 = $null
    try {
        $sha256 = [Security.Cryptography.SHA256]::Create()
        $hash = $sha256.ComputeHash($Certificate.RawData)
        return ([BitConverter]::ToString($hash)).Replace('-', '')
    }
    finally {
        if ($null -ne $sha256) { $sha256.Dispose() }
    }
}

function Get-WindowsFileAuthenticodeFacts {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath
    )

    try {
        $signature = Get-AuthenticodeSignature -LiteralPath $FilePath
    }
    catch {
        Throw-ReleaseError 'signature_invalid'
    }

    $signatureType = ''
    if ($null -ne $signature.PSObject.Properties['SignatureType']) {
        $signatureType = [string]$signature.SignatureType
    }
    $signerSha256 = $null
    if ($null -ne $signature.SignerCertificate) {
        $signerSha256 = Get-CertificateSha256 `
            -Certificate $signature.SignerCertificate
    }
    $timestampSha256 = $null
    if ($null -ne $signature.TimeStamperCertificate) {
        $timestampSha256 = Get-CertificateSha256 `
            -Certificate $signature.TimeStamperCertificate
    }

    return [PSCustomObject]@{
        Status = [string]$signature.Status
        SignatureType = $signatureType
        SignerCertificateSha256 = $signerSha256
        TimestampCertificateSha256 = $timestampSha256
        HasTimestamp = $null -ne $signature.TimeStamperCertificate
    }
}

function Get-WindowsAuthenticodeFacts {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ArtifactPath
    )

    $artifactFullPath = Assert-ArtifactPath -ArtifactPath $ArtifactPath
    return Get-WindowsFileAuthenticodeFacts -FilePath $artifactFullPath
}

function Get-WindowsCatalogAuthenticodeFacts {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ArtifactPath,

        [Parameter(Mandatory = $true)]
        [string]$CatalogPath
    )

    $artifactFullPath = Assert-ArtifactPath -ArtifactPath $ArtifactPath
    $catalogFullPath = Assert-WindowsCatalogPath `
        -ArtifactFullPath $artifactFullPath `
        -CatalogPath $CatalogPath `
        -RequireExisting
    return Get-WindowsFileAuthenticodeFacts -FilePath $catalogFullPath
}

function Assert-WindowsSignatureFacts {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Facts,

        [Parameter(Mandatory = $true)]
        [string]$ExpectedSignerSha256,

        [Parameter(Mandatory = $true)]
        [int]$SignToolExitCode
    )

    if ($ExpectedSignerSha256 -cnotmatch '\A[A-F0-9]{64}\z') {
        Throw-ReleaseError 'expected_signer_invalid'
    }
    if ($SignToolExitCode -ne 0) {
        Throw-ReleaseError 'signtool_verify_failed'
    }
    if (-not [string]::Equals(
            [string]$Facts.Status,
            'Valid',
            [StringComparison]::Ordinal)) {
        Throw-ReleaseError 'signature_invalid'
    }
    if (-not [string]::Equals(
            [string]$Facts.SignatureType,
            'Authenticode',
            [StringComparison]::Ordinal)) {
        Throw-ReleaseError 'signature_type_invalid'
    }
    if ([string]::IsNullOrWhiteSpace(
            [string]$Facts.SignerCertificateSha256)) {
        Throw-ReleaseError 'signer_missing'
    }
    if (-not [string]::Equals(
            [string]$Facts.SignerCertificateSha256,
            $ExpectedSignerSha256,
            [StringComparison]::Ordinal)) {
        Throw-ReleaseError 'signer_mismatch'
    }
    if (-not [bool]$Facts.HasTimestamp) {
        Throw-ReleaseError 'timestamp_missing'
    }
    if ([string]$Facts.TimestampCertificateSha256 -cnotmatch
        '\A[A-F0-9]{64}\z') {
        Throw-ReleaseError 'timestamp_invalid'
    }
}

function Assert-WindowsCatalogValidationFacts {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Facts
    )

    $status = if ($null -ne $Facts.PSObject.Properties['Status']) {
        [string]$Facts.Status
    }
    else {
        [string]$Facts
    }
    if (-not [string]::Equals(
            $status,
            'Valid',
            [StringComparison]::Ordinal)) {
        Throw-ReleaseError 'catalog_validation_failed'
    }

    if ($null -eq $Facts.PSObject.Properties['HashAlgorithm'] -or
        -not [string]::Equals(
            [string]$Facts.HashAlgorithm,
            'SHA256',
            [StringComparison]::OrdinalIgnoreCase)) {
        Throw-ReleaseError 'catalog_hash_algorithm_invalid'
    }
}

function Assert-WindowsReleaseGatePolicy {
    param(
        [Parameter(Mandatory = $true)]
        [object]$ArtifactSignatureFacts,

        [Parameter(Mandatory = $true)]
        [object]$CatalogSignatureFacts,

        [Parameter(Mandatory = $true)]
        [object]$CatalogValidationFacts,

        [Parameter(Mandatory = $true)]
        [string]$ExpectedSignerSha256,

        [Parameter(Mandatory = $true)]
        [int]$ArtifactSignToolExitCode,

        [Parameter(Mandatory = $true)]
        [int]$CatalogSignToolExitCode
    )

    Assert-WindowsSignatureFacts `
        -Facts $ArtifactSignatureFacts `
        -ExpectedSignerSha256 $ExpectedSignerSha256 `
        -SignToolExitCode $ArtifactSignToolExitCode
    Assert-WindowsSignatureFacts `
        -Facts $CatalogSignatureFacts `
        -ExpectedSignerSha256 $ExpectedSignerSha256 `
        -SignToolExitCode $CatalogSignToolExitCode
    Assert-WindowsCatalogValidationFacts -Facts $CatalogValidationFacts
}

function Get-ExpectedSignerSha256 {
    param(
        [AllowNull()]
        [System.Collections.IDictionary]$Environment
    )

    $value = Get-EnvironmentSetting `
        -Name 'EDIZ_REMOTE_RELEASE_SIGNER_SHA256' `
        -Environment $Environment
    if ([string]::IsNullOrWhiteSpace($value)) {
        Throw-ReleaseError 'expected_signer_missing'
    }
    $normalized = $value.Trim().ToUpperInvariant()
    if ($normalized -cnotmatch '\A[A-F0-9]{64}\z') {
        Throw-ReleaseError 'expected_signer_invalid'
    }
    return $normalized
}

function Get-WindowsSigningConfiguration {
    param(
        [AllowNull()]
        [System.Collections.IDictionary]$Environment
    )

    foreach ($forbiddenName in @(
            'EDIZ_REMOTE_SIGNING_PFX_PATH',
            'EDIZ_REMOTE_SIGNING_PFX_PASSWORD',
            'EDIZ_REMOTE_SIGNING_CERTIFICATE_PASSWORD',
            'EDIZ_REMOTE_SIGNING_PASSWORD')) {
        $forbiddenValue = Get-EnvironmentSetting `
            -Name $forbiddenName `
            -Environment $Environment
        if (-not [string]::IsNullOrWhiteSpace($forbiddenValue)) {
            Throw-ReleaseError 'unsafe_private_key_configuration'
        }
    }

    $certificateSha1 = Get-EnvironmentSetting `
        -Name 'EDIZ_REMOTE_SIGNING_CERT_SHA1' `
        -Environment $Environment
    if ([string]::IsNullOrWhiteSpace($certificateSha1)) {
        Throw-ReleaseError 'signing_certificate_missing'
    }
    $certificateSha1 = $certificateSha1.Trim().ToUpperInvariant()
    if ($certificateSha1 -cnotmatch '\A[A-F0-9]{40}\z') {
        Throw-ReleaseError 'signing_certificate_invalid'
    }

    $timestampUrlText = Get-EnvironmentSetting `
        -Name 'EDIZ_REMOTE_SIGNING_TIMESTAMP_URL' `
        -Environment $Environment
    $timestampUrl = $null
    if ([string]::IsNullOrWhiteSpace($timestampUrlText) -or
        -not [Uri]::TryCreate(
            $timestampUrlText,
            [UriKind]::Absolute,
            [ref]$timestampUrl) -or
        -not [string]::Equals(
            $timestampUrl.Scheme,
            'https',
            [StringComparison]::OrdinalIgnoreCase) -or
        [string]::IsNullOrWhiteSpace($timestampUrl.Host) -or
        -not [string]::IsNullOrEmpty($timestampUrl.UserInfo) -or
        -not [string]::IsNullOrEmpty($timestampUrl.Query) -or
        -not [string]::IsNullOrEmpty($timestampUrl.Fragment)) {
        Throw-ReleaseError 'timestamp_url_invalid'
    }

    $store = Get-EnvironmentSetting `
        -Name 'EDIZ_REMOTE_SIGNING_CERT_STORE' `
        -Environment $Environment
    if ([string]::IsNullOrWhiteSpace($store)) {
        $store = 'CurrentUser'
    }
    if ($store -notin @('CurrentUser', 'LocalMachine')) {
        Throw-ReleaseError 'certificate_store_invalid'
    }

    return [PSCustomObject]@{
        CertificateSha1 = $certificateSha1
        TimestampUrl = $timestampUrl.AbsoluteUri
        Store = $store
    }
}

function Resolve-SignToolPath {
    param(
        [AllowNull()]
        [System.Collections.IDictionary]$Environment
    )

    $configuredPath = Get-EnvironmentSetting `
        -Name 'EDIZ_REMOTE_SIGNTOOL_PATH' `
        -Environment $Environment
    $candidatePath = $null
    if (-not [string]::IsNullOrWhiteSpace($configuredPath)) {
        try {
            $candidatePath = [IO.Path]::GetFullPath($configuredPath)
        }
        catch {
            Throw-ReleaseError 'signtool_missing'
        }
    }
    else {
        $command = Get-Command 'signtool.exe' -CommandType Application `
            -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -eq $command) {
            Throw-ReleaseError 'signtool_missing'
        }
        $candidatePath = [IO.Path]::GetFullPath($command.Source)
    }

    try {
        if ($candidatePath.StartsWith('\\', [StringComparison]::Ordinal) -or
            -not [IO.Path]::GetFileName($candidatePath).Equals(
                'signtool.exe',
                [StringComparison]::OrdinalIgnoreCase) -or
            -not (Test-Path -LiteralPath $candidatePath -PathType Leaf)) {
            Throw-ReleaseError 'signtool_missing'
        }
        $tool = Get-Item -LiteralPath $candidatePath -Force
        if ($tool.PSIsContainer -or
            ($tool.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            Throw-ReleaseError 'signtool_missing'
        }
        Assert-LocalReleaseDirectory `
            -DirectoryPath ([IO.Path]::GetDirectoryName($candidatePath))
    }
    catch {
        Throw-ReleaseError 'signtool_missing'
    }
    return $candidatePath
}

function Invoke-SignToolProcess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SignToolPath,

        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $toolLock = $null
    try {
        $toolLock = [IO.File]::Open(
            $SignToolPath,
            [IO.FileMode]::Open,
            [IO.FileAccess]::Read,
            [IO.FileShare]::Read)
        & $SignToolPath @Arguments 2>&1 | Out-Null
        return [int]$LASTEXITCODE
    }
    catch {
        return 1
    }
    finally {
        if ($null -ne $toolLock) { $toolLock.Dispose() }
    }
}

function Get-WindowsSignToolSigningArguments {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [Parameter(Mandatory = $true)]
        [object]$Configuration
    )

    $arguments = @(
        'sign',
        '/fd',
        'SHA256',
        '/sha1',
        [string]$Configuration.CertificateSha1,
        '/s',
        'My'
    )
    if ([string]$Configuration.Store -eq 'LocalMachine') {
        $arguments += '/sm'
    }
    $arguments += @(
        '/tr',
        [string]$Configuration.TimestampUrl,
        '/td',
        'SHA256',
        $FilePath
    )
    return [string[]]$arguments
}

function Get-WindowsSignToolVerificationArguments {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath
    )

    return [string[]]@('verify', '/pa', '/all', '/v', '/tw', $FilePath)
}

function Invoke-WindowsFileStoreSigning {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [AllowNull()]
        [System.Collections.IDictionary]$Environment
    )

    $configuration = Get-WindowsSigningConfiguration -Environment $Environment
    $signToolPath = Resolve-SignToolPath -Environment $Environment
    $arguments = Get-WindowsSignToolSigningArguments `
        -FilePath $FilePath `
        -Configuration $configuration
    $exitCode = Invoke-SignToolProcess `
        -SignToolPath $signToolPath `
        -Arguments $arguments
    if ($exitCode -ne 0) {
        Throw-ReleaseError 'signing_failed'
    }
}

function Invoke-WindowsStoreSigning {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ArtifactPath,

        [AllowNull()]
        [System.Collections.IDictionary]$Environment
    )

    $artifactFullPath = Assert-ArtifactPath -ArtifactPath $ArtifactPath
    Invoke-WindowsFileStoreSigning `
        -FilePath $artifactFullPath `
        -Environment $Environment
}

function Invoke-WindowsCatalogStoreSigning {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ArtifactPath,

        [Parameter(Mandatory = $true)]
        [string]$CatalogPath,

        [AllowNull()]
        [System.Collections.IDictionary]$Environment
    )

    $artifactFullPath = Assert-ArtifactPath -ArtifactPath $ArtifactPath
    $catalogFullPath = Assert-WindowsCatalogPath `
        -ArtifactFullPath $artifactFullPath `
        -CatalogPath $CatalogPath `
        -RequireExisting
    $releaseDirectory = [IO.Path]::GetDirectoryName($artifactFullPath)
    $lockedTree = $null
    try {
        $lockedTree = Open-WindowsReleaseTreeLocks `
            -ReleaseDirectory $releaseDirectory
        $before = Invoke-WindowsFileCatalogValidation `
            -ReleaseDirectory $releaseDirectory `
            -CatalogPath $catalogFullPath
        Assert-WindowsCatalogValidationFacts -Facts $before

        Invoke-WindowsFileStoreSigning `
            -FilePath $catalogFullPath `
            -Environment $Environment

        $after = Invoke-WindowsFileCatalogValidation `
            -ReleaseDirectory $releaseDirectory `
            -CatalogPath $catalogFullPath
        Assert-WindowsCatalogValidationFacts -Facts $after
        $afterTree = Get-WindowsReleaseTreeState `
            -ReleaseDirectory $releaseDirectory
        if (-not [string]::Equals(
                $lockedTree.State.Fingerprint,
                $afterTree.Fingerprint,
                [StringComparison]::Ordinal)) {
            Throw-ReleaseError 'release_tree_changed'
        }
    }
    finally {
        Close-WindowsReleaseTreeLocks -LockedTree $lockedTree
    }
}

function Invoke-WindowsFileCatalogValidation {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ReleaseDirectory,

        [Parameter(Mandatory = $true)]
        [string]$CatalogPath
    )

    try {
        return Test-FileCatalog `
            -Path $ReleaseDirectory `
            -CatalogFilePath $CatalogPath `
            -Detailed `
            -Confirm:$false `
            -WarningAction SilentlyContinue `
            -ErrorAction Stop
    }
    catch {
        Throw-ReleaseError 'catalog_validation_failed'
    }
}

function New-WindowsReleaseCatalog {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ArtifactPath,

        [Parameter(Mandatory = $true)]
        [string]$ManifestPath,

        [Parameter(Mandatory = $true)]
        [string]$CatalogPath
    )

    $artifactFullPath = Assert-ArtifactPath -ArtifactPath $ArtifactPath
    $manifestFullPath = Assert-ManifestPath `
        -ArtifactFullPath $artifactFullPath `
        -ManifestPath $ManifestPath
    if (-not (Test-Path -LiteralPath $manifestFullPath -PathType Leaf)) {
        Throw-ReleaseError 'manifest_invalid'
    }
    $catalogFullPath = Assert-WindowsCatalogPath `
        -ArtifactFullPath $artifactFullPath `
        -CatalogPath $CatalogPath
    $releaseDirectory = [IO.Path]::GetDirectoryName($artifactFullPath)
    $temporaryPath = Join-Path `
        ([IO.Path]::GetDirectoryName($catalogFullPath)) `
        ('.EdizRemote.win-x64.{0}.tmp.cat' -f [guid]::NewGuid().ToString('N'))
    $lockedTree = $null
    try {
        $lockedTree = Open-WindowsReleaseTreeLocks `
            -ReleaseDirectory $releaseDirectory
        if (-not ($lockedTree.State.RelativePaths -ccontains 'EdizRemote.exe') -or
            -not ($lockedTree.State.RelativePaths -ccontains
                'EdizRemote.release-manifest.json')) {
            Throw-ReleaseError 'release_tree_invalid'
        }

        try {
            New-FileCatalog `
                -Path $releaseDirectory `
                -CatalogFilePath $temporaryPath `
                -CatalogVersion 2.0 `
                -Confirm:$false `
                -ErrorAction Stop | Out-Null
        }
        catch {
            Throw-ReleaseError 'catalog_creation_failed'
        }

        if (-not (Test-Path -LiteralPath $temporaryPath -PathType Leaf)) {
            Throw-ReleaseError 'catalog_creation_failed'
        }
        $temporaryCatalog = Get-Item -LiteralPath $temporaryPath -Force
        if (($temporaryCatalog.Attributes -band
                [IO.FileAttributes]::ReparsePoint) -ne 0 -or
            [int64]$temporaryCatalog.Length -le 0) {
            Throw-ReleaseError 'catalog_creation_failed'
        }
        if ([int64]$temporaryCatalog.Length -gt 16777216) {
            Throw-ReleaseError 'catalog_too_large'
        }

        $catalogFacts = Invoke-WindowsFileCatalogValidation `
            -ReleaseDirectory $releaseDirectory `
            -CatalogPath $temporaryPath
        Assert-WindowsCatalogValidationFacts -Facts $catalogFacts

        $after = Get-WindowsReleaseTreeState `
            -ReleaseDirectory $releaseDirectory
        if (-not [string]::Equals(
                $lockedTree.State.Fingerprint,
                $after.Fingerprint,
                [StringComparison]::Ordinal)) {
            Throw-ReleaseError 'release_tree_changed'
        }

        Move-Item `
            -LiteralPath $temporaryPath `
            -Destination $catalogFullPath `
            -Force
        Assert-WindowsCatalogPath `
            -ArtifactFullPath $artifactFullPath `
            -CatalogPath $catalogFullPath `
            -RequireExisting | Out-Null
    }
    finally {
        Close-WindowsReleaseTreeLocks -LockedTree $lockedTree
        if (Test-Path -LiteralPath $temporaryPath) {
            Remove-Item -LiteralPath $temporaryPath -Force
        }
    }
}

function Invoke-WindowsReleaseGate {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ArtifactPath,

        [Parameter(Mandatory = $true)]
        [string]$ManifestPath,

        [Parameter(Mandatory = $true)]
        [string]$CatalogPath,

        [AllowNull()]
        [System.Collections.IDictionary]$Environment
    )

    $artifactFullPath = Assert-ArtifactPath -ArtifactPath $ArtifactPath
    $manifestFullPath = Assert-ManifestPath `
        -ArtifactFullPath $artifactFullPath `
        -ManifestPath $ManifestPath
    $catalogFullPath = Assert-WindowsCatalogPath `
        -ArtifactFullPath $artifactFullPath `
        -CatalogPath $CatalogPath `
        -RequireExisting
    $releaseDirectory = [IO.Path]::GetDirectoryName($artifactFullPath)
    $lockedTree = $null
    $catalogLock = $null
    try {
        $lockedTree = Open-WindowsReleaseTreeLocks `
            -ReleaseDirectory $releaseDirectory
        $catalogLock = [IO.File]::Open(
            $catalogFullPath,
            [IO.FileMode]::Open,
            [IO.FileAccess]::Read,
            [IO.FileShare]::Read)
        if (-not ($lockedTree.State.RelativePaths -ccontains 'EdizRemote.exe') -or
            -not ($lockedTree.State.RelativePaths -ccontains
                'EdizRemote.release-manifest.json')) {
            Throw-ReleaseError 'release_tree_invalid'
        }

        $manifest = Read-WindowsReleaseManifest `
            -ArtifactPath $artifactFullPath `
            -ManifestPath $manifestFullPath
        Assert-WindowsArtifactMatchesManifest `
            -ArtifactPath $artifactFullPath `
            -Manifest $manifest
        $identity = ConvertTo-WindowsReleaseIdentity `
            -Facts (Get-WindowsReleaseIdentityFacts -ArtifactPath $artifactFullPath)
        Assert-WindowsReleaseIdentityMatchesManifest `
            -Identity $identity `
            -Manifest $manifest
        Assert-WindowsReleaseAntiRollbackPolicy `
            -Manifest $manifest `
            -MinimumSequence (Get-WindowsReleaseMinimumSequence -Environment $Environment)

        $artifactFacts = Get-WindowsAuthenticodeFacts `
            -ArtifactPath $artifactFullPath
        $catalogFacts = Get-WindowsCatalogAuthenticodeFacts `
            -ArtifactPath $artifactFullPath `
            -CatalogPath $catalogFullPath
        $expectedSignerSha256 = Get-ExpectedSignerSha256 -Environment $Environment
        $signToolPath = Resolve-SignToolPath -Environment $Environment
        $artifactSignToolExitCode = Invoke-SignToolProcess `
            -SignToolPath $signToolPath `
            -Arguments (Get-WindowsSignToolVerificationArguments `
                -FilePath $artifactFullPath)
        $catalogSignToolExitCode = Invoke-SignToolProcess `
            -SignToolPath $signToolPath `
            -Arguments (Get-WindowsSignToolVerificationArguments `
                -FilePath $catalogFullPath)
        $catalogValidationFacts = Invoke-WindowsFileCatalogValidation `
            -ReleaseDirectory $releaseDirectory `
            -CatalogPath $catalogFullPath
        Assert-WindowsReleaseGatePolicy `
            -ArtifactSignatureFacts $artifactFacts `
            -CatalogSignatureFacts $catalogFacts `
            -CatalogValidationFacts $catalogValidationFacts `
            -ExpectedSignerSha256 $expectedSignerSha256 `
            -ArtifactSignToolExitCode $artifactSignToolExitCode `
            -CatalogSignToolExitCode $catalogSignToolExitCode
        Assert-WindowsArtifactMatchesManifest `
            -ArtifactPath $artifactFullPath `
            -Manifest $manifest
        $after = Get-WindowsReleaseTreeState `
            -ReleaseDirectory $releaseDirectory
        if (-not [string]::Equals(
                $lockedTree.State.Fingerprint,
                $after.Fingerprint,
                [StringComparison]::Ordinal)) {
            Throw-ReleaseError 'release_tree_changed'
        }
    }
    finally {
        if ($null -ne $catalogLock) { $catalogLock.Dispose() }
        Close-WindowsReleaseTreeLocks -LockedTree $lockedTree
    }
}

Export-ModuleMember -Function @(
    'Get-WindowsReleaseErrorCode',
    'ConvertTo-WindowsReleaseVersion',
    'ConvertTo-WindowsReleaseSequence',
    'Get-WindowsReleaseIdentityFacts',
    'ConvertTo-WindowsReleaseIdentity',
    'Get-WindowsReleaseMinimumSequence',
    'Get-WindowsPublishReleaseSequence',
    'Get-WindowsReleasePackageVersion',
    'Get-WindowsReleaseSourceState',
    'Get-WindowsPublishIdentityProperties',
    'Assert-WindowsReleaseSourceState',
    'Assert-WindowsReleaseSigningProvenance',
    'Assert-WindowsReleaseIdentityMatchesManifest',
    'Assert-WindowsReleaseAntiRollbackPolicy',
    'Write-WindowsReleaseManifest',
    'Read-WindowsReleaseManifest',
    'Assert-WindowsReleaseManifestObject',
    'Assert-WindowsArtifactMatchesManifest',
    'Assert-WindowsSignatureFacts',
    'Assert-WindowsCatalogValidationFacts',
    'Assert-WindowsReleaseGatePolicy',
    'Get-ExpectedSignerSha256',
    'Get-WindowsSigningConfiguration',
    'Get-WindowsSignToolSigningArguments',
    'Get-WindowsSignToolVerificationArguments',
    'Invoke-WindowsStoreSigning',
    'Invoke-WindowsCatalogStoreSigning',
    'New-WindowsReleaseCatalog',
    'Invoke-WindowsReleaseGate'
)

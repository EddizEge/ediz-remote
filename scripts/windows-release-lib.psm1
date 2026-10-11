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
    'provenance_path_invalid',
    'provenance_manifest_invalid',
    'provenance_manifest_too_large',
    'provenance_mode_conflict',
    'provenance_tree_mismatch',
    'provenance_checksums_invalid',
    'provenance_tool_missing',
    'provenance_attestation_invalid',
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

# Provenance (GitHub attestation) modu: imzasız yayın ağacının bütünlüğü ayrı,
# açık şemalı bir manifest + SHA256SUMS ile ve GitHub'da derlendiği Sigstore
# SLSA build provenance attestation'ıyla doğrulanır. Doğrulama politikası
# manifestten okunmaz; aşağıdaki sabitlerdir.
$script:ProvenanceSchemaVersion = 1
$script:ProvenanceIntegrityMode = 'github-attestation'
$script:ProvenanceRepository = 'EddizEge/ediz-remote'
$script:ProvenanceSignerWorkflow =
    'EddizEge/ediz-remote/.github/workflows/windows-release.yml'
$script:ProvenanceSignerWorkflowUri =
    'https://github.com/EddizEge/ediz-remote/.github/workflows/windows-release.yml@refs/heads/main'
$script:ProvenanceSourceRef = 'refs/heads/main'
$script:ProvenancePredicateType = 'https://slsa.dev/provenance/v1'
$script:ProvenanceOidcIssuer = 'https://token.actions.githubusercontent.com'
$script:ProvenanceTreeRoot = 'win-x64'
$script:ProvenanceManifestFileName = 'EdizRemote.win-x64.provenance.json'
$script:ProvenanceChecksumsFileName = 'EdizRemote.win-x64.SHA256SUMS'
$script:ProvenanceMaximumBytes = 4194304
$script:ProvenanceMaximumAttestationOutputChars = 33554432

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

function Test-ExactString {
    param(
        [AllowNull()]
        [object]$Value,

        [Parameter(Mandatory = $true)]
        [string]$Expected,

        [switch]$IgnoreCase
    )

    $comparison = [StringComparison]::Ordinal
    if ($IgnoreCase) {
        $comparison = [StringComparison]::OrdinalIgnoreCase
    }
    return $Value -is [string] -and
        [string]::Equals([string]$Value, $Expected, $comparison)
}

function Assert-WindowsProvenanceFilePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ArtifactFullPath,

        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$FileName
    )

    # Provenance çıktıları katalog gibi yayın ağacının dışında, `win-x64`
    # klasörünün kardeşidir; böylece manifest kendi özetini kapsamaz.
    try {
        $releaseDirectory = [IO.Path]::GetDirectoryName(
            [IO.Path]::GetFullPath($ArtifactFullPath))
        $expectedDirectory = [IO.Path]::GetDirectoryName($releaseDirectory)
        $fullPath = [IO.Path]::GetFullPath($Path)
        $directory = [IO.Path]::GetDirectoryName($fullPath)
    }
    catch {
        Throw-ReleaseError 'provenance_path_invalid'
    }
    if ([string]::IsNullOrWhiteSpace($directory) -or
        -not [string]::Equals(
            $directory,
            $expectedDirectory,
            [StringComparison]::OrdinalIgnoreCase) -or
        -not [IO.Path]::GetFileName($fullPath).Equals(
            $FileName,
            [StringComparison]::OrdinalIgnoreCase)) {
        Throw-ReleaseError 'provenance_path_invalid'
    }
    try {
        Assert-LocalReleaseDirectory -DirectoryPath $directory
    }
    catch {
        Throw-ReleaseError 'provenance_path_invalid'
    }
    if (Test-Path -LiteralPath $fullPath) {
        $item = Get-Item -LiteralPath $fullPath -Force
        if ($item.PSIsContainer -or
            ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            Throw-ReleaseError 'provenance_path_invalid'
        }
    }
    return $fullPath
}

function Test-WindowsProvenanceRelativePath {
    param(
        [AllowNull()]
        [object]$Path
    )

    # Manifest yolu `win-x64` köküne göreli, `/` ayraçlı ve normalize edilmiş
    # olmalıdır: mutlak yol, sürücü, `.`/`..`, ters bölü, kontrol karakteri ve
    # Windows'un sessizce kırptığı nokta/boşluk sonekleri reddedilir.
    if ($Path -isnot [string] -or
        $Path.Length -lt 1 -or
        $Path.Length -gt 1024) {
        return $false
    }
    foreach ($character in $Path.ToCharArray()) {
        $code = [int]$character
        if ($code -lt 0x20 -or
            $code -eq 0x7F -or
            '\:*?"<>|'.IndexOf($character) -ge 0) {
            return $false
        }
    }
    foreach ($segment in $Path.Split('/')) {
        if ($segment.Length -eq 0 -or
            $segment -eq '.' -or
            $segment -eq '..' -or
            $segment.EndsWith('.', [StringComparison]::Ordinal) -or
            $segment.EndsWith(' ', [StringComparison]::Ordinal)) {
            return $false
        }
    }
    return $true
}

function Get-WindowsProvenanceTreeEntries {
    param(
        [Parameter(Mandatory = $true)]
        [object]$TreeState
    )

    $count = @($TreeState.RelativePaths).Count
    $keys = [string[]]::new($count)
    $files = [string[]]::new($count)
    for ($index = 0; $index -lt $count; $index += 1) {
        $keys[$index] = ([string]$TreeState.RelativePaths[$index]).Replace('\', '/')
        $files[$index] = [string]$TreeState.FilePaths[$index]
    }
    [Array]::Sort($keys, $files, [StringComparer]::Ordinal)

    $seen = [Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase)
    $entries = [Collections.Generic.List[object]]::new()
    for ($index = 0; $index -lt $count; $index += 1) {
        $relativePath = $keys[$index]
        if (-not (Test-WindowsProvenanceRelativePath -Path $relativePath) -or
            -not $seen.Add($relativePath)) {
            Throw-ReleaseError 'release_tree_invalid'
        }
        # Authenticode manifesti yalnız imzalı katalog yolunda anlamlıdır;
        # iki bütünlük modu aynı ağaçta karıştırılmaz.
        if ([string]::Equals(
                $relativePath,
                'EdizRemote.release-manifest.json',
                [StringComparison]::OrdinalIgnoreCase)) {
            Throw-ReleaseError 'provenance_mode_conflict'
        }
        $entries.Add([PSCustomObject]@{
                Path = $relativePath
                SizeBytes = [int64]([IO.FileInfo]::new($files[$index]).Length)
                Sha256 = (Get-FileSha256 -Path $files[$index]).ToLowerInvariant()
            })
    }
    if (-not ($keys -ccontains 'EdizRemote.exe')) {
        Throw-ReleaseError 'release_tree_invalid'
    }
    return , $entries.ToArray()
}

function New-WindowsProvenanceDocument {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Identity,

        [Parameter(Mandatory = $true)]
        [string]$BuildId,

        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$Entries
    )

    $files = [Collections.Generic.List[object]]::new()
    $totalBytes = [int64]0
    foreach ($entry in $Entries) {
        $files.Add([ordered]@{
                path = [string]$entry.Path
                sizeBytes = [int64]$entry.SizeBytes
                sha256 = [string]$entry.Sha256
            })
        $totalBytes += [int64]$entry.SizeBytes
    }
    return [ordered]@{
        schemaVersion = $script:ProvenanceSchemaVersion
        product = 'Ediz Remote'
        integrity = $script:ProvenanceIntegrityMode
        buildId = $BuildId
        release = [ordered]@{
            version = [string]$Identity.Version
            sequence = [int]$Identity.Sequence
        }
        source = [ordered]@{
            repository = $script:ProvenanceRepository
            revision = [string]$Identity.SourceRevision
            treeClean = [bool]$Identity.SourceTreeClean
        }
        attestation = [ordered]@{
            predicateType = $script:ProvenancePredicateType
            signerWorkflow = $script:ProvenanceSignerWorkflow
            sourceRef = $script:ProvenanceSourceRef
        }
        tree = [ordered]@{
            root = $script:ProvenanceTreeRoot
            fileCount = [int]$files.Count
            totalBytes = $totalBytes
            files = $files.ToArray()
        }
    }
}

function ConvertTo-WindowsProvenanceJson {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Document
    )

    # Kanonik biçim: PowerShell 7 JSON yazıcısı, LF satır sonu, sonda tek LF.
    # Doğrulama aynı biçimi yeniden üretip byte byte karşılaştırır; böylece
    # yinelenen anahtar veya elle düzenlenmiş kayıt kabul edilmez.
    $json = ($Document | ConvertTo-Json -Depth 8).Replace("`r`n", "`n")
    return $json + "`n"
}

function ConvertTo-WindowsProvenanceCanonicalDocument {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Document
    )

    $entries = @(foreach ($file in @($Document.tree.files)) {
            [PSCustomObject]@{
                Path = [string]$file.path
                SizeBytes = [int64]$file.sizeBytes
                Sha256 = [string]$file.sha256
            }
        })
    $identity = [PSCustomObject]@{
        Version = [string]$Document.release.version
        Sequence = [int]$Document.release.sequence
        SourceRevision = [string]$Document.source.revision
        SourceTreeClean = [bool]$Document.source.treeClean
    }
    return New-WindowsProvenanceDocument `
        -Identity $identity `
        -BuildId ([string]$Document.buildId) `
        -Entries $entries
}

function Get-WindowsProvenanceChecksumsText {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Document
    )

    # `sha256sum -c` biçimi: küçük harf hex, iki boşluk, `win-x64/<yol>`, LF.
    # Provenance manifestinin kendi özeti bu listeye girmez.
    $builder = [Text.StringBuilder]::new()
    foreach ($file in @($Document.tree.files)) {
        [void]$builder.Append([string]$file.sha256)
        [void]$builder.Append('  ')
        [void]$builder.Append($script:ProvenanceTreeRoot)
        [void]$builder.Append('/')
        [void]$builder.Append([string]$file.path)
        [void]$builder.Append("`n")
    }
    return $builder.ToString()
}

function Assert-WindowsProvenanceDocumentShape {
    param(
        [AllowNull()]
        [object]$Document
    )

    Assert-ExactProperties -Value $Document -Expected @(
        'schemaVersion',
        'product',
        'integrity',
        'buildId',
        'release',
        'source',
        'attestation',
        'tree'
    )
    Assert-ExactProperties -Value $Document.release -Expected @(
        'version',
        'sequence'
    )
    Assert-ExactProperties -Value $Document.source -Expected @(
        'repository',
        'revision',
        'treeClean'
    )
    Assert-ExactProperties -Value $Document.attestation -Expected @(
        'predicateType',
        'signerWorkflow',
        'sourceRef'
    )
    Assert-ExactProperties -Value $Document.tree -Expected @(
        'root',
        'fileCount',
        'totalBytes',
        'files'
    )

    if (-not (Test-IsIntegralJsonNumber $Document.schemaVersion) -or
        [int64]$Document.schemaVersion -ne $script:ProvenanceSchemaVersion -or
        -not (Test-ExactString $Document.product 'Ediz Remote') -or
        -not (Test-ExactString $Document.integrity $script:ProvenanceIntegrityMode) -or
        $Document.buildId -isnot [string] -or
        $Document.buildId -cnotmatch '\A[A-Za-z0-9][A-Za-z0-9._@+:-]{0,127}\z') {
        throw 'invalid'
    }

    ConvertTo-WindowsReleaseVersion -Value $Document.release.version | Out-Null
    if (-not (Test-IsIntegralJsonNumber $Document.release.sequence)) {
        throw 'invalid'
    }
    ConvertTo-WindowsReleaseSequence `
        -Value $Document.release.sequence `
        -AllowDevelopment | Out-Null

    if (-not (Test-ExactString $Document.source.repository $script:ProvenanceRepository) -or
        $Document.source.revision -isnot [string] -or
        $Document.source.revision -cnotmatch $script:ReleaseRevisionPattern -or
        $Document.source.treeClean -isnot [bool]) {
        throw 'invalid'
    }
    if (-not (Test-ExactString $Document.attestation.predicateType `
                $script:ProvenancePredicateType) -or
        -not (Test-ExactString $Document.attestation.signerWorkflow `
                $script:ProvenanceSignerWorkflow) -or
        -not (Test-ExactString $Document.attestation.sourceRef `
                $script:ProvenanceSourceRef)) {
        throw 'invalid'
    }

    $files = $Document.tree.files
    if (-not (Test-ExactString $Document.tree.root $script:ProvenanceTreeRoot) -or
        $files -isnot [Array] -or
        $files.Count -lt 1 -or
        $files.Count -gt 8192 -or
        -not (Test-IsIntegralJsonNumber $Document.tree.fileCount) -or
        [int64]$Document.tree.fileCount -ne $files.Count -or
        -not (Test-IsIntegralJsonNumber $Document.tree.totalBytes)) {
        throw 'invalid'
    }

    $seen = [Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase)
    $previousPath = $null
    $totalBytes = [int64]0
    $hasArtifact = $false
    foreach ($file in $files) {
        Assert-ExactProperties -Value $file -Expected @(
            'path',
            'sizeBytes',
            'sha256'
        )
        # Sıra ordinal ve kesin artan olmalı; büyük/küçük harf çakışması
        # (Windows'ta aynı dosya) ayrıca reddedilir.
        if (-not (Test-WindowsProvenanceRelativePath -Path $file.path) -or
            ($null -ne $previousPath -and
                [string]::CompareOrdinal($previousPath, $file.path) -ge 0) -or
            -not $seen.Add($file.path) -or
            [string]::Equals(
                $file.path,
                'EdizRemote.release-manifest.json',
                [StringComparison]::OrdinalIgnoreCase) -or
            -not (Test-IsIntegralJsonNumber $file.sizeBytes) -or
            [int64]$file.sizeBytes -lt 0 -or
            $file.sha256 -isnot [string] -or
            $file.sha256 -cnotmatch '\A[0-9a-f]{64}\z') {
            throw 'invalid'
        }
        if ([string]::Equals(
                $file.path,
                'EdizRemote.exe',
                [StringComparison]::Ordinal)) {
            $hasArtifact = $true
        }
        $previousPath = $file.path
        $totalBytes += [int64]$file.sizeBytes
    }
    if (-not $hasArtifact -or
        [int64]$Document.tree.totalBytes -ne $totalBytes) {
        throw 'invalid'
    }
}

function Assert-WindowsProvenanceDocumentObject {
    param(
        [AllowNull()]
        [object]$Document
    )

    try {
        Assert-WindowsProvenanceDocumentShape -Document $Document
    }
    catch {
        Throw-ReleaseError 'provenance_manifest_invalid'
    }
}

function Read-WindowsProvenanceText {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$InvalidCode,

        [Parameter(Mandatory = $true)]
        [string]$TooLargeCode
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Throw-ReleaseError $InvalidCode
    }
    $maximumBytes = $script:ProvenanceMaximumBytes
    $stream = $null
    $bytes = $null
    try {
        $stream = [IO.File]::Open(
            $Path,
            [IO.FileMode]::Open,
            [IO.FileAccess]::Read,
            [IO.FileShare]::Read)
        if ($stream.Length -gt $maximumBytes) {
            Throw-ReleaseError $TooLargeCode
        }
        $bytes = [byte[]]::new($maximumBytes + 1)
        $total = 0
        while ($total -lt $bytes.Length) {
            $read = $stream.Read($bytes, $total, $bytes.Length - $total)
            if ($read -eq 0) { break }
            $total += $read
        }
        if ($total -gt $maximumBytes) {
            Throw-ReleaseError $TooLargeCode
        }
        # Yazıcı BOM'suz UTF-8 üretir; BOM veya bozuk UTF-8 kanonik değildir.
        if ($total -ge 3 -and
            $bytes[0] -eq 0xEF -and
            $bytes[1] -eq 0xBB -and
            $bytes[2] -eq 0xBF) {
            Throw-ReleaseError $InvalidCode
        }
        $utf8 = [Text.UTF8Encoding]::new($false, $true)
        return $utf8.GetString($bytes, 0, $total)
    }
    catch {
        if ($_.Exception.Message -eq $TooLargeCode) { throw }
        Throw-ReleaseError $InvalidCode
    }
    finally {
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function Assert-WindowsProvenanceIdentity {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Identity,

        [Parameter(Mandatory = $true)]
        [object]$Document,

        [Parameter(Mandatory = $true)]
        [int]$MinimumSequence
    )

    Assert-WindowsProvenanceDocumentObject -Document $Document
    if ($MinimumSequence -lt 1 -or
        $MinimumSequence -gt $script:ReleaseMaximumSequence) {
        Throw-ReleaseError 'release_floor_invalid'
    }
    if (-not [string]::Equals(
            [string]$Identity.Version,
            [string]$Document.release.version,
            [StringComparison]::Ordinal) -or
        [int64]$Identity.Sequence -ne [int64]$Document.release.sequence -or
        -not [string]::Equals(
            [string]$Identity.SourceRevision,
            [string]$Document.source.revision,
            [StringComparison]::Ordinal) -or
        [bool]$Identity.SourceTreeClean -ne [bool]$Document.source.treeClean) {
        Throw-ReleaseError 'release_identity_mismatch'
    }
    if (-not [bool]$Document.source.treeClean) {
        Throw-ReleaseError 'provenance_dirty_source'
    }
    $sequence = [int64]$Document.release.sequence
    if ($sequence -lt 1) {
        Throw-ReleaseError 'release_sequence_invalid'
    }
    if ($sequence -lt $MinimumSequence) {
        Throw-ReleaseError 'release_rollback_rejected'
    }
}

function Assert-WindowsProvenanceOffline {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ArtifactFullPath,

        [Parameter(Mandatory = $true)]
        [string]$ProvenanceFullPath,

        [Parameter(Mandatory = $true)]
        [string]$ChecksumsFullPath,

        [Parameter(Mandatory = $true)]
        [object]$TreeState,

        [Parameter(Mandatory = $true)]
        [int]$MinimumSequence
    )

    $text = Read-WindowsProvenanceText `
        -Path $ProvenanceFullPath `
        -InvalidCode 'provenance_manifest_invalid' `
        -TooLargeCode 'provenance_manifest_too_large'
    try {
        $document = $text | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        Throw-ReleaseError 'provenance_manifest_invalid'
    }
    Assert-WindowsProvenanceDocumentObject -Document $document
    $canonical = ConvertTo-WindowsProvenanceJson `
        -Document (ConvertTo-WindowsProvenanceCanonicalDocument -Document $document)
    if (-not [string]::Equals($canonical, $text, [StringComparison]::Ordinal)) {
        Throw-ReleaseError 'provenance_manifest_invalid'
    }

    # Ağaç ↔ manifest: eksik/fazla dosya, yol, boyut ve SHA-256 birebir.
    $entries = Get-WindowsProvenanceTreeEntries -TreeState $TreeState
    $files = @($document.tree.files)
    if ($entries.Count -ne $files.Count) {
        Throw-ReleaseError 'provenance_tree_mismatch'
    }
    for ($index = 0; $index -lt $files.Count; $index += 1) {
        if (-not [string]::Equals(
                [string]$entries[$index].Path,
                [string]$files[$index].path,
                [StringComparison]::Ordinal) -or
            [int64]$entries[$index].SizeBytes -ne [int64]$files[$index].sizeBytes -or
            -not [string]::Equals(
                [string]$entries[$index].Sha256,
                [string]$files[$index].sha256,
                [StringComparison]::Ordinal)) {
            Throw-ReleaseError 'provenance_tree_mismatch'
        }
    }

    $checksums = Read-WindowsProvenanceText `
        -Path $ChecksumsFullPath `
        -InvalidCode 'provenance_checksums_invalid' `
        -TooLargeCode 'provenance_checksums_invalid'
    if (-not [string]::Equals(
            (Get-WindowsProvenanceChecksumsText -Document $document),
            $checksums,
            [StringComparison]::Ordinal)) {
        Throw-ReleaseError 'provenance_checksums_invalid'
    }

    $identity = ConvertTo-WindowsReleaseIdentity `
        -Facts (Get-WindowsReleaseIdentityFacts -ArtifactPath $ArtifactFullPath)
    Assert-WindowsProvenanceIdentity `
        -Identity $identity `
        -Document $document `
        -MinimumSequence $MinimumSequence
    return $document
}

function Write-WindowsReleaseProvenance {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ArtifactPath,

        [Parameter(Mandatory = $true)]
        [string]$ProvenancePath,

        [Parameter(Mandatory = $true)]
        [string]$ChecksumsPath,

        [Parameter(Mandatory = $true)]
        [string]$RepositoryRoot,

        [Parameter(Mandatory = $true)]
        [string]$BuildId,

        [AllowNull()]
        [System.Collections.IDictionary]$Environment
    )

    $artifactFullPath = Assert-ArtifactPath -ArtifactPath $ArtifactPath
    $provenanceFullPath = Assert-WindowsProvenanceFilePath `
        -ArtifactFullPath $artifactFullPath `
        -Path $ProvenancePath `
        -FileName $script:ProvenanceManifestFileName
    $checksumsFullPath = Assert-WindowsProvenanceFilePath `
        -ArtifactFullPath $artifactFullPath `
        -Path $ChecksumsPath `
        -FileName $script:ProvenanceChecksumsFileName
    # Önceki koşunun çıktısı bu koşu başarısız olursa geride bayat kalmamalı.
    foreach ($outputPath in @($provenanceFullPath, $checksumsFullPath)) {
        if (Test-Path -LiteralPath $outputPath -PathType Leaf) {
            Remove-Item -LiteralPath $outputPath -Force
        }
    }

    # Sign kapısıyla aynı ön koşullar: taban, temiz kaynak, commit = HEAD,
    # package.json sürümü, sequence >= 1 ve tabandan küçük olmama.
    $minimumSequence = Get-WindowsReleaseMinimumSequence -Environment $Environment
    $identity = Assert-WindowsReleaseSigningProvenance `
        -ArtifactPath $artifactFullPath `
        -RepositoryRoot $RepositoryRoot `
        -Environment $Environment

    $releaseDirectory = [IO.Path]::GetDirectoryName($artifactFullPath)
    $outputDirectory = [IO.Path]::GetDirectoryName($provenanceFullPath)
    $nonce = [guid]::NewGuid().ToString('N')
    $temporaryProvenance = Join-Path $outputDirectory `
        ('.EdizRemote.win-x64.provenance.{0}.tmp' -f $nonce)
    $temporaryChecksums = Join-Path $outputDirectory `
        ('.EdizRemote.win-x64.SHA256SUMS.{0}.tmp' -f $nonce)
    $lockedTree = $null
    $completed = $false
    try {
        $lockedTree = Open-WindowsReleaseTreeLocks `
            -ReleaseDirectory $releaseDirectory
        $entries = Get-WindowsProvenanceTreeEntries -TreeState $lockedTree.State
        $document = New-WindowsProvenanceDocument `
            -Identity $identity `
            -BuildId $BuildId `
            -Entries $entries
        $json = ConvertTo-WindowsProvenanceJson -Document $document
        Assert-WindowsProvenanceDocumentObject -Document ($json | ConvertFrom-Json)
        if ([Text.Encoding]::UTF8.GetByteCount($json) -gt
            $script:ProvenanceMaximumBytes) {
            Throw-ReleaseError 'provenance_manifest_too_large'
        }
        $checksums = Get-WindowsProvenanceChecksumsText -Document $document

        # Hash'ler hesaplanırken commit veya ağaç değiştiyse kayıt yazılmaz.
        Assert-WindowsReleaseSourceState `
            -Identity $identity `
            -SourceState (Get-WindowsReleaseSourceState -RepositoryRoot $RepositoryRoot) `
            -PackageVersion (Get-WindowsReleasePackageVersion -RepositoryRoot $RepositoryRoot)

        $utf8 = [Text.UTF8Encoding]::new($false)
        [IO.File]::WriteAllText($temporaryChecksums, $checksums, $utf8)
        [IO.File]::WriteAllText($temporaryProvenance, $json, $utf8)
        Move-Item -LiteralPath $temporaryChecksums -Destination $checksumsFullPath -Force
        Move-Item -LiteralPath $temporaryProvenance -Destination $provenanceFullPath -Force

        $after = Get-WindowsReleaseTreeState -ReleaseDirectory $releaseDirectory
        if (-not [string]::Equals(
                $lockedTree.State.Fingerprint,
                $after.Fingerprint,
                [StringComparison]::Ordinal)) {
            Throw-ReleaseError 'release_tree_changed'
        }
        # Yazılan kayıt, doğrulayıcının attestation dışındaki bütün
        # kontrollerinden geri okunarak geçirilir.
        Assert-WindowsProvenanceOffline `
            -ArtifactFullPath $artifactFullPath `
            -ProvenanceFullPath $provenanceFullPath `
            -ChecksumsFullPath $checksumsFullPath `
            -TreeState $lockedTree.State `
            -MinimumSequence $minimumSequence | Out-Null
        $completed = $true
        return $document
    }
    finally {
        Close-WindowsReleaseTreeLocks -LockedTree $lockedTree
        foreach ($temporaryPath in @($temporaryProvenance, $temporaryChecksums)) {
            if (Test-Path -LiteralPath $temporaryPath) {
                Remove-Item -LiteralPath $temporaryPath -Force
            }
        }
        if (-not $completed) {
            foreach ($outputPath in @($provenanceFullPath, $checksumsFullPath)) {
                if (Test-Path -LiteralPath $outputPath -PathType Leaf) {
                    Remove-Item -LiteralPath $outputPath -Force
                }
            }
        }
    }
}

function Get-WindowsGhAttestationArguments {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [Parameter(Mandatory = $true)]
        [string]$SourceRevision
    )

    if ($SourceRevision -cnotmatch $script:ReleaseRevisionPattern) {
        Throw-ReleaseError 'provenance_attestation_invalid'
    }
    # Kimlik politikası en sıkı biçimde: depo, signer workflow ve onun commit'i,
    # kaynak ref'i ve commit'i, SLSA predicate, GitHub OIDC issuer ve yalnız
    # GitHub-hosted runner.
    return [string[]]@(
        'attestation',
        'verify',
        $FilePath,
        '--repo',
        $script:ProvenanceRepository,
        '--signer-workflow',
        $script:ProvenanceSignerWorkflow,
        '--signer-digest',
        $SourceRevision,
        '--source-ref',
        $script:ProvenanceSourceRef,
        '--source-digest',
        $SourceRevision,
        '--predicate-type',
        $script:ProvenancePredicateType,
        '--cert-oidc-issuer',
        $script:ProvenanceOidcIssuer,
        '--deny-self-hosted-runners',
        '--format',
        'json'
    )
}

function Assert-WindowsAttestationEntry {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Entry,

        [Parameter(Mandatory = $true)]
        [string]$FileSha256,

        [Parameter(Mandatory = $true)]
        [string]$SourceRevision
    )

    $statement = $Entry.verificationResult.statement
    $certificate = $Entry.verificationResult.signature.certificate
    if (-not (Test-ExactString $statement.predicateType $script:ProvenancePredicateType)) {
        throw 'invalid'
    }
    $matched = $false
    foreach ($subject in @($statement.subject)) {
        $digest = $null
        if ($null -ne $subject -and
            $null -ne $subject.PSObject.Properties['digest'] -and
            $null -ne $subject.digest -and
            $null -ne $subject.digest.PSObject.Properties['sha256']) {
            $digest = $subject.digest.sha256
        }
        if (Test-ExactString $digest $FileSha256) {
            $matched = $true
        }
    }
    # Sertifika alanları GitHub OIDC token'ından gelir; workflow tarafından
    # değiştirilemez. `statement.predicate` güven kaynağı olarak kullanılmaz.
    if (-not $matched -or
        -not (Test-ExactString $certificate.issuer $script:ProvenanceOidcIssuer) -or
        -not (Test-ExactString $certificate.sourceRepositoryURI `
                ($script:ReleaseSourceRepository) -IgnoreCase) -or
        -not (Test-ExactString $certificate.sourceRepositoryDigest $SourceRevision) -or
        -not (Test-ExactString $certificate.sourceRepositoryRef $script:ProvenanceSourceRef) -or
        -not (Test-ExactString $certificate.buildSignerURI `
                $script:ProvenanceSignerWorkflowUri -IgnoreCase) -or
        -not (Test-ExactString $certificate.buildSignerDigest $SourceRevision) -or
        -not (Test-ExactString $certificate.runnerEnvironment 'github-hosted')) {
        throw 'invalid'
    }
}

function Assert-WindowsAttestationResult {
    param(
        [Parameter(Mandatory = $true)]
        [int]$ExitCode,

        [AllowNull()]
        [AllowEmptyString()]
        [string]$Output,

        [Parameter(Mandatory = $true)]
        [string]$FileSha256,

        [Parameter(Mandatory = $true)]
        [string]$SourceRevision
    )

    if ($ExitCode -ne 0 -or
        $FileSha256 -cnotmatch '\A[0-9a-f]{64}\z' -or
        $SourceRevision -cnotmatch $script:ReleaseRevisionPattern -or
        [string]::IsNullOrWhiteSpace($Output) -or
        $Output.Length -gt $script:ProvenanceMaximumAttestationOutputChars -or
        -not $Output.TrimStart().StartsWith('[', [StringComparison]::Ordinal)) {
        Throw-ReleaseError 'provenance_attestation_invalid'
    }
    try {
        $results = @($Output | ConvertFrom-Json -ErrorAction Stop)
        if ($results.Count -lt 1 -or $results.Count -gt 64) {
            throw 'invalid'
        }
        foreach ($result in $results) {
            Assert-WindowsAttestationEntry `
                -Entry $result `
                -FileSha256 $FileSha256 `
                -SourceRevision $SourceRevision
        }
    }
    catch {
        Throw-ReleaseError 'provenance_attestation_invalid'
    }
}

function Resolve-GhPath {
    param(
        [AllowNull()]
        [System.Collections.IDictionary]$Environment
    )

    $configuredPath = Get-EnvironmentSetting `
        -Name 'EDIZ_REMOTE_GH_PATH' `
        -Environment $Environment
    $candidatePath = $null
    try {
        if (-not [string]::IsNullOrWhiteSpace($configuredPath)) {
            $candidatePath = [IO.Path]::GetFullPath($configuredPath)
        }
        else {
            $command = Get-Command 'gh.exe' -CommandType Application `
                -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($null -eq $command) {
                Throw-ReleaseError 'provenance_tool_missing'
            }
            $candidatePath = [IO.Path]::GetFullPath($command.Source)
        }
        if ($candidatePath.StartsWith('\\', [StringComparison]::Ordinal) -or
            -not [IO.Path]::GetFileName($candidatePath).Equals(
                'gh.exe',
                [StringComparison]::OrdinalIgnoreCase) -or
            -not (Test-Path -LiteralPath $candidatePath -PathType Leaf)) {
            Throw-ReleaseError 'provenance_tool_missing'
        }
        $tool = Get-Item -LiteralPath $candidatePath -Force
        if ($tool.PSIsContainer -or
            ($tool.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            Throw-ReleaseError 'provenance_tool_missing'
        }
        Assert-LocalReleaseDirectory `
            -DirectoryPath ([IO.Path]::GetDirectoryName($candidatePath))
    }
    catch {
        Throw-ReleaseError 'provenance_tool_missing'
    }
    return $candidatePath
}

function Invoke-GhAttestationProcess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$GhPath,

        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    # Karar yalnız çıkış koduna ve stdout JSON'una dayanır; stderr (hata
    # ayrıntısı, token durumu) loga aktarılmaz.
    $ErrorActionPreference = 'Continue'
    $toolLock = $null
    try {
        $toolLock = [IO.File]::Open(
            $GhPath,
            [IO.FileMode]::Open,
            [IO.FileAccess]::Read,
            [IO.FileShare]::Read)
        $output = @(& $GhPath @Arguments 2>$null)
        $exitCode = [int]$LASTEXITCODE
        return [PSCustomObject]@{
            ExitCode = $exitCode
            Output = [string]::Join("`n", [string[]]$output)
        }
    }
    catch {
        return [PSCustomObject]@{ ExitCode = 1; Output = '' }
    }
    finally {
        if ($null -ne $toolLock) { $toolLock.Dispose() }
    }
}

function Invoke-WindowsAttestationCheck {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [Parameter(Mandatory = $true)]
        [string]$FileSha256,

        [Parameter(Mandatory = $true)]
        [string]$SourceRevision,

        [AllowNull()]
        [string]$GhPath,

        [AllowNull()]
        [scriptblock]$AttestationInvoker
    )

    $arguments = Get-WindowsGhAttestationArguments `
        -FilePath $FilePath `
        -SourceRevision $SourceRevision
    try {
        if ($null -ne $AttestationInvoker) {
            $result = & $AttestationInvoker $arguments
        }
        else {
            $result = Invoke-GhAttestationProcess `
                -GhPath $GhPath `
                -Arguments $arguments
        }
    }
    catch {
        if ($_.Exception.Message -eq 'provenance_tool_missing') { throw }
        Throw-ReleaseError 'provenance_attestation_invalid'
    }
    if ($null -eq $result -or
        @($result).Count -ne 1 -or
        $null -eq $result.PSObject.Properties['ExitCode'] -or
        $null -eq $result.PSObject.Properties['Output'] -or
        -not (Test-IsIntegralJsonNumber $result.ExitCode)) {
        Throw-ReleaseError 'provenance_attestation_invalid'
    }
    Assert-WindowsAttestationResult `
        -ExitCode ([int]$result.ExitCode) `
        -Output ([string]$result.Output) `
        -FileSha256 $FileSha256 `
        -SourceRevision $SourceRevision
}

function Invoke-WindowsProvenanceGate {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ArtifactPath,

        [Parameter(Mandatory = $true)]
        [string]$ProvenancePath,

        [Parameter(Mandatory = $true)]
        [string]$ChecksumsPath,

        [AllowNull()]
        [System.Collections.IDictionary]$Environment,

        # Testler gerçek `gh`/ağ yerine çağrıyı enjekte eder; argüman dizisini
        # alır, `ExitCode` ve `Output` taşıyan tek nesne döndürür.
        [AllowNull()]
        [scriptblock]$AttestationInvoker
    )

    $minimumSequence = Get-WindowsReleaseMinimumSequence -Environment $Environment
    $artifactFullPath = Assert-ArtifactPath -ArtifactPath $ArtifactPath
    $provenanceFullPath = Assert-WindowsProvenanceFilePath `
        -ArtifactFullPath $artifactFullPath `
        -Path $ProvenancePath `
        -FileName $script:ProvenanceManifestFileName
    $checksumsFullPath = Assert-WindowsProvenanceFilePath `
        -ArtifactFullPath $artifactFullPath `
        -Path $ChecksumsPath `
        -FileName $script:ProvenanceChecksumsFileName
    $releaseDirectory = [IO.Path]::GetDirectoryName($artifactFullPath)
    $lockedTree = $null
    $fileLocks = [Collections.Generic.List[IDisposable]]::new()
    try {
        $lockedTree = Open-WindowsReleaseTreeLocks `
            -ReleaseDirectory $releaseDirectory
        foreach ($path in @($provenanceFullPath, $checksumsFullPath)) {
            if (Test-Path -LiteralPath $path -PathType Leaf) {
                $fileLocks.Add([IO.File]::Open(
                        $path,
                        [IO.FileMode]::Open,
                        [IO.FileAccess]::Read,
                        [IO.FileShare]::Read))
            }
        }
        $document = Assert-WindowsProvenanceOffline `
            -ArtifactFullPath $artifactFullPath `
            -ProvenanceFullPath $provenanceFullPath `
            -ChecksumsFullPath $checksumsFullPath `
            -TreeState $lockedTree.State `
            -MinimumSequence $minimumSequence

        $ghPath = $null
        if ($null -eq $AttestationInvoker) {
            $ghPath = Resolve-GhPath -Environment $Environment
        }
        $artifactSha256 = $null
        foreach ($file in @($document.tree.files)) {
            if ([string]::Equals(
                    [string]$file.path,
                    'EdizRemote.exe',
                    [StringComparison]::Ordinal)) {
                $artifactSha256 = [string]$file.sha256
            }
        }
        Invoke-WindowsAttestationCheck `
            -FilePath $artifactFullPath `
            -FileSha256 $artifactSha256 `
            -SourceRevision ([string]$document.source.revision) `
            -GhPath $ghPath `
            -AttestationInvoker $AttestationInvoker
        Invoke-WindowsAttestationCheck `
            -FilePath $provenanceFullPath `
            -FileSha256 (Get-FileSha256 -Path $provenanceFullPath).ToLowerInvariant() `
            -SourceRevision ([string]$document.source.revision) `
            -GhPath $ghPath `
            -AttestationInvoker $AttestationInvoker

        $after = Get-WindowsReleaseTreeState -ReleaseDirectory $releaseDirectory
        if (-not [string]::Equals(
                $lockedTree.State.Fingerprint,
                $after.Fingerprint,
                [StringComparison]::Ordinal)) {
            Throw-ReleaseError 'release_tree_changed'
        }
        return $document
    }
    finally {
        foreach ($lock in $fileLocks) { $lock.Dispose() }
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
    'Invoke-WindowsReleaseGate',
    'Assert-WindowsProvenanceDocumentObject',
    'ConvertTo-WindowsProvenanceJson',
    'Get-WindowsProvenanceChecksumsText',
    'Write-WindowsReleaseProvenance',
    'Get-WindowsGhAttestationArguments',
    'Assert-WindowsAttestationResult',
    'Invoke-WindowsProvenanceGate'
)

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) {
    $pwsh = Get-Command 'pwsh.exe' -CommandType Application `
        -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $pwsh) {
        [Console]::Error.WriteLine(
            'WINDOWS_RELEASE_TESTS_FAILED:powershell_version_unsupported')
        exit 1
    }
    & $pwsh.Source '-NoLogo' '-NoProfile' '-File' $PSCommandPath
    exit $LASTEXITCODE
}
$modulePath = Join-Path $PSScriptRoot 'windows-release-lib.psm1'
Import-Module $modulePath -Force

$script:TestCount = 0
$script:SourceRepository = 'https://github.com/EddizEge/ediz-remote'

function Assert-Equal {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Expected,

        [Parameter(Mandatory = $true)]
        [object]$Actual
    )

    if (-not [object]::Equals($Expected, $Actual)) {
        throw 'test_assertion_failed'
    }
}

function Assert-ThrowsCode {
    param(
        [Parameter(Mandatory = $true)]
        [scriptblock]$Action,

        [Parameter(Mandatory = $true)]
        [string]$ExpectedCode
    )

    try {
        & $Action
    }
    catch {
        Assert-Equal -Expected $ExpectedCode -Actual $_.Exception.Message
        $script:TestCount += 1
        return
    }
    throw 'test_expected_exception'
}

function New-ValidSignatureFacts {
    return [PSCustomObject]@{
        Status = 'Valid'
        SignatureType = 'Authenticode'
        SignerCertificateSha256 = 'A' * 64
        TimestampCertificateSha256 = 'B' * 64
        HasTimestamp = $true
    }
}

function New-IdentityFacts {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$ProductVersion,

        [Parameter(Mandatory = $true)]
        [string]$FileVersion,

        [int]$Major = 0,
        [int]$Minor = 1,
        [int]$Build = 0,
        [int]$Private = 7
    )

    return [PSCustomObject]@{
        ProductVersion = $ProductVersion
        FileVersion = $FileVersion
        FileMajorPart = $Major
        FileMinorPart = $Minor
        FileBuildPart = $Build
        FilePrivatePart = $Private
    }
}

# Gerçek Windows sürüm kaynağı (VS_VERSIONINFO) taşıyan küçük bir PE üretir;
# release kimliği testleri sahte nesne yerine FileVersionInfo okumasını kullanır.
function New-VersionedPeBytes {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FileVersion,

        [Parameter(Mandatory = $true)]
        [string]$InformationalVersion
    )

    if ($null -eq ('Microsoft.CodeAnalysis.CSharp.CSharpCompilation' -as [type])) {
        Add-Type -TypeDefinition `
            'namespace EdizRemoteReleaseTests { public static class CompilerWarmup { } }'
    }
    $source = @"
[assembly: System.Reflection.AssemblyFileVersion("$FileVersion")]
[assembly: System.Reflection.AssemblyInformationalVersion("$InformationalVersion")]
namespace EdizRemoteReleaseFixture { public static class Marker { public static int Value => 1; } }
"@
    $tree = [Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree]::ParseText($source)
    $references = [Microsoft.CodeAnalysis.MetadataReference[]]@(
        [Microsoft.CodeAnalysis.MetadataReference]::CreateFromFile(
            [object].Assembly.Location))
    $options = [Microsoft.CodeAnalysis.CSharp.CSharpCompilationOptions]::new(
        [Microsoft.CodeAnalysis.OutputKind]::DynamicallyLinkedLibrary).WithDeterministic($true)
    $compilation = [Microsoft.CodeAnalysis.CSharp.CSharpCompilation]::Create(
        'EdizRemote',
        [Microsoft.CodeAnalysis.SyntaxTree[]]@($tree),
        $references,
        $options)
    $resources = $compilation.CreateDefaultWin32Resources($true, $true, $null, $null)
    $peStream = [IO.MemoryStream]::new()
    try {
        $result = $compilation.Emit($peStream, $null, $null, $resources)
        if (-not $result.Success) {
            throw 'test_fixture_compilation_failed'
        }
        return , $peStream.ToArray()
    }
    finally {
        $peStream.Dispose()
        $resources.Dispose()
    }
}

function Copy-ManifestObject {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Manifest
    )

    return $Manifest | ConvertTo-Json -Depth 6 | ConvertFrom-Json
}

function Invoke-FixtureGit {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Repository,

        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $output = @(& git -C $Repository @Arguments 2>$null)
    if ($LASTEXITCODE -ne 0) {
        throw 'test_fixture_git_failed'
    }
    return $output
}

$testRoot = Join-Path `
    ([IO.Path]::GetTempPath()) `
    ('EdizRemote.ReleaseTests.{0}' -f [guid]::NewGuid().ToString('N'))
$releaseRoot = Join-Path $testRoot 'win-x64'
$artifactPath = Join-Path $releaseRoot 'EdizRemote.exe'
$manifestPath = Join-Path $releaseRoot 'EdizRemote.release-manifest.json'
$catalogPath = Join-Path $testRoot 'EdizRemote.win-x64.cat'
$fixtureRevision = '0123456789abcdef0123456789abcdef01234567'
$utf8 = [Text.UTF8Encoding]::new($false)

# Fixture git deposu kullanıcının global/system git ayarlarından yalıtılır.
$previousGitGlobal = $env:GIT_CONFIG_GLOBAL
$previousGitNoSystem = $env:GIT_CONFIG_NOSYSTEM
$isolatedGitConfig = Join-Path $testRoot 'gitconfig'

try {
    New-Item -ItemType Directory -Path $releaseRoot | Out-Null
    [IO.File]::WriteAllText($isolatedGitConfig, '', $utf8)
    $env:GIT_CONFIG_GLOBAL = $isolatedGitConfig
    $env:GIT_CONFIG_NOSYSTEM = '1'

    $fixtureBytes = New-VersionedPeBytes `
        -FileVersion '0.1.0.7' `
        -InformationalVersion "0.1.0+$fixtureRevision"
    [IO.File]::WriteAllBytes($artifactPath, $fixtureBytes)
    $assetDirectory = Join-Path $releaseRoot 'web\assets'
    New-Item -ItemType Directory -Path $assetDirectory | Out-Null
    [IO.File]::WriteAllText(
        (Join-Path $assetDirectory 'main.js'),
        'release-asset',
        $utf8)

    # --- Release kimliği: EXE sürüm kaynağı ---
    $identity = ConvertTo-WindowsReleaseIdentity `
        -Facts (Get-WindowsReleaseIdentityFacts -ArtifactPath $artifactPath)
    Assert-Equal -Expected '0.1.0' -Actual $identity.Version
    Assert-Equal -Expected 7 -Actual $identity.Sequence
    Assert-Equal -Expected $fixtureRevision -Actual $identity.SourceRevision
    Assert-Equal -Expected $true -Actual $identity.SourceTreeClean
    $script:TestCount += 1

    $dirtyIdentity = ConvertTo-WindowsReleaseIdentity -Facts (New-IdentityFacts `
            -ProductVersion "0.1.0+$fixtureRevision.dirty" `
            -FileVersion '0.1.0.7')
    Assert-Equal -Expected $false -Actual $dirtyIdentity.SourceTreeClean
    $script:TestCount += 1

    $developmentIdentity = ConvertTo-WindowsReleaseIdentity -Facts (New-IdentityFacts `
            -ProductVersion "0.1.0+$fixtureRevision" `
            -FileVersion '0.1.0.0' `
            -Private 0)
    Assert-Equal -Expected 0 -Actual $developmentIdentity.Sequence
    $script:TestCount += 1

    $invalidIdentityFacts = @(
        (New-IdentityFacts -ProductVersion '' -FileVersion '0.1.0.7'),
        (New-IdentityFacts -ProductVersion '0.1.0' -FileVersion '0.1.0.7'),
        (New-IdentityFacts -ProductVersion "0.1.0+$($fixtureRevision.ToUpperInvariant())" -FileVersion '0.1.0.7'),
        (New-IdentityFacts -ProductVersion "0.1.0+$fixtureRevision+$fixtureRevision" -FileVersion '0.1.0.7'),
        (New-IdentityFacts -ProductVersion "0.1.0+$fixtureRevision.Dirty" -FileVersion '0.1.0.7'),
        (New-IdentityFacts -ProductVersion "0.1.0+$($fixtureRevision.Substring(1))" -FileVersion '0.1.0.7'),
        (New-IdentityFacts -ProductVersion "00.1.0+$fixtureRevision" -FileVersion '00.1.0.7'),
        (New-IdentityFacts -ProductVersion "0.1+$fixtureRevision" -FileVersion '0.1.7' -Build 7),
        (New-IdentityFacts -ProductVersion "65535.0.0+$fixtureRevision" -FileVersion '65535.0.0.7' -Major 65535 -Minor 0),
        (New-IdentityFacts -ProductVersion "0.1.0+$fixtureRevision" -FileVersion '0.1.0'),
        (New-IdentityFacts -ProductVersion "0.1.0+$fixtureRevision" -FileVersion '0.1.0.007'),
        (New-IdentityFacts -ProductVersion "0.1.0+$fixtureRevision" -FileVersion '0.1.0.65536' -Private 0),
        (New-IdentityFacts -ProductVersion "0.1.0+$fixtureRevision" -FileVersion '0.2.0.7'),
        (New-IdentityFacts -ProductVersion "0.1.0+$fixtureRevision" -FileVersion '0.1.0.7' -Private 8),
        (New-IdentityFacts -ProductVersion "0.1.0+$fixtureRevision" -FileVersion '0.1.0.7' -Minor 2)
    )
    foreach ($facts in $invalidIdentityFacts) {
        Assert-ThrowsCode -ExpectedCode 'release_identity_invalid' -Action {
            ConvertTo-WindowsReleaseIdentity -Facts $facts | Out-Null
        }
    }

    $unversionedRoot = Join-Path $testRoot 'unversioned\win-x64'
    New-Item -ItemType Directory -Path $unversionedRoot | Out-Null
    $unversionedArtifact = Join-Path $unversionedRoot 'EdizRemote.exe'
    [IO.File]::WriteAllBytes($unversionedArtifact, [byte[]](1, 3, 3, 7))
    Assert-ThrowsCode -ExpectedCode 'release_identity_invalid' -Action {
        ConvertTo-WindowsReleaseIdentity `
            -Facts (Get-WindowsReleaseIdentityFacts -ArtifactPath $unversionedArtifact) |
            Out-Null
    }
    Assert-ThrowsCode -ExpectedCode 'release_identity_invalid' -Action {
        Write-WindowsReleaseManifest `
            -ArtifactPath $unversionedArtifact `
            -ManifestPath (Join-Path $unversionedRoot 'EdizRemote.release-manifest.json') `
            -BuildId 'ediz-remote@test' | Out-Null
    }

    # --- Manifest v2 ---
    Write-WindowsReleaseManifest `
        -ArtifactPath $artifactPath `
        -ManifestPath $manifestPath `
        -BuildId 'ediz-remote@test' | Out-Null
    $firstManifestBytes = [IO.File]::ReadAllBytes($manifestPath)
    $manifest = Read-WindowsReleaseManifest `
        -ArtifactPath $artifactPath `
        -ManifestPath $manifestPath
    Assert-WindowsArtifactMatchesManifest `
        -ArtifactPath $artifactPath `
        -Manifest $manifest
    Assert-Equal -Expected 2 -Actual ([int]$manifest.schemaVersion)
    Assert-Equal -Expected '0.1.0' -Actual $manifest.release.version
    Assert-Equal -Expected 7 -Actual ([int]$manifest.release.sequence)
    Assert-Equal -Expected $script:SourceRepository -Actual $manifest.provenance.sourceRepository
    Assert-Equal -Expected $fixtureRevision -Actual $manifest.provenance.sourceRevision
    Assert-Equal -Expected $true -Actual $manifest.provenance.sourceTreeClean
    $script:TestCount += 1

    Assert-WindowsReleaseIdentityMatchesManifest -Identity $identity -Manifest $manifest
    $script:TestCount += 1

    Write-WindowsReleaseManifest `
        -ArtifactPath $artifactPath `
        -ManifestPath $manifestPath `
        -BuildId 'ediz-remote@test' | Out-Null
    $secondManifestBytes = [IO.File]::ReadAllBytes($manifestPath)
    Assert-Equal `
        -Expected ([Convert]::ToBase64String($firstManifestBytes)) `
        -Actual ([Convert]::ToBase64String($secondManifestBytes))
    $script:TestCount += 1

    $legacyManifest = [PSCustomObject]@{
        schemaVersion = 1
        product = 'Ediz Remote'
        buildId = 'ediz-remote@test'
        artifact = $manifest.artifact
    }
    Assert-ThrowsCode -ExpectedCode 'manifest_schema_invalid' -Action {
        Assert-WindowsReleaseManifestObject -Manifest $legacyManifest
    }

    $futureManifest = Copy-ManifestObject -Manifest $manifest
    $futureManifest.schemaVersion = 3
    Assert-ThrowsCode -ExpectedCode 'manifest_build_invalid' -Action {
        Assert-WindowsReleaseManifestObject -Manifest $futureManifest
    }

    $schemaMutations = @(
        { param($m) $m.provenance.sourceRepository = 'https://example.invalid/ediz-remote' },
        { param($m) $m.provenance.sourceRevision = $fixtureRevision.ToUpperInvariant() },
        { param($m) $m.provenance.sourceTreeClean = 'true' },
        { param($m) $m.release.sequence = '7' },
        { param($m) $m.release.sequence = 65536 },
        { param($m) $m.release.sequence = -1 },
        { param($m) $m.release.version = '0.1' },
        { param($m) $m.release | Add-Member -NotePropertyName channel -NotePropertyValue 'stable' },
        { param($m) $m.provenance | Add-Member -NotePropertyName builder -NotePropertyValue 'x' }
    )
    foreach ($mutation in $schemaMutations) {
        $mutated = Copy-ManifestObject -Manifest $manifest
        & $mutation $mutated
        Assert-ThrowsCode -ExpectedCode 'manifest_schema_invalid' -Action {
            Assert-WindowsReleaseManifestObject -Manifest $mutated
        }
    }

    $identityMutations = @(
        { param($m) $m.release.sequence = 8 },
        { param($m) $m.release.version = '0.1.1' },
        { param($m) $m.provenance.sourceRevision = 'f' * 40 },
        { param($m) $m.provenance.sourceTreeClean = $false }
    )
    foreach ($mutation in $identityMutations) {
        $mutated = Copy-ManifestObject -Manifest $manifest
        & $mutation $mutated
        Assert-ThrowsCode -ExpectedCode 'release_identity_mismatch' -Action {
            Assert-WindowsReleaseIdentityMatchesManifest `
                -Identity $identity `
                -Manifest $mutated
        }
    }

    # --- Anti-rollback politikası ---
    Assert-WindowsReleaseAntiRollbackPolicy -Manifest $manifest -MinimumSequence 7
    Assert-WindowsReleaseAntiRollbackPolicy -Manifest $manifest -MinimumSequence 1
    $script:TestCount += 1

    Assert-ThrowsCode -ExpectedCode 'release_rollback_rejected' -Action {
        Assert-WindowsReleaseAntiRollbackPolicy -Manifest $manifest -MinimumSequence 8
    }
    Assert-ThrowsCode -ExpectedCode 'release_floor_invalid' -Action {
        Assert-WindowsReleaseAntiRollbackPolicy -Manifest $manifest -MinimumSequence 0
    }
    $dirtyManifest = Copy-ManifestObject -Manifest $manifest
    $dirtyManifest.provenance.sourceTreeClean = $false
    Assert-ThrowsCode -ExpectedCode 'provenance_dirty_source' -Action {
        Assert-WindowsReleaseAntiRollbackPolicy -Manifest $dirtyManifest -MinimumSequence 1
    }
    $developmentManifest = Copy-ManifestObject -Manifest $manifest
    $developmentManifest.release.sequence = 0
    Assert-ThrowsCode -ExpectedCode 'release_sequence_invalid' -Action {
        Assert-WindowsReleaseAntiRollbackPolicy -Manifest $developmentManifest -MinimumSequence 1
    }

    Assert-Equal -Expected 7 -Actual (Get-WindowsReleaseMinimumSequence -Environment @{
            EDIZ_REMOTE_RELEASE_MINIMUM_SEQUENCE = ' 7 '
        })
    $script:TestCount += 1
    Assert-ThrowsCode -ExpectedCode 'release_floor_missing' -Action {
        Get-WindowsReleaseMinimumSequence -Environment @{} | Out-Null
    }
    foreach ($invalidFloor in @('0', '-1', '07', '1e3', '65536', 'seven')) {
        Assert-ThrowsCode -ExpectedCode 'release_floor_invalid' -Action {
            Get-WindowsReleaseMinimumSequence -Environment @{
                EDIZ_REMOTE_RELEASE_MINIMUM_SEQUENCE = $invalidFloor
            } | Out-Null
        }
    }

    Assert-Equal -Expected 0 -Actual (Get-WindowsPublishReleaseSequence -Environment @{})
    Assert-Equal -Expected 12 -Actual (Get-WindowsPublishReleaseSequence -Environment @{
            EDIZ_REMOTE_RELEASE_SEQUENCE = '12'
        })
    $script:TestCount += 1
    foreach ($invalidSequence in @('-1', '007', '1.5', '65536', 'x')) {
        Assert-ThrowsCode -ExpectedCode 'release_sequence_invalid' -Action {
            Get-WindowsPublishReleaseSequence -Environment @{
                EDIZ_REMOTE_RELEASE_SEQUENCE = $invalidSequence
            } | Out-Null
        }
    }

    # --- Publish kimlik özellikleri ---
    $cleanProperties = Get-WindowsPublishIdentityProperties `
        -Version '0.1.0' `
        -Sequence 7 `
        -SourceState ([PSCustomObject]@{ Revision = $fixtureRevision; Clean = $true })
    Assert-Equal `
        -Expected ([string]::Join("`n", @(
                '-p:Version=0.1.0',
                '-p:AssemblyVersion=0.1.0.0',
                '-p:FileVersion=0.1.0.7',
                "-p:InformationalVersion=0.1.0+$fixtureRevision",
                '-p:IncludeSourceRevisionInInformationalVersion=false'))) `
        -Actual ([string]::Join("`n", $cleanProperties))
    $script:TestCount += 1

    $dirtyProperties = Get-WindowsPublishIdentityProperties `
        -Version '0.1.0' `
        -Sequence 0 `
        -SourceState ([PSCustomObject]@{ Revision = $fixtureRevision; Clean = $false })
    Assert-Equal `
        -Expected "-p:InformationalVersion=0.1.0+$fixtureRevision.dirty" `
        -Actual $dirtyProperties[3]
    $script:TestCount += 1

    Assert-ThrowsCode -ExpectedCode 'release_identity_invalid' -Action {
        Get-WindowsPublishIdentityProperties `
            -Version '0.1' `
            -Sequence 1 `
            -SourceState ([PSCustomObject]@{ Revision = $fixtureRevision; Clean = $true }) |
            Out-Null
    }
    Assert-ThrowsCode -ExpectedCode 'source_state_unavailable' -Action {
        Get-WindowsPublishIdentityProperties `
            -Version '0.1.0' `
            -Sequence 1 `
            -SourceState ([PSCustomObject]@{ Revision = 'HEAD'; Clean = $true }) |
            Out-Null
    }
    Assert-ThrowsCode -ExpectedCode 'release_sequence_invalid' -Action {
        Get-WindowsPublishIdentityProperties `
            -Version '0.1.0' `
            -Sequence 65536 `
            -SourceState ([PSCustomObject]@{ Revision = $fixtureRevision; Clean = $true }) |
            Out-Null
    }

    # --- Kaynak durumu ve imza öncesi provenance ---
    $sourceRoot = Join-Path $testRoot 'source'
    New-Item -ItemType Directory -Path $sourceRoot | Out-Null
    Assert-ThrowsCode -ExpectedCode 'source_state_unavailable' -Action {
        Get-WindowsReleaseSourceState -RepositoryRoot $sourceRoot | Out-Null
    }
    Invoke-FixtureGit -Repository $sourceRoot -Arguments @('init', '-q') | Out-Null
    [IO.File]::WriteAllText(
        (Join-Path $sourceRoot 'package.json'),
        '{ "name": "ediz-remote", "version": "0.1.0" }',
        $utf8)
    Invoke-FixtureGit -Repository $sourceRoot -Arguments @('add', 'package.json') | Out-Null
    Invoke-FixtureGit -Repository $sourceRoot -Arguments @(
        '-c', 'user.name=Ediz Remote Release Test',
        '-c', 'user.email=release-test@example.invalid',
        'commit', '-q', '-m', 'release fixture') | Out-Null
    $sourceRevision = ([string]@(Invoke-FixtureGit -Repository $sourceRoot -Arguments @(
                'rev-parse', 'HEAD'))[0]).Trim()

    $sourceState = Get-WindowsReleaseSourceState -RepositoryRoot $sourceRoot
    Assert-Equal -Expected $sourceRevision -Actual $sourceState.Revision
    Assert-Equal -Expected $true -Actual $sourceState.Clean
    Assert-Equal -Expected '0.1.0' -Actual (Get-WindowsReleasePackageVersion -RepositoryRoot $sourceRoot)
    $script:TestCount += 1

    $untrackedPath = Join-Path $sourceRoot 'untracked.cs'
    [IO.File]::WriteAllText($untrackedPath, '// untracked build input', $utf8)
    Assert-Equal -Expected $false -Actual (Get-WindowsReleaseSourceState -RepositoryRoot $sourceRoot).Clean
    $script:TestCount += 1
    Remove-Item -LiteralPath $untrackedPath -Force

    $sourceSubdirectory = Join-Path $sourceRoot 'nested'
    New-Item -ItemType Directory -Path $sourceSubdirectory | Out-Null
    Assert-ThrowsCode -ExpectedCode 'source_state_unavailable' -Action {
        Get-WindowsReleaseSourceState -RepositoryRoot $sourceSubdirectory | Out-Null
    }

    $badPackageRoot = Join-Path $testRoot 'bad-package'
    New-Item -ItemType Directory -Path $badPackageRoot | Out-Null
    Assert-ThrowsCode -ExpectedCode 'release_identity_invalid' -Action {
        Get-WindowsReleasePackageVersion -RepositoryRoot $badPackageRoot | Out-Null
    }
    [IO.File]::WriteAllText(
        (Join-Path $badPackageRoot 'package.json'),
        '{ "version": "1.0" }',
        $utf8)
    Assert-ThrowsCode -ExpectedCode 'release_identity_invalid' -Action {
        Get-WindowsReleasePackageVersion -RepositoryRoot $badPackageRoot | Out-Null
    }

    $signingRoot = Join-Path $testRoot 'signing\win-x64'
    New-Item -ItemType Directory -Path $signingRoot | Out-Null
    $signingArtifact = Join-Path $signingRoot 'EdizRemote.exe'
    $floorSeven = @{ EDIZ_REMOTE_RELEASE_MINIMUM_SEQUENCE = '7' }

    [IO.File]::WriteAllBytes($signingArtifact, (New-VersionedPeBytes `
                -FileVersion '0.1.0.7' `
                -InformationalVersion "0.1.0+$sourceRevision"))
    $signingIdentity = Assert-WindowsReleaseSigningProvenance `
        -ArtifactPath $signingArtifact `
        -RepositoryRoot $sourceRoot `
        -Environment $floorSeven
    Assert-Equal -Expected 7 -Actual $signingIdentity.Sequence
    Assert-Equal -Expected $sourceRevision -Actual $signingIdentity.SourceRevision
    $script:TestCount += 1

    Assert-ThrowsCode -ExpectedCode 'release_floor_missing' -Action {
        Assert-WindowsReleaseSigningProvenance `
            -ArtifactPath $signingArtifact `
            -RepositoryRoot $sourceRoot `
            -Environment @{} | Out-Null
    }
    Assert-ThrowsCode -ExpectedCode 'release_rollback_rejected' -Action {
        Assert-WindowsReleaseSigningProvenance `
            -ArtifactPath $signingArtifact `
            -RepositoryRoot $sourceRoot `
            -Environment @{ EDIZ_REMOTE_RELEASE_MINIMUM_SEQUENCE = '8' } | Out-Null
    }

    [IO.File]::WriteAllText($untrackedPath, '// untracked build input', $utf8)
    Assert-ThrowsCode -ExpectedCode 'provenance_dirty_source' -Action {
        Assert-WindowsReleaseSigningProvenance `
            -ArtifactPath $signingArtifact `
            -RepositoryRoot $sourceRoot `
            -Environment $floorSeven | Out-Null
    }
    Remove-Item -LiteralPath $untrackedPath -Force

    $signingCases = @(
        @{
            Code = 'provenance_dirty_source'
            FileVersion = '0.1.0.7'
            InformationalVersion = "0.1.0+$sourceRevision.dirty"
        },
        @{
            Code = 'provenance_revision_mismatch'
            FileVersion = '0.1.0.7'
            InformationalVersion = "0.1.0+$fixtureRevision"
        },
        @{
            Code = 'release_version_mismatch'
            FileVersion = '0.2.0.7'
            InformationalVersion = "0.2.0+$sourceRevision"
        },
        @{
            Code = 'release_sequence_invalid'
            FileVersion = '0.1.0.0'
            InformationalVersion = "0.1.0+$sourceRevision"
        }
    )
    foreach ($case in $signingCases) {
        [IO.File]::WriteAllBytes($signingArtifact, (New-VersionedPeBytes `
                    -FileVersion $case.FileVersion `
                    -InformationalVersion $case.InformationalVersion))
        Assert-ThrowsCode -ExpectedCode $case.Code -Action {
            Assert-WindowsReleaseSigningProvenance `
                -ArtifactPath $signingArtifact `
                -RepositoryRoot $sourceRoot `
                -Environment @{ EDIZ_REMOTE_RELEASE_MINIMUM_SEQUENCE = '1' } | Out-Null
        }
    }

    Assert-ThrowsCode -ExpectedCode 'provenance_revision_mismatch' -Action {
        Assert-WindowsReleaseSourceState `
            -Identity $identity `
            -SourceState ([PSCustomObject]@{ Revision = 'not-a-revision'; Clean = $true }) `
            -PackageVersion '0.1.0'
    }

    # --- Katalog ve bütün ağaç ---
    New-WindowsReleaseCatalog `
        -ArtifactPath $artifactPath `
        -ManifestPath $manifestPath `
        -CatalogPath $catalogPath
    $catalogValidation = Test-FileCatalog `
        -Path $releaseRoot `
        -CatalogFilePath $catalogPath `
        -Detailed `
        -Confirm:$false
    Assert-WindowsCatalogValidationFacts -Facts $catalogValidation
    Assert-Equal -Expected 'SHA256' -Actual ([string]$catalogValidation.HashAlgorithm)
    $script:TestCount += 1

    # Gate yeni kimlik/anti-rollback kontrollerini imza adımından önce uygular.
    Assert-ThrowsCode -ExpectedCode 'release_floor_missing' -Action {
        Invoke-WindowsReleaseGate `
            -ArtifactPath $artifactPath `
            -ManifestPath $manifestPath `
            -CatalogPath $catalogPath `
            -Environment @{}
    }
    Assert-ThrowsCode -ExpectedCode 'release_rollback_rejected' -Action {
        Invoke-WindowsReleaseGate `
            -ArtifactPath $artifactPath `
            -ManifestPath $manifestPath `
            -CatalogPath $catalogPath `
            -Environment @{ EDIZ_REMOTE_RELEASE_MINIMUM_SEQUENCE = '8' }
    }
    Assert-ThrowsCode -ExpectedCode 'expected_signer_missing' -Action {
        Invoke-WindowsReleaseGate `
            -ArtifactPath $artifactPath `
            -ManifestPath $manifestPath `
            -CatalogPath $catalogPath `
            -Environment $floorSeven
    }

    $assetPath = Join-Path $assetDirectory 'main.js'
    [IO.File]::WriteAllText($assetPath, 'changed-release-asset', $utf8)
    $changedCatalogValidation = Test-FileCatalog `
        -Path $releaseRoot `
        -CatalogFilePath $catalogPath `
        -Detailed `
        -Confirm:$false
    Assert-ThrowsCode -ExpectedCode 'catalog_validation_failed' -Action {
        Assert-WindowsCatalogValidationFacts -Facts $changedCatalogValidation
    }
    [IO.File]::WriteAllText($assetPath, 'release-asset', $utf8)

    [IO.File]::WriteAllBytes(
        $manifestPath,
        [byte[]]($firstManifestBytes + [byte[]](0x20)))
    $changedManifestValidation = Test-FileCatalog `
        -Path $releaseRoot `
        -CatalogFilePath $catalogPath `
        -Detailed `
        -Confirm:$false
    Assert-ThrowsCode -ExpectedCode 'catalog_validation_failed' -Action {
        Assert-WindowsCatalogValidationFacts -Facts $changedManifestValidation
    }
    [IO.File]::WriteAllBytes($manifestPath, $firstManifestBytes)

    $tamperedArtifactBytes = [byte[]]$fixtureBytes.Clone()
    $tamperedArtifactBytes[$tamperedArtifactBytes.Length - 1] =
        $tamperedArtifactBytes[$tamperedArtifactBytes.Length - 1] -bxor 0xFF
    [IO.File]::WriteAllBytes($artifactPath, $tamperedArtifactBytes)
    $changedArtifactValidation = Test-FileCatalog `
        -Path $releaseRoot `
        -CatalogFilePath $catalogPath `
        -Detailed `
        -Confirm:$false
    Assert-ThrowsCode -ExpectedCode 'catalog_validation_failed' -Action {
        Assert-WindowsCatalogValidationFacts -Facts $changedArtifactValidation
    }
    Assert-ThrowsCode -ExpectedCode 'artifact_hash_mismatch' -Action {
        Assert-WindowsArtifactMatchesManifest `
            -ArtifactPath $artifactPath `
            -Manifest $manifest
    }
    [IO.File]::WriteAllBytes($artifactPath, $fixtureBytes)

    $unexpectedPath = Join-Path $releaseRoot 'unexpected.dll'
    [IO.File]::WriteAllBytes($unexpectedPath, [byte[]](9, 9, 9))
    $expandedTreeValidation = Test-FileCatalog `
        -Path $releaseRoot `
        -CatalogFilePath $catalogPath `
        -Detailed `
        -Confirm:$false
    Assert-ThrowsCode -ExpectedCode 'catalog_validation_failed' -Action {
        Assert-WindowsCatalogValidationFacts -Facts $expandedTreeValidation
    }
    Remove-Item -LiteralPath $unexpectedPath -Force

    [IO.File]::WriteAllBytes($artifactPath, [byte[]]($fixtureBytes + [byte[]](0)))
    Assert-ThrowsCode `
        -ExpectedCode 'artifact_size_mismatch' `
        -Action {
            Assert-WindowsArtifactMatchesManifest `
                -ArtifactPath $artifactPath `
                -Manifest $manifest
        }
    [IO.File]::WriteAllBytes($artifactPath, $fixtureBytes)

    $invalidManifest = Copy-ManifestObject -Manifest $manifest
    $invalidManifest | Add-Member -NotePropertyName secret -NotePropertyValue 'x'
    Assert-ThrowsCode `
        -ExpectedCode 'manifest_schema_invalid' `
        -Action {
            Assert-WindowsReleaseManifestObject -Manifest $invalidManifest
        }

    # Kirli build'den üretilen manifest ve katalog kapıdan geçemez.
    $dirtyBytes = New-VersionedPeBytes `
        -FileVersion '0.1.0.7' `
        -InformationalVersion "0.1.0+$fixtureRevision.dirty"
    [IO.File]::WriteAllBytes($artifactPath, $dirtyBytes)
    Write-WindowsReleaseManifest `
        -ArtifactPath $artifactPath `
        -ManifestPath $manifestPath `
        -BuildId 'ediz-remote@test' | Out-Null
    New-WindowsReleaseCatalog `
        -ArtifactPath $artifactPath `
        -ManifestPath $manifestPath `
        -CatalogPath $catalogPath
    Assert-ThrowsCode -ExpectedCode 'provenance_dirty_source' -Action {
        Invoke-WindowsReleaseGate `
            -ArtifactPath $artifactPath `
            -ManifestPath $manifestPath `
            -CatalogPath $catalogPath `
            -Environment $floorSeven
    }

    # Eski bir manifest yeni EXE'nin yanında kalırsa boyut/hash bağı kapıyı kapatır.
    [IO.File]::WriteAllBytes($artifactPath, $fixtureBytes)
    $staleManifestCode = 'artifact_hash_mismatch'
    if ($dirtyBytes.Length -ne $fixtureBytes.Length) {
        $staleManifestCode = 'artifact_size_mismatch'
    }
    Assert-ThrowsCode -ExpectedCode $staleManifestCode -Action {
        Invoke-WindowsReleaseGate `
            -ArtifactPath $artifactPath `
            -ManifestPath $manifestPath `
            -CatalogPath $catalogPath `
            -Environment $floorSeven
    }
    [IO.File]::WriteAllBytes($manifestPath, $firstManifestBytes)

    # --- İmza politikası ---
    $facts = New-ValidSignatureFacts
    Assert-WindowsSignatureFacts `
        -Facts $facts `
        -ExpectedSignerSha256 ('A' * 64) `
        -SignToolExitCode 0
    $script:TestCount += 1

    $catalogFacts = [PSCustomObject]@{
        Status = 'Valid'
        HashAlgorithm = 'SHA256'
    }
    Assert-WindowsReleaseGatePolicy `
        -ArtifactSignatureFacts (New-ValidSignatureFacts) `
        -CatalogSignatureFacts (New-ValidSignatureFacts) `
        -CatalogValidationFacts $catalogFacts `
        -ExpectedSignerSha256 ('A' * 64) `
        -ArtifactSignToolExitCode 0 `
        -CatalogSignToolExitCode 0
    $script:TestCount += 1

    $badCatalogSignature = New-ValidSignatureFacts
    $badCatalogSignature.SignerCertificateSha256 = 'C' * 64
    Assert-ThrowsCode -ExpectedCode 'signer_mismatch' -Action {
        Assert-WindowsReleaseGatePolicy `
            -ArtifactSignatureFacts (New-ValidSignatureFacts) `
            -CatalogSignatureFacts $badCatalogSignature `
            -CatalogValidationFacts $catalogFacts `
            -ExpectedSignerSha256 ('A' * 64) `
            -ArtifactSignToolExitCode 0 `
            -CatalogSignToolExitCode 0
    }

    Assert-ThrowsCode -ExpectedCode 'signtool_verify_failed' -Action {
        Assert-WindowsReleaseGatePolicy `
            -ArtifactSignatureFacts (New-ValidSignatureFacts) `
            -CatalogSignatureFacts (New-ValidSignatureFacts) `
            -CatalogValidationFacts $catalogFacts `
            -ExpectedSignerSha256 ('A' * 64) `
            -ArtifactSignToolExitCode 0 `
            -CatalogSignToolExitCode 1
    }

    Assert-ThrowsCode -ExpectedCode 'catalog_hash_algorithm_invalid' -Action {
        Assert-WindowsCatalogValidationFacts -Facts ([PSCustomObject]@{
                Status = 'Valid'
                HashAlgorithm = 'SHA1'
            })
    }

    $facts = New-ValidSignatureFacts
    $facts.Status = 'NotSigned'
    Assert-ThrowsCode -ExpectedCode 'signature_invalid' -Action {
        Assert-WindowsSignatureFacts `
            -Facts $facts `
            -ExpectedSignerSha256 ('A' * 64) `
            -SignToolExitCode 0
    }

    $facts = New-ValidSignatureFacts
    $facts.SignatureType = 'Catalog'
    Assert-ThrowsCode -ExpectedCode 'signature_type_invalid' -Action {
        Assert-WindowsSignatureFacts `
            -Facts $facts `
            -ExpectedSignerSha256 ('A' * 64) `
            -SignToolExitCode 0
    }

    $facts = New-ValidSignatureFacts
    $facts.SignerCertificateSha256 = 'C' * 64
    Assert-ThrowsCode -ExpectedCode 'signer_mismatch' -Action {
        Assert-WindowsSignatureFacts `
            -Facts $facts `
            -ExpectedSignerSha256 ('A' * 64) `
            -SignToolExitCode 0
    }

    $facts = New-ValidSignatureFacts
    $facts.HasTimestamp = $false
    $facts.TimestampCertificateSha256 = $null
    Assert-ThrowsCode -ExpectedCode 'timestamp_missing' -Action {
        Assert-WindowsSignatureFacts `
            -Facts $facts `
            -ExpectedSignerSha256 ('A' * 64) `
            -SignToolExitCode 0
    }


    $facts = New-ValidSignatureFacts
    $facts.TimestampCertificateSha256 = 'invalid'
    Assert-ThrowsCode -ExpectedCode 'timestamp_invalid' -Action {
        Assert-WindowsSignatureFacts `
            -Facts $facts `
            -ExpectedSignerSha256 ('A' * 64) `
            -SignToolExitCode 0
    }

    $facts = New-ValidSignatureFacts
    Assert-ThrowsCode -ExpectedCode 'signtool_verify_failed' -Action {
        Assert-WindowsSignatureFacts `
            -Facts $facts `
            -ExpectedSignerSha256 ('A' * 64) `
            -SignToolExitCode 1
    }

    $safeSigningEnvironment = @{
        EDIZ_REMOTE_SIGNING_CERT_SHA1 = 'D' * 40
        EDIZ_REMOTE_SIGNING_TIMESTAMP_URL = 'https://timestamp.example.test/rfc3161'
        EDIZ_REMOTE_SIGNING_CERT_STORE = 'CurrentUser'
    }
    $configuration = Get-WindowsSigningConfiguration `
        -Environment $safeSigningEnvironment
    Assert-Equal -Expected ('D' * 40) -Actual $configuration.CertificateSha1
    Assert-Equal -Expected 'CurrentUser' -Actual $configuration.Store
    $script:TestCount += 1

    $expectedSignArguments = @(
        'sign',
        '/fd',
        'SHA256',
        '/sha1',
        ('D' * 40),
        '/s',
        'My',
        '/tr',
        'https://timestamp.example.test/rfc3161',
        '/td',
        'SHA256',
        $catalogPath
    )
    $actualSignArguments = Get-WindowsSignToolSigningArguments `
        -FilePath $catalogPath `
        -Configuration $configuration
    Assert-Equal `
        -Expected ([string]::Join("`n", $expectedSignArguments)) `
        -Actual ([string]::Join("`n", $actualSignArguments))
    $script:TestCount += 1

    $verifyArguments = Get-WindowsSignToolVerificationArguments `
        -FilePath $catalogPath
    Assert-Equal `
        -Expected "verify`n/pa`n/all`n/v`n/tw`n$catalogPath" `
        -Actual ([string]::Join("`n", $verifyArguments))
    $script:TestCount += 1

    $inTreeCatalogPath = Join-Path $releaseRoot 'EdizRemote.win-x64.cat'
    [IO.File]::WriteAllBytes($inTreeCatalogPath, [byte[]](1))
    Assert-ThrowsCode -ExpectedCode 'catalog_path_invalid' -Action {
        Invoke-WindowsCatalogStoreSigning `
            -ArtifactPath $artifactPath `
            -CatalogPath $inTreeCatalogPath `
            -Environment $safeSigningEnvironment
    }
    Remove-Item -LiteralPath $inTreeCatalogPath -Force

    $wrongReleaseRoot = Join-Path $testRoot 'custom-output'
    New-Item -ItemType Directory -Path $wrongReleaseRoot | Out-Null
    $wrongArtifactPath = Join-Path $wrongReleaseRoot 'EdizRemote.exe'
    [IO.File]::WriteAllBytes($wrongArtifactPath, $fixtureBytes)
    Assert-ThrowsCode -ExpectedCode 'release_path_invalid' -Action {
        Write-WindowsReleaseManifest `
            -ArtifactPath $wrongArtifactPath `
            -ManifestPath (Join-Path $wrongReleaseRoot `
                'EdizRemote.release-manifest.json') `
            -BuildId 'ediz-remote@test' | Out-Null
    }

    $unsafeSigningEnvironment = @{
        EDIZ_REMOTE_SIGNING_CERT_SHA1 = 'D' * 40
        EDIZ_REMOTE_SIGNING_TIMESTAMP_URL = 'https://timestamp.example.test/rfc3161'
        EDIZ_REMOTE_SIGNING_PFX_PASSWORD = 'sentinel-release-password'
    }
    Assert-ThrowsCode `
        -ExpectedCode 'unsafe_private_key_configuration' `
        -Action {
            Get-WindowsSigningConfiguration `
                -Environment $unsafeSigningEnvironment | Out-Null
        }

    $insecureTimestampEnvironment = @{
        EDIZ_REMOTE_SIGNING_CERT_SHA1 = 'D' * 40
        EDIZ_REMOTE_SIGNING_TIMESTAMP_URL = 'http://timestamp.example.test/'
    }
    Assert-ThrowsCode -ExpectedCode 'timestamp_url_invalid' -Action {
        Get-WindowsSigningConfiguration `
            -Environment $insecureTimestampEnvironment | Out-Null
    }

    $secretTimestampEnvironment = @{
        EDIZ_REMOTE_SIGNING_CERT_SHA1 = 'D' * 40
        EDIZ_REMOTE_SIGNING_TIMESTAMP_URL = 'https://timestamp.example.test/rfc3161?token=ER_SENTINEL'
    }
    Assert-ThrowsCode -ExpectedCode 'timestamp_url_invalid' -Action {
        Get-WindowsSigningConfiguration `
            -Environment $secretTimestampEnvironment | Out-Null
    }

    [IO.File]::WriteAllBytes($manifestPath, [byte[]]::new(16385))
    Assert-ThrowsCode -ExpectedCode 'manifest_too_large' -Action {
        Read-WindowsReleaseManifest `
            -ArtifactPath $artifactPath `
            -ManifestPath $manifestPath | Out-Null
    }

    [IO.File]::WriteAllBytes($manifestPath, [byte[]](0xC3, 0x28))
    Assert-ThrowsCode -ExpectedCode 'manifest_invalid' -Action {
        Read-WindowsReleaseManifest `
            -ArtifactPath $artifactPath `
            -ManifestPath $manifestPath | Out-Null
    }

    Write-Host ('WINDOWS_RELEASE_TESTS_OK:{0}' -f $script:TestCount)
}
finally {
    $env:GIT_CONFIG_GLOBAL = $previousGitGlobal
    $env:GIT_CONFIG_NOSYSTEM = $previousGitNoSystem
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}

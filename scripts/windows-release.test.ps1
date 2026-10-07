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

$testRoot = Join-Path `
    ([IO.Path]::GetTempPath()) `
    ('EdizRemote.ReleaseTests.{0}' -f [guid]::NewGuid().ToString('N'))
$releaseRoot = Join-Path $testRoot 'win-x64'
$artifactPath = Join-Path $releaseRoot 'EdizRemote.exe'
$manifestPath = Join-Path $releaseRoot 'EdizRemote.release-manifest.json'
$catalogPath = Join-Path $testRoot 'EdizRemote.win-x64.cat'

try {
    New-Item -ItemType Directory -Path $releaseRoot | Out-Null
    [IO.File]::WriteAllBytes($artifactPath, [byte[]](1, 3, 3, 7))
    $assetDirectory = Join-Path $releaseRoot 'web\assets'
    New-Item -ItemType Directory -Path $assetDirectory | Out-Null
    [IO.File]::WriteAllText(
        (Join-Path $assetDirectory 'main.js'),
        'release-asset',
        [Text.UTF8Encoding]::new($false))

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

    $assetPath = Join-Path $assetDirectory 'main.js'
    [IO.File]::WriteAllText(
        $assetPath,
        'changed-release-asset',
        [Text.UTF8Encoding]::new($false))
    $changedCatalogValidation = Test-FileCatalog `
        -Path $releaseRoot `
        -CatalogFilePath $catalogPath `
        -Detailed `
        -Confirm:$false
    Assert-ThrowsCode -ExpectedCode 'catalog_validation_failed' -Action {
        Assert-WindowsCatalogValidationFacts -Facts $changedCatalogValidation
    }
    [IO.File]::WriteAllText(
        $assetPath,
        'release-asset',
        [Text.UTF8Encoding]::new($false))

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

    [IO.File]::WriteAllBytes($artifactPath, [byte[]](1, 3, 3, 8))
    $changedArtifactValidation = Test-FileCatalog `
        -Path $releaseRoot `
        -CatalogFilePath $catalogPath `
        -Detailed `
        -Confirm:$false
    Assert-ThrowsCode -ExpectedCode 'catalog_validation_failed' -Action {
        Assert-WindowsCatalogValidationFacts -Facts $changedArtifactValidation
    }
    [IO.File]::WriteAllBytes($artifactPath, [byte[]](1, 3, 3, 7))

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

    [IO.File]::WriteAllBytes($artifactPath, [byte[]](1, 3, 3, 7, 9))
    Assert-ThrowsCode `
        -ExpectedCode 'artifact_size_mismatch' `
        -Action {
            Assert-WindowsArtifactMatchesManifest `
                -ArtifactPath $artifactPath `
                -Manifest $manifest
        }
    [IO.File]::WriteAllBytes($artifactPath, [byte[]](1, 3, 3, 7))

    [IO.File]::WriteAllBytes($artifactPath, [byte[]](1, 3, 3, 8))
    Assert-ThrowsCode `
        -ExpectedCode 'artifact_hash_mismatch' `
        -Action {
            Assert-WindowsArtifactMatchesManifest `
                -ArtifactPath $artifactPath `
                -Manifest $manifest
        }
    [IO.File]::WriteAllBytes($artifactPath, [byte[]](1, 3, 3, 7))

    $invalidManifest = $manifest | ConvertTo-Json -Depth 4 | ConvertFrom-Json
    $invalidManifest | Add-Member -NotePropertyName secret -NotePropertyValue 'x'
    Assert-ThrowsCode `
        -ExpectedCode 'manifest_schema_invalid' `
        -Action {
            Assert-WindowsReleaseManifestObject -Manifest $invalidManifest
        }

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
    [IO.File]::WriteAllBytes($wrongArtifactPath, [byte[]](1))
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
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}

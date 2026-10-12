# Windows release imzası, katalog ve bütünlük kapısı

`desktop:publish` paketi imzalamaz; yalnız release kimliğini ve kaynak
provenance'ını EXE'nin Windows sürüm kaynağına gömer. Üretim adayı ayrı bir
adımda imzalanır ve fail-closed kapıdan geçirilir. Gerçek bir code signing
sertifikası olmadan bu kapı başarı vermez.

Depo sahibinin 2026-10-11 kararıyla sertifika gelene kadar yayınlar imzasız
**provenance (GitHub attestation) yolu** ile çıkar: bütünlük ve kaynak, GitHub'da
derlenen ağacın provenance manifesti, SHA256SUMS ve Sigstore SLSA build
provenance attestation'ı ile doğrulanır; işletim sistemi düzeyinde yayıncı güveni
yoktur. Ayrıntı [aşağıdaki bölümdedir](#provenance-github-attestation-yolu).
Authenticode yolu değişmeden kalır.

Akış PowerShell 7 gerektirir. NPM komutları Windows PowerShell 5.1 üzerinden
başlatılsa bile script kurulu `pwsh.exe` sürecine argüman dizisiyle kendini tekrar
başlatır; PowerShell 7 bulunamazsa sabit `powershell_version_unsupported` koduyla
kapanır. Bunun nedeni katalog doğrulaması sırasında yayın dosyalarında no-write/
no-delete handle'ları korumaktır.

## Güven sınırı

Release kapısı aşağıdakilerin tamamını zorunlu tutar:

- `EdizRemote.release-manifest.json` strict şema v2'dir; beklenmeyen alan, farklı
  dosya adı, şema v1 veya 16 KiB üzeri kayıt reddedilir.
- Manifestin release ve provenance alanları EXE'nin gömülü kimliğiyle birebir
  aynıdır; kirli kaynaktan üretilmiş, sequence'i `0` olan veya güvenilir
  anti-rollback tabanının altında kalan paket reddedilir (aşağıdaki bölüm).
- Manifestteki byte uzunluğu ve SHA-256, diskteki `EdizRemote.exe` ile birebir
  eşleşir.
- Yayın kökü `artifacts/windows-desktop/win-x64` tek bir klasör olarak kataloglanır.
  Böylece EXE, yayınlanan DLL/JSON dosyaları, `web` varlıkları ve release manifesti
  dahil ağacın tamamı katalog kapsamındadır. Reparse point içeren veya 8192 dosya,
  1024 klasör ya da 1 MiB göreli yol bütçesini aşan ağaç reddedilir.
- SHA-256 Windows File Catalog, öz-kapsama/circular hash oluşturmaması için yayın
  ağacının dışında, kardeş
  `artifacts/windows-desktop/EdizRemote.win-x64.cat` yolunda tutulur.
- Hem EXE hem katalog imzası `Get-AuthenticodeSignature` için `Valid`, türü
  `Authenticode` ve signer sertifikasının SHA-256 parmak izi açık allowlist ile
  birebir aynı olmalıdır. İkisinde de timestamp sertifikası bulunmalıdır.
- Windows SDK `signtool verify /pa /all /v /tw`, EXE ve katalog için ayrı ayrı
  sıfır koduyla bitmelidir. Araç çıktısı loga aktarılmaz.
- `Test-FileCatalog -Detailed` sonucu `Valid`, katalog hash algoritması `SHA256`
  olmalıdır. Dosya atlama seçeneği kullanılmaz.

Dosya ve klasör yolları yerel, reparse içermeyen release alanıyla sınırlandırılır.
Manifest 16 KiB, katalog 16 MiB ile sınırlıdır. Katalog üretimi ve doğrulaması
sırasında yayın dosyaları read-only/no-write/no-delete handle'larla tutulur; işlem
öncesi ve sonrası ağaç listesi tekrar karşılaştırılır. Başarısızlık ayrıntısı,
sertifika subject'i veya araç çıktısı basılmaz; yalnız sabit bir hata kodu döner.
`NotSigned`, yanlış signer, eksik timestamp, değişmiş hash, geçersiz katalog,
eksik `signtool` veya eksik allowlist ayrı ayrı başarısızdır.

## Release kimliği, anti-rollback ve build provenance

Her `desktop:publish` çıktısı kaynağını kendi Windows sürüm kaynağında taşır:

| Alan | Değer | Kaynak |
|---|---|---|
| `ProductVersion` | `<sürüm>+<40 hex commit>`; kirli ağaçta `<sürüm>+<commit>.dirty` | Kök `package.json` sürümü ve `git rev-parse HEAD` |
| `FileVersion` | `<sürüm>.<sequence>` | `EDIZ_REMOTE_RELEASE_SEQUENCE`; verilmezse `0` |
| `AssemblyVersion` | `<sürüm>.0` | Kök `package.json` sürümü |

- Kaynak durumu web build'inden önce ve EXE üretildikten sonra
  `git status --porcelain=v1 --untracked-files=all` ile okunur. `.gitignore`
  dışındaki izlenmeyen dosya da kirliliktir; SDK glob'u veya web import'u onu
  derleyebilir. Publish sırasında commit ya da kirlilik değişirse yeni EXE silinir
  ve komut başarısız olur. Proje kökü git kökü değilse kimlik üretilmez.
- Sürüm parçaları başında sıfır olmayan 0–65534 ondalık değerlerdir. Sequence her
  production yayınında artan 1–65535 tamsayısıdır; `0` geliştirme paketidir ve
  hiçbir release kapısından geçemez.
- Manifest şema v2 `release.version`, `release.sequence`,
  `provenance.sourceRepository`, `provenance.sourceRevision` ve
  `provenance.sourceTreeClean` alanlarını elle almaz; EXE'nin sürüm kaynağından
  okur. Metin `FileVersion`/`ProductVersion` ile `VS_FIXEDFILEINFO` sayısal sürümü
  uyuşmazsa kimlik reddedilir (`release_identity_invalid`).
- Manifest yayın ağacının içinde olduğundan imzalı SHA-256 katalog kapsamındadır;
  provenance beyanı release signer'ının bütünlük korumasıyla taşınır. Yeni publish
  bir önceki EXE'yi tarif eden manifesti siler.

`release:windows:sign`, hiçbir imza veya timestamp isteği göndermeden önce şunları
zorunlu tutar:

1. Güvenilir release ayarından gelen `EDIZ_REMOTE_RELEASE_MINIMUM_SEQUENCE`
   (1–65535). Yoksa `release_floor_missing`, bozuksa `release_floor_invalid`.
2. EXE temiz ağaçtan üretilmiş ve imza anında depo da temiz olmalıdır
   (`provenance_dirty_source`).
3. Gömülü commit imza anındaki `HEAD` ile (`provenance_revision_mismatch`), EXE
   sürümü kök `package.json` sürümüyle aynıdır (`release_version_mismatch`).
4. Sequence 1 veya üzeridir (`release_sequence_invalid`) ve tabandan küçük değildir
   (`release_rollback_rejected`).

`release:windows:verify` aynı tabanı ister; imza kontrollerinden önce manifest ile
EXE kimliğini (`release_identity_mismatch`), temiz kaynak bayrağını ve tabanı
doğrular. Taban yayımlanmış en yüksek sequence'tir: yeni yayın imzalanırken
`önceki + 1`, indirilen bir yayın doğrulanırken bilinen en yüksek sequence verilir.
Böylece aynı anahtarla imzalanmış eski ve açıklı bir paket yeni sürüm diye yeniden
dağıtılamaz. Eski wire sürümlü istemciler signaling'de ayrıca reddedilir
(`ediz-remote.v3`).

Faz 5 güncelleyicisinin sözleşmesi: kurulu uygulama kendi `FileVersion`
sequence'ini okur ve küçük ya da eşit sequence taşıyan güncellemeyi uygulamaz.
Güncelleyici henüz yoktur; bu dilim yalnız kimliği ve kapıyı hazırlar.

Bu model tek geliştirici makinesinde kaynak provenance'ı sağlar; barındırılan,
izole bir build platformu veya imzalı SLSA attestation'ı değildir; bunu
aşağıdaki provenance yolu GitHub-hosted build ve Sigstore SLSA attestation ile
tamamlar. .NET SDK ve Node sürümleri commit'e sabitlenmez; production yayın
kaydına ayrıca yazılmalıdır.

## Komutlar

Geliştirme sırasında normal self-contained paketi ve imzasız manifesti üretmek
mümkündür:

```powershell
npm run desktop:publish
npm run release:windows:manifest
```

İkinci komut deterministik SHA-256 manifestini EXE'nin yanına yazar. İmzasız
geliştirme adayında da manifest üretilebilir; katalog ve iki geçerli imza olmadan
bu işlem production kabulü değildir. Manifest komutu daha önce imzalanmış bir
katalogu doğal olarak geçersiz kılar; production sırası aşağıdaki `sign` komutuyla
tek akışta yürütülmelidir.

Production adayı temiz bir klondan (izlenmeyen dosya olmadan) ve artan sequence
ile üretilir:

```powershell
git status --porcelain=v1 --untracked-files=all   # boş olmalı
$env:EDIZ_REMOTE_RELEASE_SEQUENCE = '<önceki yayın + 1>'
npm run desktop:publish
```

Release doğrulaması için signer sertifikasının public SHA-256 parmak izini ve
anti-rollback tabanını güvenilir CI/release ayarından ver:

```powershell
$env:EDIZ_REMOTE_RELEASE_SIGNER_SHA256 = '<64 hexadecimal characters>'
$env:EDIZ_REMOTE_RELEASE_MINIMUM_SEQUENCE = '<bilinen en yüksek sequence>'
npm run release:windows:verify
```

Yerel politika testleri gerçek sertifika veya `signtool` gerektirmez:

```powershell
npm run release:windows:test
```

## Parolasız store/HSM imzalama

Repo akışı PFX dosyası veya parolası kabul etmez. Signing key Windows Certificate
Store, donanım anahtarı ya da CI'ın store'a sunduğu non-exportable anahtar içinde
kalmalıdır. Aşağıdaki değerler secret değildir; yalnız sertifika seçici ve public
politika bilgisidir:

```powershell
$env:EDIZ_REMOTE_SIGNING_CERT_SHA1 = '<40 hexadecimal characters>'
$env:EDIZ_REMOTE_RELEASE_SIGNER_SHA256 = '<64 hexadecimal characters>'
$env:EDIZ_REMOTE_RELEASE_MINIMUM_SEQUENCE = '<bu yayının sequence değeri>'
$env:EDIZ_REMOTE_SIGNING_TIMESTAMP_URL = 'https://timestamp-provider.example/rfc3161'
$env:EDIZ_REMOTE_SIGNING_CERT_STORE = 'CurrentUser' # veya LocalMachine
$env:EDIZ_REMOTE_SIGNTOOL_PATH = 'C:\Program Files (x86)\Windows Kits\10\bin\<sdk>\x64\signtool.exe'
npm run release:windows:sign
```

Zaman damgası sağlayıcısı kod imzalama sertifikasını veren CA'dan bağımsız seçilebilir.
2026-10-09'da `https://timestamp.sectigo.com` HTTPS üzerinden RFC3161 `Granted` yanıtı
verdi; DigiCert, GlobalSign, SSL.com ve Entrust'ın belgelenen uç noktaları HTTPS
bağlantısını kabul etmedi. Windows'un güvenmediği sağlayıcılar (ör. FreeTSA)
`signtool verify /tw` doğrulamasından geçmez; HTTPS şartı gevşetilmez.

`release:windows:sign` önce yukarıdaki provenance ve anti-rollback ön koşullarını
doğrular; ardından sırasıyla EXE'yi imzalar, imzalı EXE'nin manifestini yazar,
yayın ağacı için catalog version 2 (SHA-256) üretir, kataloğu aynı sertifikayla
imzalar ve iki imza + katalog bütünlük kapısını çalıştırır. Store'daki sertifika
`signtool /sha1` ile seçilir; EXE ve katalog imzalarında
`/fd SHA256 /tr <HTTPS URL> /td SHA256` kullanılarak RFC3161 timestamp istenir.
Timestamp URL'si HTTPS olmalı; userinfo, query ve fragment taşıyamaz. Araç çıktısı
bastırılır. `EDIZ_REMOTE_SIGNING_PFX_PATH`, `...PFX_PASSWORD`,
`...CERTIFICATE_PASSWORD` veya `...SIGNING_PASSWORD` tanımlıysa işlem bilinçli
olarak reddedilir.

Microsoft'un davranış sözleşmesine göre `New-FileCatalog` version 2 SHA-256
kullanır ve tek klasör girdisinde göreli yolları koruyarak ağacı recursive
kataloglar; `Test-FileCatalog` ise katalogdaki hash'leri gerçek ağaçla karşılaştırır.
SignTool'da `/fd` dosya digest'ini, `/tr` + `/td` RFC3161 timestamp digest'ini
seçer: [New-FileCatalog](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/new-filecatalog),
[Test-FileCatalog](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/test-filecatalog),
[SignTool](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool).

## Provenance (GitHub attestation) yolu

Ücretli Authenticode sertifikası şimdilik yoktur (depo sahibi kararı,
2026-10-11). Faz 4'ün "yayınlanan Windows binary'sinin bütünlüğü ve kaynağı
doğrulanabilir" kriteri, GitHub Actions'ta derlenen EXE için **GitHub artifact
attestation** (Sigstore, SLSA build provenance `https://slsa.dev/provenance/v1`)
ve depoya ait provenance manifesti ile karşılanacaktır. Yukarıdaki Authenticode +
katalog yolu aynen kalır, gevşetilmez; sertifika geldiğinde kullanılır.

### Ne kanıtlar, ne kanıtlamaz

Kanıtlar:

- Dağıtılan `win-x64` ağacındaki her dosyanın yolu, boyutu ve SHA-256'sı
  provenance manifestiyle birebir aynıdır; eksik, fazla veya değişmiş dosya yoktur.
- EXE ve provenance manifesti `EddizEge/ediz-remote` deposunun `main` dalındaki,
  manifestte yazan commit'ten `.github/workflows/windows-release.yml` workflow'u
  tarafından GitHub-hosted runner üzerinde derlenip attest edilmiştir. Bu bilgi
  Sigstore sertifikasındaki GitHub OIDC alanlarından gelir, workflow çıktısından
  değil.
- EXE'nin gömülü kimliği (sürüm, sequence, commit, temiz ağaç) manifestle aynıdır
  ve sequence güvenilir anti-rollback tabanının altında değildir.

Kanıtlamaz:

- İşletim sistemi düzeyinde yayıncı güveni yoktur. EXE Authenticode imzasızdır
  (`NotSigned`); Windows SmartScreen ilk çalıştırmada uyarı verir ve kullanıcının
  "Ek bilgi → Yine de çalıştır" demesi gerekir. Bu, depo sahibinin 2026-10-11'de
  kabul ettiği artık risktir ([`THREAT_MODEL.md` ER-T13](THREAT_MODEL.md)).
- Windows attestation'ı kendiliğinden kontrol etmez. Doğrulama ancak indiren kişi
  `gh attestation verify` veya `release:windows:verify-provenance` çalıştırırsa ya
  da SHA-256'yı yayın sayfasıyla karşılaştırırsa yapılır.
- GitHub hesabı veya `main` dalı ele geçirilirse saldırgan da geçerli attestation
  üretebilir; branch koruması ve hesap güvenliği bu modelin parçasıdır.

### Ön koşullar ve çıktılar

`release:windows:provenance`, `release:windows:sign` ile aynı katılıkta ve dosya
yazmadan önce şunları zorunlu tutar: `EDIZ_REMOTE_RELEASE_MINIMUM_SEQUENCE`
(`release_floor_missing`/`release_floor_invalid`), temiz git ağacı ve `.dirty`
taşımayan EXE (`provenance_dirty_source`), EXE commit'i = `HEAD`
(`provenance_revision_mismatch`), kök `package.json` sürümü
(`release_version_mismatch`), sequence ≥ 1 (`release_sequence_invalid`) ve taban
(`release_rollback_rejected`). Yayın ağacı Authenticode yolunun
`EdizRemote.release-manifest.json` dosyasını içeriyorsa iki mod karışmasın diye
`provenance_mode_conflict` ile reddedilir. Ağaç kilidi (no-write/no-delete
handle), reparse point, `..`, mutlak yol, büyük/küçük harf çakışması ve 8192
dosya / 1024 klasör / 1 MiB yol bütçesi katalog yolundaki kontrollerle aynıdır;
hash'ler hesaplanırken commit veya ağaç değişirse kayıt yazılmaz.

Çıktılar `win-x64` klasörünün kardeşidir; manifest kendi özetini kapsamaz:

| Dosya | İçerik |
|---|---|
| `artifacts/windows-desktop/EdizRemote.win-x64.provenance.json` | Strict şema `1`: `schemaVersion`, `product`, `integrity: "github-attestation"`, `buildId`, `release` (`version`, `sequence`), `source` (`repository: "EddizEge/ediz-remote"`, `revision`, `treeClean`), `attestation` (`predicateType`, `signerWorkflow`, `sourceRef`), `tree` (`root: "win-x64"`, `fileCount`, `totalBytes`, `files[]` = `path`, `sizeBytes`, küçük harf `sha256`) |
| `artifacts/windows-desktop/EdizRemote.win-x64.SHA256SUMS` | `sha256sum -c` biçimi: `<küçük harf hex>  win-x64/<yol>` satırları, LF; provenance manifestinin özeti dahil değildir |

Manifest kanonik bayt biçimindedir (PowerShell 7 JSON yazıcısı, LF, BOM'suz UTF-8,
sonda tek LF; en fazla 4 MiB). Doğrulayıcı aynı biçimi yeniden üretip byte byte
karşılaştırır; beklenmeyen/eksik alan, yinelenen anahtar, yeniden biçimlendirme,
ordinal sırada olmayan veya normalize edilmemiş yol (`\`, `/` ile başlayan,
sürücü, `.`/`..`, kontrol karakteri, nokta/boşluk soneki) reddedilir. Manifestteki
`attestation` alanları yalnız beyandır; doğrulama politikası kodda sabittir ve
manifest bu sabitlerden farklıysa reddedilir. Authenticode manifesti (şema 2) bu
yolda, provenance manifesti Authenticode yolunda kabul edilmez. `desktop:publish`
önceki pakete ait provenance ve SHA256SUMS dosyalarını siler; başarısız bir
`provenance` koşusu geride çıktı bırakmaz.

### Doğrulama

`release:windows:verify-provenance` sırasıyla tabanı
(`EDIZ_REMOTE_RELEASE_MINIMUM_SEQUENCE` zorunlu), yolları, ağaç kilidini, manifest
şemasını ve kanonik baytlarını, ağaç ↔ manifest eşliğini
(`provenance_tree_mismatch`), SHA256SUMS'un manifestten üretilen metinle birebir
aynılığını (`provenance_checksums_invalid`), EXE `ProductVersion`/`FileVersion` ↔
manifest kimliğini (`release_identity_mismatch`), temiz kaynağı ve tabanı
doğrular. Ardından EXE ve provenance manifesti için ayrı ayrı şu çağrıyı argüman
dizisiyle yapar:

```powershell
gh attestation verify <dosya> --repo EddizEge/ediz-remote `
  --signer-workflow EddizEge/ediz-remote/.github/workflows/windows-release.yml `
  --signer-digest <manifestteki commit> --source-ref refs/heads/main `
  --source-digest <manifestteki commit> --predicate-type https://slsa.dev/provenance/v1 `
  --cert-oidc-issuer https://token.actions.githubusercontent.com `
  --deny-self-hosted-runners --format json
```

Çıkış kodu sıfır olmalıdır; JSON çıktısındaki her doğrulanmış attestation için
`statement.predicateType`, dosyanın SHA-256'sını taşıyan `subject` ve sertifikanın
`issuer`, `sourceRepositoryURI`, `sourceRepositoryDigest`, `sourceRepositoryRef`,
`buildSignerURI`, `buildSignerDigest` ve `runnerEnvironment = github-hosted`
alanları ayrıca kontrol edilir. Workflow tarafından değiştirilebilen
`statement.predicate` güven kaynağı sayılmaz. `gh` bulunamazsa
`provenance_tool_missing`, doğrulama düşerse `provenance_attestation_invalid`
döner; `gh` stderr çıktısı loga aktarılmaz. `gh` yolu `EDIZ_REMOTE_GH_PATH` ile
verilebilir (dosya adı `gh.exe`, yerel ve reparse içermeyen yol); verilmezse
`PATH`'teki `gh.exe` kullanılır. Bayraklar ve JSON alan adları gh 2.96.0 ile
gerçek bir public attestation üzerinde doğrulandı; bu bayrakları tanımayan eski
gh sürümü fail-closed düşer. Çağrı `GH_TOKEN` veya `gh auth` oturumuyla GitHub
API'sinden attestation'ları okur.

```powershell
git status --porcelain=v1 --untracked-files=all   # boş olmalı
$env:EDIZ_REMOTE_RELEASE_SEQUENCE = '<önceki yayın + 1>'
npm run desktop:publish
$env:EDIZ_REMOTE_RELEASE_MINIMUM_SEQUENCE = '<bu yayının sequence değeri>'
npm run release:windows:provenance

# İndirilen yayını doğrulama (artifacts/windows-desktop altında win-x64 +
# provenance.json + SHA256SUMS):
$env:EDIZ_REMOTE_RELEASE_MINIMUM_SEQUENCE = '<bilinen en yüksek sequence>'
npm run release:windows:verify-provenance
```

Başka bir klasör için `scripts/windows-release.ps1 verify-provenance -ArtifactPath
<klasör>\win-x64\EdizRemote.exe` kullanılabilir; provenance ve SHA256SUMS yine
`win-x64` klasörünün kardeşi olmalıdır (`-ProvenancePath`/`-ChecksumsPath` aynı
kurala bağlıdır).

Hata kodları: `provenance_path_invalid`, `provenance_manifest_invalid`,
`provenance_manifest_too_large`, `provenance_mode_conflict`,
`provenance_tree_mismatch`, `provenance_checksums_invalid`,
`provenance_tool_missing`, `provenance_attestation_invalid`; ayrıca ortak
`release_*`, `provenance_dirty_source`, `provenance_revision_mismatch`,
`source_state_unavailable` ve `release_tree_*` kodları. Hata satırı
`WINDOWS_RELEASE_PROVENANCE_FAILED:<kod>` veya
`WINDOWS_RELEASE_VERIFY_PROVENANCE_FAILED:<kod>` biçimindedir; başarıda
`WINDOWS_RELEASE_PROVENANCE_OK` ve `WINDOWS_RELEASE_PROVENANCE_VERIFY_OK` basılır.

### CI akışı

Workflow `.github/workflows/windows-release.yml` (`windows-release`) yalnız elle
(`workflow_dispatch`) ve yalnız `refs/heads/main` üzerinden çalışır. Tek girdi
`sequence`dır (1–65535, başında sıfır yok); `run:` bloklarına `${{ }}` ile
gömülmez, `env:` üzerinden verilir. Üst düzey yetki `permissions: {}`, eşzamanlılık
`windows-release` grubunda tek koşu (çalışan koşu iptal edilmez), cache yoktur.
Bütün `uses:` adımları tam commit SHA'sına sabit GitHub action'larıdır
(`actions/checkout`, `setup-node`, `upload-artifact`, `download-artifact`,
`attest-build-provenance`); üçüncü taraf action yoktur. Runner'ın 8.3 kısa adlı
`TEMP`'i iki işte de kısa adsız `RUNNER_TEMP`'e alınır; yol kontrolleri
gevşetilmez.

1. `build` işi (`windows-2025`, yalnız `contents: read`, secret ve `id-token`
   yok): depo/dal/sequence doğrulaması → checkout ve commit = `GITHUB_SHA` →
   Node 22 → `npm ci` → `build` → `test` → `lint` → `native:test` →
   `desktop:test` → `release:windows:test` → `security:audit` → temiz ağaç kapısı →
   girdi sequence ile `desktop:publish` → aynı değer taban olarak
   `release:windows:provenance` → `artifacts/windows-desktop/` düzeni tam olarak
   `win-x64/` + provenance.json + SHA256SUMS ise 7 günlük artifact olarak yüklenir.
2. `release` işi (`needs: build`, environment `windows-release`; `contents`,
   `id-token`, `attestations: write`; npm/node çalıştırmaz): artifact indirilir;
   ağaç SHA256SUMS'a karşı yeniden doğrulanır (eksik/fazla/yinelenen dosya, yol
   kaçışı, reparse point, hash); EXE `ProductVersion = <sürüm>+<commit>` ve
   `FileVersion = <sürüm>.<sequence>` kontrol edilir; anti-rollback için taslaklar
   dahil sürümler ve `windows-v*` tag'lerindeki en yüksek sequence'ten büyük olma
   ve tag'in bulunmaması zorunludur. Tam ağaç `EdizRemote.win-x64.zip` olarak
   paketlenip içeriği SHA256SUMS ile karşılaştırılır. EXE, provenance.json,
   SHA256SUMS ve zip `actions/attest-build-provenance` ile attest edilir; ardından
   depo betiği `powershell -File scripts/windows-release.ps1 verify-provenance`
   (`GH_TOKEN` ile) çalışır ve `gh release create --draft` ile
   `windows-v<sürüm>.<sequence>` taslak yayını dört dosyayla açılır. Yayın
   notları önce destek alan/veren için Türkçe kullanım adımlarını (zip'i açma,
   SmartScreen "Ek bilgi → Yine de çalıştır", kod, onay seçenekleri,
   revoke/bitir/acil durdurma, WebView2 gereksinimi), sonra commit/sequence/build
   kimliğini, dört dosyanın SHA-256 değerlerini ve `gh attestation verify`
   komutunu içerir. Yayını depo sahibi (ya da onun izniyle yönetici) elle yayımlar.

EXE tek başına çalışmaz (yanında `Web/` ve `ediz-remote.settings.json` gerekir);
dağıtım birimi zip'tir. Zip açıldığında `win-x64/` ağacı SHA256SUMS ile birebir
eşleşmelidir. Depo sahibi `windows-release` environment'ına onay kuralı
(required reviewer) ve yalnız `main` dal kısıtı ekleyebilir.

### Yerel kanıt ve kalan iş

2026-10-11: release politika/katalog/provenance testleri 234/234 geçti (123'ü
provenance; gerçek `gh` veya ağ kullanılmaz, attestation çağrısı enjekte edilir).
Kasıtlı mutasyonlar (ağaç hash karşılaştırması, fazla dosya reddi, attestation
çıkış kodu) testte düştü. Temiz ağaçta `3091505` commit'inden sequence `1` ile
publish edilen gerçek aday (`184859904` bayt, SHA-256
`B76FC9718E2AAB877552E8261850CBC834AAD4EB70251B1C08E7366F632D3554`,
`ProductVersion 0.1.0+30915050ca8dcdc1efc82bc0f6d7933f21ede0a8`,
`FileVersion 0.1.0.1`, `NotSigned`) için `provenance` 12 dosyalık manifest ve
SHA256SUMS üretti; yeniden üretim aynı baytları verdi, `sha256sum -c` geçti.
Tabansız koşu `release_floor_missing`, izlenmeyen dosyalı ağaç
`provenance_dirty_source` (çıktı bırakmadan) ile kapandı. `verify-provenance`
yerelde attestation olmadığı için beklenen `provenance_attestation_invalid`,
`gh` yolu yokken `provenance_tool_missing`, taban 2 ile
`release_rollback_rejected`, değiştirilmiş veya fazla dosyada
`provenance_tree_mismatch` verdi. Aynı ağaçta Authenticode `verify`
`catalog_missing` ile kapanmaya devam eder.

### İlk GitHub koşusu (2026-10-11)

İlk iki koşu `build` işinde fail-closed düştü ve sürüm oluşmadı: runner'ın 8.3
kısa adlı `TEMP`'i container yol kontrolünde `path_unsafe` verdi (`3fed2b1` ile
geçici dizin `RUNNER_TEMP`'e alındı, kontrol gevşetilmedi) ve bir container testi
yerel klasör adına bağlıydı (`8701f78`). Üçüncü koşu (Actions run `38107001498`,
`windows-2025`, commit `8701f78a11f368e784139d234a3cba6a8b26efda`, sequence `1`)
iki işte de başarılı oldu: bütün test/lint/build/audit kapıları, publish,
`provenance`, ağaç yeniden doğrulaması, attestation ve CI içindeki
`verify-provenance` geçti; `windows-v0.1.0.1` **taslak** yayını açıldı.

| Dosya | Boyut | SHA-256 |
|---|---|---|
| `EdizRemote.exe` | `184859904` | `b1e77dc5ecd56208e1ca99c64e7126ea1eb860350e0a94cf1794f17cfde8f516` |
| `EdizRemote.win-x64.zip` | `79933844` | `3e9952464ca3e62b34a787b7766bc8028d8a4661f3bed0b672535899be75783b` |
| `EdizRemote.win-x64.provenance.json` | `2724` | `977e44a1528f4bcb39e20d6daf4f803150c64082f5695799f6caec6599d59171` |
| `EdizRemote.win-x64.SHA256SUMS` | `1188` | `964eb23173148c1ee4756cc2b8eb42a6383e28f6148ed87a2dbdf026f2ced41c` |

EXE kimliği `ProductVersion 0.1.0+8701f78a11f368e784139d234a3cba6a8b26efda`,
`FileVersion 0.1.0.1`, Authenticode `NotSigned`. Bağımsız doğrulama (ayrı bir
Windows makinesi, taslaktan indirilen dosyalar): dört dosya için yukarıdaki en sıkı
`gh attestation verify` politikası (signer/source digest = commit,
`github-hosted`) başarılı, yanlış commit ile doğrulama düştü; zip içindeki EXE
tekil EXE ile aynı; zip'ten açılan ağaçta `verify-provenance` (taban 1)
`WINDOWS_RELEASE_PROVENANCE_VERIFY_OK`, bir dosya değiştirilince
`provenance_tree_mismatch`, taban 2 ile `release_rollback_rejected`.

2026-10-12 production denemesi (geliştirme makinesi, temiz Windows değil): zip
SHA-256 yeniden doğrulanıp açıldı, ağaç SHA256SUMS ile 12/12 eşleşti. EXE
varsayılan ayarla `wss://remote.edizegemercan.com.tr/ws`'ye bağlandı; production
v3 üzerinden headless Edge guest ile dokuz gerçek oturum kuruldu: doğrudan P2P
2560×1440 GPU H.264, view+control (`pointer.move` ile gerçek imleç), revoke,
ayrılma; guest relay'e zorlandığında TURN relay↔relay; ICE/native lane arızası,
retry ve ani guest kaybında zarif hata/kurtarma. Oturumlardan birinde (zorlanmış
relay, video kurulamadı, guest kapanırken) EXE `0xC0000005` ile kapandı (`ntdll`,
serbest bırakılmış `CRITICAL_SECTION`; ER-T15). Bu nedenle `windows-v0.1.0.1`
taslağı yayımlanmadı; yerini `windows-v0.1.0.2` aldı.

### İkinci GitHub koşusu ve yayın (2026-10-12)

Çökme düzeltmesi (`fe10421`, birleşme `fa24b20`) sonrası Actions run
`38200657904` (`windows-2025`, sequence `2`) iki işte de başarılı oldu. CI'da
npm 591 + 1 atlanan, native 54 + 1 atlanan, desktop 113, release 234 test ve
`security:audit` geçti; attestation ve CI içi `verify-provenance` OK.

| Dosya | Boyut | SHA-256 |
|---|---|---|
| `EdizRemote.exe` | `184864000` | `0ed698ecf4aa4796b51c486b0f10f0809e5bdfd01e2b6217edd720a6d30366f0` |
| `EdizRemote.win-x64.zip` | `79939180` | `2b82d6b0b4c1c6d8406930e4f5918cfd94a82e0826c4e2067bcbeceef5141f56` |
| `EdizRemote.win-x64.provenance.json` | `2724` | `70e6e3f7dcb0f7ff331322ebf5e9e7661b6da7b3564572aa14965be5b24237ed` |
| `EdizRemote.win-x64.SHA256SUMS` | `1188` | `081d9a4a86cb00ec95fd26784e118887aed14c4122a1aaee617052bf5110bbe1` |

EXE kimliği `ProductVersion 0.1.0+fa24b20e189d41e2713234d81e6af9ea66f51c89`,
`FileVersion 0.1.0.2`, Authenticode `NotSigned`. Bağımsız doğrulama (geliştirme
makinesi, taslaktan indirilen dosyalar): dört dosya için en sıkı `gh attestation
verify` politikası başarılı, yanlış commit ile düştü; zip içindeki EXE tekil EXE
ile aynı; zip'ten açılan ağaçta `verify-provenance` (taban 2)
`WINDOWS_RELEASE_PROVENANCE_VERIFY_OK`.

Production denemesi (geliştirme makinesi, temiz Windows değil): yayın EXE'si cdb
bağlı ve bağlı değilken 13 senaryo — doğrudan P2P + kontrol/imleç/revoke/ayrılma,
zorlanmış relay, relay'de görüntü kurulamadan guest kaybı (ER-T15'in asıl
senaryosu), onaydan 1,5/2,5 sn sonra ve akış sırasında ani guest kaybı, üç tur
"Görüntüyü yeniden dene". Çökme olayı ve dump yok. `windows-v0.1.0.2`
2026-10-12T04:26:20Z'de yayımlandı (06:05Z'ye kadar Latest). Sürüm notlarına iki bilinen sorun
eklendi: relay'de ICE yenilemesinin lane yalıtımı (ER-T16) ve ilk oturumda Windows
Güvenlik Duvarı izin penceresi (yeni EXE yolu ilk kez dinleyen soket açtığında;
uygulama hatası değildir).

### ER-T16 düzeltmeli koşular (2026-10-12)

ICE yenilemesinin lane yalıtımı ve görüntü hattı kurtarması için iki koşu daha
yapıldı. İkisi de aynı bağımsız doğrulamadan geçti: geliştirme makinesinde, taslaktan
indirilen dört dosya için en sıkı `gh attestation verify` politikası başarılı; zip
içindeki EXE tekil EXE ile aynı; zip'ten açılan ağaçta `verify-provenance`
(taban = sequence) `WINDOWS_RELEASE_PROVENANCE_VERIFY_OK`.

- Run `38204145851` (`4f848f3`, sequence `3`; lane başına ICE yenilemesi `4d4b470`).
  CI'da npm 600 + 1 atlanan, native 54 + 1 atlanan, desktop 113, release 234.
  Production'da doğrudan 5/5, zorlanmış relay 4/5 (birinde host'ta elle
  "Görüntüyü yeniden dene" gerekti). `windows-v0.1.0.3` **taslak** kaldı.
- Run `38206406764` (`2ebd1ee`, sequence `4`; ek olarak taşıma düşüşünde sınırlı
  otomatik yeniden offer `554207f`). CI'da npm 607 + 1 atlanan, native 54 + 1
  atlanan, desktop 120, release 234. Production'da web `2ebd1ee` ile doğrudan +
  kontrol 9/9, zorlanmış relay 6/8; kalan iki relay hatası guest tarafındaki geç
  aday yarışıydı ve yalnız web'de düzeltildi (`75d530b`, Pi'de `0bdd4d2`). Aynı
  EXE web `0bdd4d2` ile zorlanmış relay + kontrol 5/5 geçti (görüntü 3,1–4,3 sn).
  `windows-v0.1.0.4` 2026-10-12T06:05:05Z'de yayımlandı (Latest).

| Sürüm | Dosya | Boyut | SHA-256 |
|---|---|---|---|
| 0.1.0.3 | `EdizRemote.exe` | `184864000` | `4b02fee71d9b4fdea5556daf900f956bfa90c39807903cfd6685dc87ec2be35b` |
| 0.1.0.3 | `EdizRemote.win-x64.zip` | `79939932` | `773db16c156aa3be076841fb4554884096a0dd8e423e1af7aaf0a0d88f7e666f` |
| 0.1.0.3 | `EdizRemote.win-x64.provenance.json` | `2724` | `fc199379e8cb338927c8d09e3c998a2ab532af0e346d12d3dd9044ec81985a40` |
| 0.1.0.3 | `EdizRemote.win-x64.SHA256SUMS` | `1188` | `58c47b2c2eecdbccd06a45bedf44039ecacb834adb96ae10f9c024f7e3d130ea` |
| 0.1.0.4 | `EdizRemote.exe` | `184864000` | `f53bc130a2ebf3c30575721ec814a1091eac64fecf88be766d782953846f040b` |
| 0.1.0.4 | `EdizRemote.win-x64.zip` | `79940022` | `0340e38b96371a7e6a6fded2855e9e170bfcaa42881b4380863cb8c246ddbc75` |
| 0.1.0.4 | `EdizRemote.win-x64.provenance.json` | `2724` | `b1d4b28b7694d681136c2fb1874d6e763c70dd9584cea86e1f856f124823352c` |
| 0.1.0.4 | `EdizRemote.win-x64.SHA256SUMS` | `1188` | `0a1242bcf36c7cc73fb65f8337cbc0f52c720b3e1f7e1964a5a7d56bdacade15` |

EXE kimlikleri: `ProductVersion 0.1.0+4f848f3008369cc9b0e5338b2206df60a19276ea`,
`FileVersion 0.1.0.3` ve `ProductVersion 0.1.0+2ebd1ee925c2e7fad08baae12d1aa4552fdbdde4`,
`FileVersion 0.1.0.4`; ikisi de Authenticode `NotSigned`.

Kalan: temiz Windows 10/11 makinesinde indirme + çalıştırma + SmartScreen
davranışı kanıtı. Bu alınmadan kriter karşılanmış sayılmaz.

## Dağıtım ve kalan production engeli

Dağıtım birimi `win-x64` klasörü ile kardeş `EdizRemote.win-x64.cat` dosyasının
birlikte taşınmasıdır; klasör içeriği yeniden paketlenirken hiçbir dosya eklenmemeli,
silinmemeli veya değiştirilmemelidir. Kapı katalogu Windows catalog database'e
kaydetmez ve sistem durumuna güvenmez; açık katalog yolu üzerinden doğrular.

Provenance yolunda dağıtım birimi `win-x64` klasörü ile kardeş
`EdizRemote.win-x64.provenance.json` ve `EdizRemote.win-x64.SHA256SUMS`
dosyalarıdır; GitHub yayınında attestation'lar depoya bağlı olarak saklanır.

Mevcut proje adayında gerçek code signing sertifikası yoktur ve Authenticode
durumu `NotSigned`dır. İmzalı katalog üretme, doğrulama ve anti-rollback/build
provenance politikası kod ve test olarak uygulanmıştır. Production kabulü için
gerçek OV/EV store/HSM sertifikası, güvenilir RFC3161 sağlayıcısı, temiz ağaçtan
sequence 1 veya üzeriyle üretilmiş aday, iki geçerli imza ve temiz Windows 10/11
makinede doğrulama kanıtı hâlâ gerekir.

2026-10-09 yerel doğrulaması: release politika/katalog testleri 111/111 geçti.
Testler gerçek `VS_VERSIONINFO` taşıyan Roslyn PE fixture'ları, yalıtılmış geçici
git deposu ve imzasız katalogla gate sırasını kullanır. Gerçek `desktop:publish`
adayına `0.1.0+<commit>.dirty` ve `FileVersion 0.1.0.0` gömüldü; publish bayat v1
manifesti sildi ve `release:windows:manifest` şema v2 kaydı üretti. `verify`
beklenen `catalog_missing`, tabansız `sign` `release_floor_missing`, tabanlı `sign`
ise imza denemeden `provenance_dirty_source` ile kapandı; EXE `NotSigned` ve hash'i
değişmeden kaldı. Aday kimliği [geliştirme rehberinde](DEVELOPMENT.md#windows-masaüstü-uygulaması)
kayıtlıdır.

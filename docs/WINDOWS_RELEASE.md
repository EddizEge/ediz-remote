# Windows release imzası, katalog ve bütünlük kapısı

`desktop:publish` paketi imzalamaz; yalnız release kimliğini ve kaynak
provenance'ını EXE'nin Windows sürüm kaynağına gömer. Üretim adayı ayrı bir
adımda imzalanır ve fail-closed kapıdan geçirilir. Gerçek bir code signing
sertifikası olmadan bu kapı başarı vermez.

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
izole bir build platformu veya imzalı SLSA attestation'ı değildir. .NET SDK ve
Node sürümleri commit'e sabitlenmez; production yayın kaydına ayrıca yazılmalıdır.

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

## Dağıtım ve kalan production engeli

Dağıtım birimi `win-x64` klasörü ile kardeş `EdizRemote.win-x64.cat` dosyasının
birlikte taşınmasıdır; klasör içeriği yeniden paketlenirken hiçbir dosya eklenmemeli,
silinmemeli veya değiştirilmemelidir. Kapı katalogu Windows catalog database'e
kaydetmez ve sistem durumuna güvenmez; açık katalog yolu üzerinden doğrular.

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

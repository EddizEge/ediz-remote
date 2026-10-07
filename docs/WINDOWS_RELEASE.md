# Windows release imzası, katalog ve bütünlük kapısı

Bu akış geliştirme amaçlı `desktop:publish` komutunu değiştirmez. Üretim adayı
ayrı bir adımda imzalanır ve fail-closed kapıdan geçirilir. Gerçek bir code
signing sertifikası olmadan bu kapı başarı vermez.

Akış PowerShell 7 gerektirir. NPM komutları Windows PowerShell 5.1 üzerinden
başlatılsa bile script kurulu `pwsh.exe` sürecine argüman dizisiyle kendini tekrar
başlatır; PowerShell 7 bulunamazsa sabit `powershell_version_unsupported` koduyla
kapanır. Bunun nedeni katalog doğrulaması sırasında yayın dosyalarında no-write/
no-delete handle'ları korumaktır.

## Güven sınırı

Release kapısı aşağıdakilerin tamamını zorunlu tutar:

- `EdizRemote.release-manifest.json` strict şemalıdır; beklenmeyen alan, farklı
  dosya adı veya 16 KiB üzeri kayıt reddedilir.
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

Release doğrulaması için signer sertifikasının public SHA-256 parmak izini güvenilir
CI/release ayarından ver:

```powershell
$env:EDIZ_REMOTE_RELEASE_SIGNER_SHA256 = '<64 hexadecimal characters>'
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
$env:EDIZ_REMOTE_SIGNING_TIMESTAMP_URL = 'https://timestamp-provider.example/rfc3161'
$env:EDIZ_REMOTE_SIGNING_CERT_STORE = 'CurrentUser' # veya LocalMachine
$env:EDIZ_REMOTE_SIGNTOOL_PATH = 'C:\Program Files (x86)\Windows Kits\10\bin\<sdk>\x64\signtool.exe'
npm run release:windows:sign
```

`release:windows:sign` sırasıyla EXE'yi imzalar, imzalı EXE'nin manifestini yazar,
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
durumu `NotSigned`dır. İmzalı katalog üretme ve doğrulama politikası uygulanmıştır,
ancak production kabulü için gerçek OV/EV store/HSM sertifikası, güvenilir RFC3161
sağlayıcısı, iki geçerli imza, anti-rollback/build provenance politikası ve temiz
Windows 10/11 makinede doğrulama kanıtı hâlâ gerekir.

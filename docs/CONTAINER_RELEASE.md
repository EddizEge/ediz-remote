# Container release kapısı

Production container dağıtımı build-once → scan → aynı immutable image akışını
kullanır. `docker-compose.yml` build yapmaz ve `EDIZ_REMOTE_APP_IMAGE` verilmeden
config aşamasında kapanır; `pull_policy: never` ile başka registry artifact'ine
düşmez. Yerel geliştirme build'i ayrı
`docker-compose.dev.yml` dosyasındadır.

## Kilitli imajlar

2026-09-02 tarihinde yerel `pull`/`image inspect` ve registry manifest incelemesiyle
aşağıdaki index digest'lerinin hem `linux/amd64` hem `linux/arm64` içerdiği
doğrulandı:

- `node:22.23.2-alpine3.24@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32`
- `coturn/coturn:4.17.0-r0-alpine@sha256:8f80ed9d6867319340ca612b9d005aaea2444755aa4ce3dd79ddfb5f31f6e1b5`
- `aquasec/trivy:0.74.0@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969`

Tag tek başına kullanılmaz. Digest değişikliği Dockerfile/Compose, script lock
metadata'sı ve testte birlikte, yeni manifest kanıtıyla yapılmalıdır.
Node tabanı build sırasında Alpine güvenlik güncellemelerini ve sabit npm 12.0.2
toolchain'ini alır; ayrı `runtime-base` katmanı güncellenir ve npm/npx/corepack
araçları production yüzeyinden çıkarılır. Coturn referansı doğrudan production'da
çalıştırılmaz; yalnız dar `infra/coturn` build context'inin pinned base'idir.
Alpine güvenlik güncellemeleri uygulanır, port 3478 için gereksiz upstream file
capability kaldırılır ve entrypoint final runtime image'a `0555` olarak
kopyalanır. Final kullanıcı `1000:1000`dır; production Compose bind-mounted
entrypoint kabul etmez.

Parent index digest'lerinin `linux/amd64` ve `linux/arm64` üyeliği lock güncelleme
incelemesinde resmi registry metadata'sıyla doğrulanır. Her audit koşusu uzaktaki
manifest listesini tekrar istemez; immutable parent digest'i aktif engine
platformuyla exact pull eder ve yerel `RepoDigests` eşliğini doğrular. Böylece
Docker Hub anonymous-rate limiti güvenlik kararına dönüştürülmez. Arm64
çalışabilirliği ancak Pi üzerinde aynı exact pull/build/scan tamamlandığında kabul
edilir. Resmi tag kaynakları: [Node Docker Official Image](https://hub.docker.com/_/node),
[coturn Docker image README](https://github.com/coturn/coturn/blob/master/docker/coturn/README.md).

## Kapıyı çalıştırma

Kapı deployment ile aynı yerel Linux Docker engine'inde çalıştırılır. Remote
Docker context reddedilir. Windows Docker Desktop `linux/amd64`, Raspberry Pi 5
ise `linux/arm64` kanıtı üretir; bir platformdaki sonuç diğer platformun
layer'ları için temiz kabul edilmez.

```text
npm run security:containers
```

Kapı şunları yapar:

1. Engine'in yalnız `linux/amd64` veya `linux/arm64` olduğunu doğrular; Node,
   coturn ve Trivy'yi o platform için exact parent digest ile çeker ve yerel
   `RepoDigests` kaydını eşleştirir.
2. Hardened Node runtime base, final application ve entrypoint'i içine alan
   hardened coturn runtime image'ını ayrı etiketsiz `--iidfile` kayıtlarıyla bir
   kez build eder. Coturn context'i yalnız `Dockerfile` ile `entrypoint.sh` içerir.
3. Her immutable image ID'yi geçici Docker archive'a aktarır.
4. Koşuya özel cache'te güncel Trivy vulnerability DB indirir ve 48 saatten eski
   DB'yi reddeder.
5. Taramaları ağsız, log driver kapalı, CPU/bellek/PID sınırlı, read-only rootfs,
   tüm capability'ler düşürülmüş ve `no-new-privileges` açık container'da yapar.
   Her çalıştırma isim/cidfile ile izlenir ve timeout sonrasında da yokluğu
   doğrulanır. Docker socket'i, repo, `.env`, secret veya source dizini
   tarayıcıya bağlanmaz.
6. Hardened Node runtime base, final uygulama ve final coturn runtime image'ı için
   CycloneDX, SPDX 2.3 ve yalnız HIGH/CRITICAL vulnerability JSON üretir. Docker
   runtime/manifest image ID'si ile `docker save` config digest'i ayrı tutulur;
   config blob'unun SHA-256'sı arşiv içinde doğrulanır. CycloneDX property, SPDX
   CONTAINER annotation ve Trivy JSON bu digest'e tekil/exact bağlanmıyorsa rapor
   reddedilir.

Kanıtlar platforma göre aşağıdadır:

- `artifacts/security/containers/linux-amd64/`
- `artifacts/security/containers/linux-arm64/`

Her rapor image ID, platform ve archive SHA-256 bağı taşır. Archive hash'i bütün
scanner kullanımlarından sonra yeniden hesaplanır; değişen archive reddedilir.
Şema v3 `container-audit-manifest.json`, runtime image ID'si, doğrulanmış image
config digest'i, application/final coturn image ID'leri, arşiv ve rapor hash'leri
ile kapı kararını birleştirir.
Eksik Docker/scanner, eski DB, tarama hatası veya tek bir HIGH/CRITICAL bulgu
non-zero sonuçtur. Ham Docker/Trivy stderr'i, host yolu veya ortam değerleri
terminale yazılmaz.

Kapı yalnız tamamen temiz olduğunda ve geçici kaynak cleanup'ı başarıyla bittikten
sonra manifest ile `deployment.env` dosyasını audit lock tutulurken atomik dosya
geçişleriyle commit eder; lock en son kaldırılır. Bir kill/crash aralıkta kalırsa
stale lock kanıtı kullanılamaz yapar. Dosya ayrıca manifest SHA-256 commit'ini taşır.
Production dağıtımı ham Compose komutuyla değil,
lock'un boş olduğunu, manifest/report hash'lerini ve local image ID'yi doğrulayan
tüketiciyle başlatılır. Tüketici Trivy DB `updatedAt`/`downloadedAt` zamanlarını
da dağıtım anında yeniden doğrular; 48 saati aşan veya beş dakikadan fazla
gelecekte görünen kanıt kullanılamaz. Node/coturn base referansları pinned
digest'lerle; application/coturn final `sourceReference` alanları kendi manifest
image ID'leriyle ve bu ID'ler yerel engine'deki exact image ID'leriyle
eşleşmelidir.

Tek tüketici önce application, sonra coturn Compose'unu aynı manifest SHA-256
etiketi ve hedef image ID etiketiyle başlatır. Her adım `--pull never`,
`--no-build` kullanır, health sonucunu en fazla 120 saniye bekler ve ardından
çalışan container'ın gerçek image ID/etiket/health değerlerini tekrar okur.
Unhealthy, timeout veya post-deploy uyuşmazlığı başarılı dağıtım sayılmaz:

```text
npm run security:container:deploy
```

Windows Docker Desktop üzerinde doğrulama yapılıyorsa tüketici otomatik olarak
`linux-amd64` dizinini seçer. Stale audit lock, yarım commit veya değiştirilmiş
kanıt fail-closed reddedilir; production Compose doğrulama token'ı olmadan config
aşamasında kapanır. Application ya da coturn Compose'unu doğrudan çalıştırmak
production akışı değildir. İkinci servis adımında hata olursa komut non-zero
döner; var olan container'ları otomatik `down` etmez. Operatör sabit hata kodunu
giderip aynı doğrulanmış komutu yeniden çalıştırmalı ve iki health sonucunu da
başarılı görmelidir. `deployment.env` başka hosta taşınacak registry artifact'i
değildir; cross-host dağıtım ileride registry manifest digest'i ve imza doğrulama
eklenmeden yapılmamalıdır.

Yerel build/debug akışı production kanıtı sayılmaz:

```text
docker compose --env-file .env -f docker-compose.dev.yml up -d --build
```

`npm run security:audit` günlük npm/NuGet dependency kapısı olarak ayrı kalır;
container release kapısı ağır ve fail-closed olduğu için yalnız
`security:containers` komutuyla çalışır.

Bu dilimin deterministik fake-runner testleri gerçek Docker build/scan kanıtının
yerine geçmez. Production kabulü, hedef platformda gerçek komutun sıfır bulguyla
bitmesi ve üretilen manifest/deployment dosyasının kullanılmasıyla verilir.

## 2026-09-02 yerel linux/amd64 kanıtı

- Gerçek Docker Desktop `linux/amd64` koşusunda hardened Node runtime base, final
  application ve hardened coturn için CycloneDX + SPDX + Trivy JSON üretildi;
  üç hedefte HIGH/CRITICAL bulgu `0` ve kapı sonucu `passed` oldu.
- Manifest şeması `3`, application image
  `sha256:89880f536c607b542efe4dd55d9f0b1791d818e03510ca5892e5ed275235a1c1`,
  coturn image
  `sha256:fece86812826e40ad00a993d2f0e2bc4c58597c6a6ad7072088c8c0f6633a2f1`
  ve manifest SHA-256
  `5F9C90D527A9AEE06B744417957FDEDBDE2876A79190DDF8DFE5BB1A545D12E8`dır.
- Audited application image'ında Node çalıştı ve npm/npx bulunmadı. Audited
  coturn image'ı UID 1000, read-only rootfs, tüm capability'ler kapalı ve
  `no-new-privileges` ile health smoke verdi. Güncel resmi coturn tabanıyla kısa
  ömürlü HMAC relay probe'u 6/6 geçti.
- Bu kanıt Pi `linux/arm64` sonucu değildir ve production Compose tüketicisiyle
  gerçek servis deployment'ı yapılmadı. Pi'de exact scan + secret/audit volume +
  iki health sonucu görülmeden Faz 4 container kabulü tamamlanmış sayılmaz.

## 2026-10-09 yerel linux/amd64 kanıtı

2026-09-02 kanıtı 48 saatlik tazelik sınırını aştığı için kapı aynı kilitli
Node/coturn/Trivy digest'leriyle ve 2026-10-09 npm güvenlik yükseltmelerini içeren
lockfile ile yeniden çalıştırıldı. Eski kanıtın yerini bu koşu aldı.

- Docker Desktop `linux/amd64` üzerinde üç hedef build/scan edildi; HIGH/CRITICAL
  bulgu `0`, kapı sonucu `passed`, koşu yaklaşık 231 saniye.
- Trivy DB `updatedAt` `2026-10-09T13:10:00Z`, `downloadedAt`
  `2026-10-09T13:51:44Z`.
- Manifest şeması `3`, application image
  `sha256:da42511455b3fdabb1c87db9cc22fd2159c8d5fbb483994f7908fe25977f4aa2`,
  coturn image
  `sha256:43b32cdf12d9ad7b8d73c2e086c106d8c28296228445b5d165d92b7d0eccada8`
  ve manifest SHA-256
  `0C82A7B08C7BC21A88B1A85E727EBC2AF87129C35A537C6605A80DAEF003CB55`dır.
- Application CycloneDX kaydı `proxy-addr` 2.0.8 içerir; yalnız geliştirme
  paketleri (`concurrently`, `shell-quote`, `vitest`, `source-map-js`) imajda yoktur.
- Audited application image'ı ağsız, read-only, capsiz ve `no-new-privileges`
  ile UID/GID 1000 altında Node 22.23.2 çalıştırdı; npm, npx, corepack, yarn ve
  pnpm bulunmadı. Bu koşuda coturn health smoke'u ve HMAC relay probe'u yeniden
  çalıştırılmadı.
- Bu kanıt da Pi `linux/arm64` sonucu değildir; deployment yapılmadı.

## 2026-10-11 Pi linux/arm64 kanıtı

Kapı, production Pi'nin yerel Docker engine'inde (Docker 29.8.0, Compose v5.5.1)
public depodan temiz klonlanan `219cfc9` kaynağıyla çalıştırıldı. Koşu yalnız
build/scan yaptı; çalışan servislere dokunulmadı ve deployment yapılmadı.

- Platform `linux/arm64`; üç hedef (hardened Node runtime base, final application,
  custom coturn) build/scan edildi; HIGH/CRITICAL bulgu `0`, kapı sonucu `passed`,
  koşu yaklaşık üç dakika.
- Her hedef için CycloneDX, SPDX 2.3 ve Trivy JSON üretildi (application 96/97
  bileşen kaydı, coturn 58/59, Node tabanı 21/22).
- Trivy DB `updatedAt` `2026-10-11T01:13:45Z`, `downloadedAt`
  `2026-10-11T02:05:21Z`; 48 saatlik tazelik sınırı nedeniyle deploy öncesi kapı
  yeniden çalıştırılır.
- Manifest şeması `3`, application image
  `sha256:48f0054668ad4434a6225f0045f4a18d5c43ec0664bcb79655ee1bdd8a5f5a8a`,
  coturn image
  `sha256:730f47e0a229abf144deb75dafb39bb6252ece95e3e43c8c5368bd757cdb0a59`
  ve manifest SHA-256
  `FCC5988740E9204478C3BA5BC3FF0B3117DB1A576D7AD68FD2822022B025782B`dır.
- Kalan Faz 4 container kabulü: UID 1000 secret dosyaları ve audit volume ile
  `security:container:deploy` tüketicisinden geçen iki servisli deployment,
  application/coturn health, canlı coturn stdout suppression ve audit
  503/restart davranışının kaydı.

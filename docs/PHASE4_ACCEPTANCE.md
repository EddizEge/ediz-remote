# Faz 4 kabul kanıtı

Tarih: 2026-10-09

Durum: **TAMAMLANMADI.** Kod, birim/entegrasyon testi, fuzz ve yerel gerçek
ortam kanıtlarının büyük bölümü hazırdır; production ve hedef platform kanıtları
eksiktir. Bu belge Faz 4 kanıtlarını tek yerde toplar; bir satırın
`Karşılandı` olması yalnız belirtilen kanıt türü için geçerlidir ve production
deployment yapıldığı anlamına gelmez.

Kaynaklar: [`AGENTS.md`](../AGENTS.md) §5 ve §7 Faz 4,
[`PHASE4_PLAN.md`](PHASE4_PLAN.md), [`THREAT_MODEL.md`](THREAT_MODEL.md) §6 ve §11,
[`CONTAINER_RELEASE.md`](CONTAINER_RELEASE.md),
[`WINDOWS_RELEASE.md`](WINDOWS_RELEASE.md), [`DEVELOPMENT.md`](DEVELOPMENT.md),
[`SECURITY_AUDIT.md`](SECURITY_AUDIT.md) ve [`PROTOCOL.md`](PROTOCOL.md).

## Bloklayıcılar

| Bloklayıcı | Etkilediği kabul | Eksik girdi |
|---|---|---|
| Pi `linux/arm64` üzerinde gerçek `security:containers` kapısı ve iki servisli deploy smoke'u (UID 1000 secret/audit volume, application/coturn health, canlı coturn stdout suppression, audit 503/restart davranışı) | Kriter 4, supply-chain ve deployment çıkış kapıları | Pi erişimi için kullanıcı onayı |
| Gerçek OV/EV store/HSM sertifikasıyla EXE + katalog Authenticode imzası ve RFC3161 timestamp'i; temiz ağaçtan sequence ≥ 1 ilk imzalı yayın | Kriter 5, imzalı artifact çıkış kapısı | OV/EV code signing sertifikası (store/HSM) ve güvenilir RFC3161 sağlayıcısı |
| İmzalı adayın temiz Windows 10/11 makinesinde doğrulanması | Kriter 5 | Temiz Windows 10/11 test makinesi |
| Yeni web, signaling ve Windows paketinin production'a birlikte alınması ve gerçek HTTPS/WSS deployment testi | Kriter 1, 2 ve 4'ün production kanıtı; Cloudflare çıkış kapısı | Yukarıdaki Pi onayı ve imzalı Windows paketi |

Tablo tabanlı süresi geçmiş/replay durum makinesi matrisi 2026-10-09'da
tamamlandı (`20b972b`); artık bloklayıcı değildir.

## Kanıt türleri

| Tür | Anlamı |
|---|---|
| Birim/entegrasyon | Depodaki otomatik testler; yerel geliştirme makinesinde koşturulur |
| Fuzz | Seed'li, deterministik fuzz/regresyon testleri ve canlı yerel signaling kampanyası |
| Yerel gerçek ortam | Geliştirme makinesinde gerçek Docker/Trivy, publish, tarayıcı veya EXE koşusu |
| Production | Pi production servisinde, gerçek imzalı artifact'te veya temiz hedef makinede alınmış kanıt |

Tarihsel sonuçlar (2026-08/09) ilgili dilimin o günkü durumunu gösterir; güncel
taban 2026-10-09 koşularıdır. Atlanan testler başarılı sayılmaz: toplu `npm test`
içindeki 1 signaling testi ve native paketteki zorlanmış TURN ortamı isteyen 1 test
her koşuda atlanmıştır.

2026-08 ve 2026-09 dilimlerinin ayrı commit'i bu depoda yoktur; o işler ilk içe
aktarma `425abc9` içinde gelir. 2026-10-09 işleri ayrı commit'lerdedir.

## Kabul kriterleri matrisi

| # | Kriter | Kanıt (test dosyası / komut) | Sonuç, tarih | Commit | Kanıt türü | Durum | Eksik girdi |
|---|---|---|---|---|---|---|---|
| 1 | Onaysız veya süresi geçmiş oturum ekran/control sinyali aktaramaz | `services/signaling/test/stateMachine.test.ts` (durum × rol × mesaj matrisi: oturumsuz, bekleyen, reddedilmiş, onaylı, revoke sonrası, bitmiş, kod TTL'i geçmiş, askıda, grace aşımı, döndürülmüş resume token), `services/signaling/test/server.test.ts`, `services/signaling/test/fuzz.test.ts`, `apps/web/src/features/session/useSignaling.test.ts`; `npm test`. Her hücrede gönderene dönen yanıt ve diğer bütün soketlerin aldığı mesajların tam listesi; yetkisiz hücrede `signal`/onay/ICE sızıntısı yok | 2026-10-09: durum makinesi 326/326, signaling 407 + 1 atlanan, toplu `npm test` 576 + 1 atlanan; 10 kasıtlı sunucu bozulmasının 10'u da matriste düştü. Canlı fuzz'da 2.500 kimliksiz frame sonrası hiçbir sokete signal/onay ulaşmadı. Bulgu: kodu bilen üçüncü kişi `join_session` ile kod TTL'i geçmiş onaylı ya da host'u askıdaki oturumu bitirebiliyordu; düzeltildi | `50ae6f6`, `5b8b314`, `20b972b`, `6bdf2a5` | Birim/entegrasyon, fuzz | Karşılandı (test kapsamı) | v3 web/signaling/desktop paketinin production'a alınması ve canlı doğrulama (Pi onayı) |
| 2 | Eski/replay control mesajları etkisizdir | `services/signaling/test/stateMachine.test.ts` (negotiation replay: aynı offer tekrarı, ikinci answer, yeni offer sonrası eski candidate, yanlış lane, ters yön, 257. offer, resume boyunca korunan durum; eski resume token replay'i), `apps/web/src/features/webrtc/peerProtocol.test.ts`, `apps/web/src/features/webrtc/negotiation.test.ts`, `apps/windows-desktop.Tests/ControlInputTests.cs`, `services/signaling/test/server.test.ts`. Ortak session `sequence`, rate reddinde ilerlemeyen watermark, yalnız başarılı uygulamada ilerleyen native watermark | 2026-10-09: durum makinesi 326/326, web 106, signaling 407 + 1 atlanan, desktop 113/113 | `50ae6f6`, `20b972b`, `425abc9`, `6bdf2a5` | Birim/entegrasyon, fuzz | Karşılandı (test kapsamı) | Production control soak ölçümü (ER-T07) |
| 3 | Fuzz/bozuk mesaj testleri servisi veya host'u düşürmez | `packages/protocol/test/fuzz.test.ts`, `services/signaling/test/fuzz.test.ts`, `apps/web/src/features/webrtc/peerProtocol.fuzz.test.ts`, `apps/windows-desktop.Tests/BridgeFuzzTests.cs`; yardımcı `packages/protocol/test/fuzzSupport.ts` | 2026-10-09: 24 fuzz/regresyon testi; protocol 18, web 106, signaling 81 + 1 atlanan, desktop 113/113. Canlı kampanya sonrası health ve temiz çiftin relay'i sağlam. İki gerçek bulgu kapatıldı (iç içe `__proto__`, WPF eşlenmemiş surrogate istisnası); oracle olarak eski korumalar testte düştü | `6bdf2a5` | Fuzz, birim/entegrasyon | Karşılandı (test kapsamı) | Production negotiation-churn/soak ölçümü (ER-T06); fiziksel host üzerinde fuzz çalıştırılmadı |
| 4 | Secret/token/SDP içeren üretim logu bulunmaz | `services/signaling/test/securityAudit.test.ts`, `services/signaling/test/securityAuditConfig.test.ts`, `services/signaling/test/server.test.ts`, `scripts/safe-output.test.mjs`, `scripts/browser-turn-simulation-redaction.test.mjs`, `apps/windows-host.Tests/SafeHostDiagnosticsTests.cs`; `npm run security-output:test`. Strict sekiz alanlı JSONL audit, coturn `no-stdout-log` | 2026-10-09: güvenli çıktı 10/10, signaling 81 + 1 atlanan; sentinel testleri stdout/stderr, audit ve TURN/browser probe tanılarını kapsar | `425abc9` | Birim/entegrasyon | Kısmen | Canlı production stdout/stderr capture ve Pi audit volume/secret smoke'u (Pi onayı); gelecekteki destek paketi testi (Faz 6) |
| 5 | Yayınlanan binary bütünlüğü doğrulanabilir | `scripts/windows-release.test.ps1` (`npm run release:windows:test`), `npm run release:windows:manifest`, `npm run release:windows:verify`, `npm run release:windows:sign` | 2026-10-09: release politika/katalog 111/111. Gerçek aday `NotSigned`; `verify` → `catalog_missing`, tabansız `sign` → `release_floor_missing`, tabanlı `sign` → imza denemeden `provenance_dirty_source` | `971506f`, `8c209df`, `893de84` | Birim/entegrasyon, yerel gerçek ortam | Bekliyor | OV/EV store/HSM sertifikası, RFC3161 sağlayıcısı, temiz ağaçtan sequence ≥ 1 aday, temiz Windows 10/11 makinesi |

Gerekçeler:

- Kriter 1 ve 2 için Faz 4 planı ve tehdit modelinin istediği tablo tabanlı
  süresi geçmiş/replay matrisi 2026-10-09'da tamamlandı ve gerçek bir
  erişilebilirlik bulgusunu kapattı; bu yüzden test kapsamında `Karşılandı`dır.
  Faz 4 web/signaling/desktop paketi henüz production'a alınmadığından production
  kanıtı yoktur.
- Kriter 3 bir test kriteridir ve 2026-10-09 fuzz matrisi dört katmanda geçmiştir;
  production soak bu kriterin değil ER-T06'nın kalan işidir.
- Kriter 4 "üretim logu" ister; yalnız yerel sentinel testi vardır, canlı production
  capture yapılmamıştır.
- Kriter 5 için kapı kodu hazırdır, ancak imzalı tek bir artifact yoktur.

## Tehdit modeli §11 çıkış kapıları

Kaynak: [`THREAT_MODEL.md` §11](THREAT_MODEL.md#11-faz-4-çıkış-kapıları).

| Çıkış kapısı | Kanıt (test dosyası / komut) | Sonuç, tarih | Commit | Kanıt türü | Durum | Eksik girdi |
|---|---|---|---|---|---|---|
| Onaysız/süresi geçmiş/replay durumları için state-machine ve fuzz matrisi | Kriter 3'teki dört fuzz dosyası ve `services/signaling/test/stateMachine.test.ts` | 2026-10-09: fuzz katmanı protokol, canlı signaling, web DataChannel ve WPF köprüsünde tamam; durum makinesi matrisi 326/326; üç gerçek bulgu kapatıldı (iç içe `__proto__`, WPF eşlenmemiş surrogate, kodla onaylı oturum sonlandırma) | `6bdf2a5`, `20b972b` | Fuzz, birim/entegrasyon | Karşılandı (test kapsamı) | — |
| Negotiation ID/lane, bounded pending ICE ve DataChannel rol/yetki matrisi | `apps/web/src/features/webrtc/negotiation.test.ts`, `apps/web/src/features/webrtc/peerProtocol.test.ts`, `services/signaling/test/server.test.ts`, `apps/windows-desktop.Tests/NativeVideoBridgeProtocolTests.cs` | Tarihsel 2026-09-02 Dilim 3: web 100/100, signaling 42/42, desktop 87/87. Güncel 2026-10-09 tabanında da geçer | `425abc9` | Birim/entegrasyon | Kısmen | Production churn/soak kanıtı |
| Global/IP kaynak kotaları ve signal/ICE/message rate limitleri | `services/signaling/test/rateLimit.test.ts`, `services/signaling/test/server.test.ts` | Tarihsel 2026-08-24 Dilim 2: signaling 38/38 (64 KiB, flood, bozuk UTF-8, derin JSON, takeover). Güncel 2026-10-09: signaling 81 + 1 atlanan | `425abc9` | Birim/entegrasyon | Kısmen | Production kapasite ölçümü |
| Signaling stdout/stderr, JSONL audit ve TURN/browser probe tanılarında secret sentinel sızıntı testi | Kriter 4'teki dosyalar; `npm run security-output:test` | 2026-10-09: güvenli çıktı 10/10, TURN 13/13 | `425abc9` | Birim/entegrasyon | Kısmen | Canlı production capture; gelecekteki destek paketi doğrulaması |
| Production npm/NuGet/container taraması, SBOM ve gerekçeli baseline | `npm run security:audit`, `npm run security:containers`, `scripts/container-security-audit.test.mjs` | 2026-10-09: npm + dört NuGet projesi 0 açık; container politika 22/22; yerel `linux/amd64` 3/3 hedef HIGH/CRITICAL `0` | `d71b739` | Birim/entegrasyon, yerel gerçek ortam | Kısmen | Pi `linux/arm64` gerçek scan ve deployment smoke (Pi erişim onayı) |
| Authenticode imzalı Windows artifact ve bağımsız imza/hash doğrulaması | Kriter 5'teki dosya ve komutlar | 2026-10-09: 111/111 politika testi; aday `NotSigned`, katalog yok | `971506f`, `8c209df`, `893de84` | Birim/entegrasyon, yerel gerçek ortam | Bekliyor | OV/EV sertifika + RFC3161 sağlayıcısı; temiz Windows 10/11 makinesi |
| Cloudflare origin/proxy policy ile gerçek HTTPS/WSS deployment testi | `services/signaling/test/server.test.ts` (origin, subprotocol, proxy spoof) | Kod/test geçer; Faz 4 v3 paketiyle gerçek deployment testi yapılmadı | `425abc9` | Birim/entegrasyon | Bekliyor | v3 web/signaling/desktop paketinin production'a alınması (Pi onayı) |
| Faz 4 kabul kanıtlarının `docs/PHASE4_ACCEPTANCE.md` altında toplanması | Bu belge | 2026-10-09: ilk sürüm ve durum makinesi matrisi sonrası güncelleme | `51890cf` | — | Karşılandı | Pi, imza ve production kanıtı geldikçe güncellenir |

## Dilim özeti

- **[Dilim 1 — Threat model ve signaling giriş sınırı](PHASE4_PLAN.md#dilim-1--threat-model-ve-signaling-giriş-sınırı):**
  Yazılı tehdit modeli, zorunlu sürümlü alt protokol (bugün `ediz-remote.v3`,
  current/minimum 3/3, legacy fallback yok), origin allowlist, explicit
  `CF-Connecting-IP` güveni, strict/bounded SDP/ICE ve binary frame reddi.
  SIPSorcery 10.0.16. Açık: paketin production'a birlikte alınması.
- **[Dilim 2 — Kaynak kötüye kullanımı ve brute-force dayanıklılığı](PHASE4_PLAN.md#dilim-2--kaynak-kötüye-kullanımı-ve-brute-force-dayanıklılığı):**
  Global/IP socket ve session tavanları, ayrı token bucket kapsamları, bounded TTL
  sayaç haritaları, O(1) resume indeksi, strict `rate_limited`/`capacity_exceeded`
  sözleşmesi ve wire v2. Tüm maddeler işaretli.
- **[Dilim 3 — Oturum ve alt protokol yetkilendirmesi](PHASE4_PLAN.md#dilim-3--oturum-ve-alt-protokol-yetkilendirmesi):**
  Role göre offer/answer yönü, `negotiationId` ile replay reddi, bounded pending ICE,
  DataChannel label/rol/yetki matrisi, ortak session `sequence`, bridge
  `sessionEpoch` ve wire v3. Tüm maddeler işaretli.
- **[Dilim 4 — Hassas loglar ve minimal audit](PHASE4_PLAN.md#dilim-4--hassas-loglar-ve-minimal-audit):**
  Ortak redaction katmanı, sekiz alanlı strict JSONL audit ve günlük HMAC IP bucket,
  fail-closed audit arızası, sentinel testleri, production CSP ve güvenlik başlıkları.
  Destek paketi kapsamı Faz 6'da.
- **[Dilim 5 — Supply chain ve artifact bütünlüğü](PHASE4_PLAN.md#dilim-5--supply-chain-ve-artifact-bütünlüğü):**
  `security:audit` kapısı, digest kilitli base image'lar, build-once
  `security:containers` kapısı, store/HSM Authenticode modeli, SHA-256 Catalog v2,
  release kimliği ve anti-rollback/build provenance. Açık: Pi `linux/arm64` kanıtı
  ve gerçek sertifikalı imza.
- **[Dilim 6 — Fuzz ve bozuk mesaj matrisi](PHASE4_PLAN.md#dilim-6--fuzz-ve-bozuk-mesaj-matrisi):**
  Bağımlılıksız seed'li fuzz yardımcısı; protokol, canlı signaling, web DataChannel
  ve WPF köprüsü kampanyaları; 326 testlik signaling durum makinesi matrisi ve bu
  kanıt belgesi. Üç gerçek bulgu kapatıldı. Tüm maddeler işaretli.

## Doğrulama tabanı

| Tarih | Kapsam | Sonuç | Tür | Not |
|---|---|---|---|---|
| 2026-08-24 | Dilim 2 | TURN 7/7, web 72/72, protocol 9/9, signaling 38/38, desktop 66/66, native 40 + 1 atlanan; lint/build/audit başarılı | Birim/entegrasyon | Tarihsel, wire v2 |
| 2026-09-02 | Dilim 3 | TURN 7/7, web 100/100, protocol 10/10, signaling 42/42, desktop 87/87, native 40 + 1 atlanan; lint/build/publish/audit başarılı | Birim/entegrasyon | Tarihsel, wire v3 |
| 2026-09-02 | Dilim 4/5 | Toplu 233 + 1 atlanan; native 42 + 1 atlanan; desktop 106/106; release 31/31; Compose 3/3; modül syntax 14/14 | Birim/entegrasyon | Tarihsel |
| 2026-09-02 | Container kapısı | Yerel `linux/amd64` 3/3 hedef HIGH/CRITICAL `0`; manifest SHA-256 `5F9C90D5…D12E8`; coturn health smoke ve HMAC relay 6/6 | Yerel gerçek ortam | Tarihsel; 48 saatlik tazelik sınırı nedeniyle 2026-10-09 koşusu yerini aldı |
| 2026-10-09 | Taban yenileme | İlk `security:audit` npm'de 6 bulguyla fail-closed kapandı (3 kritik, 1 yüksek, 2 orta); lockfile yükseltmesi sonrası npm + dört NuGet projesi 0 açık; toplu 233 + 1 atlanan; native 42 + 1 atlanan; desktop 106/106 | Birim/entegrasyon | Güncel; `d71b739` |
| 2026-10-09 | Release provenance | Release politika/katalog 31 → 111/111 | Birim/entegrasyon | Güncel; `971506f`, `8c209df` |
| 2026-10-09 | Container kapısı | Yerel `linux/amd64` 3/3 hedef HIGH/CRITICAL `0`; application image Node/no-npm smoke'u | Yerel gerçek ortam | Güncel; coturn health ve HMAC relay bu koşuda yeniden çalıştırılmadı |
| 2026-10-09 | Fuzz dilimi sonrası | Toplu 250 + 1 atlanan (TURN 13, güvenli çıktı 10, container 22, web 106, protocol 18, signaling 81 + 1 atlanan); native 42 + 1 atlanan; desktop 113/113; release 111/111; lint/build/audit temiz | Birim/entegrasyon, fuzz | `6bdf2a5` |
| 2026-10-09 | Durum makinesi matrisi ve join düzeltmesi | Durum makinesi 326/326; toplu 576 + 1 atlanan (signaling 407 + 1 atlanan); lint/build temiz; 10 + 5 kasıtlı bozulma matriste düştü | Birim/entegrasyon | Güncel; `20b972b` |

Bu koşuların hiçbiri production ortamında yapılmamıştır. Fiziksel EXE/UI smoke
2026-09-02 ve 2026-10-09 koşularında çalıştırılmadı; son fiziksel EXE smoke
2026-08-24 tarihli wire v2 adayına aittir.

## Güncel artifact ve kanıt kimlikleri

### Windows geliştirme adayı

Kaynak: [`DEVELOPMENT.md`](DEVELOPMENT.md#windows-masaüstü-uygulaması) ve
[`WINDOWS_RELEASE.md`](WINDOWS_RELEASE.md).

| Alan | Değer |
|---|---|
| Durum | Geliştirme paketi — **production değil** |
| Dosya | `artifacts/windows-desktop/win-x64/EdizRemote.exe` |
| Boyut | `184835328` bayt |
| Son yazma | `2026-10-09 17:55:07 +03:00` |
| SHA-256 | `330D033CE3AC08C0E011E2DEEF0B477D15F71754570DB76CD091DC6E838D20E0` |
| `ProductVersion` | `0.1.0+6bdf2a5f7a070a56a7c70593e4ff464db56be155.dirty` |
| `FileVersion` | `0.1.0.0` (sequence `0`) |
| Şema v2 manifest SHA-256 | `A70C696D7A9ABA76C531ECAB50F514A681B8BA9CBADA6DCD766E5043C27000E2` |
| Web ağacı | Kaynak/yayın dörder dosya, fark `0`; bundle'da wire v3 |
| Authenticode | `NotSigned`; katalog yok |
| Kapı sonuçları | `verify` `catalog_missing`; tabansız `sign` `release_floor_missing`; tabanlı `sign` `provenance_dirty_source` |
| Önceki aday | `971506f` adayı `DED61FD7…D71D`, aynı gün bu adayla değiştirildi |

### Container kapısı

Kaynak: [`CONTAINER_RELEASE.md`](CONTAINER_RELEASE.md#2026-10-09-yerel-linuxamd64-kanıtı).

| Alan | Değer |
|---|---|
| Platform | Docker Desktop `linux/amd64` (yerel; Pi `linux/arm64` değil) |
| Hedefler | Hardened Node runtime, final application, custom coturn — 3/3 HIGH/CRITICAL `0`, sonuç `passed` |
| Manifest şeması | `3` |
| Manifest SHA-256 | `0C82A7B08C7BC21A88B1A85E727EBC2AF87129C35A537C6605A80DAEF003CB55` |
| Application image | `sha256:da42511455b3fdabb1c87db9cc22fd2159c8d5fbb483994f7908fe25977f4aa2` |
| Coturn image | `sha256:43b32cdf12d9ad7b8d73c2e086c106d8c28296228445b5d165d92b7d0eccada8` |
| Trivy DB `updatedAt` | `2026-10-09T13:10:00Z` |
| Trivy DB `downloadedAt` | `2026-10-09T13:51:44Z` |
| Deployment | Yapılmadı |
| Kaynak notu | Bu image'lar `6bdf2a5` (protokol) ve `20b972b` (signaling) değişikliklerinden önce build edildi; deploy öncesi güncel kaynaktan yeni scan zorunludur |

## Kabul için kalan sıra

1. Pi erişim onayıyla güncel kaynaktan `linux/arm64` gerçek container kapısını ve
   iki servisli deploy smoke'unu çalıştır; canlı stdout/audit kanıtını kaydet.
2. Gerçek sertifika ve RFC3161 sağlayıcısıyla temiz ağaçtan sequence ≥ 1 adayı
   imzala; temiz Windows 10/11 makinesinde doğrula.
3. Web/signaling/desktop v3 paketini birlikte production'a al; HTTPS/WSS deployment
   testini kaydet ve bu belgeyi son durumla güncelle.

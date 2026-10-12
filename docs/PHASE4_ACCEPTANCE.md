# Faz 4 kabul kanıtı

Tarih: 2026-10-09 (son güncelleme 2026-10-12)

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
| Yayın EXE'sinde native çökme (ER-T15): 2026-10-12 production oturumlarının birinde (guest relay'e zorlanmış, 45 sn video kurulamamış, guest kapanırken) `windows-v0.1.0.1` `0xC0000005` ile kapandı; hata `ntdll`'de serbest bırakılmış bir `CRITICAL_SECTION`'a girişte (native use-after-free yarışı). cdb bağlıyken sekiz senaryoda yeniden üretilemedi | Yayın kalitesi; host'un ağ arızasında düşmemesi | Kök neden ve düzeltme, yeni GitHub yayını (sequence 2) ve production oturum tekrarı |
| Provenance adayının temiz Windows 10/11 makinesinde indirilip çalıştırılması, SmartScreen davranışının kaydı ve gerçek oturum. İlk GitHub `windows-release` koşusu, attestation ve bağımsız `verify-provenance` 2026-10-11'de; aynı paketle production üzerinden gerçek oturumlar 2026-10-12'de geliştirme makinesinde geçti | Kriter 5 | Temiz Windows 10/11 test makinesi |
| (İleride) Gerçek OV/EV store/HSM sertifikasıyla EXE + katalog Authenticode imzası ve RFC3161 timestamp'i | Yayıncı güveni; Faz 4 kabulünü artık bloklamaz (ER-T13 artık risk kabulü) | OV/EV code signing sertifikası ve güvenilir RFC3161 sağlayıcısı |

Audit arızasında 503/restart davranışının izole doğrulaması ve gerçek oturum
trafiği sonrası production log/audit örneği 2026-10-12'de tamamlandı; artık
bloklayıcı değildir.

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
| 4 | Secret/token/SDP içeren üretim logu bulunmaz | `services/signaling/test/securityAudit.test.ts`, `services/signaling/test/securityAuditConfig.test.ts`, `services/signaling/test/server.test.ts`, `scripts/safe-output.test.mjs`, `scripts/browser-turn-simulation-redaction.test.mjs`, `apps/windows-host.Tests/SafeHostDiagnosticsTests.cs`; `npm run security-output:test`. Strict sekiz alanlı JSONL audit, coturn `no-stdout-log` | 2026-10-09: güvenli çıktı 10/10, signaling 81 + 1 atlanan; sentinel testleri stdout/stderr, audit ve TURN/browser probe tanılarını kapsar. 2026-10-12 production: application çıktısı tek yapılandırılmış satır (`service.ready`), IPv4 benzeri değer yok; coturn log sürücüsü `none` + `TURN_LOG_OUTPUT=discard`; audit volume `1000:1000` `0700`; secret dosyaları `1000:1000` `0400`. Dokuz gerçek production oturumundan (doğrudan P2P, TURN relay, kontrol/revoke, arıza yolları) sonra Pi'de salt-okunur sayım: audit 35 kayıt, yalnız sekiz izinli alan, `protocolVersion` 3; application log hâlâ tek satır; IPv4/IPv6/6 haneli sayı/SDP-candidate/secret sözcüğü/dosya yolu deseni 0. Audit yazım arızası tatbikatı (`npm run security:audit-drill`, Docker Desktop amd64, izole): `/health` ve yeni upgrade 13–46 ms içinde `503`, çıkış kodu 1 (`audit_unavailable`, ardından `shutdown_failed`), arıza sürerken `startup_failed` restart döngüsü, geri almada 5–8 sn'de `healthy`; dört koşu `passed` | `425abc9`, `abcaab9`, `90241f2` | Birim/entegrasyon, yerel gerçek ortam, production | Karşılandı | Gelecekteki destek paketi testi (Faz 6) |
| 5 | Yayınlanan binary bütünlüğü doğrulanabilir | Depo sahibi kararı (2026-10-11): ücretli sertifika gelene kadar **provenance yolu** — GitHub'da derlenen ağaç için SLSA build provenance attestation + provenance manifesti + SHA256SUMS ([`WINDOWS_RELEASE.md`](WINDOWS_RELEASE.md#provenance-github-attestation-yolu)). `scripts/windows-release.test.ps1` (`npm run release:windows:test`), `npm run release:windows:provenance`, `npm run release:windows:verify-provenance`; workflow `.github/workflows/windows-release.yml`. Authenticode yolu (`release:windows:sign`/`verify`) değişmeden kalır | 2026-10-11: release politika/katalog/provenance 234/234 (123 provenance; 3 kasıtlı mutasyon düştü). Temiz ağaçta `3091505`'ten sequence 1 gerçek aday (`NotSigned`): `provenance` → 12 dosyalık manifest + SHA256SUMS, deterministik; kirli ağaç → `provenance_dirty_source`; `verify-provenance` → attestation olmadığı için `provenance_attestation_invalid`, kurcalanmış ağaç → `provenance_tree_mismatch`. 2026-10-11 ilk GitHub koşusu (run `38107001498`, `8701f78`, sequence 1): CI kapıları, attestation ve CI içi `verify-provenance` geçti, `windows-v0.1.0.1` taslağı (EXE SHA-256 `b1e77dc5…f516`, zip `3e995246…783b`); ayrı makinede dört dosya en sıkı `gh attestation verify` politikasıyla doğrulandı, yanlış commit ile düştü; zip ağacında `verify-provenance` OK, değiştirilmiş dosya → `provenance_tree_mismatch`, taban 2 → `release_rollback_rejected`. 2026-10-12: aynı zip (SHA256SUMS 12/12) geliştirme makinesinde production v3 üzerinden dokuz gerçek oturumda kullanıldı (doğrudan P2P ve TURN relay 2560×1440 H.264, kontrol/revoke); birinde native çökme (bloklayıcılar). 2026-10-09 Authenticode tabanı: `verify` → `catalog_missing` | `971506f`, `8c209df`, `893de84`, `3091505`, `8701f78` | Birim/entegrasyon, yerel gerçek ortam, GitHub-hosted build | Kısmen — GitHub derlemesi, attestation ve bağımsız doğrulama tamam; temiz Windows 10/11 kanıtı bekliyor | Temiz Windows 10/11 makinesinde indirme/çalıştırma ve SmartScreen kaydı; taslağın yayımlanması. Yayıncı güveni/SmartScreen artık risk olarak kabul edildi (ER-T13); Authenticode için OV/EV sertifika + RFC3161 ileride |

Gerekçeler:

- Kriter 1 ve 2 için Faz 4 planı ve tehdit modelinin istediği tablo tabanlı
  süresi geçmiş/replay matrisi 2026-10-09'da tamamlandı ve gerçek bir
  erişilebilirlik bulgusunu kapattı; bu yüzden test kapsamında `Karşılandı`dır.
  Faz 4 web/signaling/desktop paketi henüz production'a alınmadığından production
  kanıtı yoktur.
- Kriter 3 bir test kriteridir ve 2026-10-09 fuzz matrisi dört katmanda geçmiştir;
  production soak bu kriterin değil ER-T06'nın kalan işidir.
- Kriter 4 "üretim logu" ister; 2026-10-12'de dokuz gerçek production oturumundan
  sonra application log ve audit dosyası hassas desen taramasından temiz geçti ve
  audit yazım arızasının fail-closed davranışı izole tatbikatla doğrulandı. Bu
  yüzden production kanıtıyla `Karşılandı`dır; destek paketi Faz 6 işidir.
- 2026-10-12 production oturumlarında görülen native çökme (ER-T15) kriter 3'ün
  fuzz kapsamında değil, ağ arıza yolundaki kaynak yaşam döngüsü yarışıdır; ayrı
  bloklayıcı olarak izlenir.
- Kriter 5 için depo sahibi 2026-10-11'de Authenticode yerine GitHub attestation
  tabanlı provenance yolunu seçti. Kod ve testler hazırdır; ilk GitHub koşusu
  (`8701f78`, sequence 1) attest edilmiş `windows-v0.1.0.1` taslağını üretti ve
  dört dosya ayrı makinede `gh attestation verify` ile, ağaç `verify-provenance`
  ile doğrulandı. Temiz Windows 10/11 makinesinde çalıştırma kanıtı olmadığı için
  kriter hâlâ "Kısmen"dir. Yayıncı güveni ve SmartScreen uyarısı bu yolda kalır;
  kabul edilmiş artık risktir (ER-T13).

## Tehdit modeli §11 çıkış kapıları

Kaynak: [`THREAT_MODEL.md` §11](THREAT_MODEL.md#11-faz-4-çıkış-kapıları).

| Çıkış kapısı | Kanıt (test dosyası / komut) | Sonuç, tarih | Commit | Kanıt türü | Durum | Eksik girdi |
|---|---|---|---|---|---|---|
| Onaysız/süresi geçmiş/replay durumları için state-machine ve fuzz matrisi | Kriter 3'teki dört fuzz dosyası ve `services/signaling/test/stateMachine.test.ts` | 2026-10-09: fuzz katmanı protokol, canlı signaling, web DataChannel ve WPF köprüsünde tamam; durum makinesi matrisi 326/326; üç gerçek bulgu kapatıldı (iç içe `__proto__`, WPF eşlenmemiş surrogate, kodla onaylı oturum sonlandırma) | `6bdf2a5`, `20b972b` | Fuzz, birim/entegrasyon | Karşılandı (test kapsamı) | — |
| Negotiation ID/lane, bounded pending ICE ve DataChannel rol/yetki matrisi | `apps/web/src/features/webrtc/negotiation.test.ts`, `apps/web/src/features/webrtc/peerProtocol.test.ts`, `services/signaling/test/server.test.ts`, `apps/windows-desktop.Tests/NativeVideoBridgeProtocolTests.cs` | Tarihsel 2026-09-02 Dilim 3: web 100/100, signaling 42/42, desktop 87/87. Güncel 2026-10-09 tabanında da geçer | `425abc9` | Birim/entegrasyon | Kısmen | Production churn/soak kanıtı |
| Global/IP kaynak kotaları ve signal/ICE/message rate limitleri | `services/signaling/test/rateLimit.test.ts`, `services/signaling/test/server.test.ts` | Tarihsel 2026-08-24 Dilim 2: signaling 38/38 (64 KiB, flood, bozuk UTF-8, derin JSON, takeover). Güncel 2026-10-09: signaling 81 + 1 atlanan | `425abc9` | Birim/entegrasyon | Kısmen | Production kapasite ölçümü |
| Signaling stdout/stderr, JSONL audit ve TURN/browser probe tanılarında secret sentinel sızıntı testi | Kriter 4'teki dosyalar; `npm run security-output:test`; `npm run security:audit-drill` | 2026-10-09: güvenli çıktı 10/10, TURN 13/13. 2026-10-12 production: dokuz gerçek oturum sonrası audit 35 kayıt + application log 1 satır, hassas desen 0; audit arıza tatbikatı 503 → çıkış → restart → geri dönüş `passed` | `425abc9`, `90241f2` | Birim/entegrasyon, yerel gerçek ortam, production | Karşılandı | Gelecekteki destek paketi doğrulaması (Faz 6) |
| Production npm/NuGet/container taraması, SBOM ve gerekçeli baseline | `npm run security:audit`, `npm run security:containers`, `scripts/container-security-audit.test.mjs` | 2026-10-09: npm + dört NuGet projesi 0 açık; container politika 22/22; yerel `linux/amd64` 3/3 hedef HIGH/CRITICAL `0`. 2026-10-11: Pi `linux/arm64` 3/3 hedef HIGH/CRITICAL `0`, CycloneDX + SPDX + Trivy JSON. 2026-10-12: deploy öncesi yeniden arm64 3/3 `0` (manifest `BFF1492E…0521`), `security:container:deploy` ile production; çalışan image ID'leri ve etiketleri manifestle eşleşir, iki health `healthy` | `d71b739`, `219cfc9`, `abcaab9` | Birim/entegrasyon, yerel gerçek ortam, production | Karşılandı | Operasyon: 48 saatlik tazelikle yeniden tarama ve güvenli digest yenileme |
| Bütünlüğü ve kaynağı doğrulanabilir Windows artifact'i (Authenticode yerine 2026-10-11'den beri GitHub attestation + provenance manifesti) ve bağımsız hash/attestation doğrulaması | Kriter 5'teki dosya ve komutlar | 2026-10-11: 234/234 politika testi; ilk GitHub koşusu `windows-v0.1.0.1` taslağını attest etti; ayrı makinede dört dosyanın attestation'ı ve zip ağacında `verify-provenance` geçti, kurcalama/taban negatifleri düştü. Authenticode adayı `NotSigned`, katalog yok | `971506f`, `8c209df`, `893de84`, `3091505`, `8701f78` | Birim/entegrasyon, yerel gerçek ortam, GitHub-hosted build | Kısmen | Temiz Windows 10/11 makinesi |
| Cloudflare origin/proxy policy ile gerçek HTTPS/WSS deployment testi | `services/signaling/test/server.test.ts` (origin, subprotocol, proxy spoof) | 2026-10-12 production, Pi dışından Cloudflare Tunnel üzerinden: `ediz-remote.v3` site ve WebView2 origin'iyle kabul; `ediz-remote.v2` ve alt protokolsüz istek `426`; yabancı origin `403`; CSP, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, Permissions-Policy, COOP/CORP mevcut. Uygulama portu yalnız `127.0.0.1`; `CF-Connecting-IP` güveni yalnız tunnel arkasında açık | `425abc9`, `abcaab9` | Birim/entegrasyon, production | Karşılandı | HSTS uygulamada yok (isteğe bağlı, Cloudflare'de açılabilir) |
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
  release kimliği ve anti-rollback/build provenance; 2026-10-11'de imzasız
  provenance (GitHub attestation) yolu, ilk attest edilmiş GitHub yayını
  (`windows-v0.1.0.1` taslağı) ve Pi `linux/arm64` gerçek scan. Açık: Pi
  deployment smoke'u ve temiz Windows 10/11 doğrulaması.
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
| 2026-10-11 | Provenance (GitHub attestation) yolu | Release politika/katalog/provenance 111 → 234/234; 3 kasıtlı mutasyon düştü; toplu 576 + 1 atlanan; lint temiz. Yerel temiz ağaç `3091505`, sequence 1 adayında `provenance` OK, `verify-provenance` → `provenance_attestation_invalid` (yerel attestation yok) | Birim/entegrasyon, yerel gerçek ortam | Güncel; `3091505` |
| 2026-10-11 | İlk GitHub `windows-release` koşusu | Run `38107001498` (`windows-2025`, `8701f78`, sequence 1): build ve release işleri başarılı; attestation + CI içi `verify-provenance` OK; `windows-v0.1.0.1` taslağı. Ayrı makinede 4/4 `gh attestation verify` OK, zip ağacında `verify-provenance` OK, negatifler düştü. Önceki iki koşu fail-closed düştü (runner TEMP 8.3 kısa adı, klasör adına bağlı test) | GitHub-hosted build, yerel gerçek ortam | Güncel; sürüm taslak, yayımlanmadı |
| 2026-10-11 | Pi container kapısı | Gerçek `linux/arm64` 3/3 hedef HIGH/CRITICAL `0`, kapı `passed`; manifest SHA-256 `FCC59887…782B` | Hedef platform (build/scan) | `219cfc9`; 2026-10-12 koşusu yerini aldı |
| 2026-10-12 | Pi production deployment | Deploy öncesi arm64 kapısı yeniden 3/3 `0` (manifest `BFF1492E…0521`); `container_deployment:passed`; iki container `healthy`, UID 1000, read-only, capsiz, `no-new-privileges`; audit volume ve secret izinleri doğru; dış HTTPS/WSS politika testi 5/5 | Production | Güncel; `abcaab9` |
| 2026-10-12 | Production gerçek oturum | `windows-v0.1.0.1` zip'i (SHA256SUMS 12/12) geliştirme makinesinde, production v3 üzerinden headless Edge guest ile dokuz oturum: doğrudan P2P 2560×1440 H.264, view+control, `pointer.move` ile gerçek imleç, revoke, ayrılma; zorlanmış TURN relay (relay↔relay UDP); ICE/native lane arızası, retry ve ani guest kaybında zarif hata/kurtarma. Bir oturumda native çökme (`0xC0000005`, ER-T15) | Production (geliştirme makinesi, temiz Windows değil) | `8701f78` paketi |
| 2026-10-12 | Production log/audit örneği | Pi'de salt-okunur sayım: audit 35 kayıt, yalnız sekiz alan, v3; application log 1 satır; IP/kod/SDP/secret/yol deseni 0; coturn log sürücüsü `none`; iki container `healthy`, restart 0 | Production | `abcaab9` deployment |
| 2026-10-12 | Audit arıza tatbikatı ve taban | `npm run security:audit-drill` Docker Desktop amd64'te dört kez `passed` (503 13–46 ms, çıkış kodu 1, restart döngüsü, 5–8 sn'de geri dönüş, önekli kaynak kalmadı). `security:audit`: npm 0, dört NuGet projesi temiz. Toplu 591 + 1 atlanan (TURN 13, güvenli çıktı 10, container 22, audit tatbikatı 15, web 106, protocol 18, signaling 407 + 1 atlanan); lint temiz | Yerel gerçek ortam, birim/entegrasyon | `90241f2`, `b9883ac` |
| 2026-10-11 | Birleşme sonrası `main` | Toplu 576 + 1 atlanan (TURN 13, güvenli çıktı 10, container 22, web 106, protocol 18, signaling 407 + 1 atlanan); release 234/234; lint/build temiz. Protokol rastgele JSON fuzz testi yüklü makinede ~26 sn sürdüğü için fuzz süre bütçesi 30 → 120 sn yapıldı; kapsam değişmedi | Birim/entegrasyon, fuzz | Güncel; `7fc258d` |

2026-10-11 Pi arm64 kapısı yalnız build/scan yaptı; 2026-10-12 deployment, gerçek
oturum ve log/audit satırları production'dır. Diğer koşular production ortamında
yapılmamıştır. Fiziksel EXE/UI smoke 2026-09-02 ve 2026-10-09 koşularında
çalıştırılmadı; 2026-10-12'de GitHub'da derlenen `windows-v0.1.0.1` paketiyle
production üzerinden yapıldı (geliştirme makinesi; temiz Windows kanıtı değildir).

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

### Provenance yolu yerel adayı (2026-10-11)

Kaynak: [`WINDOWS_RELEASE.md`](WINDOWS_RELEASE.md#yerel-kanıt-ve-kalan-iş).

| Alan | Değer |
|---|---|
| Durum | Yerel uçtan uca koşu — **GitHub'da derlenmedi, attestation yok, production değil** |
| Kaynak | Temiz ağaç, commit `3091505`, sequence `1` |
| EXE | `184859904` bayt, SHA-256 `B76FC9718E2AAB877552E8261850CBC834AAD4EB70251B1C08E7366F632D3554`, `NotSigned` |
| Sürüm kaynağı | `ProductVersion 0.1.0+30915050ca8dcdc1efc82bc0f6d7933f21ede0a8`, `FileVersion 0.1.0.1` |
| Provenance manifesti | Şema `1`, 12 dosya, `186112294` bayt; SHA-256 `5F3B83E89629CADCE268B7B7138A76CA36ECC3D467788C6A6FD71AC2D4803777` (yeniden üretimde aynı) |
| SHA256SUMS | SHA-256 `F0148676A549D1D6DB7F68FE1DE2E12720FC7F67F9EFBA74F0690BC42AAA660B`; `sha256sum -c` geçti |
| Kapı sonuçları | `verify-provenance` → `provenance_attestation_invalid`; `gh` yokken `provenance_tool_missing`; taban 2 → `release_rollback_rejected`; kurcalanmış/fazla dosya → `provenance_tree_mismatch`; kirli ağaçta `provenance` → `provenance_dirty_source` |

### GitHub provenance adayı (2026-10-11)

Kaynak: [`WINDOWS_RELEASE.md`](WINDOWS_RELEASE.md#provenance-github-attestation-yolu)
("İlk GitHub koşusu" alt bölümü).

| Alan | Değer |
|---|---|
| Durum | GitHub'da derlendi ve attest edildi; **taslak**, yayımlanmadı; temiz Windows 10/11 kanıtı yok |
| Yayın | `windows-v0.1.0.1` (Actions run `38107001498`, `windows-2025`) |
| Kaynak | `8701f78a11f368e784139d234a3cba6a8b26efda`, sequence `1` |
| EXE | `184859904` bayt, SHA-256 `b1e77dc5ecd56208e1ca99c64e7126ea1eb860350e0a94cf1794f17cfde8f516`, `NotSigned` |
| Zip (dağıtım birimi) | `79933844` bayt, SHA-256 `3e9952464ca3e62b34a787b7766bc8028d8a4661f3bed0b672535899be75783b` |
| Provenance manifesti | SHA-256 `977e44a1528f4bcb39e20d6daf4f803150c64082f5695799f6caec6599d59171` |
| SHA256SUMS | SHA-256 `964eb23173148c1ee4756cc2b8eb42a6383e28f6148ed87a2dbdf026f2ced41c` |
| Doğrulama | 4/4 `gh attestation verify` (signer/source digest = commit, `github-hosted`); zip ağacında `verify-provenance` OK |

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

### Pi linux/arm64 container kapısı (2026-10-11)

Kaynak: [`CONTAINER_RELEASE.md`](CONTAINER_RELEASE.md#2026-10-11-pi-linuxarm64-kanıtı).

| Alan | Değer |
|---|---|
| Platform | Production Pi'nin yerel Docker engine'i, `linux/arm64` |
| Kaynak | Public depodan temiz klon, `219cfc9` |
| Hedefler | Hardened Node runtime, final application, custom coturn — 3/3 HIGH/CRITICAL `0`, sonuç `passed` |
| Manifest şeması | `3` |
| Manifest SHA-256 | `FCC5988740E9204478C3BA5BC3FF0B3117DB1A576D7AD68FD2822022B025782B` |
| Application image | `sha256:48f0054668ad4434a6225f0045f4a18d5c43ec0664bcb79655ee1bdd8a5f5a8a` |
| Coturn image | `sha256:730f47e0a229abf144deb75dafb39bb6252ece95e3e43c8c5368bd757cdb0a59` |
| Trivy DB `updatedAt` | `2026-10-11T01:13:45Z` |
| Trivy DB `downloadedAt` | `2026-10-11T02:05:21Z` |
| Deployment | 2026-10-12'de kapı yeniden çalıştırılıp (manifest `BFF1492E5FEF9DCA4150305012A5997D125255290273B4E591BB28471E040521`, DB `updatedAt` `2026-10-11T19:06:46Z`, `downloadedAt` `2026-10-12T00:22:02Z`, image ID'ler aynı) `security:container:deploy` ile yapıldı; ayrıntı [`CONTAINER_RELEASE.md`](CONTAINER_RELEASE.md#2026-10-12-pi-production-deployment-kanıtı) |

## Kabul için kalan sıra

1. Native çökmenin (ER-T15) kök nedenini bulup düzelt; düzeltmeyi içeren yeni
   GitHub yayınını (sequence 2) üret, attestation/`verify-provenance` ile doğrula
   ve production üzerinden oturum senaryolarını yeniden koş.
2. Yayın adayını temiz Windows 10/11 makinesinde indirip çalıştır; SmartScreen
   davranışını kaydet, production v3 sunucusu üzerinden gerçek bir oturum kur.
   Authenticode imzası sertifika geldiğinde ayrıca eklenir.

(Pi arm64 kapısı, doğrulanmış production deployment'ı, dış HTTPS/WSS testi,
gerçek oturum sonrası production log/audit örneği ve audit arıza tatbikatı
2026-10-12'de tamamlandı.)

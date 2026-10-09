# Faz 4 — Güvenlik sertleştirmesi çalışma planı

Durum: Devam ediyor  
Başlangıç: 2026-08-23

## Dilim 1 — Threat model ve signaling giriş sınırı

- [x] Yazılı tehdit modelini ve veri sınıflarını oluştur.
- [x] Kod brute force, takeover, replay, yetkisiz input, TURN abuse, downgrade,
  hassas log ve supply-chain risklerini kayıt altına al.
- [x] Zorunlu, sürümlü WebSocket alt protokolü sınırını ilk olarak
  `ediz-remote.v1` ile ekle.
- [x] `ready` mesajına current/minimum wire sürümü ekle; legacy fallback'i kapat.
- [x] WebSocket origin'i same-host veya açık allowlist ile sınırla; eksik/kötü
  origin'i upgrade öncesi reddet.
- [x] `CF-Connecting-IP` güvenini explicit production ayarına bağla ve IP'yi
  doğrula.
- [x] Binary frame'i reddet; ortak client/server nesnelerini strict yap.
- [x] SDP/ICE payload'larını ortak strict/bounded şemaya taşı.
- [x] Native-video signaling zarfına ilk güven sınırı olarak `version: 1` ekle;
  Dilim 3 wire kırılımında strict `version: 2` zarfına yükselt.
- [x] Protokol paketi için doğrudan güvenlik test paketi ekle.
- [x] Uygulanabilir SIPSorcery HIGH açıklarını 10.0.16 yükseltmesiyle kapat.
- [x] Yeni web bundle'ı içeren self-contained Windows EXE adayını publish et.
- [ ] Yeni web, signaling ve Windows paketini production'a birlikte al.

Rollout kararı: Güncel sunucu yalnız `ediz-remote.v3` kabul eder ve `ready`
current/minimum sürümünü 3/3 bildirir. Faz 4 wire v1/v2 adayları ile alt protokol
teklif etmeyen daha eski EXE'ler yeni sunucuya bağlanamaz. Güvenlik politikasını
gevşeten legacy seçeneği eklenmeyecek; server deployment yeni desktop artifact'i
hazırlandıktan sonra web/signaling/desktop birlikte yapılacaktır.

## Dilim 2 — Kaynak kötüye kullanımı ve brute-force dayanıklılığı

- [x] Global ve IP başına eşzamanlı WebSocket sınırı.
- [x] IP başına aktif/bekleyen session ve `create_session` kotası.
- [x] Join, resume, invalid-message, signal ve `refresh_ice` için ayrı bounded
  token bucket'lar.
- [x] Global, IP, socket ve kalıcı session-member kapsamlarını ayır; reconnect'in
  ICE/signal burst borcunu sıfırlamasını engelle.
- [x] Sayaç haritaları için TTL, boyut tavanı ve temizleme kanıtı.
- [x] Resume token lookup'ını session başına doğrusal aramadan bounded/O(1)
  hash indeksine taşı.
- [x] Resume'u yalnız henüz bir role/session'a bağlanmamış yeni sokette kabul et.
- [x] Rate-limit yanıtına strict `operation` ve bounded `retryAfterSeconds` ekle;
  create latch, recovery ve aktif oturum davranışını istemcide güvenli ayır.
- [x] `rate_limited`/`capacity_exceeded` metadata'sını kod bazında zorunlu,
  diğer error türlerinde yasak yap; ambiguity'yi fail-closed kapat.
- [x] Throttled resume'u `retryAfterSeconds` sonunda fresh socket ile, aktif
  guest signal akışını fresh-socket resume, host signal/ICE akışını kontrollü ICE
  refresh ile otomatik yeniden dene.
- [x] Strict operation-aware hata sözleşmesi wire-uyumsuz olduğu için signaling
  alt protokolünü current/minimum v2'ye yükselt; v1 fallback'i açma.
- [x] Tarihsel wire v2 64 KiB sınırı, flood, bozuk UTF-8, derin JSON ve takeover
  testleri sonunda servis sağlığı ile normal istemci akışını doğrula.

## Dilim 3 — Oturum ve alt protokol yetkilendirmesi

- [x] Genel peer/native-video offer-answer yönünü role göre doğrula.
- [x] ICE negotiation kimliği/epoch ekleyerek eski negotiation replay'ini reddet.
- [x] Pending ICE candidate kuyruklarına eleman/byte sınırı koy.
- [x] DataChannel label→mesaj matrisi uygula; pointer kanalında yalnız
  `pointer.move` kabul et.
- [x] `screen-share-state`, ping/pong ve session mesajlarını yön/rol bazında sınırla.
- [x] Rate-limit reddinin sequence watermark'ını ilerleterek meşru input'u
  kilitlemesini engelle.
- [x] WebView2/native video bridge'e session epoch ve sürümlü strict zarf ekle.
- [x] 60 KiB ham SDP'nin JSON zarfıyla tutarlı taşınması için WebSocket toplam
  sınırını 128 KiB yap; aşırı kaçış üreten SDP kontrol karakterlerini reddet ve
  128 KiB+1 close davranışını test et.
- [x] Yerel ICE adayını SDP `ice-ufrag` nesline bağla; geç/eski callback'in yeni
  `negotiationId` ile etiketlenmesini engelle.
- [x] WPF native offer öncesinde strict negotiation başlangıç zarfı yayınla;
  pre-offer ICE taşmasını takılmış offer'ı beklemeden görünür fail-closed kapat.
- [x] Fatal protokol kilidini `active`↔`recovering` boyunca koru; yalnız yeni/
  bitmiş oturum veya açık kullanıcı retry'ında sıfırla.
- [x] Native input sequence watermark'ını yalnız başarılı uygulama sonrası ilerlet;
  SAS girişiminde input'u kapatıp bütün basılı girdileri bırak ve kontrol açıkken
  pencerenin sessizce tepsiye gizlenmesini engelle.

Dilim 3 kararı:

- Wire current/minimum v3 ve zorunlu alt protokol `ediz-remote.v3`'tür. Her
  session-description/ICE candidate UUID `negotiationId` taşır; genel peer ile
  native-video lane'leri ayrı izlenir ve lane başına oturum boyunca en fazla 256
  daha önce görülmemiş host offer kimliği kabul edilir.
- Web ve native pending ICE kuyruğu negotiation başına 64 aday/64 KiB; signaling
  aboneliği öncesi erken sinyal kuyruğu lane başına 64 mesaj/128 KiB'dir.
- Tarayıcıdaki yerel ICE callback'i yalnız SDP'den bounded biçimde çıkarılan aynı
  `ice-ufrag` nesliyle eşleşirse gönderilir. WPF ise offer'dan önce ayrı strict
  negotiation başlangıcı yayınlar; web eski/replay başlangıç veya offer ile aktif
  kimliği geri sarmaz. Native pre-offer taşması offer üretimi takılsa da oturumu
  hemen durdurur.
- Native-video signaling ve WebView2 bridge zarfı v2'dir; bridge ayrıca UUID
  `sessionEpoch` ile stale native callback/sinyali ayırır.
- Session DataChannel zarfı v2'dir ve gönderen başına bütün session mesajları ortak
  artan `sequence` alanını kullanır. Strict label/transport/rol/yetki matrisi
  pointer kanalında yalnız kontrol yetkili host'a gelen `pointer.move` mesajını
  kabul eder.
- Matris/reliable taşıma veya güvenli hız sınırı ihlali fail-closed kapanır ve
  native input bırakılır. Eski/replay mesajlar uygulanmaz; rate reddi watermark'ı
  ilerletmez. Fatal kilit aynı onaylı oturumun recovery geçişinde sıfırlanmaz;
  native sıra yalnız gerçekten uygulanan input'ta ilerler.

## Dilim 4 — Hassas loglar ve minimal audit

- [x] TURN/browser doğrulama araçları için ortak redaction/safe-event katmanı oluştur.
- [x] Token, code, SDP, ICE, credential, tam IP ve exception alanlarını tip
  seviyesinde/açık allowlist ile yasakla.
- [x] Ham içerik ve kalıcı istemci tanımlayıcısı içermeyen minimal audit olay
  şemasını, retention ve günlük HMAC IP bucket modelini uygula.
- [x] Sentinel secret'ların signaling stdout/stderr, JSONL audit ve mevcut
  TURN/browser probe tanılarına sızmadığını test et. Kullanıcı tarafından dışa
  aktarılabilir destek paketi henüz bulunmadığı için o kapsam Faz 6'da kalır.
- [x] Production web yanıtlarına script/bağlantı/frame/referrer/yetki yüzeyini
  daraltan sabit CSP ve güvenlik başlıklarını uygula; framework disclosure'ı kapat.

Dilim 4 kararı:

- Signaling audit'i yalnız sekiz sabit JSONL alanını ve izinli olay/sonuç/rol/
  reason kombinasyonlarını kabul eder. Request/session/peer kimlikleri, bağlantı
  kodu, token, SDP/ICE, TURN credential, ham IP, exception, stack ve dosya yolu
  şemada yoktur.
- Ham istemci IP'si ayrı bir audit anahtarıyla günlük HMAC pseudonym'ine çevrilir;
  saklama 1–30 gün, production varsayılanı 7 gündür. Anahtar bounded tek-descriptor
  okumayla yüklenir; audit dizini ve günlük dosya kimliği her yazımda doğrulanır.
- Bounded async kuyruk, dışarıdan üretilebilen gürültü için emission limiti ve
  kritik yaşam döngüsü olayları için rezerv taşır. Kritik kayıt kaybı, dosya
  hatası veya geçersiz audit olayı writer'ı unhealthy yapar.
- Audit başlangıçta hazır değilse port açılmaz. Runtime arızasında health `503`,
  yeni upgrade ve mevcut soketin sonraki mesajı fail-closed olur; bir saniyelik
  watchdog servisi sabit hata koduyla kapatır.
- Production coturn config'i raw bağlantı stdout'unu discard eder. TURN/browser
  probe tanıları ortak bounded redaction sınırından geçer; top-level hatalar stack
  yerine sabit kod üretir.
- Public web yanıtlarında inline script ve script attribute yasaktır; frame,
  object, form ve cross-origin kaynaklar kapalıdır. Tek mevcut React inline stil
  kullanımı için yalnız `style-src-attr 'unsafe-inline'` bırakılır. Paketlenmiş
  WebView2 arayüzü ayrıca meta CSP taşır; yalnız ayarlarda izin verilen güvenli WSS
  hedefleri ile loopback geliştirme WS hedeflerini açar. Ekran paylaşımı için
  `display-capture=(self)` korunurken kamera/mikrofon/konum/ödeme/USB kapatılır.

## Dilim 5 — Supply chain ve artifact bütünlüğü

- [x] İlk NuGet/npm denetimini çalıştır ve uygulanabilir SIPSorcery bulgusunu düzelt.
- [x] Güncellenebilir transitive `nanoid`/`postcss` paketlerini ve yeni duyuru
  sonrası `qs` 6.16.0'ı yükselt; tam `npm audit` sonucunu 0 açığa indir.
- [x] npm ve dört .NET proje taramasını `npm run security:audit` komutunda
  tekrarlanabilir ve bulguda başarısız olan kapıya dönüştür.
- [x] Kalan transitive uyumluluk bulgularını güvenli `System.Net.Http 4.3.4` ve
  `System.Text.RegularExpressions 4.3.1` direct override'larıyla kapat; .NET 8
  runtime assembly seçimini publish çıktısında doğrula.
- [x] Node, coturn ve Trivy base image'larını multi-arch digest ile sabitle;
  production Compose'u yalnız audit'ten çıkan immutable application/coturn image
  ID'lerini tüketen `--pull never`/`--no-build` akışına bağla.
- [x] Final application ve gömülü-entrypoint custom coturn runtime image'larını
  build-once tarayan, CycloneDX/SPDX üreten ve HIGH/CRITICAL bulguda duran
  `security:containers` release kapısını uygula.
- [x] Authenticode anahtarını yalnız Windows Certificate Store/HSM içindeki
  non-exportable key olarak kabul eden modeli uygula; PFX ve parola girdilerini
  fail-closed reddet.
- [x] EXE ile dış SHA-256 katalog imzasında `/fd SHA256 /tr HTTPS /td SHA256`;
  doğrulamada iki artifact için exact signer, timestamp ve
  `signtool verify /pa /all /v /tw` şartlarını zorunlu kıl.
- [x] Strict release manifesti dahil tüm `win-x64` ağacını, ağacın dışındaki
  SHA-256 Windows File Catalog v2 ile kapsa; `Test-FileCatalog=Valid/SHA256`,
  bounded/reparse/TOCTOU kontrollerini ekle.
- [x] 2026-10-09 yeni duyuruları sonrası `proxy-addr` 2.0.8, `shell-quote`
  1.12.0 (`concurrently` 9.2.5), `source-map-js` 1.2.2 ve `vitest` 4.1.11'e
  bildirilen semver aralıkları içinde yükselt; `npm audit` ve dört NuGet projesi
  0 açık.
- [x] Release kimliğini EXE sürüm kaynağına göm: `ProductVersion`
  `<sürüm>+<commit>[.dirty]`, `FileVersion` `<sürüm>.<sequence>`. Manifesti bu
  kimliği taşıyan strict şema v2'ye yükselt; publish sırasında kaynak değişirse
  EXE'yi bırakma.
- [x] Anti-rollback/build provenance politikasını kapıya bağla: imza öncesi temiz
  ağaç, `HEAD` = gömülü commit, `package.json` sürümü, sequence ≥ 1 ve güvenilir
  `EDIZ_REMOTE_RELEASE_MINIMUM_SEQUENCE` tabanı; verify'da manifest/EXE kimlik eşliği,
  temiz kaynak ve taban. Gerçek PE fixture'lı 111 politika testi.
- [ ] Pi `linux/arm64` hedefinde gerçek container kapısını sıfır bulguyla geçir;
  UID 1000 secret/audit volume ve application/coturn health deployment smoke
  kanıtını kaydet.
- [ ] Gerçek OV/EV store/HSM sertifikası ve güvenilir RFC3161 servisiyle temiz
  ağaçtan sequence ≥ 1 üretilmiş EXE ile katalogu imzala; temiz Windows 10/11
  doğrulamasını ve ilk imzalı yayının sequence/commit kaydını tut.

## Faz 4 kabul durumu

Faz 4 henüz tamamlanmadı. İlk dört dilim downgrade/origin/proxy/payload, kaynak
kotaları, brute-force/flood, negotiation replay/pending ICE, DataChannel yetkisi,
hassas çıktı sınırları ve minimal audit'i kapatır. Beşinci dilimin dependency,
container, Windows release ve anti-rollback/build provenance kapıları kod/politika
olarak tamamlandı. Faz 4 kabulü için gerçek Pi hedef-platform taramasının sıfır
bulguyla geçmesi, gerçek EXE + katalog Authenticode/RFC3161 imzası ve temiz makine
doğrulaması gerekir.

## İkinci dilim tarihsel doğrulama özeti

- TURN preflight: 7/7
- Web: 72/72
- Protocol: 9/9
- Signaling: 38/38
- Native: 40 başarılı, zorlanmış TURN ortamı isteyen 1 atlandı
- Desktop: 66/66
- Lint ve build: başarılı
- `npm run security:audit`: npm ve dört .NET proje taraması 0 açık
- Localhost Chromium: wire v2 signaling hazır, kod `907 056` → `767 642` yenileme
  başarılı; 390×844 mobil görünümde yatay taşma ve console warning/error yok
- Publish: `184810752` bayt, `2026-08-24 01:32:12 +03`,
  SHA-256 `8AABBA8BFD76346867903A77DCD7625F25E9803D253D2949BE9AC0995C6B12B1`;
  paket web ağacında wire v1 eşleşmesi `0`, wire v2 eşleşmesi `1`
- Fiziksel EXE smoke: pencere başlığı/handle oluştu ve temiz kapandı
- Authenticode: `NotSigned`; release kapısı henüz geçmedi

## Üçüncü dilim doğrulama durumu

- TURN preflight: 7/7
- Web: 100/100
- Protocol: 10/10
- Signaling: 42/42
- Native: 40 başarılı, zorlanmış TURN ortamı isteyen 1 atlandı
- Desktop: 87/87
- Lint, build, publish ve `npm run security:audit`: başarılı; npm ve dört .NET
  proje taraması 0 açık
- Localhost Browser: wire v3 kod yenileme, iki istemcili host onayı, direct P2P,
  session v2 kalite seçiminin iki tarafa yansıması, 390×844 yatay taşmasız aktif
  guest görünümü ve iki tarafta 0 console warning/error geçti
- Publish: `184835328` bayt, `2026-09-02 15:10:00 +03:00`, SHA-256
  `2DE77D95685E752801E28B98CBCA661208E8653B176C6C13CE93597388613425`;
  source/published dörder web dosyasında göreli yol, boyut ve SHA-256 farkı `0`,
  paket web bundle'ında wire v3 eşleşmesi doğrulandı
- Authenticode: `NotSigned`; production release kapısı henüz geçmedi
- Fiziksel EXE smoke bu dilimde yeniden çalıştırılmadı; görünür pencere açmadan
  yapılan publish/asset/hash doğrulamasının kapsamı olarak kaydedildi

İkinci dilimin yukarıdaki sayıları tarihsel kanıttır; Dilim 3 sonucu değildir.

## Dördüncü/beşinci dilim yerel doğrulama durumu

- Toplu test: 233 başarılı, bir ortam testi atlandı; bunun içinde TURN 13/13,
  güvenli çıktı 10/10, container güvenlik politikası 22/22, web 100/100,
  protocol 10/10 ve signaling 78 başarılı + 1 atlanan test vardır.
- Native: 42 başarılı, zorlanmış TURN ortamı isteyen 1 test atlandı; desktop
  106/106 ve Windows release politika/katalog testleri 31/31 başarılıdır.
- Lint, build, publish ve `npm run security:audit` başarılıdır; npm ve dört .NET
  projesinde bilinen açık bulunmadı. Production application/coturn ile development
  Compose yapılandırmaları 3/3, JavaScript modül syntax kontrolleri 14/14 geçti.
- Güncel imzasız aday `184835328` bayt, `2026-09-02 17:56:51 +03:00`, SHA-256
  `FB9FB3B74E045A76E5677875BDC98E61198A06A48694CABE29D492A6FD25E6BC`;
  strict release manifesti bu değerlerle eşleşir.
- Adayın Authenticode durumu `NotSigned` ve kardeş katalog henüz yoktur;
  `release:windows:verify` bu nedenle beklenen `catalog_missing` sonucu ile
  fail-closed kapanır. Gerçek sertifika/imzalama çalıştırılmadı.
- Güncel Node 22.23.2/Alpine 3.24 ve coturn 4.17.0/Alpine multi-arch parent
  digest'leriyle gerçek Docker Desktop `linux/amd64` kapısı geçti. Hardened Node
  runtime base, final application ve custom coturn için CycloneDX/SPDX/Trivy
  üretildi; HIGH/CRITICAL `0`, manifest şeması `3` ve deployment referansı hazır.
- Audited application runtime Node/no-npm smoke'u; audited coturn runtime ise UID
  1000, read-only, capsiz, `no-new-privileges` health smoke'u verdi. Güncel
  coturn HMAC relay probe'u 6/6 geçti. Bu yerel amd64 kanıtıdır; Pi `linux/arm64`
  gerçek scan, secret/audit-volume ve iki-service deploy smoke hâlâ beklenmektedir.
- Bu doğrulamada fiziksel EXE/UI smoke çalıştırılmadı.

## 2026-10-09 devir sonrası taban ve release provenance doğrulaması

- İlk taban koşusu: testler geçti, `security:audit` npm'de 6 yeni bulguyla
  (3 kritik, 1 yüksek, 2 orta) fail-closed kapandı. Lockfile yükseltmesi sonrası
  npm ve dört NuGet projesi 0 açık.
- Toplu test 233 başarılı + 1 atlanan (TURN 13, güvenli çıktı 10, container
  politika 22, web 100, protocol 10, signaling 78 + 1 atlanan); native 42 + 1
  atlanan; desktop 106/106; lint ve build başarılı.
- Windows release politika/katalog testleri 31 → 111: gerçek `VS_VERSIONINFO`
  taşıyan PE fixture'ları, yalıtılmış geçici git deposu, şema v2 mutasyonları,
  imza öncesi provenance ve imzasız katalogla gate sırası.
- Yerel Docker Desktop `linux/amd64` container kapısı yeni lockfile ile 3/3 hedefte
  HIGH/CRITICAL `0`; manifest SHA-256
  `0C82A7B08C7BC21A88B1A85E727EBC2AF87129C35A537C6605A80DAEF003CB55`; audited
  application image'ı UID 1000, ağsız/read-only Node smoke'unu npm araçları olmadan
  geçti. Coturn health ve HMAC relay probe'u bu koşuda yeniden çalıştırılmadı.
- Geliştirme adayı `184835328` bayt, SHA-256
  `DED61FD7661EE3EFEBBCBFB3F7C2DFE18167F9B4B5DDE14F64277A4168C1D71D`,
  `ProductVersion 0.1.0+971506fb38a0ef162dee09868493e4f481767be0.dirty`,
  `FileVersion 0.1.0.0`; Authenticode `NotSigned`. `verify` `catalog_missing`;
  tabansız `sign` `release_floor_missing`, tabanlı `sign` imza denemeden
  `provenance_dirty_source` ile kapandı.
- Pi `linux/arm64` scan/deploy, gerçek sertifikalı imza ve temiz Windows 10/11
  doğrulaması bu turda yapılmadı; Pi erişimi ve signing sertifikası yoktu.

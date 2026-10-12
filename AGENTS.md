# Ediz Remote — Ajan Çalışma Rehberi

Bu dosya, projeyi yeni bir Codex sohbetinde veya başka bir ajanla devam ettirirken
temel bağlam ve yol haritası olarak kullanılmalıdır. Kök dizinin tamamı için
geçerlidir. Alt dizinde daha özel bir `AGENTS.md` bulunursa o dosyanın talimatları
önceliklidir.

## 1. Projenin amacı

Ediz Remote, danışmanlık verilen bilgisayarlara uzaktan destek sağlamak için
geliştirilen, Windows öncelikli ve mümkün olduğunda doğrudan P2P çalışan bir
AnyDesk alternatifidir.

İlk hedef ticari ürün çıkarmak değil, proje sahibinin kendi müşterilerine güvenli
ve güvenilir biçimde uzaktan bağlanabildiği tam kullanılabilir bir sürümdür.
Mimari daha sonra çok kullanıcılı/ticari ürüne dönüşebilecek şekilde kurulmalı,
ancak bugünkü ihtiyacın önüne lisanslama, abonelik veya geniş yönetim paneli
çalışmaları geçirilmemelidir.

Tam kullanılabilir ilk sürümün hedef kapsamı:

- Host: Windows 10/11 x64 masaüstü uygulaması.
- Operatör: modern Chromium tabanlı tarayıcı; daha sonra aynı Windows uygulaması.
- Görüntü: GPU yakalama ve donanım H.264 encode.
- Taşıma: doğrudan WebRTC P2P, doğrudan bağlantı kurulamazsa TURN fallback.
- Kontrol: yalnızca host'un açık onayından sonra fare ve klavye.
- Güvenlik: görünür oturum durumu, anında yetki iptali ve acil durdurma.
- Dağıtım: imzalanabilir installer ve Raspberry Pi 5 üzerinde self-hosted altyapı.

Ses, dosya aktarımı ve gözetimsiz erişim ilk tam kullanılabilir sürümün zorunlu
kabul kriteri değildir. Pano senkronizasyonu hassas veri modeli nedeniyle V1
sonrasına bırakılmıştır.

## 2. Kullanıcı ve iletişim biçimi

- Proje sahibi teknik bir IT uzmanıdır; açıklamalar doğrudan ve teknik olabilir.
- Kullanıcıyla Türkçe konuş.
- Sonuçla başla, ardından değişen dosyaları, testleri ve kalan riski kısa şekilde
  bildir.
- Makul teknik kararları ilerlemeyi durdurmadan al. Güvenliği veya ürün davranışını
  önemli ölçüde değiştiren seçimlerde varsayımı açıkça belirt.
- Bir geliştirme turu tamamlandığında güvenli ve anlamlı sıradaki adımı öner.

## 3. Değişmez mimari ilkeleri

1. **P2P önceliklidir.** Görüntü ve kontrol verisi mümkün olduğunda iki cihaz
   arasında doğrudan WebRTC ile akar.
2. **Raspberry Pi medya sunucusu değildir.** Pi üzerindeki servis oda/kod yönetimi,
   onay akışı ve SDP/ICE sinyalleşmesi yapar. TURN gerektiğinde medya ayrı TURN
   bileşeninden geçebilir.
3. **Cloudflare Tunnel sinyalleşme içindir.** Tünel, web arayüzü ve WebSocket'i
   `remote.edizegemercan.com.tr` üzerinden yayınlar; gerçek zamanlı masaüstü
   görüntüsünü HTTP/WebSocket üzerinden taşımaya çalışma.
4. **Host onayı olmadan erişim yoktur.** Onaydan önce SDP/ICE aktarımı, ekran
   yakalama veya giriş enjeksiyonu başlatılmamalıdır.
5. **Native görüntü ve kontrol sinyalleri ayrıdır.** Native H.264 hattı
   `channel: "native-video"` zarfıyla ayrıştırılır. Yeni protokoller de açıkça
   sürümlenmeli ve kanal/tür bazında doğrulanmalıdır.
6. **Güvenlik sonradan eklenecek bir katman değildir.** Girdi doğrulama, hız
   sınırı, yetki durumu ve oturum yaşam döngüsü her özellikte baştan ele alınır.
7. **Fallback korunur.** Native Windows yakalama gelişirken tarayıcı host'lar için
   `getDisplayMedia` hattını gereksiz yere bozma.
8. **Gizli erişim yoktur.** Tam ekran paylaşımı/kontrol sırasında host üzerinde
   görünür durum ve bağlantıyı kesme imkânı bulunmalıdır.

## 4. Mevcut mimari

### Bileşenler

| Dizin | Sorumluluk |
|---|---|
| `apps/web` | React 19 + Vite arayüzü, oturum akışı ve tarayıcı WebRTC eşleri |
| `apps/windows-host` | .NET 8 native yakalama, GPU dönüştürme/encode, RTP ve WebRTC |
| `apps/windows-host.Tests` | Native host birim ve yerel eş entegrasyon testleri |
| `apps/windows-desktop` | WPF + WebView2 Windows uygulaması ve native/web köprüsü |
| `apps/windows-desktop.Tests` | Masaüstü ayar ve paketleme testleri |
| `packages/protocol` | Ortak TypeScript/Zod mesaj şemaları |
| `services/signaling` | Express + WebSocket kod/oda/onay/sinyal servisi |
| `infra/cloudflared` | Cloudflare Tunnel örneği |
| `docs` | Protokol, Windows host/desktop ve tasarım belgeleri |

### Çalışan bağlantı akışı

1. Host sinyalleşme servisine bağlanır ve 10 dakika geçerli altı haneli kod alır.
2. Guest kodu girer; host açıkça izin verir veya reddeder.
3. Onay sonrası genel WebRTC DataChannel bağlantısı ve SDP/ICE sinyalleri aktarılır.
4. Windows desktop host ayrıca `native-video` offer'ı üretir.
5. DXGI Desktop Duplication masaüstünü GPU texture olarak yakalar.
6. D3D11 hattı görüntüyü NV12'ye çevirir.
7. Media Foundation donanım MFT'si Annex B H.264 üretir.
8. RFC 6184 STAP-A/FU-A paketleyici RTP payload'larını üretir.
9. SIPSorcery ICE + DTLS-SRTP ile native video track'ini guest tarayıcıya yollar.
10. Guest native track varsa onu, yoksa tarayıcı `getDisplayMedia` fallback'ini
    gösterir.
11. Kontrol onaylandıysa reliable klavye/buton ve düşük gecikmeli pointer kanalları
    guest olaylarını host'a taşır.
12. WPF köprüsü oturum/yetki/şema/sıra/hız kontrollerinden sonra olayları seçili
    monitör koordinatlarına dönüştürür ve `SendInput` ile uygular.

### Native görüntü dayanıklılığı

- SDP generic NACK ve NACK/PLI RTCP feedback desteğini ilan eder.
- Son 4096 RTP paketi NACK yeniden iletimi için bellekte tutulur.
- PLI veya önbellekte bulunamayan kritik kayıp, encoder yenilemesiyle yeni
  SPS/PPS + IDR üretir.
- RTCP receiver report `fraction-lost` verisi hedef bitrate'i yaklaşık 1–8 Mbps
  arasında uyarlar.
- Encoder değişiklikleri salınımı azaltmak için en fazla iki saniyede bir uygulanır.
- Windows arayüzü hedef bitrate ve paket kaybını canlı gösterebilir.

### Mevcut altyapı

- Geliştirme web adresi: `http://localhost:8080`
- Geliştirme signaling adresi: `http://localhost:8788`
- Üretim hostname: `remote.edizegemercan.com.tr`
- Cloudflare origin hedefi: `http://localhost:8080`
- Windows masaüstü varsayılan signaling URL'si:
  `wss://remote.edizegemercan.com.tr/ws`
- Son kullanıcı EXE çıktısı:
  `artifacts/windows-desktop/win-x64/EdizRemote.exe`

## 5. Halihazırda tamamlanan özellikler

- Tek kullanımlık ve süreli bağlantı kodu.
- Host onay/reddetme akışı.
- Host onayında ayrı görüntüleme/kontrol erişim modu seçimi.
- `channel: "control", version: 1` yetki/olay şemaları ve canlı kontrol geri alma.
- Aktif host'a özel strict `revoke_control` mesajıyla signaling oturumunun idempotent
  `control` → `view` düşürülmesi; resume sonrasında `view` kalıcılığı ve web
  revoke latch/retransmit koruması.
- Reliable klavye/buton ile unordered/partial-reliable pointer hareket kanalları.
- Guest pointer/klavye olay üretimi, pointer coalescing ve çift katmanlı hız sınırı.
- DPI/negatif monitör koordinatlarını destekleyen test edilebilir `SendInput` katmanı.
- Disconnect/focus loss/revoke sırasında basılı girişlerin zorunlu bırakılması.
- Görünür kontrol durumu, tek tıkla geri alma ve `Ctrl+Alt+Shift+F12` acil durdurma.
- IP bazlı kod deneme sınırı ve WebSocket mesaj boyutu sınırı.
- WebRTC DataChannel, gecikme ölçümü ve direct/relay yolu gösterimi.
- Sürümlü/yapılandırılabilir ICE listesi ve onay sonrası istemciye özel, kısa
  ömürlü HMAC TURN credential üretimi.
- Güvenli coturn Pi/VPS Compose'u ve gerçek HMAC credential ile yerel 6/6 relay
  allocation probe'u.
- UDP/TCP TURN için gecikme, jitter, kayıp ve bant daraltmalı ağ kalite probe'u.
- Public TURN adresi geldiğinde signaling ile aynı HMAC credential hattını
  kullanarak UDP/TCP relay doğrulayan `turn:public-preflight` komutu.
- Rol bazlı reconnect token, 30 saniyelik onaylı oturum kurtarma ve kontrollü
  ICE credential yenileme.
- Tarayıcı ekran paylaşımı ve guest uzak ekran görünümü.
- WPF + WebView2 Windows uygulaması.
- Çoklu monitör keşfi.
- DXGI Desktop Duplication yakalama.
- GPU NV12 dönüştürme.
- NVIDIA/Intel/AMD Media Foundation donanım encoder keşfi.
- Donanım H.264 Annex B üretimi.
- H.264 STAP-A/FU-A RTP paketleme.
- Native ICE, DTLS-SRTP ve tarayıcıya canlı video.
- RTCP PLI, generic NACK önbelleği ve adaptif bitrate çekirdeği.
- Masaüstü/mobil uyumlu Türkçe arayüz.
- Docker Compose, health endpoint ve Cloudflare Tunnel örneği.
- Self-contained Windows x64 yayınlama.
- Zorunlu `ediz-remote.v3` signaling alt protokolü ve current/minimum wire v3
  politikası; v1/v2 dahil eski istemci için fail-closed upgrade reddi.
- Same-host/açık allowlist WebSocket origin kontrolü, explicit Cloudflare proxy IP
  güveni ve binary frame reddi.
- Strict client/server wire nesneleri, bounded SDP/ICE şemaları, zorunlu UUID
  `negotiationId` ve `version: 2` native-video signaling zarfı.
- Yazılı Faz 4 threat model/veri sınıfları; ilk npm/NuGet denetimi ve SIPSorcery
  10.0.16 güvenlik yükseltmesi.
- Global/IP WebSocket-session hard kotası; global/IP/socket/session-member
  kapsamlı bounded token bucket'lar ve TTL/subject tavanlı sayaç yaşam döngüsü.
- Bounded O(1) reconnect-token indeksi, yalnız boş socket'te güvenli takeover ve
  reconnect boyunca korunan signal/ICE hız borcu.
- İşleme bağlı `rate_limited`/`capacity_exceeded` yanıtı ve create/recovery/active
  fazlarını kilitlemeyen web state-machine davranışı; resume için fresh-socket,
  guest signal için fresh-socket resume, host signal/ICE için kontrollü ICE
  otomatik yeniden denemesi.
- Bare/native-video SDP için host-offer/guest-answer yön doğrulaması.
- Genel peer ve native-video için ayrı negotiation lane'i; lane başına oturum
  boyunca 256 görülen offer kimliği, eski kimlik replay reddi ve resume boyunca
  korunan epoch durumu.
- Web/native pending ICE için negotiation başına 64 aday/64 KiB; signaling erken
  sinyalleri için lane başına 64 mesaj/128 KiB fail-closed kuyruk sınırı.
- Yerel ICE callback'ini SDP `ice-ufrag` nesline bağlayıp geç/eski adayı düşürme;
  native offer öncesi strict başlangıç zarfı ve takılmış offer'dan bağımsız anlık
  pre-offer taşma kapanışı.
- `channel: "session", version: 2` gönderen-başına ortak sıra alanı ve strict
  DataChannel label/transport/rol/yetki matrisi; pointer kanalında yalnız yetkili
  host'a gelen `pointer.move` kabulü.
- Matris, reliable taşıma veya güvenli hız sınırı ihlalinde bağlantı/control
  hattını fail-closed kapatma ve native input bırakma; fatal kilidi aynı onaylı
  recovery boyunca koruma; eski/replay mesajları uygulamadan etkisiz bırakma.
- Native watermark'ı yalnız başarılı input uygulaması sonrası ilerletme; SAS
  girişiminde kontrolü kapatıp bütün girdileri bırakma ve kontrol açıkken gizli
  tepsi çalışmasını engelleme.
- TURN/browser probe'larında exact secret, ağ adresi, token ve kod kalıplarını
  maskeleyen bounded ortak `safe-output` sınırı; top-level hatalarda sabit kod.
- Strict sekiz alanlı minimal JSONL signaling audit'i; günlük HMAC istemci
  pseudonym'i, 1–30 gün retention ve kritik yaşam döngüsü kuyruk rezervi.
- Audit başlangıç/runtime arızasında port/health/WebSocket/yetki yükseltmelerini
  fail-closed tutan watchdog; private/no-symlink audit dosyaları ve production
  coturn raw stdout discard yapılandırması.
- Production HTTP yanıtında sabit CSP/COOP/CORP/Permissions-Policy/referrer/
  nosniff/frame başlıkları ve paketlenmiş WebView2 için güvenli WSS/loopback
  bağlantı hedefleriyle sınırlı meta CSP.
- Signaling içindeki TURN ve audit secret'larını environment yerine bounded/
  no-follow, tek hard-link, current-UID sahipliği ve private-mode doğrulamalı
  dosyalardan okuyan yükleyiciler; coturn tarafında ayrı type/symlink/owner/mode/
  size doğrulaması.
- Digest kilitli Node/coturn/Trivy tabanları; final application ile entrypoint'i
  gömülü custom coturn image'ını build-once tarayan, CycloneDX/SPDX üreten ve
  HIGH/CRITICAL bulguda duran immutable container release/deployment kapısı.
- Store/HSM-only Windows release modeli; strict EXE manifesti ve tüm `win-x64`
  ağacını kapsayan dış SHA-256 Catalog v2 için exact signer, RFC3161 timestamp,
  iki Authenticode/SignTool ve `Test-FileCatalog` doğrulaması.
- EXE sürüm kaynağına gömülü release kimliği (`<sürüm>+<commit>[.dirty]`,
  `<sürüm>.<sequence>`), bu kimliği taşıyan strict manifest v2 ve imza öncesi temiz
  kaynak/`HEAD`/sürüm/sequence tabanı kontrol eden anti-rollback/build provenance
  kapısı.
- Sertifikasız yayın için provenance (GitHub attestation) modu: aynı kaynak/
  sequence/taban kapısıyla tüm `win-x64` ağacını kapsayan strict, kanonik
  provenance manifesti + SHA256SUMS (`release:windows:provenance`) ve ağaç/kimlik/
  taban ile `gh attestation verify` sonucunu fail-closed denetleyen
  `release:windows:verify-provenance`.
- Her derinlikte `__proto__`, eşlenmemiş UTF-16 surrogate ve kap bütçesi reddeden
  protokol ön taraması; istisna yerine temiz ret veren WPF köprü ayrıştırıcıları ve
  protokol, canlı signaling, web DataChannel ve WPF köprüsü için seed'li fuzz matrisi.
- Tablo tabanlı signaling durum makinesi matrisi (326 test; onaysız, süresi geçmiş,
  askıdaki ve replay durumları) ve kod bilgisiyle onaylı/askıdaki oturumun
  sonlandırılamaması.
- Bulguda duran `npm run security:audit`; npm ve dört .NET proje taraması 0 açık.

2026-08-24 tarihli Faz 4 ikinci dilim tarihsel doğrulama tabanı:

- Native testler: 40 başarılı, zorlanmış TURN ortamı gerektiren 1 test atlandı.
- Zorlanmış native TURN simülasyonu: UDP 1/1 ve TCP 1/1 başarılı; yalnızca relay
  ICE adaylarıyla DTLS-SRTP H.264 RTP teslimi.
- İki sanal NAT browser simülasyonu başarılı: gerçek host/guest Chrome onayı,
  yalnızca relay adayları, iki açık DataChannel, 1920×1080 fallback video ve
  5 saniyelik guest ağ kesintisi sonrası ilerleyen görüntü; konsol 0 uyarı/hata.
- Web testleri: 72 başarılı.
- Protocol testleri: 9 başarılı.
- Signaling testleri: 38 başarılı.
- Desktop testleri: 66 başarılı.
- TURN public preflight parser/yapılandırma/sınır testleri: 7 başarılı.
- Lint, build ve publish başarılı.
- TURN ağ kalite probu: 80±20 ms, %2 kayıp ve 4 Mbit/s altında UDP 192/200
  (%96), TCP 60/60 (%100).
- NVIDIA RTX 4060 Ti üzerinde gerçek 2560×1440 DXGI/GPU encode probe başarılı;
  134/134 encoded frame, 30.11 FPS ve 0 encoder restart.
- Self-contained Windows x64 publish başarılı. Web içeriği single-file bundle
  dışında source → güvenli staging → final olarak kopyalandı; source/published
  dörder dosyanın göreli yol, boyut ve SHA-256 karşılaştırması fark `0` verdi.
- Faz 4 ikinci güvenlik dilimi tarihsel wire v2 `EdizRemote.exe` adayı:
  `184810752` bayt,
  `2026-08-24 01:32:12 +03`, SHA-256
  `8AABBA8BFD76346867903A77DCD7625F25E9803D253D2949BE9AC0995C6B12B1`;
  Authenticode `NotSigned`, bu nedenle production release kabulü değil.
- Bu aday fiziksel başlangıç smoke probe'unda `Ediz Remote` HWND oluşturdu ve
  temiz kapandı.
- Final fiziksel EXE probe'unda dolu arayüz, `2 ekran · H.264 GPU`, WebView
  odaktayken F5 sonrası görünür fail-closed hata ve retry ile yeni kod, ikinci
  launch'ta tek pencere, `Alt+F4` tepsiye gizleme ve aynı HWND reaktivasyonu geçti.
- Final gerçek tarayıcı probe'unda direct P2P, 390×844 taşmasız görünüm, temiz
  host/guest konsolları ve görünür terminal oturum bildirimi geçti.
- Faz 4 ikinci dilim tarihsel localhost Chromium probe'unda wire v2 signaling hazır durumu,
  `907 056` → `767 642` kod yenileme, desktop ve 390×844 yatay taşmasız render
  ile 0 console warning/error geçti.
- `npm run security:audit` npm ve dört .NET proje için 0 açık verdi. SIPSorcery
  10.0.16 sonrası uygulanabilir iki HIGH kapandı; eski NETStandard uyumluluk
  düğümleri güvenli 4.3.4/4.3.1 direct override ile temizlendi. Publish fiziksel
  runtime assembly'leri .NET 8.0.29 / assembly 8.0.0.0 kaldı.
- Gerçek desktop→browser P2P oturumunda tıklama, çift tıklama, tekerlek,
  klavye/kısayol, revoke ve global acil durdurma başarılı.
- İki taraflı WebSocket kesintisinden aynı onaylı oturuma resume ve timeout
  sonrası temiz yeni oturum akışı başarılı.
- Canlı native oturumda 2560×1440 → 1920×1080 → 2560×1440 ekran modu
  değişimi sonrası yayın, uygulama yeniden başlatılmadan geri döndü.
- `remote.edizegemercan.com.tr` Cloudflare Tunnel üzerinden yayınlandı; DNS,
  HTTPS health, TLS doğrulamalı WSS kod/onay/ping akışı geçti.
- 2026-08-13: Pi 5 üzerinde mevcut Docker servislerine dokunmadan
  `/opt/ediz-remote` altında production HMAC coturn kuruldu;
  `turn.edizegemercan.com.tr` public UDP ve TCP preflight 6/6 geçti.
- Coturn'un üretilen authenticated yapılandırmayı gerçekten yüklediği ve
  geçersiz HMAC allocation'ını reddettiği negatif testle doğrulandı.
- Pi web/signaling uygulaması ayrı `ediz-remote-app` Compose projesinde healthy;
  canlı kod/onay akışının verdiği TURN credential ile public UDP/TCP relay 6/6.
- Pi üretim arayüzü masaüstü ve 390×844 mobil görünümde yatay taşma ve konsol
  hatası olmadan render edildi; yeni kod oluşturma etkileşimi geçti.
- Public WSS onayının verdiği kısa ömürlü credential ile public coturn UDP ve
  TCP relay 6/6 geçti.
- Gerçek mobil veri→ev interneti oturumunda direct P2P görüntü geçti. Beş saniyelik
  mobil ağ kesintisinde stale WSS nedeniyle ilk recovery başarısız oldu; 5 sn
  ping/pong watchdog, aktif soket token takeover ve tarayıcı `online` reconnect
  düzeltmesi canlıya alındı. Fiziksel tekrar testinde 5 sn mobil veri
  kesintisinden görüntü aynı onaylı oturuma geri döndü.

2026-09-02 tarihli Faz 4 üçüncü dilim doğrulaması:

- TURN public preflight testleri 7/7, web 100/100, protocol 10/10, signaling 42/42
  ve desktop 87/87 başarılıdır.
- Native testler 40 başarılı; zorlanmış TURN ortamı isteyen 1 test atlandı.
- Lint, build, self-contained publish ve `npm run security:audit` başarılı;
  npm ve dört .NET proje taraması 0 açıktır.
- Localhost Browser'da wire v3 kod yenileme, iki istemcili onay, direct P2P,
  session v2 kalite seçiminin iki tarafa yansıması ve 390×844 yatay taşmasız
  aktif guest görünümü geçti; host/guest console warning/error sayısı `0`dır.
- Wire v3 `EdizRemote.exe` adayı `184835328` bayt,
  `2026-09-02 15:10:00 +03:00`, SHA-256
  `2DE77D95685E752801E28B98CBCA661208E8653B176C6C13CE93597388613425`;
  source/published dörder web dosyasında göreli yol, boyut ve SHA-256 farkı `0`
  ve paket bundle'ında wire v3 eşleşmesi doğrulandı.
- Authenticode `NotSigned`; fiziksel EXE smoke bu dilimde yeniden çalıştırılmadı.
  Bu nedenle aday production release kabulü değildir.

2026-09-02 tarihli Faz 4 dördüncü/beşinci dilim yerel doğrulaması:

- Toplu `npm test`: 233 başarılı, 1 ortam testi atlandı. Alt dağılım TURN 13/13,
  güvenli çıktı 10/10, container politika 22/22, web 100/100, protocol 10/10 ve
  signaling 78 başarılı + 1 atlanandır.
- Native 42 başarılı + zorlanmış TURN ortamı isteyen 1 atlanan, desktop 106/106
  ve Windows release politika/katalog testleri 31/31 geçti.
- Lint, build, self-contained publish ve `npm run security:audit` başarılı; npm
  ile dört .NET proje denetimi temizdir. Production application/coturn ve dev
  Compose 3/3; JavaScript modül syntax kontrolleri 14/14 geçti.
- Güncel imzasız `EdizRemote.exe` adayı `184835328` bayt,
  `2026-09-02 17:56:51 +03:00`, SHA-256
  `FB9FB3B74E045A76E5677875BDC98E61198A06A48694CABE29D492A6FD25E6BC`;
  strict release manifesti bu değerlerle eşleşir.
- Authenticode `NotSigned`, kardeş katalog yoktur ve release verify beklenen
  `catalog_missing` ile fail-closed kapanır. Gerçek sertifika/imzalama, gerçek Pi
  `linux/arm64` container scan/deploy ve fiziksel EXE/UI smoke çalıştırılmadı.
- Node 22.23.2/Alpine 3.24 ve coturn 4.17.0/Alpine exact multi-arch digest'leriyle
  gerçek Docker Desktop `linux/amd64` kapısı geçti. Hardened Node runtime base,
  final application ve custom coturn için CycloneDX/SPDX/Trivy üretildi;
  HIGH/CRITICAL `0`, manifest şeması `3` ve deployment referansı doğrulandı.
- Audited application image'ında Node/no-npm smoke'u; audited coturn image'ında
  UID 1000, read-only rootfs, capsiz, `no-new-privileges` health smoke'u geçti.
  Güncel coturn tabanıyla HMAC relay probe'u 6/6 başarılıdır. Bunlar yerel amd64
  kanıtıdır; Pi `linux/arm64` scan ve iki-servis deployment kabulü değildir.

2026-10-09 tarihli devir sonrası taban yenileme ve release provenance dilimi:

- İlk taban koşusunda testler geçti, fakat `npm audit` 6 yeni bulgu verdi
  (`proxy-addr`, `shell-quote`/`concurrently`, `source-map-js`, `vitest`). Hepsi
  bildirilen semver aralıkları içinde lockfile'da yükseltildi; `security:audit`
  npm ve dört .NET projede 0 açık verdi.
- Toplu `npm test` 233 başarılı + 1 ortam testi atlandı; lint, build, native 42
  başarılı + 1 atlanan ve desktop 106/106 geçti.
- Yerel Docker Desktop `linux/amd64` container kapısı yeni lockfile ile üç hedefte
  HIGH/CRITICAL `0` verdi; manifest SHA-256
  `0C82A7B08C7BC21A88B1A85E727EBC2AF87129C35A537C6605A80DAEF003CB55`.
- Release kimliği/anti-rollback/build provenance kapısı eklendi; Windows release
  politika/katalog testleri 111/111 geçti. Gerçek publish adayı kimliği
  `docs/DEVELOPMENT.md` dosyasındadır; aday `NotSigned` ve kirli ağaçtan geliştirme
  build'idir, production kabulü değildir.
- Fuzz dilimi sonrası toplu `npm test` 250 başarılı + 1 atlanan (TURN 13, güvenli
  çıktı 10, container 22, web 106, protocol 18, signaling 81 + 1); native 42 + 1;
  desktop 113/113; Windows release 111/111. Fuzz iki gerçek bulgu verdi ve ikisi de
  kapatıldı: iç içe `__proto__` anahtarının sessizce atılması ve WPF köprüsünün
  eşlenmemiş surrogate'ta istisna fırlatması.
- Durum makinesi matrisi ve `joinSession` düzeltmesi sonrası (`20b972b`) toplu
  `npm test` 576 başarılı + 1 atlanan (signaling 407 + 1); lint ve build temiz.
  Kriter bazında kanıt `docs/PHASE4_ACCEPTANCE.md` altındadır.

2026-10-11 provenance (GitHub attestation) dilimi:

- Depo sahibi kararı: ücretli Authenticode sertifikası gelene kadar Faz 4'ün
  Windows binary bütünlüğü/kaynağı kriteri GitHub artifact attestation (Sigstore
  SLSA build provenance) + provenance manifesti ile karşılanacak; SmartScreen
  uyarısı kabul edilmiş artık risktir (ER-T13). Authenticode yolu değişmedi.
- Windows release testleri 111 → 234/234 (123 provenance); 3 kasıtlı mutasyon
  (hash karşılaştırması, fazla dosya reddi, attestation çıkış kodu) düştü. Toplu
  `npm test` 576 + 1 atlanan, lint temiz.
- Yerel temiz ağaç `3091505`, sequence 1 adayında `provenance` OK;
  `verify-provenance` yerel attestation olmadığı için beklenen
  `provenance_attestation_invalid`. İlk GitHub koşusu (run `38107001498`,
  `8701f78`, sequence 1) `windows-v0.1.0.1` taslağını attest etti; ayrı makinede
  4/4 `gh attestation verify` ve zip ağacında `verify-provenance` geçti. Temiz
  Windows 10/11 kanıtı bekliyor.

Bu sayıları sabit kabul etme; test eklendiğinde bu bölümü güncelle.

## 6. Bilinen sınırlar

- TURN istemci, credential, coturn Compose, public Pi coturn ve gerçek
  WAN/mobil veri direct-recovery-relay kabulü hazırdır.
- Ayrı donanım imlecinin konumu guest katmanında gösteriliyor; exact DXGI pointer
  shape/piksel maskesi görüntüye birleştirilmiyor ve Faz 6 GPU/sürücü matrisine
  ertelendi.
- Döndürülmüş monitörlerin kare rotasyonu uygulanmıyor.
- Kilit ekranı, UAC secure desktop ve Session 0 yakalanmıyor; bunları güvenlik
  önlemlerini aşarak çözmeye çalışma.
- Installer, gerçek code signing sertifikası/imzalı production artifact ve
  otomatik güncelleme yok; imzalama/katalog ve anti-rollback/build provenance
  kapısı kod ve politika olarak hazırdır. Sertifika gelene kadar Windows yayını
  imzasız provenance (GitHub attestation) yoluyla çıkar; işletim sistemi yayıncı
  güveni yoktur ve SmartScreen ilk çalıştırmada uyarır.
- Wire v3/minimum sürüm kapısı tamamlandı; gelecekteki v4 capability ve geriye
  uyumluluk/iki aşamalı rollout politikası henüz tamamlanmadı.
- Daha geniş uzak ağ, uzun süreli soak ve farklı GPU sürücü matrisi henüz
  tamamlanmadı; bunlar Faz 6 kapsamındadır.
- Gözetimsiz erişim için güvenli cihaz kimliği/credential kasası yok.
- Clipboard senkronizasyonu Faz 3 ve V1 kapsamında yoktur; hassas veri yönü,
  görünür onay, boyut/tür sınırı ve iptal modeli Faz 4'ten sonra tasarlanmadan
  eklenmemelidir.

## 7. Tam kullanılabilir sürüme giden yol haritası

Fazlar sıralıdır. Bir fazın kabul kriterleri karşılanmadan sonraki büyük ürün
fazını “tamamlandı” sayma. Küçük hazırlıklar paralel yapılabilir.

### Faz 1 — Güvenli fare ve klavye kontrolü — TAMAMLANDI

Amaç: Onaylı oturumda operatörün normal Windows masaüstünü gerçekten kontrol
edebilmesi.

Tamamlanan uygulama:

- Sürümlü `control.request`, `control.granted`, `control.revoked` ve
  `control.event` şemaları.
- Güvenilir/sıralı klavye-buton kanalı ve unordered `maxRetransmits: 0` pointer
  hareket kanalı; kanal hatasında güvenilir fallback.
- Görüntü alanından seçili monitörün fiziksel/negatif koordinatlarına dönüşüm.
- Küçük ve test edilebilir arabirim arkasında Windows `SendInput`.
- Pointer coalescing, bounded mesaj boyutu, web/native hız sınırı ve replay reddi.
- Disconnect, focus loss, visibility change, revoke, WebView hatası ve kapanışta
  basılı tuş/butonların bırakılması.
- Görünür kontrol durumu, tek tıkla revoke ve global `Ctrl+Alt+Shift+F12` acil stop.
- `Ctrl+Alt+Del`, UAC secure desktop, kilit ekranı ve Session 0 sınırlarının korunması.

Kabul kriterleri:

- Host ayrı ayrı görüntü ve kontrol izni verebilir.
- Guest tıklama, çift tıklama, sürükleme, tekerlek ve temel klavye girişini doğru
  uygular.
- Türkçe karakterler ve yaygın kısayollar kontrollü test matrisinden geçer.
- Disconnect sonrası hiçbir tuş/buton basılı kalmaz.
- Host yetkiyi anında iptal edebilir; guest yeni input gönderemez.
- Kontrol izni olmadan gelen bütün input mesajları reddedilir ve oran sınırlıdır.

Bu kriterlerin tamamı karşılandı. Kanıt matrisi `docs/PHASE1_ACCEPTANCE.md`
dosyasındadır.

### Faz 2 — İnternet bağlantısı ve oturum kurtarma — TAMAMLANDI

Amaç: Farklı NAT/CGNAT ağlarında ve kısa bağlantı kesintilerinde güvenilir çalışma.

Yapılacaklar:

- Raspberry Pi veya uygun VPS üzerinde coturn kur.
- Direct bağlantı başarısızsa relay'e düş, arayüzde yolu açıkça göster.
- WebSocket reconnect, oturum zaman aşımı ve kontrollü ICE restart ekle.
- Kısa ağ kesintisinde aynı onaylı oturumu sınırlı bir grace period içinde kurtar.
- `DXGI_ERROR_ACCESS_LOST`, ekran çözünürlüğü/monitör/GPU değişimi ve uyku-uyanma
  durumlarında capture graph'ını yeniden kur.
- Encoder veya capture hatasında sessizce donmak yerine anlaşılır durum gönder.

Tamamlanan geliştirme:

- Uzun ömürlü TURN parolası istemciye gömülmeden, signaling servisinden host
  onayı sonrası ayrı ve kısa ömürlü HMAC credential üretiliyor.
- Sürümlü/yapılandırılabilir ICE listesi tarayıcı genel eşine, native H.264
  tarayıcı eşine ve Windows SIPSorcery eşine uygulanıyor.
- TURN yapılandırılmamış kurulumlarda mevcut STUN/direct fallback korunuyor.
- Resmi coturn 4.12.0-r0 imajıyla Pi/VPS deployment, healthcheck, güvenlik
  sınırları ve gerçek signaling HMAC credential kullanan 6/6 yerel relay probe
  hazırdır.
- Host ve guest için bağlantı kodundan ayrı 256 bit reconnect token, yalnızca hash
  saklama, başarılı resume sonrası rotation ve 30 saniyelik grace period hazırdır.
- WebSocket yeniden bağlanması, iki taraflı suspend/resume, replay/timeout reddi ve
  kontrollü yeni oturum yolu uygulanmıştır.
- `disconnected`/`failed` durumlarında en fazla üç denemeli ICE yenileme, yeni
  kısa ömürlü TURN credential ve doğrudan/relay durum görünürlüğü uygulanmıştır.
- `DXGI_ERROR_ACCESS_LOST` sınıflandırılır; seçili ekran cihaz adıyla yeniden
  bulunur ve DXGI/NV12/encoder graph'ı 1/2/4 saniyelik bounded retry ile kurulur.
- Capture/encoder hataları kullanıcıya görünür; otomatik denemeler tükenirse
  `Yeniden dene` native oturumu baştan kurar.
- İki taraflı WebSocket kesintisi 30 saniyelik grace period içinde aynı onaylı
  oturuma dönmüş; timeout sonrası eski onayın kullanılmadığı doğrulanmıştır.
- 80±20 ms gecikme, %2 paket kaybı ve 4 Mbit/s sınırında UDP/TCP TURN probe'u
  geçmiştir.
- Native H.264 gönderici/alıcıda `relay-only` ICE politikasıyla UDP ve TCP TURN
  üzerinden şifreli RTP teslimi simüle edilmiştir; test host/`srflx` adaylarını
  reddeder ve kısa ömürlü signaling HMAC credential kullanır.
- İki ayrı özel ağ ve NAT router arkasındaki gerçek Chrome host/guest uygulaması
  `relay-only` olarak bağlanmış; UI, DataChannel ve fallback ekran videosu ile
  kısa ağ kesintisi dönüşü doğrulanmıştır. Browser medya ayağı kapalı laboratuvar
  omurgasında `no-auth`, üretim HMAC hattı ise ayrı resmi coturn probe'unda
  doğrulanmıştır.
- Public TURN preflight otomasyonu yerel LAN listener üzerinde UDP 6/6 ve TCP
  6/6 dry-run vermiştir.
- Gerçek çözünürlük değişiminde native yayın uygulama yeniden başlatılmadan
  toparlanmıştır.
- Pi 5 üzerinde production HMAC coturn ile public UDP/TCP 6/6 relay, geçersiz
  credential reddi, Cloudflare HTTPS/WSS ve canlı onay credential zinciri geçti.
- Ev internetindeki Windows host ile mobil veri tarayıcısı direct P2P bağlandı ve
  görüntü aktı. Beş saniyelik mobil veri kesintisinden aynı onaylı oturuma dönüş
  doğrulandı.
- Direct adayları geçici olarak kapatıldığında aynı fiziksel WAN oturumu
  self-hosted public coturn üzerinden bağlandı ve arayüzde `TURN relay` görüldü.
  Testten sonra production paketi normal P2P öncelikli `all` politikasına geri
  alındı.

Faz 2'nin bütün kabul kriterleri karşılandı. Uyku-uyanma/GPU reset dayanıklılığı
ve daha geniş donanım/ağ matrisi Faz 6'da sürdürülecektir. Kanıt matrisi
`docs/PHASE2_ACCEPTANCE.md` dosyasındadır.

Kabul kriterleri:

- Aynı LAN, farklı ev/ofis ağı, mobil hotspot ve en az bir CGNAT/symmetric NAT
  senaryosu başarıyla bağlanır.
- Direct mümkün olduğunda relay kullanılmaz; direct mümkün değilse TURN çalışır.
- 30 saniyelik kısa ağ kesintisinden kullanıcıyı yanıltmadan toparlanır veya temiz
  biçimde yeni bağlantı ister.
- Ekran modu değişiminden sonra uygulama yeniden başlatılmadan yayın döner.

### Faz 3 — Uzaktan destek kullanıcı deneyimi — TAMAMLANDI

Amaç: Günlük danışmanlık işinde teknik sürtünmeyi azaltmak.

Tamamlanan geliştirme (2026-08-23):

- Ana ve aktif oturum ekranlarında host/guest rolleri “destek alan/destek veren”
  olarak sadeleştirildi.
- Native Windows monitör listesi bounded WebView2 köprüsü ve sürümlü
  `channel: "session", version: 2` DataChannel mesajlarıyla guest operatöre
  taşındı.
- Operatörün `display.select` isteği host ve native sınırlarında doğrulanıyor;
  DXGI yakalama ve `SendInput` koordinat alanı aynı seçili monitöre geçiyor.
- Monitör değişiminde basılı girişler bırakılıyor, kontrol yetkisi korunuyor ve
  native H.264 offer aynı onaylı oturum içinde yeniden kuruluyor.
- Direct/relay, gecikme, hedef bitrate ve paket kaybı ayrı alanlı sade durum
  panelinde gösteriliyor.
- İki gerçek localhost tarayıcıyla kod/onay/direct-P2P akışı, masaüstü render,
  390×844 mobil görünüm, konsol ve ana etkileşim doğrulandı.
- Sürümlü `quality.select`/`quality.state` mesajlarıyla otomatik, hız ve kalite
  profilleri eklendi; native encoder tavanı 8/3/12 Mbps ve FPS 30/24/30 olarak
  uygulanıyor, browser fallback bounded track constraint kullanıyor.
- Guest görüntüsüne sığdır, 1:1 gerçek piksel ve tam ekran eklendi. Pointer
  koordinatı render edilen video dikdörtgeninden hesaplandığı için letterbox,
  scroll ve fullscreen modlarında aynı normalize alan korunuyor.
- İki gerçek localhost tarayıcıda kalite seçimi host'a gidip state olarak geri
  döndü; ölçekleme ve tam ekran etkileşimi ile 390×844 aktif guest görünümü
  konsol hatası ve yatay taşma olmadan doğrulandı.
- DXGI pointer konumu seçili monitörde normalize edilip bounded WebView2 köprüsü
  ve sürümlü/sıralı `cursor.state` mesajıyla guest'e taşınıyor. Guest katmanı
  sığdır/1:1/scroll/fullscreen video dikdörtgenine DOM üzerinden yerleşiyor;
  DXGI imleci kareye bileşik verirse çift çizim yapılmıyor.
- Bağlantı süresi beşinci sade durum alanı olarak eklendi ve aynı onaylı oturumun
  `recovering` geçişinde sıfırlanmıyor.
- Gerçek Windows desktop→browser 1920×1080 native H.264/direct-P2P oturumu ile
  390×844 mobil render ve konsol doğrulaması geçti.
- Windows sistem tepsisi, boşta tepsiye gizleme, aktif oturumda görünmez çalışmayı
  engelleyen çıkış onayı ve named mutex/event tabanlı tek-instance eklendi.
- Kapanış yolu tutulan input → hotkey → native stream → synchronization → WebView
  sırasıyla deterministik hale getirildi; ikinci gerçek EXE probe'unda yalnızca
  ilk PID çalışmaya devam etti.
- Signaling, WebRTC, ekran paylaşımı ve desktop durumları ham hata metinlerinden
  ayrılarak merkezi, allowlist kullanıcı hata kataloğunda toplandı; eylemler role
  ve mevcut güvenli recovery yoluna göre sınırlandı.
- Signaling sunucu mesajlarına runtime şema doğrulaması uygulandı. Beklenmeyen
  mesaj, bozuk ICE yapılandırması veya çözümlenemeyen protokol durumu bağlantıyı
  fail-closed kapatıp yalnızca güvenli genel hata kodu yayınlıyor.
- WebSocket callback'leri yalnız güncel aktif soket nesli için işleniyor. Şemadan
  geçen mesajlar ayrıca oturum fazı ve role göre doğrulanıyor; geç mesajlar
  etkisiz kalıyor, geç create/join yanıtları mevcut kullanıcı işlemini geri
  alamıyor, aynı bekleyen istek coalesce ediliyor ve terminal sonuçtan sonra açık
  yeni denemeye kadar oturum mesajlarını engelleyen latch korunuyor. Bozuk/unknown
  payload fail-closed kalıyor; `peer_unavailable` mevcut onaylı `accessMode`
  değerini temizlemiyor.
- Aktif host kontrol geri almayı strict, sürümlü `revoke_control` mesajıyla sunucuya
  kalıcılaştırıyor. Sunucu `control` → `view` geçişini idempotent uyguluyor; resume
  `view` dönüyor. Web latch'i stale `control` resume yanıtını yerelde kabul etmeyip
  geri alma mesajını yeniden gönderiyor.
- WebView2 navigation/process arızası native stream'i durduruyor, kontrol
  girdilerini bırakıyor ve masaüstü yükleme/hata ekranında yeniden yükleme veya
  WebView'i yeniden oluşturma yolu sunuyor. Yalnız WPF'nin kendi `Navigate`
  çağrısından hemen önce kurduğu tek kullanımlık expected-navigation izni kabul
  ediliyor; F5, Ctrl+R, programatik reload ve diğer beklenmeyen top-level
  navigasyonlar aynı fail-closed kapanışa giriyor.
- Desktop bridge hataları capture, encoder, GPU input, control input, display,
  quality ve native video alanlarına ayrıldı; köprü dışına yalnızca allowlist
  kodlar çıkıyor.
- Sürümlü `media.state` mesajına sıra ve hız sınırı eklendi; replay, sıra dışı,
  role aykırı veya limit üstü durum güncellemeleri etkisiz kalıyor.
- Tarayıcı host mevcut ekranı değiştirirken picker'ı iptal eder veya picker hata
  verirse eski canlı stream gizli kalmıyor: durum yeniden `sharing` oluyor ve
  allowlist uyarı görünür kalıyor; canlı stream yoksa durum `idle` oluyor.
- Peer/native video, signaling, desktop ve ekran paylaşımı için görünür crash/
  retry ekranları aynı merkezi action yönlendirmesine bağlandı.
- Desktop publish web asset'lerini single-file dışında tutuyor; source doğrulaması,
  güvenli staging, stale ağacın değiştirilmesi ve final index referans kontrolü
  eksik asset'i başarılı paket gibi yayınlamayı engelliyor.

Çalışma listesi:

- [x] Host/guest rollerini arayüzde netleştir.
- [x] Native uygulamanın guest rolünü değerlendir: aynı EXE'nin WebView2 arayüzü
  guest/destek veren rolünü destekliyor; ayrı native guest gerekli değil.
- [x] Monitör seçimi ve oturum sırasında monitör değiştirme.
- [x] Kalite seçenekleri: otomatik, hız öncelikli, kalite öncelikli.
- [x] Uzak imleç gösterimi.
- [x] DXGI pointer shape/piksel maskesini değerlendir: exact birleşimi Faz 6 GPU/
  sürücü matrisine ertele, mevcut normalize uzak imleç katmanını koru.
- [x] Tam ekran, gerçek piksel, sığdır ve ölçekleme seçenekleri.
- [x] Direct/relay, bitrate, kayıp ve gecikme için sade durum paneli.
- [x] Bağlantı süresini durum paneline ekle.
- [x] Sistem tepsisi, tek instance davranışı ve temiz kapanış.
- [x] Kullanıcıya dönük hata mesajlarının kalanını ve “yeniden dene” akışını sadeleştir.
- [x] Clipboard kapsam kararını ver: güvenlik modeli nedeniyle Faz 3/V1 dışında;
  Faz 4 sonrasında post-V1 açık opt-in özellik olarak değerlendir.

Kabul kriterleri:

- Teknik olmayan host yalnızca uygulamayı açıp kodu söyleyerek destek alabilir.
- Operatör monitörü/ölçeklemeyi bağlantıyı koparmadan değiştirebilir.
- Bütün hata durumları donmuş ekran yerine görünür bir durum ve iyileşme yolu verir.

Bu kriterlerin tamamı karşılandı. Kanıt ve bilinen fiziksel risk matrisi
`docs/PHASE3_ACCEPTANCE.md` dosyasındadır. Exact DXGI pointer shape bileşimi Faz 6
GPU matrisine; clipboard ise güvenli onay/veri yönü modeli tamamlanmadan
uygulanmamak üzere Faz 4 sonrasına ve post-V1'e bırakılmış ürün kararlarıdır.

### Faz 4 — Güvenlik sertleştirmesi

Amaç: İnternete açık self-hosted kullanım için kabul edilebilir saldırı yüzeyi.

Tamamlanan güvenlik geliştirmeleri (2026-08-23–2026-10-09):

- `docs/THREAT_MODEL.md` altında varlıklar, veri sınıfları, güven sınırları ve kod
  brute force, takeover, replay, yetkisiz input, TURN abuse, downgrade, hassas log,
  DoS ve supply-chain risk kaydı oluşturuldu.
- WebSocket upgrade zorunlu `ediz-remote.v3` alt protokolüne bağlandı. Sunucu
  `ready` ile current/minimum wire v3 bildiriyor; legacy fallback yok. İlk dilimde
  kurulan v1 sınırı operation-aware strict hata sözleşmesiyle v2'ye, Dilim 3'te
  negotiation kimliği ve oturum zarfı kırılımıyla v3'e yükseltildi.
- Eksik/kötü origin HTTP 403, eksik/uyumsuz alt protokol HTTP 426 ile upgrade
  öncesi reddediliyor. Same-host ve açık `SIGNALING_ALLOWED_ORIGINS` allowlist'i
  destekleniyor.
- `CF-Connecting-IP` yalnız `TRUST_CLOUDFLARE_CONNECTING_IP=true` olduğunda ve
  değer geçerli IP ise kullanılıyor; varsayılan istemci soket adresidir.
- Client/server wire nesneleri strict hale getirildi. SDP 60 KiB, ICE candidate
  4096 karakterle sınırlandı; binary WebSocket frame reddediliyor ve
  `native-video` zarfı `version: 2` taşıyor.
- Protocol için 5 doğrudan güvenlik testi; signaling origin/subprotocol/proxy
  spoof/binary/extra-field testleri eklendi.
- SIPSorcery 10.0.16'ya yükseltilerek uygulanabilir iki HIGH kapatıldı;
  `nanoid`/`postcss` transitive güncellemeleri sonrası `npm audit` 0 açık.
- İkinci dilimde yeni web bundle'lı self-contained Windows adayı publish edildi.
  Wire v1/v2 adayları ve alt protokol teklif etmeyen daha eski EXE'ler yeni v3
  sunucuyla bilinçli olarak uyumlu değildir; Dilim 3 artifact kimliği tam
  doğrulama/publish sonrasında kaydedildi ve production web/signaling/desktop
  birlikte güncellenmelidir.
- Global 256/IP 16 WebSocket, global 96/IP 4 session hard tavanı; create/join/
  resume/invalid/inbound/signal/ICE için global ve uygun IP/socket/member token
  bucket kapsamı eklendi. 4096 IP subject ve 15 dakika TTL fail-closed bounded'dır.
- Resume token lookup'ı O(1) indekstir; aktif başka session'a bağlı socket resume
  yapamaz. Signal/ICE bucket'ı active socket takeover ile sıfırlanmaz.
- `rate_limited` strict operation/retry metadata'sı ve hard kota için ayrı
  `capacity_exceeded` eklendi. Metadata'sız/yanlış zarf reddedilir; web create
  latch'ini ve active onayı korur; throttled resume'u fresh socket'le, guest'in
  düşen answer sinyalini fresh-socket resume'la, host signal/ICE'ı kontrollü ICE
  refresh ile otomatik yeniden dener.
- SDP UTF-8 byte sınırı, güvenli SDP metin karakteri kontrolü, deep JSON,
  128 KiB+1 close, bozuk UTF-8, flood, counter cleanup ve offer/answer yön
  testleri tamamlandı.
- Her peer sinyali zorunlu UUID `negotiationId` taşır. Genel peer ile native-video
  lane'leri ayrı izlenir; yalnız host yeni, daha önce görülmemiş offer kimliği
  açabilir, guest yalnız aynı kimliğe bir kez answer verebilir ve candidate yalnız
  güncel kimlikte kabul edilir. Lane başına 256 kimlikten sonra yeni onaylı oturum
  gerekir; durum reconnect/resume boyunca korunur.
- Web ve native eşlerin pending ICE kuyruğu negotiation başına 64 aday/64 KiB;
  signaling handler kurulmadan gelen peer/native sinyal kuyruğu lane başına 64
  mesaj/128 KiB ile bounded'dır. Taşma fail-closed kapanır.
- Tarayıcı yerel ICE adayını SDP `ice-ufrag` nesline bağlar ve geç nesil callback'i
  düşürür. WPF offer öncesinde strict negotiation başlangıcı yayınlar; web replay
  offer ile aktif kimliği geri sarmaz. Pre-offer ICE taşması offer üretimi takılsa
  bile native oturumu hemen durdurur.
- Session DataChannel zarfı v2'dir ve gönderenin bütün session mesajları ortak
  artan `sequence` alanını kullanır. Label/transport/rol/yetki allowlist'i pointer
  kanalını yalnız `pointer.move` ile sınırlar; güvenilir kanal kapanırsa pointer ve
  native input da kapatılıp basılı girişler bırakılır. Matris/hız ihlali fail-closed,
  eski veya replay sıra ise etkisizdir; rate reddi sıra watermark'ını ilerletmez.
  Fatal kilit aynı onaylı recovery'de kalır; native sıra yalnız başarılı input
  uygulamasında ilerler, SAS denemesi ve kontrol açıkken gizli tepsi yolu input'u
  kapatıp bütün basılı girdileri bırakır.
- Signaling audit'i yalnız sekiz sabit JSONL alanını ve izinli olay/sonuç/rol/
  reason matrisini kabul eder; bağlantı kodu, token, request/session/peer kimliği,
  SDP/ICE, TURN credential, ham IP, exception, stack ve dosya yolu şemada yoktur.
- Ham IP ayrı audit anahtarıyla günlük HMAC pseudonym'ine çevrilir. Retention
  1–30 gün, production varsayılanı 7 gündür; key tek descriptor/bounded read ile,
  audit dizini ve günlük dosya ise kimlik/no-symlink/private-mode kontrolleriyle
  işlenir.
- Dışarıdan üretilebilen audit gürültüsü emission limitiyle bastırılır ve kritik
  yaşam döngüsü olaylarının kuyruk rezervini tüketemez. Startup/runtime audit
  arızası health, yeni upgrade, mevcut socket mesajı, approval ve resume yollarını
  fail-closed kapatır; watchdog sabit hata koduyla servisi sonlandırır.
- TURN ve browser doğrulama araçları ortak bounded redaction sınırını kullanır;
  production coturn config'i raw bağlantı stdout'unu discard eder. Sentinel
  sızıntı, retention, queue starvation, symlink/junction, runtime degradation ve
  shutdown yarış testleri eklendi.
- Production web yanıtlarına sabit CSP ve tarayıcı güvenlik başlıkları, paketlenmiş
  WebView2 arayüzüne güvenli WSS/loopback bağlantı hedefleriyle sınırlı meta CSP
  eklendi. Signaling TURN/audit secret'ları environment yerine bounded/no-follow,
  current-UID/private-mode ve tek-link doğrulamalı dosyalardan yüklenir; coturn
  entrypoint'i type/symlink/owner/mode/size sınırını ayrıca uygular.
- Güvenli transitive .NET override'ları ve tekrarlanabilir `security:audit` kapısı
  ile npm/dört NuGet proje 0 açığa indirildi.
- Node/coturn/Trivy tabanları multi-arch digest ile kilitlendi. Node
  22.23.2/Alpine 3.24 ile coturn 4.17.0/Alpine hardened runtime'ları build-once
  üretilip aynı HIGH/CRITICAL Trivy, CycloneDX/SPDX ve immutable deployment
  tüketicisine bağlandı; production Compose build/pull fallback yapmaz. Docker
  archive config blob'u SHA-256 ile doğrulanır; runtime image ID ve config digest
  ayrı tutulur, CycloneDX/SPDX/Trivy native kimliği şema v3 manifestte exact ve
  tekil bağlanır. Gerçek yerel amd64 taraması üç hedefte 0 bulguyla geçmiştir.
- Windows release akışı EXE imzasından sonra strict manifest üretir ve manifest
  dahil tüm `win-x64` ağacını dışarıdaki `EdizRemote.win-x64.cat` SHA-256 Catalog
  v2 dosyasında kapsar. EXE ve katalog için aynı exact signer, timestamp,
  Authenticode `Valid`, `signtool /pa /all /v /tw` ve
  `Test-FileCatalog=Valid/SHA256` zorunludur. Store/HSM modeli kullanılır;
  PFX/parola reddedilir.
- 2026-10-09: `desktop:publish` release kimliğini EXE sürüm kaynağına gömer
  (`ProductVersion` `<sürüm>+<commit>[.dirty]`, `FileVersion`
  `<sürüm>.<EDIZ_REMOTE_RELEASE_SEQUENCE>`); publish sırasında kaynak değişirse EXE
  bırakılmaz. Manifest strict şema v2 bu kimliği taşır. `sign` imza öncesi temiz
  ağaç, `HEAD` = gömülü commit, `package.json` sürümü, sequence ≥ 1 ve güvenilir
  `EDIZ_REMOTE_RELEASE_MINIMUM_SEQUENCE` tabanını; `verify` manifest/EXE kimlik
  eşliğini, temiz kaynağı ve tabanı zorunlu tutar. Yerel politika/katalog testleri
  gerçek PE fixture'larıyla 111/111 geçmiştir.
- 2026-10-11: depo sahibi kararıyla sertifikasız provenance yolu eklendi.
  `release:windows:provenance` aynı ön koşullarla ağacın tamamı için
  `EdizRemote.win-x64.provenance.json` (şema 1, `integrity: github-attestation`)
  ve `EdizRemote.win-x64.SHA256SUMS` üretir; `release:windows:verify-provenance`
  ağaç/manifest/SHA256SUMS/EXE kimliği/taban ve `gh attestation verify` (depo,
  `.github/workflows/windows-release.yml`, `refs/heads/main`, commit,
  GitHub-hosted runner) ile doğrular. İki mod birbirinin kaydını kabul etmez.
- 2026-10-09: yeni npm duyuruları sonrası `proxy-addr` 2.0.8, `shell-quote` 1.12.0,
  `source-map-js` 1.2.2 ve `vitest` 4.1.11 lockfile yükseltmeleri; npm/NuGet 0 açık
  ve yerel amd64 container kapısı yeniden 3/3 hedefte 0 bulgu.
- 2026-10-09 fuzz dilimi: bağımlılıksız seed'li fuzz yardımcısıyla protokol (rastgele
  JSON, 50 seed mutasyonu, her derinlikte şüpheli anahtar), canlı signaling (kimliksiz,
  onaylı oturum ve varsayılan-limit suistimal kampanyaları), web DataChannel yetki
  matrisi ve WPF köprü ayrıştırıcıları için 24 fuzz/regresyon testi. Protokol ön
  taraması iç içe `__proto__`, eşlenmemiş surrogate ve 2048 kap bütçesini reddeder;
  `BridgeJson` WPF tarafında metin/ad/özellik okumasını istisnasız yapar, yinelenen
  anahtarları ve protokol dışı ICE sunucu alanlarını reddeder.
- 2026-10-09 durum makinesi dilimi: `services/signaling/test/stateMachine.test.ts`
  durum × rol × mesaj matrisi (326 test, 10 kasıtlı sunucu bozulmasının 10'u düştü).
  Bulgu: kodu bilen üçüncü kişi `join_session` ile kod TTL'i geçmiş onaylı oturumu ya
  da host'u askıdaki oturumu bitirebiliyordu; `joinSession` artık yalnız misafiri
  olmayan oturumun süre sonunu uygular. Kanıt matrisi `docs/PHASE4_ACCEPTANCE.md`.

Faz 4 tamamlanmadı. Güncel dilim ve açık riskler `docs/PHASE4_PLAN.md`, tehdit
kaydı `docs/THREAT_MODEL.md`, kriter bazında kabul kanıtı
`docs/PHASE4_ACCEPTANCE.md` altındadır.

Kalan yapılacaklar:

- Audit arızasında runtime 503/restart davranışını aynı image ile izole Docker
  ortamında doğrula (canlı servise arıza enjekte etme); gerçek oturum sonrası
  production log/audit örneğini kaydet.
- Pi `linux/arm64` kapısı ve doğrulanmış production deployment'ı 2026-10-12'de
  tamamlandı: deploy öncesi 3/3 sıfır bulgu, `security:container:deploy`, iki
  `healthy`, UID 1000 secret/audit volume, coturn log sürücüsü `none`, dış
  HTTPS/WSS politika testi. Yeniden deploy'da kapı 48 saat içinde tazelenir.
- `windows-v0.1.0.1` taslağının (ilk attest edilmiş GitHub yayını, 2026-10-11'de
  bağımsız doğrulandı) temiz Windows 10/11 doğrulamasını (SmartScreen davranışı
  dahil) kaydet ve taslağı yayımla. Sertifika gelince
  gerçek OV/EV store/HSM sertifikasıyla EXE + katalog imzasını ve RFC3161
  timestamp'i ayrıca üret. Mevcut artifact hâlâ `NotSigned`dır; yayın temiz
  klondan, sequence ≥ 1 ve güvenilir tabanla üretilmelidir.
- Pi, imza ve production kanıtı geldikçe `docs/PHASE4_ACCEPTANCE.md`'yi güncelle.

Kabul kriterleri:

- Onaysız veya süresi geçmiş oturum ekran/control sinyali aktaramaz.
- Eski/replay control mesajları etkisizdir.
- Fuzz/bozuk mesaj testleri servisi veya host'u düşürmez.
- Secret/token/SDP içeren üretim logu bulunmaz.
- Yayınlanan binary bütünlüğü doğrulanabilir.

### Faz 5 — Paketleme, kurulum ve güncelleme

Amaç: Kaynak kod veya SDK gerektirmeyen sürdürülebilir dağıtım.

Yapılacaklar:

- Self-contained EXE'nin yanında imzalı installer (MSIX, MSI veya seçilen güvenli
  kurulum biçimi) üret.
- WebView2 Runtime eksikliğini anlaşılır şekilde ele al.
- Uygulama sürümü, protokol sürümü ve build kimliğini arayüzde göster.
- İmzalı güncelleme manifesti ve rollback destekli güncelleme mekanizması tasarla.
- Sessiz güncellemeyi zorunlu yapma; kullanıcıya sürüm ve yeniden başlatma bilgisini
  göster.
- Raspberry Pi için kalıcı volume, restart policy, healthcheck ve basit backup/
  restore talimatı ekle.
- Üretim `.env`/secret yönetimini dokümante et.

Kabul kriterleri:

- Temiz Windows 10 ve 11 makinelerinde tek installer ile kurulur/kaldırılır.
- Güncelleme imzası doğrulanmadan binary çalıştırılmaz.
- Başarısız güncelleme son çalışan sürümü bozmaz.
- Pi yeniden başladığında signaling/web otomatik ve sağlıklı şekilde ayağa kalkar.

### Faz 6 — V1 yayın kalitesi

Amaç: Proje sahibinin günlük müşteri desteğinde güvenebileceği sürüm.

Yapılacaklar:

- En az 2 saatlik, tercihen 8 saatlik soak testleri.
- Windows 10/11; NVIDIA/Intel/AMD; tek/çoklu monitör; DPI ve çözünürlük matrisi.
- LAN/direct, WAN/direct ve WAN/TURN test matrisi.
- Paket kaybı, jitter, bant daraltma ve bağlantı kopması testleri.
- CPU/GPU/RAM, handle ve packet-cache büyümesini izle.
- Kontrollü crash log ve kullanıcı tarafından dışa aktarılabilir tanı paketi ekle;
  ekran içeriğini veya hassas token'ları pakete otomatik dahil etme.
- Kurulum, kullanım, Pi deployment, TURN ve sorun giderme belgelerini tamamla.
- Bilinen sınırlar ve sürüm notlarını yayınla.

V1 “tam kullanılabilir” kabul kriterleri:

- Temiz kurulumdan sonra iki farklı internet bağlantısı arasında kod + onayla
  bağlantı kurulabilir.
- Görüntü, fare, klavye, çoklu monitör seçimi ve bağlantıyı kesme çalışır.
- Direct başarısız olduğunda TURN otomatik devreye girer.
- Host her an kontrol yetkisini geri alabilir ve görünür oturum durumuna sahiptir.
- Ağ/ekran değişiklikleri ya otomatik düzelir ya da güvenli ve anlaşılır hata verir.
- İmzalı installer ve tekrarlanabilir release çıktısı vardır.
- Zorunlu test matrisi, soak testi ve güvenlik kontrol listesi geçmiştir.

### V1 sonrasına bırakılanlar

- Gözetimsiz erişim ve kalıcı cihaz eşleştirme.
- Adres defteri, ekip/rol yönetimi ve çok kullanıcılı yönetim paneli.
- Dosya aktarımı.
- Açık opt-in ve güvenlik modeli tamamlanmış clipboard/pano senkronizasyonu.
- Ses aktarımı.
- Mobil native istemciler.
- Abonelik/lisanslama ve ticari kullanım ölçümü.

Gözetimsiz erişimi eklemeden önce cihaz kimliği, credential saklama, anahtar
döndürme, cihaz iptali ve audit modeli ayrıca tasarlanmalıdır.

## 8. Geliştirme komutları

Gereksinim: Node.js 22+ LTS. Native betikler gerekirse yerel `.tools/dotnet`
altında .NET 8 SDK hazırlar.

```powershell
npm install
npm run dev
```

Web/protokol/signaling doğrulaması:

```powershell
npm test
npm run lint
npm run build
```

Native host:

```powershell
npm run native:build
npm run native:test
npm run native:probe
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows-host.ps1 stream-probe -Duration 5
npm run native:publish
```

Windows desktop:

```powershell
npm run desktop:build
npm run desktop:test
npm run desktop:run
npm run desktop:publish
```

Pi/Docker:

```bash
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:8080/health
```

## 9. Değişiklik doğrulama matrisi

Her değişiklikte en küçük yeterli doğrulamayı değil, riskle orantılı doğrulamayı
uygula.

| Değişiklik alanı | Asgari doğrulama |
|---|---|
| React/UI | Web testleri + lint + build + localhost tarayıcı QA |
| Protocol/Zod | Protocol build/test + signaling ve web testleri |
| Signaling | Signaling testleri + health + iki istemcili oturum akışı |
| RTP/RTCP/WebRTC | Native testler + yerel iki-peer ICE/DTLS/SRTP testi |
| DXGI/encoder | Native testler + gerçek `probe`/`stream-probe` |
| WPF/WebView köprüsü | Desktop build/test + mümkünse gerçek desktop→browser oturumu |
| Paketleme | `desktop:publish` + çıktı EXE'sinin temiz başlangıç kontrolü |
| Dağıtım | Container health, restart ve dış HTTPS/WSS kontrolü |

Bir UI değişikliği yalnızca build geçti diye tamamlanmış sayılmaz. Gerçek render,
konsol hataları, ana etkileşim ve en az bir mobil görünüm kontrol edilmelidir.

## 10. Kod ve protokol kuralları

- Mevcut TypeScript strict ve C# nullable kurallarını koru.
- Protokol payload'larını `unknown` kabul et ve sınırda doğrula.
- Yeni mesajlarda açık `type`, gerekirse `channel` ve `version` kullan.
- WebView2 mesajlarını doğrudan güvenilir nesne kabul etme; alan/tür kontrolü yap.
- Sık gelen pointer/metrics olaylarını React state'e sınırsız hızda yazma; throttle,
  coalescing veya ref kullan.
- Event handler ve native session aboneliklerini kapanışta mutlaka çöz.
- CancellationToken ve dispose yaşam döngüsünü koru; native kaynakları finalizer'a
  bırakma.
- RTP sıra numarası wrap-around, timestamp birimi ve ağ byte order testlerini koru.
- Paket önbelleğini sınırlı tut; bağlantı süresiyle büyüyen koleksiyon oluşturma.
- Encoder/capture hatalarını yutma; kullanıcıya güvenli hata durumu yayınla.
- İlgisiz kullanıcı değişikliklerini silme veya yeniden biçimlendirme.

## 11. Güvenlik kontrol listesi

Yeni özellikte aşağıdakileri cevaplamadan işi tamamlanmış sayma:

- Bu mesajı yalnızca hangi rol ve oturum durumu gönderebilir?
- Host izni geri alındığında işlem hemen duruyor mu?
- Payload boyutu, türü, frekansı ve koordinat/aralıkları doğrulanıyor mu?
- Replay veya sıra dışı mesaj sırası ne yapıyor?
- Disconnect sırasında basılı tuş, açık stream veya native kaynak kalıyor mu?
- Loglara token, SDP, ICE adresi veya ekran içeriği sızıyor mu?
- Relay credential kısa ömürlü mü ve kötüye kullanım sınırı var mı?
- Kullanıcı ekranda görüntü/kontrolün aktif olduğunu anlayabiliyor mu?
- UAC/secure desktop gibi Windows güvenlik sınırları korunuyor mu?

## 12. Belgeleri güncel tutma

Mimari veya protokol değiştiğinde en az şu dosyaları değerlendir:

- `README.md`: kullanıcıya dönük mevcut özellikler ve sıradaki dilim.
- `docs/PROTOCOL.md`: mesajlar, güvenlik kuralları, SDP/ICE/RTCP davranışı.
- `docs/WINDOWS_HOST.md`: DXGI/encoder/RTP ve native sınırlar.
- `docs/WINDOWS_DESKTOP.md`: WPF/WebView köprüsü, ayarlar ve paket.
- `docs/TURN.md`: coturn public deployment, firewall ve relay probe.
- `docs/PHASE2_PLAN.md`: Faz 2 çalışma paketleri ve kabul durumu.
- `docs/PHASE3_PLAN.md`: Faz 3 tamamlanan UX dilimleri ve ürün kararları.
- `docs/PHASE3_ACCEPTANCE.md`: Faz 3 kabul kanıtı ve ertelenen fiziksel matris.
- `docs/THREAT_MODEL.md`: Faz 4 varlık, sınır, risk ve audit veri modeli.
- `docs/PHASE4_PLAN.md`: Tamamlanan güvenlik dilimleri ve sıradaki açık riskler.
- `docs/PHASE4_ACCEPTANCE.md`: Faz 4 kriter bazında kanıt, kanıt türü ve eksik girdi.
- `AGENTS.md`: tamamlanan faz, yeni kabul kriteri veya temel mimari karar.

Yol haritasında tamamlanan işleri bu dosyada uygun bölüme taşı; aynı özelliği hem
“tamamlandı” hem “henüz yok” olarak bırakma.

## 13. Bir sonraki ajan için başlangıç sırası

Yeni bir geliştirme sohbetinde:

1. Bu dosyayı ve `README.md`yi oku.
2. İstenen alanla ilgili `docs/` belgesini oku.
3. Çalışma ağacındaki mevcut dosya/değişiklikleri kontrol et ve koru.
4. İlgili testleri başlangıçta çalıştır veya son bilinen tabanı doğrula.
5. Yol haritasındaki en erken tamamlanmamış fazdan küçük, uçtan uca çalışan bir
   dilim seç.
6. Kodu, testleri, gerçek çalışma doğrulamasını ve belgeleri birlikte tamamla.
7. Yeni self-contained Windows sürümü üretilmişse kullanıcıya kesin EXE yolunu ver.

Faz 1, Faz 2 ve Faz 3 kabulü tamamlanmıştır. Bugünkü öncelikli sıradaki iş
**Faz 4 — güvenlik sertleştirmesi**dir. Threat model, signaling wire v3/origin/
proxy/strict-payload, global/IP/socket/member kaynak kotası ve negotiation/
DataChannel yetkilendirme dilimleri; yerel ICE nesil bağı, native pre-offer taşma
yarışı, recovery-kalıcı fatal/input korumaları, ortak güvenli probe çıktısı ve
minimal signaling audit'i tamamlandı. Container image digest'i, HIGH/CRITICAL
tarama/SBOM, Windows EXE+katalog imzalama ve release kimliği/anti-rollback/build
provenance kapıları da kod ve politika olarak tamamlandı; yerel `linux/amd64`
kapısı 2026-10-09'da, Pi `linux/arm64` kapısı 2026-10-11'de üç hedefte gerçek 0
bulguyla geçti. GitHub'da derlenip attest edilen ilk Windows yayını
(`windows-v0.1.0.1` taslağı) 2026-10-11'de bağımsız doğrulandı; Pi production
2026-10-12'de doğrulanmış Faz 4 container'larıyla v3'e geçti. Sıradaki iş bu
taslağın temiz Windows 10/11 doğrulaması, gerçek oturum sonrası log/audit örneği
ve audit 503/restart davranışının izole doğrulamasıdır
(sertifika gelene kadar imzasız provenance yolu, depo sahibi kararı 2026-10-11). Başlamadan
`docs/THREAT_MODEL.md` ve `docs/PHASE4_PLAN.md` dosyalarını oku. Wire v1/v2
adayları ile alt protokol teklif etmeyen eski EXE'ler v3 sunucuya bağlanamaz;
production'da web/signaling/desktop birlikte güncellenmelidir.

# Geliştirme ve dağıtım rehberi

[Proje ana sayfasına dön](../README.md).

Bu belge ayrıntılı geliştirme komutlarını, tarihsel doğrulamaları ve deployment notlarını korur. Komutlar repo kökünde çalıştırılır. 2026-09-02 test sonuçları tarihsel kanıttır; güncel güvenlik denetimi yerine geçmez.

Kendi kullanımımıza yönelik, P2P öncelikli uzaktan destek uygulamasının ilk MVP
dilimidir. Bu sürüm iki istemciyi altı haneli, tek kullanımlık bir kodla eşleştirir;
host izin vermeden WebRTC sinyali aktarmaz.

## Bu sürümde çalışanlar

- Raspberry Pi 5 üzerinde çalışabilen Node.js sinyalleşme servisi
- Cloudflare Tunnel ile yayınlanabilen aynı-origin web istemcisi
- Otomatik üretilen, 10 dakika geçerli ve tek kullanımlık bağlantı kodu
- İstek sahibini bekletme, host onayı ve reddetme akışı
- Host onayında ayrı “yalnızca görüntüle” ve “görüntüle + kontrol et” seçimi
- Sürümlü kontrol yetkisi mesajları ve oturum sırasında tek tıkla yetki geri alma
- Aktif host'un strict `{ type: "revoke_control", channel: "control", version: 1 }`
  mesajıyla sunucu oturumunu kalıcı `control` → `view` düşürmesi; tekrar gönderimde
  idempotent davranış ve reconnect/resume sonrasında `view` yetkisinin korunması
- Düşük gecikmeli pointer hareketi ile güvenilir/sıralı buton ve klavye kanalları
- Tıklama, çift tıklama, sürükleme, tekerlek, temel klavye ve kısayol desteği
- DPI'dan bağımsız normalize koordinatların fiziksel/negatif monitör alanına dönüşümü
- Windows `SendInput` enjeksiyonu, basılı girişleri güvenli bırakma ve native hız sınırı
- Görünür “kontrol aktif” durumu ve global `Ctrl+Alt+Shift+F12` acil durdurma
- Onay sonrası genel SDP/ICE sinyal aktarımı
- Onay sonrası gerçek `RTCPeerConnection` ve sıralı DataChannel
- STUN ile doğrudan P2P bağlantı kurma
- Sürümlü ve signaling tarafından dağıtılan ICE sunucu listesi
- Host onayından sonra üretilen istemciye özel, kısa ömürlü HMAC TURN kimlik bilgisi
- Seçilen bağlantı yolunu ve DataChannel gecikmesini canlı gösterme
- Rol bazlı, tek kullanımlık reconnect token ve 30 saniyelik onaylı oturum kurtarma
- Kontrollü ICE yenileme, sınırlı geri çekilme ve kullanıcıya açık yeniden deneme
- Host tarafında tarayıcının güvenli `getDisplayMedia` izniyle ekran seçme
- Ekran video track'ini mevcut P2P oturumuna yeniden anlaşmayla ekleme/çıkarma
- Guest tarafında canlı uzak ekran görüntüleyicisi ve yayın bekleme durumu
- Windows'ta DXGI Desktop Duplication ile gerçek GPU masaüstü yakalama prototipi
- Native monitör keşfi, bellekiçi performans probe'u ve isteğe bağlı BMP snapshot
- Dış tarayıcı gerektirmeyen, aynı EXE içinde destek alan veya destek veren
  rolünde kullanılabilen WPF + WebView2 Windows masaüstü uygulaması
- React/native mesaj köprüsü ve arayüzde canlı native ekran hazır durumu
- Media Foundation üzerinden NVIDIA/Intel/AMD donanım H.264 encoder keşfi
- D3D11 device manager bağlantısı ve sıfır kopya NV12 GPU sample hazırlığı
- Gerçek DXGI masaüstü karesinden donanım hızlandırmalı Annex B H.264 üretimi
- Kesintisiz native encode oturumu ve RFC 6184 STAP-A/FU-A RTP paketleyici
- SIPSorcery ile native ICE, DTLS anahtar anlaşması ve SRTP video taşıması
- Aynı 6 haneli oturumda kontrol ve `native-video` sinyallerinin ayrıştırılması
- Windows host'tan tarayıcı guest'e otomatik GPU H.264 canlı görüntü aktarımı
- RTCP PLI ile anlık IDR üretimi ve NACK için 4096 paketlik yeniden iletim önbelleği
- Receiver report paket kaybına göre 1–8 Mbps arasında uyarlanabilir encoder bitrate'i
- Windows arayüzünde canlı hedef bitrate ve paket kaybı göstergesi
- Destek alan/destek veren rollerini açıkça ayıran aktif oturum görünümü
- Direct/relay, gecikme, hedef bitrate ve paket kaybını tek panelde gösterme
- Operatörün bağlantıyı kesmeden seçebildiği sürümlü çoklu monitör akışı
- Monitör değişiminde native yakalama ve kontrol koordinatlarını birlikte taşıma
- Otomatik (8 Mbps/30 FPS), hız (3 Mbps/24 FPS) ve kalite (12 Mbps/30 FPS)
  profilleri; mevcut RTCP adaptasyonunu profil tavanı altında koruma
- Guest görüntüsünde sığdır, 1:1 gerçek piksel ve tam ekran seçenekleri
- Onaylı oturumu ağ kurtarmasında sıfırlamadan gösteren bağlantı süresi
- DXGI ayrı pointer metadata'sını sürümlü güvenilir oturum kanalıyla taşıyan uzak
  imleç katmanı; imleç kareye zaten bileşikse çift çizimi önleme
- Windows sistem tepsisi, boşta güvenli tepsiye gizleme ve mevcut pencereyi öne
  getiren tek-instance davranışı
- Aktif bağlantıda gizli çalışmayı engelleyen çıkış onayı ve giriş/native/WebView
  kaynaklarını sıralı kapatan temiz kapanış
- Ham exception, token, SDP veya ICE ayrıntısı göstermeyen merkezi ve allowlist
  tabanlı kullanıcı hata kataloğu; role uygun, açık yeniden deneme eylemleri
- Signaling sunucu mesajlarında runtime şema doğrulaması ve beklenmeyen yanıtta
  oturumu kapalı tutan fail-closed bağlantı davranışı
- Zorunlu `ediz-remote.v3` WebSocket alt protokolü, current/minimum wire v3
  `ready` mesajı ve v1/v2 dahil desteklenmeyen istemciyi upgrade aşamasında reddetme
- Same-host veya açık allowlist WebSocket origin politikası; eksik/kötü origin'i
  ve binary frame'i bağlantı kurulmadan/işlenmeden reddetme
- `CF-Connecting-IP` başlığını yalnız açık production trust ayarıyla kabul eden,
  istemci tarafından taklit edilen değeri oran limitine taşımayan güven sınırı
- Global/IP WebSocket-session hard kotası; create/join/resume/invalid için
  global+IP, inbound için global+socket, signal/ICE için reconnect boyunca kalıcı
  global+session-member token bucket'ları
- Kaynak reddini create/join/resume/active fazına bağlayan strict `operation` ve
  bounded retry metadata'sı; metadata'sız/yanlış zarfı reddetme, resume'u yeni
  soketle, guest'in düşen answer sinyalini fresh-socket resume'la ve host signal/
  ICE akışını kontrollü ICE yenilemesiyle otomatik deneme
- Bounded O(1) reconnect-token indeksi, yalnız boş socket'te resume takeover ve
  bare/native-video SDP için host-offer/guest-answer yön zorlaması
- Her SDP/ICE sinyalinde zorunlu UUID `negotiationId`; genel peer ile
  `native-video` için ayrı negotiation lane'i, lane başına oturum boyunca en fazla
  256 yeni offer kimliği ve eski negotiation replay'ini etkisiz bırakma
- Web ve native eşlerde negotiation başına en fazla 64 aday/64 KiB pending ICE;
  signaling aboneliği kurulmadan gelen her lane için en fazla 64 mesaj/128 KiB
  erken sinyal kuyruğu
- Yerel ICE adayını SDP `ice-ufrag` nesline bağlayıp geç/eski callback'i düşürme;
  native offer öncesi strict başlangıç zarfı ve offer takılsa da anında kapanan
  bounded pre-offer ICE taşma yolu
- Strict client/server mesajları, 60 KiB SDP ve 4096 karakter ICE candidate
  tavanlı ortak signaling şeması ve `version: 2` native-video zarfı
- `channel: "session", version: 2` için gönderen başına paylaşılan artan sıra;
  DataChannel label/transport/rol/yetki allowlist'i ve pointer kanalında yalnız
  kontrol yetkili host'a gelen `pointer.move`
- Matris/reliable taşıma veya güvenli hız sınırı ihlalinde fail-closed kapanış ve
  native input bırakma; fatal kilidin aynı onaylı recovery boyunca korunması ve
  eski/replay mesajlarının state veya kontrol uygulayamaması
- Native sequence watermark'ını yalnız başarılı input uygulamasında ilerletme;
  SAS girişiminde kontrolü kapatıp tüm girdileri bırakma ve kontrol açıkken gizli
  tepsi çalışmasını engelleme
- TURN/browser doğrulama araçlarında exact secret, ağ adresi, token ve kod
  kalıplarını maskeleyen bounded ortak `safe-output` sınırı; top-level hatalarda
  stack yerine sabit hata kodu
- Yalnız sekiz allowlist alanı kabul eden minimal JSONL signaling audit'i; günlük
  HMAC istemci pseudonym'i, 1–30 gün retention ve dış gürültünün tüketemediği
  kritik yaşam döngüsü kuyruk rezervi
- Audit başlangıç/runtime arızasında port, health, WebSocket ve yetki yükselten
  işlemleri fail-closed tutan watchdog; production coturn için raw stdout'u
  discard eden yapılandırma
- Production HTTP yanıtlarında sabit CSP, frame/referrer/permission/cross-origin
  başlıkları ve paketlenmiş WebView2 için güvenli WSS/loopback ile sınırlı meta CSP
- Signaling içindeki TURN ve audit anahtarlarını environment yerine bounded/
  no-follow, tek-link, current-UID ve private-mode doğrulamalı secret dosyalarından
  yükleme; coturn entrypoint'inde ayrı type/symlink/owner/mode/size doğrulaması
- Digest kilitli Node/coturn/Trivy tabanlarından build-once final application ve
  custom coturn image'ı üreten; CycloneDX/SPDX ve HIGH/CRITICAL tarama kanıtını
  immutable deployment manifestine bağlayan container release kapısı
- Store/HSM-only Windows imzalama modeli; EXE ile tüm `win-x64` ağacını kapsayan
  dış SHA-256 katalog için exact signer, RFC3161 timestamp, Authenticode,
  `signtool` ve `Test-FileCatalog` doğrulama kapısı
- Yalnız güncel WebSocket neslinin callback'lerini kabul eden soket kimlik koruması;
  oturum fazı/rol dışındaki geç mesajları reddeden matris ve terminal geçişten sonra
  açık yeni denemeye kadar oturum mesajlarını kapalı tutan latch
- Geç create/join yanıtlarını güvenle yok sayan ve aynı bekleyen kullanıcı isteğini
  tek mesaja birleştiren oturum isteği guard'ı; `peer_unavailable` recovery sırasında
  mevcut onaylı `accessMode` değerini koruma
- WebView2 process/navigation arızasında kontrolü ve native yayını durduran,
  yalnız WPF'nin tek kullanımlık izin verdiği yerel navigasyonu kabul eden; F5,
  Ctrl+R ve programatik reload'u fail-closed durdurup yükleme/hata ekranından
  güvenli yeniden deneme sunan masaüstü yaşam döngüsü
- Vite `dist` içeriğini single-file bundle dışında tutup source → güvenli staging →
  final `Web` ağacı olarak kopyalayan; index asset referanslarını doğrulayıp eksik
  asset'te publish'i durduran paketleme zinciri; final probe'da ayrıca source/final
  yol, boyut ve SHA-256 eşliği
- Bileşen bazında ayrılmış allowlist desktop hata kodları ile sürümlü, sıralı ve
  hız sınırlı `media.state` durum akışı
- Tarayıcıda paylaşılan ekranı değiştirme seçimi iptal edilirse eski canlı
  paylaşımı görünür `paylaşılıyor` durumunda ve kullanıcı uyarısıyla koruma
- Ekran modu/GPU değişiminde DXGI → NV12 → encoder graph'ını otomatik yeniden kurma
- Oturumu iki taraftan kapatma; kapanış bildirimini koruyup güvenli yeni kod yolu
- IP başına kod deneme limiti
- Masaüstü ve mobil uyumlu Türkçe React arayüzü
- Docker Compose dağıtımı ve sağlık kontrolü

Masaüstü uygulaması onaylanan oturumda DXGI yakalama ve donanım H.264 encoder'ını
otomatik başlatır; görüntü ayrı bir native WebRTC eş bağlantısında DTLS-SRTP ile
guest tarayıcıya taşınır. Tarayıcı host'lar için `getDisplayMedia` hattı fallback
olarak korunur; tarayıcı host fallback'i güvenlik gereği yalnızca görüntüleme
sağlar. TURN kimlik bilgisi, coturn deployment ve relay yapılandırması hazırdır;
public Pi coturn ile fiziksel WAN direct/recovery/relay kabulü tamamlanmıştır.
Gözetimsiz erişim ve Windows servis modu henüz dahil değildir. Windows masaüstü
host'ta kontrol yalnızca ayrı host onayıyla açılır;
yetki iptali, bağlantı kopması, odak kaybı veya acil durdurmada basılı girişler
bırakılır. UAC secure desktop, kilit ekranı ve `Ctrl+Alt+Del` bilerek aşılmaz.

## Yerel geliştirme

Gereksinim: Node.js 22 veya daha yeni bir LTS sürümü.

```powershell
npm install
npm run dev
```

- Arayüz: `http://localhost:8080`
- Geliştirme sinyalleşme servisi: `http://localhost:8788`
- Sağlık kontrolü: `http://localhost:8080/health`

Ekran paylaşımı tarayıcı güvenlik modeli nedeniyle yalnızca `localhost` veya
HTTPS üzerinden çalışır. Paylaşan kullanıcı her oturumda tarayıcının ekran/pencere
seçim penceresini açıkça onaylamalıdır.

```powershell
npm test
npm run lint
npm run build
npm run security:audit
```

Container release kapısı ayrı `npm run security:containers` komutudur; çalışma
biçimi ve kanıt dosyaları `docs/CONTAINER_RELEASE.md` altında açıklanır.

## Windows native host

Native host için sistem geneline SDK kurmak gerekmez; yardımcı betik gerekirse
.NET 8 SDK'yı proje içindeki `.tools` klasörüne indirir.

```powershell
npm run native:test
npm run native:turn-simulation
npm run native:probe
npm run native:publish
```

Self-contained x64 paket `artifacts/windows-host/win-x64` altında oluşturulur.
Ayrıntılı kullanım ve bilinen sınırlar `docs/WINDOWS_HOST.md` dosyasındadır.

## Windows masaüstü uygulaması

```powershell
npm run desktop:test
npm run desktop:run
npm run desktop:publish
npm run release:windows:manifest
npm run release:windows:sign
npm run release:windows:verify
npm run release:windows:provenance
npm run release:windows:verify-provenance
```

Çift tıklanabilir self-contained uygulama
`artifacts/windows-desktop/win-x64/EdizRemote.exe` altında üretilir. Ayrıntılı
ayar ve paket bilgisi `docs/WINDOWS_DESKTOP.md` dosyasındadır.
Production Authenticode, strict manifest ve tüm yayın ağacını kapsayan dış
SHA-256 katalog kapısı `docs/WINDOWS_RELEASE.md` dosyasında açıklanır; imzasız
aday bu kapıdan geçmez. `desktop:publish` kök `package.json` sürümünü, `HEAD`
commit'ini, ağaç temizliğini ve `EDIZ_REMOTE_RELEASE_SEQUENCE` değerini (verilmezse
`0`) EXE sürüm kaynağına gömer; kirli ağaç veya sequence `0` geliştirme paketidir
ve release kapısı onu anti-rollback/provenance kontrolünde reddeder.
Sertifika gelene kadar (depo sahibi kararı, 2026-10-11) yayınlar imzasız
provenance yoluyla çıkar: `release:windows:provenance` ağacın tamamı için
`artifacts/windows-desktop/EdizRemote.win-x64.provenance.json` ve
`EdizRemote.win-x64.SHA256SUMS` üretir, `release:windows:verify-provenance`
bunları ve GitHub artifact attestation'ını (`gh attestation verify`) doğrular.
Ayrıntı `docs/WINDOWS_RELEASE.md` dosyasındadır; SmartScreen uyarısı kalır.

2026-08-23 final Faz 3 artifact'i `184540144` bayttır; zaman damgası
`2026-08-23 22:59:29 +03`, SHA-256 değeri
`E89F4CD1FE143166E2BDEDE92E0CB19AB92B54541FCF200BC20FD3DEDF70987B` olarak
doğrulandı. Source ve publish `Web` ağaçlarında dörder dosya vardır; göreli yol,
boyut ve SHA-256 karşılaştırmasında fark `0`dır.

Faz 4 ilk güvenlik dilimi adayı `184810566` bayttır; zaman damgası
`2026-08-23 23:26:57 +03`, SHA-256 değeri
`68CD2ECBCDE78964AD0C126F26170D56FE2E218F99F39B46E768CD48CAE4679C` olarak
doğrulandı. Authenticode durumu `NotSigned` olduğu için bu çıktı production
release kabulü değildir.

Faz 4 ikinci güvenlik diliminin tarihsel wire v2 adayı `184810752` bayttır; zaman damgası
`2026-08-24 01:32:12 +03`, SHA-256 değeri
`8AABBA8BFD76346867903A77DCD7625F25E9803D253D2949BE9AC0995C6B12B1` olarak
doğrulandı. Paketlenmiş web ağacında wire v1 eşleşmesi `0`, wire v2 eşleşmesi `1`;
fiziksel başlangıç smoke probe'u geçti. Authenticode hâlâ `NotSigned` olduğu için
bu çıktı production release kabulü değildir.

2026-08-24 tarihli ikinci dilim doğrulama tabanı: TURN preflight 7/7, web 72/72, protocol 9/9, signaling
38/38, native 40 başarılı + zorlanmış TURN ortamı gerektiren 1 atlanan test ve
desktop 66/66; lint, build ve publish başarılıdır.

2026-09-02 wire v3 Dilim 3 adayı `184835328` bayttır; zaman damgası
`2026-09-02 15:10:00 +03:00`, SHA-256 değeri
`2DE77D95685E752801E28B98CBCA661208E8653B176C6C13CE93597388613425` olarak
doğrulandı. Source/published dörder web dosyasında göreli yol, boyut ve SHA-256
farkı `0`; paket bundle'ında `ediz-remote.v3` bulundu. TURN preflight 7/7, web
100/100, protocol 10/10, signaling 42/42, native 40 başarılı + 1 ortam nedeniyle
atlanan ve desktop 87/87 geçti; lint, build, publish ve sıfır açık veren güvenlik
denetimi başarılıdır. Localhost Browser'da iki istemcili onay, direct P2P,
session v2 kalite mesajı, 390×844 taşmasız görünüm ve iki temiz konsol doğrulandı.
Authenticode `NotSigned` olduğundan bu çıktı production release değildir;
fiziksel EXE smoke bu dilimde yeniden çalıştırılmadı.

2026-09-02 Dilim 4/5 yerel adayı yine `184835328` bayttır; son yazım zamanı
`2026-09-02 17:56:51 +03:00`, SHA-256 değeri
`FB9FB3B74E045A76E5677875BDC98E61198A06A48694CABE29D492A6FD25E6BC` olarak
strict manifestle eşleştirildi. Toplu testte 233 başarılı + 1 atlanan, native
42 başarılı + 1 ortam nedeniyle atlanan, desktop 106/106 ve Windows release
politika/katalog 31/31 sonucu alındı; lint, build, publish ve dependency audit
geçti. Gerçek sertifika kullanılmadı, Authenticode `NotSigned` ve kardeş katalog
yoktur; production `release:windows:verify` bu nedenle beklenen biçimde
`catalog_missing` ile kapanır.

Aynı dilimde Node 22.23.2/Alpine 3.24 ve coturn 4.17.0/Alpine tabanları exact
multi-arch digest'lerle kilitlendi. Gerçek Docker Desktop `linux/amd64` kapısı
hardened Node runtime, final application ve custom coturn hedeflerinin üçünü de
CycloneDX/SPDX/Trivy kanıtıyla ve HIGH/CRITICAL bulgu `0` sonucu ile geçirdi.
Şema v3 manifest ve immutable deployment referansı üretildi; kısıtlı runtime
smoke'ları ile HMAC TURN relay probe'u 6/6 geçti. Pi `linux/arm64` scan/deploy
kanıtı bu yerel sonuca dahil değildir.

2026-10-09 devir sonrası taban yenilemesinde ilk `npm audit` 6 yeni bulgu verdi;
`proxy-addr`, `shell-quote`/`concurrently`, `source-map-js` ve `vitest`
bildirilen semver aralıkları içinde yükseltildi. Ardından toplu test 233 başarılı
+ 1 atlanan, native 42 başarılı + 1 atlanan, desktop 106/106, Windows release
politika/katalog 111/111 sonucu verdi; lint, build ve npm + dört NuGet projesi
dependency audit'i temizdir. Yerel `linux/amd64` container kapısı yeni lockfile ile
üç hedefte HIGH/CRITICAL `0` verdi (`docs/CONTAINER_RELEASE.md`).

Release kimliği gömülü ilk geliştirme adayı `971506f`'den üretildi (SHA-256
`DED61FD7661EE3EFEBBCBFB3F7C2DFE18167F9B4B5DDE14F64277A4168C1D71D`). Aynı gün
fuzz dilimi web bundle'ını ve WPF köprü ayrıştırıcılarını değiştirdiği için yerini
`6bdf2a5` adayı aldı.

Aynı gün eklenen seed'li fuzz matrisi (protokol, canlı signaling, web DataChannel
ve WPF köprüsü) iki gerçek bulguyu kapattı: iç içe `__proto__` anahtarının Zod
strict nesnesince sessizce atılması ve WPF `Try*` ayrıştırıcılarının eşlenmemiş
surrogate'ta istisna fırlatması. Sonrasında toplu test 250 başarılı + 1 atlanan,
native 42 başarılı + 1 atlanan, desktop 113/113 ve Windows release 111/111 geçti;
lint, build ve dependency audit temizdir. Ardından eklenen 326 testlik signaling
durum makinesi matrisi üçüncü bir bulguyu kapattı (kod bilgisiyle onaylı oturumun
sonlandırılması); toplu test 576 başarılı + 1 atlanan oldu (`20b972b`). Bu sunucu
değişikliği EXE adayını etkilemez.

Güncel geliştirme adayı `184835328` bayttır; son yazım zamanı
`2026-10-09 17:55:07 +03:00`, SHA-256 değeri
`330D033CE3AC08C0E011E2DEEF0B477D15F71754570DB76CD091DC6E838D20E0`. Sürüm
kaynağı `ProductVersion 0.1.0+6bdf2a5f7a070a56a7c70593e4ff464db56be155.dirty`,
`FileVersion 0.1.0.0` taşır; ağaç izlenmeyen teslim dosyası nedeniyle kirlidir ve
sequence `0`dır. Şema v2 manifest SHA-256
`A70C696D7A9ABA76C531ECAB50F514A681B8BA9CBADA6DCD766E5043C27000E2` olarak
üretildi. Source/published dörder web dosyasında fark `0`, bundle'da wire v3 var.
Authenticode `NotSigned`, katalog yok; `release:windows:verify` `catalog_missing`,
tabansız `sign` `release_floor_missing`, tabanlı `sign` imza denemeden
`provenance_dirty_source` ile kapanır. Fiziksel EXE smoke çalıştırılmadı.

2026-10-11 provenance yolu: release politika/katalog/provenance testleri
234/234 geçti, toplu `npm test` 576 başarılı + 1 atlanan ve lint temiz kaldı.
Temiz ağaçta `3091505` commit'inden `EDIZ_REMOTE_RELEASE_SEQUENCE=1` ile
publish edilen yerel aday `184859904` bayt, SHA-256
`B76FC9718E2AAB877552E8261850CBC834AAD4EB70251B1C08E7366F632D3554`,
`ProductVersion 0.1.0+30915050ca8dcdc1efc82bc0f6d7933f21ede0a8`,
`FileVersion 0.1.0.1`, Authenticode `NotSigned`. `release:windows:provenance`
12 dosyalık manifest (SHA-256
`5F3B83E89629CADCE268B7B7138A76CA36ECC3D467788C6A6FD71AC2D4803777`) ve
SHA256SUMS üretti; `verify-provenance` yerel attestation olmadığı için beklenen
`provenance_attestation_invalid` ile kapandı. Bu aday GitHub'da derlenmediği için
yayın adayı değildir.

## Raspberry Pi 5 kurulumu

Pi üzerinde Docker ve Docker Compose eklentisi kurulu olmalıdır.

```bash
git clone <repo-adresi> ediz-remote
cd ediz-remote
cp .env.example .env
install -d -m 0700 ./secrets
(umask 077 && openssl rand -base64 48 > ./secrets/turn-shared-secret.key)
(umask 077 && openssl rand -base64 48 > ./secrets/signaling-audit-hmac.key)
sudo chown 1000:1000 ./secrets/turn-shared-secret.key ./secrets/signaling-audit-hmac.key
chmod 0400 ./secrets/turn-shared-secret.key ./secrets/signaling-audit-hmac.key
# .env içindeki TURN ve deployment değerlerini düzenleyin.
npm run security:containers
npm run security:container:deploy
docker compose ps
curl http://127.0.0.1:8080/health
```

Production Compose yeniden build yapmaz ve doğrudan çalıştırıldığında fail-closed
kapanır; doğrulayan deploy komutu audit lock, manifest commit/report hash'leri ve
48 saatlik DB tazeliğiyle immutable local application/coturn image ID'lerini
kontrol edip iki servisin health sonucunu bekler. Yerel geliştirme build'i için
`docker compose --env-file .env -f docker-compose.dev.yml up -d --build`
komutu kullanılabilir; bu çıktı production kanıtı değildir.

Production signaling güvenlik audit'i varsayılan olarak açıktır. TURN secret'tan
ayrı anahtar dosyası yoksa servis port açmadan kapanır; çalışma sırasında audit
yazımı bozulursa health `503` olur ve yeni signaling işlemleri fail-closed
reddedilir. En geç bir saniyelik watchdog servisi sıfır olmayan kodla kapatır;
Compose restart politikası yeniden başlatır. Audit şeması, saklama ve anahtar
yönetimi `docs/SECURITY_AUDIT.md` dosyasındadır.

TURN kullanmak için `.env.example` dosyasını `.env` olarak kopyalayın.
`TURN_SHARED_SECRET_FILE_HOST` ile `COTURN_SHARED_SECRET_FILE_HOST`, signaling
ve coturn'un ortak kullandığı aynı uzun ve rastgele secret dosyasını göstermelidir.
Secret container environment'ına kopyalanmaz. `TURN_URLS` yalnızca public TURN adreslerini içerir;
Cloudflare Tunnel UDP/TCP TURN trafiğini taşımaz. Secret istemci paketine
gömülmez; signaling servisi onaylanan her istemci için varsayılan bir saatlik
HMAC credential üretir.
Production coturn entrypoint'i bind mount edilmez; pinned resmi base üzerine
gömülen final coturn image'ı aynı SBOM/tarama/manifest kapısından geçer.

Coturn deployment aynı doğrulanmış container komutuna dahildir; ayrıntılar
`docs/TURN.md` dosyasındadır:

```bash
npm run security:container:deploy
```

Yerel HMAC + relay doğrulaması:

```powershell
npm run turn:probe
npm run turn:network-probe
npm run native:turn-simulation
npm run browser:turn-simulation
```

`browser:turn-simulation`, host ve guest Chrome'u iki ayrı özel ağ/NAT arkasında
çalıştırır; zorlanmış TURN relay, açık host onayı, DataChannel'lar, hareketli
ekran videosu ve kısa ağ kesintisi sonrası toparlanmayı doğrular. Bu kapalı
laboratuvar kanıtı, 2026-08-13 tarihinde public Pi coturn ve mobil veri ağıyla
yapılan fiziksel WAN direct/recovery/relay kabulüyle tamamlandı.

Public TURN sunucusu hazır olduğunda aynı signaling credential hattıyla dış
UDP/TCP relay preflight:

```powershell
npm run turn:public-preflight
```

Mevcut Cloudflare Tunnel yapılandırmasına şu public hostname eklenir:

```text
remote.edizegemercan.com.tr -> http://localhost:8080
```

Dosya tabanlı `cloudflared` kullanıyorsanız örnek yapılandırma
`infra/cloudflared/config.yml.example` altındadır. Cloudflare panelinden yönetilen
tünelde ise aynı hostname ve service URL değerlerini panelde tanımlayın.

## Proje yapısı

```text
apps/web                 React + Vite istemcisi
apps/windows-host        .NET 8 + DXGI Desktop Duplication native host
apps/windows-host.Tests  Native host komut/BMP birim testleri
apps/windows-desktop     WPF + WebView2 son kullanıcı uygulaması
apps/windows-desktop.Tests Masaüstü yapılandırma testleri
packages/protocol        Paylaşılan mesaj tipleri ve Zod doğrulaması
services/signaling       Express + WebSocket sinyalleşme servisi
infra/cloudflared        Tunnel yapılandırma örneği
infra/coturn             Public TURN deployment ve yerel relay testi
docs/design              Kabul edilen arayüz konseptleri
docs/PROTOCOL.md          Sinyalleşme protokolü ve güvenlik kuralları
docs/THREAT_MODEL.md      Faz 4 tehdit kaydı, veri sınıfları ve güven sınırları
docs/SECURITY_AUDIT.md    Minimal audit şeması, saklama ve anahtar yönetimi
docs/CONTAINER_RELEASE.md Digest, SBOM ve container release kapısı
docs/WINDOWS_RELEASE.md   İmzalı SHA-256 katalog ve GitHub attestation provenance kapıları
docs/PHASE4_PLAN.md       Faz 4 dilimleri ve açık güvenlik işleri
```

## Sıradaki geliştirme dilimi

Faz 1–3 tamamlandı; **Faz 4 — güvenlik sertleştirmesi devam ediyor**. İlk dört
uçtan uca dilimde threat model, wire v3/origin/proxy sınırı, strict/bounded
SDP/ICE, global/IP/socket/member kaynak kotaları, O(1) resume indeksi, güvenli
takeover, negotiation epoch/pending ICE sınırı ve DataChannel rol/yetki matrisi
tamamlandı. Yerel ICE nesil bağı, native pre-offer taşma yarışı, recovery boyunca
kalıcı fatal kilit ve başarılı-uygulama tabanlı native input watermark'ı da
sertleştirildi. Derin JSON, bozuk UTF-8, 128 KiB toplam WebSocket zarfı, flood,
reconnect borcu ve eski negotiation replay testleri eklendi. Ortak güvenli probe
çıktısı, strict minimal JSONL audit, günlük HMAC pseudonym/retention ve audit
arızasında fail-closed servis yaşam döngüsü de tamamlandı.

`npm run security:audit` npm ile dört .NET projesinde bulguda duran ortak kapıdır;
`qs` 6.16.0 güncellemesi sonrasında sonuç 0 açıktır. Node/coturn image digest
kilidi, hardened custom runtime'lar, CycloneDX/SPDX üretimi ve HIGH/CRITICAL'da
duran `security:containers` release kapısı eklendi. Gerçek yerel `linux/amd64`
koşusu üç hedefte 0 bulguyla geçti; policy testleri 22/22'dir. Windows release
kod/politika kapısı da hazırdır: store/HSM tabanlı EXE+katalog imzası, exact
signer, timestamp, iki ayrı `signtool /pa /all /v /tw` ve
`Test-FileCatalog=Valid/SHA256` zorunludur. Politika/katalog testleri 31/31 geçti.
Bu amd64 kanıtı Pi `linux/arm64` deployment'ının veya gerçek sertifikalı imzanın
yerine geçmez; production kabulü için Pi'de sıfır bulgulu scan/deploy smoke ile
GitHub'da derlenip attest edilmiş Windows adayının `verify-provenance` kanıtı
(sertifika gelene kadar imzasız provenance yolu, 2026-10-11 kararı) ve temiz
Windows 10/11 kanıtı gerekir.
Wire v1/v2 adayları ile alt protokol teklif
etmeyen daha eski EXE'ler wire v3 sunucuyla bilinçli olarak uyumlu değildir;
production deployment yeni web, signaling ve Windows paketi birlikte
yapılmalıdır.

Faz 1 kabul kanıtları ve test matrisi `docs/PHASE1_ACCEPTANCE.md` dosyasındadır.
Faz 2 çalışma listesi `docs/PHASE2_PLAN.md`, kanıt matrisi
`docs/PHASE2_ACCEPTANCE.md` dosyasındadır. Faz 3 çalışma listesi
`docs/PHASE3_PLAN.md`, kanıt matrisi `docs/PHASE3_ACCEPTANCE.md` dosyasındadır.

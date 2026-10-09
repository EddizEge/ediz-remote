# Ediz Remote Windows masaüstü uygulaması

`apps/windows-desktop`, mevcut React arayüzünü WebView2 içinde paketleyen .NET 8
WPF uygulamasıdır. Kullanıcı dış tarayıcı açmadan `EdizRemote.exe` üzerinden
bağlantı kodu üretir, oturum kurar ve arayüzü kullanır.

## Mimari

- WPF gerçek Windows penceresini ve uygulama yaşam döngüsünü yönetir.
- WebView2, `apps/web/dist` üretim arayüzünü yerel bir HTTPS virtual host üzerinden
  gösterir.
- Aynı `EdizRemote.exe`, “Başka bir cihaza destek ver” seçildiğinde guest rolünü
  de destekler. Bu rolde native H.264 offer/ICE yanıtı ve gelen video track'i,
  WebView2 içindeki Chromium `RTCPeerConnection` alıcısıyla işlenir; ayrı bir WPF
  decoder veya ikinci bir uygulama gerekmez. DXGI yakalama ve `SendInput` gibi
  yetkili native host bileşenleri guest rolü tarafından başlatılmaz.
- JavaScript/native mesaj köprüsü DXGI monitör ve Media Foundation encoder keşif
  sonucunu React arayüzüne taşır.
- React arayüzü native modda ekran sayısını ve gerçek GPU H.264 hazırlık durumunu
  (`N ekran · H.264 GPU`) gösterir.
- Native monitör listesi bounded bir WebView2 mesajıyla React'e verilir. Host veya
  guest operatör aktif oturumda ekranı seçtiğinde seçim native sınırında tekrar
  doğrulanır; yakalama oturumu aynı onaylı bağlantıda yeni offer ile kurulur.
- Monitör geçişinde basılı tuş/butonlar bırakılır, ancak host'un verdiği kontrol
  yetkisi korunur. Yeni pointer koordinatları seçilen monitörün fiziksel alanına
  dönüştürülür.
- Onaylanan oturumda strict `channel: "native-video", version: 2` köprüsü yeni
  UUID `sessionEpoch` ve `negotiationId` ile ayrı bir native H.264 WebRTC offer
  üretir. Offer/capture öncesi ayrı strict negotiation başlangıcı yayınlanır;
  yalnız aynı epoch/negotiation answer ve ICE adayları host'a aktarılır, bağlantı
  kurulunca GPU yakalama otomatik başlar.
- Signaling'in onay mesajındaki sürümlü STUN/TURN listesi WebView2 sınırında
  yeniden doğrulanır ve native SIPSorcery eşine aktarılır.
- Beklenmedik WebSocket kesintisinde 30 saniyelik onaylı oturum kurtarma durumu
  gösterilir; bu sırada native video ve input kaynakları kapatılır.
- DXGI/capture/encoder graph recovery durumları WebView2'ye taşınır. Üç otomatik
  deneme tükenirse kullanıcı `Yeniden dene` ile native oturumu güvenli biçimde
  baştan kurabilir.
- Kontrol onayında WebView2 köprüsü sürümlü `control.event` mesajlarını yeniden
  doğrular ve küçük `IInputInjector` arabirimi arkasındaki Windows `SendInput`
  katmanına aktarır.
- Normalize pointer koordinatları seçili DXGI monitörün fiziksel piksel alanına,
  DPI scaling ve negatif sanal masaüstü koordinatları korunarak dönüştürülür.
- Sinyalleşme URL'si native uygulama tarafından sayfa yüklenmeden önce enjekte
  edilir; uygulama aynı web paketini yerel veya Raspberry Pi sunucusuyla kullanır.
- Paketlenen web istemcisi zorunlu `ediz-remote.v3` WebSocket alt protokolünü
  teklif eder; server `ready` mesajında current/minimum wire 3/3 dönmeden oturum
  işlemi başlamaz. WebView virtual-host origin'i
  `https://app.ediz-remote.local`, signaling allowlist'inde açıkça bulunmalıdır.
- Faz 4 önceki adayları wire v1/v2 teklif eder; Faz 4 öncesi yayınlanan EXE ise
  alt protokol teklif etmez. Yeni signaling sunucusu legacy fallback sunmadığı
  için production web/signaling/desktop rollout'u birlikte yapılmalıdır.
- Faz 4 kaynak reddi strict `operation` alanıyla create/join/resume/signal/ICE
  bağlamına ayrılır; retry metadata'sı bu kodlarda zorunlu, diğer hata kodlarında
  yasaktır. Create kotası bekleyen istek latch'ini temizler; throttled resume yeni
  soketle, guest'in düşen answer sinyali fresh-socket resume'la, host signal/ICE
  kontrollü ICE refresh ile otomatik denenir. Mevcut host onayı veya kontrol modu
  kendiliğinden düşürülmez.
- Genel peer ve native-video negotiation lane'leri ayrı tutulur. Her SDP/ICE
  zorunlu UUID `negotiationId` taşır; signaling lane başına oturum boyunca en
  fazla 256 görülmemiş host offer kimliği kabul eder ve bu state resume boyunca
  korunur. Eski kimlikli candidate/answer uygulanmaz.
- Web ve native pending ICE kuyrukları negotiation başına 64 aday/64 KiB;
  signaling aboneliği öncesi erken sinyal kuyruğu lane başına 64 mesaj/128 KiB
  ile bounded'dır. Native köprü aynı 64 aday/64 KiB sınırını uygular; taşma
  fail-closed native oturum kapanışına gider. Pre-offer taşması offer üretimi
  takılsa bile yarış sinyaliyle hemen görünür hata üretip oturumu durdurur.
- Tarayıcıdaki yerel aday yalnız offer/answer SDP'sinin bounded `ice-ufrag`
  nesliyle eşleşirse gönderilir; geç callback yeni negotiation kimliğine
  taşınmaz. Web köprü izleyicisi yalnız yeni başlangıç zarfıyla ilerler ve eski
  offer ile aktif kimliği geri sarmaz.
- WebRTC/DataChannel fatal kilidi aynı onaylı `active`↔`recovering` oturumunda
  korunur. Native input sıra watermark'ı yalnız başarılı enjeksiyon sonrası
  ilerler; SAS girişimi kontrolü kapatıp bütün girdileri bırakır ve kontrol açık
  pencere sessizce tepsiye gizlenemez.

## WebView2 yükleme ve güvenli yeniden deneme

Paketlenmiş web arayüzü eksikse, WebView2 Runtime başlatılamazsa veya yerel
arayüz navigasyonu başarısız olursa boş ya da donmuş pencere bırakılmaz. WebView
gizli tutulur; eksik paket ile WebView2 kurulum/güncelleme durumları için kullanıcıya
uygulanabilir, ham exception ayrıntısı içermeyen bir açıklama ve `Yeniden dene`
düğmesi gösterilir. WebView process'i veya güvenilir yerel navigation beklenmedik
biçimde durursa native kontrol girdisi kapatılır, basılı girişler bırakılır,
ICE/TURN referansları temizlenir ve native H.264 oturumu dispose tamamlanana kadar
beklenir; ardından aynı güvenli hata ekranına geçilir.

`Yeniden dene`, eşzamanlı ikinci başlatmayı engelleyen yaşam döngüsü koruması
altında WebView hazırlığını ve güvenilir yerel sayfa navigasyonunu tekrar çalıştırır.
Bu eylem origin/virtual-host denetimini gevşetmez, kontrol yetkisi oluşturmaz ve
başarılı navigasyon tamamlanmadan web arayüzünü görünür yapmaz.

WPF'nin `Initialize` ve `Yeniden dene` yolları tam
`https://app.ediz-remote.local/index.html` hedefi için `Navigate` çağrısından hemen
önce tek kullanımlık expected-navigation izni kurar. `NavigationStarting` izni ilk
navigasyonda tüketir; izin kurulmamış aynı-origin navigasyon dahi güvenilir kabul
edilmez. F5, Ctrl+R/Ctrl+Shift+R, JavaScript `location.reload()` veya WebView
`Reload()` gibi programatik yenileme ve başka beklenmeyen top-level yönlendirmeler
iptal edilir. Browser accelerator'ları WebView2 ayarında kapalıdır; reload kısayolu
WPF sınırında da ele alınarak input anında bırakılır ve native H.264/oturum kaynağı
mevcut deterministik fail-closed kapanış hattında durdurulur. Failure veya WebView
yeniden oluşturma bekleyen izni de temizler; retry yeni bir tek kullanımlık izin
kurmak zorundadır.

Render process çıkışından sonraki kullanıcı retry'si aynı WebView üzerinde izinli
yerel navigasyonla; browser process çıkışı veya unresponsive durum ise WebView
kontrolünü yeniden oluşturarak toparlanır. Native
kaynakların güvenli kapanışı tamamlanamazsa yanıltıcı bir retry döngüsü açılmaz;
kullanıcıdan uygulamayı yeniden başlatması istenir.

Köprü hata ayrıntısını serbest metin olarak taşımaz. Capture, encoder, GPU input,
kontrol, ekran/kalite geçişi ve native video hataları yalnız allowlist
`errorCode` değerleriyle bildirilir; React sınırı bunları yeniden doğrulayıp sabit
kullanıcı metnine dönüştürür. Bir alt sistemin başarılı durum mesajı başka bir
alt sistemin açık hatasını temizlemez.

## Güvenli uzaktan kontrol

- Host isteği “Yalnızca görüntüle” veya “Görüntüle + kontrol et” olarak ayrı
  onaylar. Kontrol seçeneği yalnızca native enjeksiyon ve global acil kısayol
  hazırsa etkinleşir.
- Pointer hareketi düşük gecikmeli unordered kanalda; buton, tekerlek ve klavye
  durumları güvenilir/sıralı kanalda taşınır.
- `channel: "session", version: 2` mesajları gönderen başına bütün session türleri
  için ortak artan `sequence` kullanır. Label/transport/rol/yetki matrisi pointer
  kanalında yalnız kontrol yetkili host'a gelen `pointer.move` mesajını; diğer
  session/control mesajlarını yalnız güvenilir kanalda beklenen yönde kabul eder.
- Pointer hareketleri animasyon karesi başına birleştirilir. Web ve native katman
  ayrı hız sınırları uygular; aralık dışı, eski, replay veya yanlış oturum mesajı
  state/input uygulamaz ve hız reddi sıra watermark'ını ilerletmez. Matris,
  reliable taşıma veya güvenli hız sınırı ihlali fail-closed kapanır; pointer
  kanalı ve native input kapatılarak tutulan tuş/butonlar bırakılır.
- `SendInput` mutlak sanal masaüstü koordinatlarını, sol/orta/sağ butonu, dikey/
  yatay tekerleği, yaygın Windows tuşlarını ve Unicode yazdırılabilir karakterleri
  destekler. Türkçe karakterler aktif klavye düzenine bağımlı olmadan Unicode
  olarak enjekte edilir; Ctrl/Alt/Meta içeren kısayollar sanal tuşla uygulanır.
- Disconnect, focus loss, visibility change, yetki iptali, WebView hatası ve
  uygulama kapanışında tutulan bütün tuş ve butonlar bırakılır.
- Host arayüzü kontrol etkinliğini sürekli gösterir. Tek tıkla geri alma yanında
  global `Ctrl+Alt+Shift+F12` kısayolu native enjeksiyonu önce kapatır, sonra
  guest'e yetki iptalini bildirir.
- Geri alma aynı anda strict
  `{ type: "revoke_control", channel: "control", version: 1 }` signaling
  mesajını yollar. Sunucu yalnız aktif host'u kabul eder, `control` erişimini
  idempotent biçimde `view` durumuna düşürür ve resume'da da `view` döndürür.
  Web host yerel revoke latch'iyle kontrolü hemen kapatır; geçici taşıma kaybında
  eski `control` durumu gelirse yetkiyi açmadan mesajı yeniden yollar.
- `Ctrl+Alt+Del` engellenir. `SendInput`, Windows UIPI/UAC sınırlarını aşmaz;
  secure desktop, kilit ekranı ve Session 0 kontrol edilmez.

## Faz 3 aktif oturum deneyimi

- Ana ekran rolleri “Bu cihaz için destek al” ve “Başka bir cihaza destek ver”
  olarak ayrılır; aktif oturumda da “Destek alan cihaz”/“Destek veren cihaz”
  rozeti görünür.
- Bağlantı paneli direct P2P veya TURN relay yolunu, round-trip gecikmesini,
  native hedef bitrate'i, paket kaybını ve onaylı oturum süresini ayrı alanlarda
  gösterir. `recovering` geçişi aynı onaylı oturumun sayacını sıfırlamaz.
- Guest operatör `Otomatik`, `Hız öncelikli` veya `Kalite öncelikli` profilini
  seçebilir. Native köprü profili yeniden doğrular ve encoder oturumunu sırasıyla
  8 Mbps/30 FPS, 3 Mbps/24 FPS veya 12 Mbps/30 FPS tavanıyla yeniden kurar.
- Guest görüntü alanı `Sığdır`, `1:1 piksel` ve Fullscreen API kullanan `Tam ekran`
  modlarını destekler. Pointer koordinatı her modda render edilen video
  dikdörtgeninden normalize edilir; letterbox veya scroll konumu kontrolü bozmaz.
- Windows host monitörleri `display.list` ile operatöre bildirir. Guest'in
  `display.select` isteği yalnızca aktif host tarafından, ilandaki bounded ekran
  kimliklerinden biri için uygulanır.
- Tarayıcı host fallback'inde monitör değişimi yeni `getDisplayMedia` seçimiyle
  yapılır; native Windows host'ta seçim DXGI yakalama hattını bağlantıyı
  sonlandırmadan yeniden kurar.
- Native stream'in DXGI pointer metadata'sı bounded WebView2 mesajıyla React
  host'a, sürümlü `cursor.state` ile guest'e taşınır. Guest konumu sığdır, 1:1,
  scroll ve fullscreen video dikdörtgenine DOM üzerinden uygular; sık mesajlar
  React state'e yazılmaz. Kapanışta katman hemen gizlenir.

## Sistem tepsisi, tek-instance ve kapanış

- Uygulama başlarken oturum-local named mutex alır. İkinci EXE aynı mutex'i
  alamaz; yeni ana pencere/WebView açmadan named auto-reset event ile mevcut
  sürece aktivasyon sinyali gönderip kapanır. Mevcut pencere gizli veya minimize
  ise normal duruma getirilip öne alınır.
- Sistem tepsisi menüsünde `Ediz Remote'u Aç` ve `Çıkış` bulunur; çift tıklama da
  pencereyi açar. Boşta başlık çubuğundaki kapatma düğmesi uygulamayı tepsiye
  gizler ve ilk seferde görünür bilgilendirme gösterir.
- Aktif native destek oturumu varken kapatma, pencereyi gizleyip bağlantıyı
  görünmez sürdürmez. Kullanıcıya bağlantının kapanacağı açıkça sorulur; onay
  verilmezse pencere görünür kalır.
- Gerçek çıkışta yeni kontrol girdisi önce kapatılır ve tutulan girişler bırakılır;
  global hotkey çözülür, native stream/ICE/encoder iptal edilip beklenir, ardından
  WebView ve synchronization kaynakları dispose edilir. Windows oturum kapanışı
  tepsiye gizleme davranışını atlayarak aynı temiz çıkış yoluna girer.

## Geliştirme komutları

```powershell
npm run desktop:build
npm run desktop:test
npm run desktop:run
npm run desktop:publish
npm run release:windows:manifest
npm run release:windows:verify
```

`desktop:run`, varsayılan olarak yerel `ws://127.0.0.1:8788/ws` sinyalleşme
servisine bağlanır. Farklı bir sunucuyla açmak için:

```powershell
powershell -File scripts/windows-desktop.ps1 run `
  -SignalingUrl wss://remote.edizegemercan.com.tr/ws
```

Self-contained paket `artifacts/windows-desktop/win-x64` altına yazılır. Ana
çalıştırılabilir dosya `EdizRemote.exe`dir; .NET kurulumu gerekmez. Hedef Windows
makinesinde Microsoft Edge WebView2 Runtime bulunmalıdır.
Üretim imzası, signer allowlist'i ve fail-closed doğrulama akışı
`docs/WINDOWS_RELEASE.md` dosyasında tanımlıdır. Publish, release kimliğini
(`ProductVersion` `<sürüm>+<commit>[.dirty]`, `FileVersion` `<sürüm>.<sequence>`)
EXE sürüm kaynağına gömer ve önceki EXE'yi tarif eden release manifestini siler.
Publish edilen uygulamanın köprüye bildirdiği sürüm bu nedenle `package.json`
sürümüdür; `desktop:build`/`desktop:run` çıktısı kimlik gömmez ve SDK varsayılanı
`1.0.0`'ı bildirir.

## Publish bütünlüğü ve final fiziksel probe

Web paketi single-file bundle'a rastgele gömülmez. Publish zinciri önce kaynak
`apps/web/dist` ağacını ve `index.html` içindeki bütün yerel `src`/`href` asset
referanslarını doğrular; içeriği güvenli bir staging dizinine kopyalar, stale final
`Web` ağacını bununla değiştirir ve final referansları tekrar doğrular. Böylece
`index.html`in olmayan hash'li JS/CSS dosyasına işaret ettiği boş ekran paketi
publish başarılı sayılamaz. Final fiziksel probe'da kaynak ve yayınlanmış `Web`
ağaçları ayrıca göreli yol, boyut ve SHA-256 ile karşılaştırıldı; iki ağaç da 4
dosyadır ve fark sayısı `0`dır.

2026-08-23 Faz 3 tarihsel final artifact kimliği:

- Dosya: `artifacts/windows-desktop/win-x64/EdizRemote.exe`
- Boyut: `184540144` bayt
- Son yazma: `2026-08-23 22:59:29 +03:00`
- SHA-256: `E89F4CD1FE143166E2BDEDE92E0CB19AB92B54541FCF200BC20FD3DEDF70987B`

Final self-contained EXE fiziksel probe'unda boş ekran yerine dolu arayüz, canlı
kod ve `2 ekran · H.264 GPU` durumu görüldü. Odaklanmış pencerede F5, input ile
native video/oturumu fail-closed durdurup görünür güvenli hata ekranını açtı;
`Yeniden dene` WebView'i güvenli biçimde yükleyip yeni kod üretti. İkinci EXE
yalnız aktivasyon gönderdi ve tek pencere kaldı. Boşta `Alt+F4` pencereyi tepsiye
gizledi; yeniden başlatma denemesi yeni pencere açmadan aynı HWND'yi görünür yaptı.
Bu tarihsel artifact'in desktop doğrulaması 66 test, build ve publish ile geçti.

2026-09-02 wire v3 Dilim 3 artifact kimliği:

- Dosya: `artifacts/windows-desktop/win-x64/EdizRemote.exe`
- Boyut: `184835328` bayt
- Son yazma: `2026-09-02 15:10:00 +03:00`
- SHA-256: `2DE77D95685E752801E28B98CBCA661208E8653B176C6C13CE93597388613425`
- Authenticode: `NotSigned`

Source ve publish `Web` ağaçlarının dörder dosyasında göreli yol, boyut ve
SHA-256 farkı `0`; yayınlanmış bundle wire v3 alt protokolünü içeriyor. Desktop
87/87, web 100/100, protocol 10/10 ve signaling 42/42 testleri geçti. Fiziksel EXE
smoke bu dilimde yeniden çalıştırılmadı; bu aday imzalanmadan production release
kabul edilmez.

2026-10-09 release kimlikli geliştirme adayı (fuzz dilimi sonrası):

- Dosya: `artifacts/windows-desktop/win-x64/EdizRemote.exe`
- Boyut: `184835328` bayt
- Son yazma: `2026-10-09 17:55:07 +03:00`
- SHA-256: `330D033CE3AC08C0E011E2DEEF0B477D15F71754570DB76CD091DC6E838D20E0`
- `ProductVersion`: `0.1.0+6bdf2a5f7a070a56a7c70593e4ff464db56be155.dirty`
- `FileVersion`: `0.1.0.0` (sequence `0`, geliştirme paketi)
- Authenticode: `NotSigned`

Source ve publish `Web` ağaçlarının dörder dosyasında fark `0`; bundle wire v3
içeriyor. Desktop 113/113 geçti; köprü ayrıştırıcıları eşlenmemiş surrogate,
yinelenen anahtar ve protokol dışı ICE sunucu alanını istisnasız reddeder. Kirli
ağaç ve sequence `0` nedeniyle release kapısı bu adayı imza öncesinde reddeder;
fiziksel EXE smoke çalıştırılmadı. Bu aday, aynı günün `971506f` adayının
(`DED61FD7…D71D`) yerini aldı.

## Sinyalleşme ayarı

Öncelik sırası:

1. `EDIZ_REMOTE_SIGNALING_URL` ortam değişkeni.
2. Uygulamanın yanındaki `ediz-remote.settings.json`.
3. Varsayılan `wss://remote.edizegemercan.com.tr/ws` adresi.

Örnek ayar:

```json
{
  "signalingUrl": "wss://remote.edizegemercan.com.tr/ws"
}
```

## Mevcut sınırlar

Windows host canlı paylaşımda DXGI → NV12 → donanım H.264 → DTLS-SRTP hattını
otomatik kullanır; guest tarayıcı gelen native track'i uzak ekran görünümünde
oynatır. Tarayıcı host fallback'i için `getDisplayMedia` düğmesi korunur ancak
native `SendInput` bulunmadığından bu rolde kontrol verilemez. TURN istemci,
public Pi coturn ve fiziksel WAN direct/recovery/relay kabul matrisi hazırdır.
Ses ve DXGI pointer shape/piksel maskesi birleştirme uygulanmamıştır; konum
metadata'sı guest katmanında gösterilir. Native host tarafında RTCP PLI/NACK
işlenir; hedef bitrate ve ölçülen paket kaybı bağlantı durum satırında canlı
gösterilir.

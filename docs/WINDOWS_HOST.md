# Windows native host — Desktop Duplication prototipi

`apps/windows-host`, Windows 8 ve sonrasında bulunan DXGI Desktop Duplication API
ile fiziksel masaüstü çıkışlarını yakalayan .NET 8 tabanlı native host'tur. D3D11
ve DXGI erişimi için `Vortice.Direct3D11` 3.8.3; encoder keşfi ve GPU sample
köprüsü için `Vortice.MediaFoundation` 3.8.3; ICE/DTLS-SRTP için `SIPSorcery`
10.0.16 kullanılır. Bu sürüm Faz 4 dependency denetiminde doğrudan uygulanabilir
SCTP/TurnServer DoS bulgularını kapatmak için minimum native tabandır. Eski
NETStandard uyumluluk grafiğinin `System.Net.Http` ve
`System.Text.RegularExpressions` audit kayıtları sırasıyla 4.3.4/4.3.1 direct
override ile güvenli sürümlere sabitlenir. Publish çıktısında seçilen fiziksel
assembly'ler .NET 8.0.29 runtime pack sürümü (`8.0.0.0`) olarak doğrulanmıştır.

## Komutlar

Kök dizinden:

```powershell
npm run native:build
npm run native:test
npm run native:probe
npm run native:publish
```

Monitör seçmek veya snapshot almak için yardımcı betik doğrudan çağrılabilir:

```powershell
powershell -File scripts/windows-host.ps1 list
powershell -File scripts/windows-host.ps1 encoders
powershell -File scripts/windows-host.ps1 encoder-probe -Output 0
powershell -File scripts/windows-host.ps1 encode-probe -Output 0 `
  -Duration 10 -File artifacts/encode-probe/frame.h264
powershell -File scripts/windows-host.ps1 stream-probe -Output 0 -Duration 5
powershell -File scripts/windows-host.ps1 probe -Output 1 -Duration 10
powershell -File scripts/windows-host.ps1 snapshot -Output 0 -File artifacts/manual.bmp
```

SDK makinede yoksa betik resmi `dotnet-install.ps1` üzerinden proje içindeki
`.tools/dotnet` klasörüne taşınabilir .NET 8 SDK kurar; sisteme veya PATH'e kalıcı
değişiklik yapmaz.

## Çıktı protokolü

Host stdout'a satır başına bir JSON olayı yazar:

- `display.list`: Bağlı monitörler, ekran kartı ve masaüstü koordinatları.
- `encoder.list`: Donanım H.264 MFT'leri, üretici ve D3D11 yetenekleri.
- `encoder.gpu-probe`: Encoder aktivasyonu, DXGI device manager bağlantısı ve
  NV12 GPU yüzeyinin Media Foundation sample'ına sarılma sonucu.
- `encoder.frame`: Gerçek masaüstü karesinden üretilen Annex B H.264 dosyası,
  byte sayısı, çözünürlük ve NAL türleri.
- `stream.started` / `stream.completed`: Kesintisiz GPU encode oturumunun kare,
  masaüstü güncellemesi, RTP paket ve payload istatistikleri.
- `capture.started`: Seçilen ekran ve test süresi.
- `capture.completed`: Boyut, piksel biçimi, alınan kare sayısı ve ilk kare hash'i.
- `snapshot.saved`: Kullanıcı tarafından istenen BMP dosyasının yolu ve özeti.
- `host.error`: Makinece okunabilir hata kodu ve açıklama.

Bu yapı sonraki aşamada web/masaüstü arayüzünün native süreci child process olarak
başlatıp durumunu izlemesine uygundur.

## Yakalama hattı

1. DXGI factory ekran kartlarını ve bağlı output'ları listeler.
2. Seçilen adapter üzerinde D3D11 cihazı oluşturulur.
3. `IDXGIOutput1.DuplicateOutput` ile yakalama oturumu açılır.
4. `AcquireNextFrame` her masaüstü değişiminde GPU texture döndürür.
5. `probe`, ilk kareyi staging texture üzerinden CPU'ya okuyarak hattı doğrular;
   sonraki kareleri diske yazmadan sayar.
6. `snapshot`, açıkça istendiğinde BGRA verisini 32-bit BMP olarak kaydeder.

Media Foundation donanım H.264 encoder keşfi artık çalışır. `encoder-probe`, aynı
GPU üzerinde D3D11 video desteği olan cihazı oluşturur, DXGI device manager'ı
asenkron encoder'a bağlar ve 1280x720 NV12 texture'ı `IMFSample` içine sıfır kopya
yüzey olarak sarar. `encode-probe` ise Desktop Duplication BGRA karesini D3D11
Video Processor ile NV12'ye dönüştürür ve NVIDIA/Intel/AMD H.264 MFT üzerinden
gerçek Annex B bitstream üretir. WebRTC entegrasyonunda staging/CPU kopyası
kullanılmaz.

`stream-probe`, aynı hattı kesintisiz oturum olarak çalıştırır. Encoder giriş
kredileri ve çıktıları asenkron MFT olaylarıyla kuyruklanır. Her encoded access
unit Annex B NAL'lara ayrılır; SPS/PPS STAP-A ile birleştirilir, MTU'yu aşan
slice'lar FU-A parçalarına bölünür. RTP sıra numarası paket başına, 90 kHz video
timestamp'i kare başına ilerler.

## Native video/WebRTC sınırı

Sonraki katmanlar şu sözleşmeyle ayrılır:

1. Desktop Duplication, yakalanan BGRA GPU texture'ını kare ömrü boyunca sağlar.
2. D3D11 video processor, aynı cihazda BGRA yüzeyi NV12 encoder yüzeyine çevirir.
3. Asenkron H.264 MFT, zaman damgalı NV12 `IMFSample` alır ve Annex B erişim
   birimleri üretir.
4. RTP paketleyici RFC 6184 packetization-mode 1 kurallarıyla tek NAL, STAP-A ve
   FU-A payload'ları üretir; son access-unit paketinde marker bitini set eder.
5. Native WebRTC sender Annex B access unit'i negotiated H.264 track'e verir;
   SIPSorcery RFC 6184 paketleme ve SRTP korumasını uygular. Paketler şifrelenmeden
   genel ağa gönderilmez.
6. Sinyalleşme servisi yalnızca SDP/ICE taşır; görüntü Raspberry Pi üzerinden
   geçmez. Onay mesajındaki sürümlü STUN/TURN listesi SIPSorcery'ye uygulanır;
   relay seçilirse şifreli medya public coturn üzerinden akar.

## RTCP geri bildirim ve bitrate kontrolü

- SDP `nack` ve `nack pli` feedback yeteneklerini ilan eder.
- Son 4096 RTP paketi sıra numarasıyla tutulur; NACK PID/BLP alanı açılarak bulunan
  paketler aynı RTP kimliğiyle tekrar SRTP hattına verilir.
- PLI veya önbellekte bulunamayan NACK, donanım encoder'ını yeniden başlatır; ilk
  çıktı SPS/PPS ve IDR ile decoder'ı yeniden eşzamanlar.
- RTCP receiver report paket kaybı yüksekse hedef bitrate çarpımsal düşürülür;
  üç iyi rapordan sonra kontrollü artırılır. Değişiklikler en fazla iki saniyede
  bir encoder yenilemesi doğurur.
- Faz 3 kalite profilleri adaptasyon tavanını ve capture FPS'ini belirler:
  `speed` 3 Mbps/24 FPS, `auto` 8 Mbps/30 FPS, `quality` 12 Mbps/30 FPS.
  Profil değişimi mevcut onaylı oturumda encoder/native WebRTC eşini güvenli
  biçimde yeniden kurar; kayıp adaptasyonu seçilen tavanın üzerine çıkmaz.
- Her DXGI karedeki pointer konumu seçili output boyutuna göre 0–1 aralığına
  normalize edilir. Ayrı hardware pointer görünürse değişiklikler en fazla
  capture FPS'i hızında yayınlanır; değişmeyen konum saniyelik heartbeat ile
  yeni DataChannel'a tekrar ulaşır ve stream kapanışında görünmez durum gönderilir.

## Mevcut sınırlar

- Ayrı donanım imlecinin şekli/piksel maskesi görüntüye birleştirilmez. Konum ve
  görünürlük guest HTML katmanına taşınır; DXGI imleci kareye zaten bileşik
  veriyorsa ikinci katman çizilmez. Bu generic metadata imleci Faz 3 uzak destek
  deneyimini karşılar. Renkli, monochrome ve masked-color pointer biçimleriyle
  hotspot/stride ve GPU kompozisyon uyumluluğu birlikte doğrulanmadan piksel
  maskesi video hattına eklenmeyecektir; exact pointer shape desteği Faz 6 GPU ve
  sürücü uyumluluk matrisine ertelenmiştir.
- Döndürülmüş monitörlerin kare rotasyonu henüz uygulanmaz.
- Kilit ekranı, UAC secure desktop ve oturum açılmamış Session 0 yakalanmaz.

## Capture/encoder graph kurtarma

`DXGI_ERROR_ACCESS_LOST` ayrı bir capture hatası olarak sınıflandırılır. Ekran
modu, çözünürlük, monitör sırası, GPU yolu veya uyku/uyanma sonrasında native host
seçili ekranı cihaz adıyla yeniden keşfeder; DXGI duplication, D3D11 NV12
converter ve Media Foundation encoder graph'ını tamamen dispose edip yeniden
kurar. Yeni encoder ilk çıktıdaki SPS/PPS + IDR ile tarayıcı decoder'ını yeniden
eşzamanlar.

Graph kurtarma 1, 2 ve 4 saniyelik iptal edilebilir gecikmelerle en fazla üç kez
denenir. Her deneme WPF köprüsüne görünür durum gönderir; kararlı başlangıçtan
sonra bağlantı yeniden `connected` olur. Denemeler tükenirse sessiz donma yerine
son güvenli hata yayınlanır ve kullanıcı arayüzü `Yeniden dene` eylemi sunar.

2026-07-23 fiziksel kabulünde canlı desktop→browser oturumu sırasında ana ekran
2560×1440'tan 1920×1080'e ve tekrar 2560×1440'a geçirildi. Native H.264 yayın
uygulama yeniden başlatılmadan iki değişimden sonra da geri döndü.

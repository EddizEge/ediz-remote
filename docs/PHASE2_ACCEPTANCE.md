# Faz 2 kabul kanıtı

Tarih: 2026-08-13

Durum: **TAMAMLANDI. Kod, yerel altyapı, oturum kurtarma, ekran modu,
public Pi coturn ve fiziksel WAN direct/relay kabul matrisi geçti.**

Faz 2'nin bütün kabul kriterleri 2026-08-13 tarihinde tamamlandı.

## Otomatik ve yerel kanıtlar

| Alan | Sonuç | Kanıt |
|---|---:|---|
| Web/protokol | Geçti | 14 web testi, production build ve lint |
| Signaling resume | Geçti | 17 test; iki taraflı resume, token rotation, replay reddi, timeout, ICE credential refresh, stale-socket takeover ve heartbeat termination |
| Native recovery | Geçti | 38 normal test; recoverable hata, bounded backoff ve ekranı cihaz adıyla yeniden bulma |
| Desktop köprüsü | Geçti | 20 test ve Release build |
| TURN relay | Geçti | Gerçek signaling HMAC credential ile container içinde 6/6 mesaj relay |
| TURN ağ kalitesi | Geçti | 80±20 ms, %2 kayıp, 4 Mbit/s: UDP 192/200 (%96), TCP 60/60 (%100) |
| Public preflight dry-run | Geçti | LAN'a yayınlanan coturn: UDP 6/6, TCP 6/6; 7 parser/yapılandırma/sınır testi |
| Public Pi coturn | Geçti | `turn.edizegemercan.com.tr` DNS-only A kaydı, Pi 5 üzerinde authenticated HMAC coturn 4.12.0-r0 healthy; public UDP 6/6 ve TCP 6/6, geçersiz HMAC allocation reddedildi |
| Pi web/signaling deployment | Geçti | `/opt/ediz-remote/app`, container healthy, restart 0; localhost health, kod→katıl→onay, TURN credential ve ping/pong akışı geçti |
| Public signaling erişimi | Geçti | `remote.edizegemercan.com.tr` Cloudflare Tunnel üzerinden DNS A/AAAA, HTTPS health 200, TLS doğrulamalı WSS kod→katıl→onay ve ping/pong geçti |
| Zorlanmış native TURN | Simülasyon geçti | `relay-only` iki native eş; yalnızca `relay` adaylarıyla UDP ve TCP üzerinde DTLS-SRTP H.264 RTP teslimi, taşıma başına 1/1 |
| İki sanal NAT browser TURN | Simülasyon geçti | İki ayrı özel ağ ve iki NAT router; gerçek host/guest Chrome akışı, açık host onayı, yalnızca `relay` ICE adayları, iki açık DataChannel, 1920×1080 sahte ekran videosu ve 5 sn guest ağ kesintisi sonrası ilerleyen video; konsol 0 uyarı/hata |
| DXGI capture | Geçti | RTX 4060 Ti, 2560×1440, 2.185 acquired frame ve 696 desktop update / 4.866 sn |
| GPU H.264 stream | Geçti | 134/134 kare, 30.11 FPS, 2.575 RTP paketi, 0 encoder restart |
| Native desktop→browser | Geçti | Host onayı sonrası H.264 GPU, 8 Mbps, %0 kayıp, direct P2P, 1 ms |
| İki tarayıcı P2P | Geçti | Host onayı sonrası direct P2P; konsol hatası/uyarısı yok |
| İki taraflı kısa kesinti | Geçti | WebSocket proxy kesildi; iki taraf 30 sn içinde aynı onaylı oturuma ve direct P2P'ye döndü |
| Kesinti timeout'u | Geçti | Grace period aşımında eski onay kullanılmadı; temiz yeni kod/oturum yolu gösterildi |
| Ekran modu kurtarma | Geçti | Canlı native oturumda 2560×1440 → 1920×1080 → 2560×1440; uygulama yeniden başlatılmadan yayın iki kez döndü |
| Responsive render | Geçti | Masaüstü ve 390×844 görünümde taşma/overlay/konsol hatası yok |

## Güvenlik ve yaşam döngüsü

- Reconnect token 256 bittir, istemci belleğinde tutulur; sunucu yalnızca SHA-256
  özetini saklar.
- Host ve guest token'ları ayrıdır. Başarılı resume token'ı döndürür; eski,
  replay ve süresi geçmiş token reddedilir.
- Peer askıya alınır alınmaz React WebRTC eşleri dispose edilir; desktop köprüsü
  native stream'i durdurur ve input yaşam döngüsü mevcut disconnect kurallarıyla
  basılı girişleri bırakır.
- `refresh_ice` yalnızca onaylı aktif üyeden kabul edilir. Yeni TURN credential
  istemciye özel ve kısa ömürlüdür.
- WebSocket heartbeat iki cevapsız 5 saniyelik aralıktan sonra sessiz bağlantıyı
  sonlandırır. Mobil ağ geri geldiğinde güncel reconnect token eski aktif soketi
  güvenle devralabilir; token hemen döndürülür.
- Capture graph recovery iptal edilebilir ve üç denemeyle sınırlıdır; sessiz
  sonsuz retry veya büyüyen stream task koleksiyonu yoktur.

## Fiziksel kabul matrisi

| Senaryo | Durum | Beklenen kanıt |
|---|---|---|
| Aynı LAN, gerçek desktop→browser | Geçti | Native görüntü/kontrol matrisi ve direct tarayıcı P2P |
| Farklı fiziksel ağ | Direct geçti | Ev internetindeki Windows host ile mobil veri tarayıcısı arasında görüntü ve `Doğrudan P2P` doğrulandı |
| Mobil hotspot/veri | Geçti | Direct görüntü; stale WSS düzeltmesi sonrası 5 sn mobil veri kesintisinden aynı onaylı oturuma ve görüntüye dönüş |
| CGNAT/symmetric NAT | Geçti | Mobil veri guest ile direct adayları zorla kapatıldı; self-hosted public coturn üzerinden bağlantı kuruldu ve arayüzde `TURN relay` doğrulandı |
| Direct zorla engelli | Geçti | Windows desktop→mobil veri tarayıcısı fiziksel WAN oturumu public self-hosted TURN üzerinden bağlandı; test sonrasında production paketi P2P öncelikli `all` politikasına geri alındı |
| 30 sn signaling kesintisi | Geçti | İki taraflı resume ve temiz timeout/yeni kod |
| Çözünürlük değişimi | Geçti | Uygulama kapanmadan native video dönüşü |
| Uyku/uyanma veya GPU reset | Faz 6 | Bounded graph rebuild ve görünür durum; donanım matrisiyle çalıştırılacak |
| Paket kaybı/jitter/bant daraltma | Geçti | UDP/TCP TURN kalite probe'u |

Public test kurulumu ve komutları `docs/TURN.md` dosyasındadır. Bu kurulumda Pi,
sabit public IPv4 ve port yönlendirme kullanılabildiği için ayrıca VPS gerekmedi.

2026-08-13 tarihinde Pi 5 üzerinde, mevcut diğer Compose projelerine
dokunulmadan ayrı `/opt/ediz-remote` dizininde coturn kuruldu. Secret root
sahipli `0600` `.env` dosyasında tutuluyor; container `nobody:nogroup`,
`cap_drop: ALL`, yalnızca `NET_BIND_SERVICE`, host network ve
`restart: unless-stopped` ile çalışıyor. Public HMAC preflight UDP ve TCP için
6/6 geçti; zaman damgası geçmiş ve yanlış HMAC credential allocation açamıyor.
Entrypoint'in ürettiği authenticated yapılandırmayı gerçekten yüklediği ayrıca
regresyon testiyle korunuyor. Aynı tarihte web/signaling uygulaması ayrı
`ediz-remote-app` Compose projesi olarak kuruldu; canlı onay akışının verdiği
credential ile public coturn UDP 6/6 ve TCP 6/6 relay geçti. Üretim arayüzü
masaüstü ve 390×844 görünümde yatay taşma ve konsol hatası olmadan render edildi;
yeni kod etkileşimi doğrulandı. Cloudflare Tunnel route eklendikten sonra public
HTTPS arayüzü ve health, TLS doğrulamalı iki istemcili WSS onay akışı ve bu public
oturumun verdiği credential ile coturn UDP/TCP 6/6 relay geçti. Fiziksel kabulde
ev internetindeki Windows host ile mobil veri tarayıcısı direct bağlandı ve
görüntü aktı. Beş saniyelik mobil veri kesintisinden aynı onaylı oturuma dönüş
geçti. Son olarak direct adayları production web paketinde geçici olarak
kapatılarak aynı fiziksel WAN oturumu public Pi coturn üzerinden kuruldu ve
arayüzde `TURN relay` görüldü. Deneyden sonra normal P2P öncelikli `all` politikası
yeniden yayınlandı.
Chrome 144 tabanlı laboratuvarda host ve guest ayrı `172.28.10.0/24` ile
`172.28.20.0/24` ağlarına, TURN ise yalnızca iki NAT router üzerinden erişilen
ayrı bir sentetik public omurgaya yerleştirildi. `relay-only` uygulama akışında
iki tarafın local/remote adaylarının tamamı `relay`, kontrol ve pointer
DataChannel'ları `open`, fallback ekran videosu 1920×1080 ve kesinti öncesi/sonrası
hareketli olarak doğrulandı.

Kimlik doğrulama ve browser medya kanıtı bilinçli olarak iki katmana ayrıldı:
üretim entrypoint'i ve kısa ömürlü signaling HMAC credential resmi coturn
istemcisiyle UDP/TCP 6/6 relay geçti ve geçersiz credential reddedildi; Chrome medya/DataChannel ayağı ise yalnızca
kapalı ve işlem sonunda silinen laboratuvar omurgasında `no-auth` coturn ile
çalıştırıldı. Bu, browser uygulama davranışını ve iki NAT taşımasını kanıtlar;
Bu laboratuvar kanıtı daha sonra public self-hosted coturn, gerçek ev
firewall/NAT'ı ve mobil veri ağıyla yapılan fiziksel direct/recovery/relay
oturumuyla tamamlandı.

`npm run turn:public-preflight` komutu DNS/TCP
erişimini, signaling ile aynı kısa ömürlü HMAC credential üretimini ve her UDP/TCP
TURN URL'sinde relay teslimatını doğrulayacaktır.

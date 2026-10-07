# Faz 2 tamamlama planı

Amaç, farklı NAT/CGNAT ağlarında bağlantı kurmak ve kısa ağ/ekran değişikliklerini
güvenli biçimde atlatmaktır. Faz 2 ancak aşağıdaki bütün kabul kanıtları
tamamlandığında `TAMAMLANDI` olarak işaretlenecektir.

Durum: **TAMAMLANDI — 2026-08-13.**

## Çalışma paketleri

### P2.1 — Sürümlü ICE ve kısa ömürlü TURN credential — TAMAMLANDI

- [x] Host onayından önce credential üretmeme.
- [x] Host ve guest için ayrı HMAC-SHA1/Base64 coturn credential.
- [x] Sürümlü ICE listesini tarayıcı ve native eşlere uygulama.
- [x] TURN yapılandırılmadığında STUN/direct fallback'i koruma.
- [x] Şema, boyut, TTL ve WebView2 sınır doğrulaması.

### P2.2 — coturn deployment ve relay kanıtı — TAMAMLANDI

- [x] Resmi, sabit ve ARM64 destekli coturn container imajı.
- [x] Root olmayan çalışma, sınırlı capability, CLI/TLS/DTLS kapatma.
- [x] Private/loopback peer engeli, allocation ve bant genişliği kotaları.
- [x] Pi/VPS host-network Compose, healthcheck ve restart policy.
- [x] Gerçek signaling HMAC credential ile yerel 6/6 relay probe.
- [x] LAN IP'sine yayınlanan TURN listener'a ayrı container'dan UDP relay kanıtı.
- [x] 80±20 ms gecikme, %2 kayıp ve 4 Mbit/s altında UDP/TCP relay kalite probe'u.
- [x] Public adres geldiğinde aynı HMAC/UDP/TCP zincirini çalıştıracak preflight
  komutu ve parser/sınır testleri.
- [x] Gerçek desktop→browser oturumunda direct yolun korunması.
- [x] Native H.264 eşinde direct adayları kapatan `relay-only` yerel UDP/TCP
  TURN simülasyonu ve şifreli RTP teslimi.
- [x] Public Pi/VPS üzerinde kurulum.
- [x] Public UDP/TCP listener ve relay port aralığı preflight doğrulaması.
- [x] İki sanal NAT arkasındaki gerçek browser uygulamasında direct engellenerek
  UI, fallback görüntü ve iki DataChannel için `TURN relay` kanıtı.
- [x] Aynı uygulama matrisini self-hosted public coturn üzerinde tekrarlama.

### P2.3 — WebSocket ve onaylı oturum kurtarma — TAMAMLANDI

- [x] Rol bazlı, bağlantı kodundan ayrı ve bellekte tutulan reconnect token.
- [x] Token hash saklama, başarılı resume sonrasında token rotation.
- [x] Onaylı oturum için en fazla 30 saniyelik grace period.
- [x] Host/guest ayrılır ayrılmaz kontrol ve native input'u kapatma.
- [x] İki taraf aynı anda kopsa da güvenli resume veya temiz timeout.
- [x] Eski, replay veya süresi geçmiş reconnect token reddi.

### P2.4 — Kontrollü ICE restart — TAMAMLANDI

- [x] `disconnected` durumunda kısa bekleme; `failed` veya süre aşımında restart.
- [x] Yalnızca onaylı ve signaling bağlantısı geri gelmiş oturumda ICE restart.
- [x] Aynı anda tek restart; bounded exponential backoff ve üst deneme sınırı.
- [x] Yeni TURN credential gerekiyorsa signaling üzerinden yenileme.
- [x] Başarısız restart sonrası donmuş ekran yerine temiz yeniden bağlantı yolu.

### P2.5 — Native capture/encoder kurtarması — TAMAMLANDI

- [x] `DXGI_ERROR_ACCESS_LOST` sınıflandırması.
- [x] Çözünürlük, monitör, GPU ve uyku/uyanma değişiminde graph dispose/rebuild.
- [x] Bounded retry/backoff ve iptal edilebilir yaşam döngüsü.
- [x] Yeniden kurulumda SPS/PPS + IDR ile decoder eşzamanlama.
- [x] Basılı input, eski stream task veya native kaynak bırakmama.
- [x] 2560×1440 → 1920×1080 → 2560×1440 gerçek ekran modu değişiminde,
  uygulama yeniden başlatılmadan native yayının dönmesi.
- [ ] Uyku-uyanma/GPU reset fiziksel dayanıklılık testi (Faz 6 donanım matrisi).

### P2.6 — Kullanıcı durumu ve yeniden deneme — TAMAMLANDI

- [x] `Bağlantı kesildi`, `yeniden bağlanıyor`, `relay deneniyor` durumları.
- [x] Capture/encoder hatasında güvenli açıklama ve `Yeniden dene`.
- [x] Direct/relay yolu, gecikme, kayıp ve bitrate bilgisini tutarlı gösterme.
- [x] Timeout olduğunda eski onayı sessizce yeniden kullanmama.

### P2.7 — Kabul ve ağ matrisi — TAMAMLANDI

- [x] Aynı LAN.
- [x] Farklı ev/ofis ağı.
- [x] Mobil hotspot/veri.
- [x] En az bir CGNAT veya symmetric NAT senaryosu.
- [x] Direct mümkünken relay kullanılmadığının kanıtı.
- [x] Direct mümkün değilken native medya TURN fallback'inin yerel simülasyon
  kanıtı.
- [x] İki sanal NAT laboratuvarında gerçek browser uygulamasında direct mümkün
  değilken TURN'ün UI/görüntü/DataChannel ile devreye girdiğinin kanıtı.
- [x] Self-hosted public TURN ile browser uygulama matrisini fiziksel WAN'da
  tekrarlama.
- [x] 30 saniyelik kesinti resume ve temiz timeout testi.
- [x] Ekran modu değişiminden sonra uygulamayı kapatmadan yayın dönüşü.
- [x] Paket kaybı/jitter/bant daraltma testi.
- [x] Yerel ve otomatik sonuçları `docs/PHASE2_ACCEPTANCE.md` altında kaydetme.

## Dış altyapı kabulü

Public IPv4/DNS, modem port yönlendirmesi, Pi 5 ve mobil veri ağıyla dış altyapı
bağımlılığı karşılandı. Fiziksel Windows desktop→mobil tarayıcı oturumunda direct
P2P görüntü, beş saniyelik mobil veri kesintisinden aynı onaylı oturuma dönüş ve
direct adayları kapalıyken self-hosted public TURN seçimi doğrulandı. Relay
deneyinden sonra production web paketi tekrar P2P öncelikli `all` politikasına
alındı.

2026-08-13 tarihinde `turn.edizegemercan.com.tr` DNS-only A kaydı ve Pi 5
üzerindeki production HMAC coturn kurulumu tamamlandı; UDP ve TCP public
preflight 6/6 geçti. `remote.edizegemercan.com.tr` üzerinden public HTTPS/WSS
yayını da geçti. Aynı secret kullanan Pi web/signaling deployment'ı healthy
durumdadır; public WSS onayı sonrası verilen credential public UDP/TCP relay'de
6/6, fiziksel uygulama oturumu ise arayüzde `TURN relay` sonucu vermiştir.

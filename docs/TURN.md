# Ediz Remote coturn kurulumu

Bu belge Faz 2 kapsamındaki public TURN relay kurulumunu açıklar. Cloudflare
Tunnel yalnızca web ve WebSocket sinyalleşmesini taşır; TURN için public UDP/TCP
portları doğrudan coturn makinesine ulaşmalıdır.

## Yerleşim kararı

- Raspberry Pi public IPv4 arkasındaysa ve router port yönlendirmesi
  yapılabiliyorsa coturn Pi üzerinde çalışabilir.
- İnternet hattı CGNAT arkasındaysa Pi'ye gelen port açılamaz. Bu durumda public
  IPv4 adresli bir VPS kullanılmalıdır.
- `turn.<alan-adı>` kaydı coturn public IPv4 adresine doğrudan A kaydı olmalıdır.
  Cloudflare kullanılıyorsa bu kayıt DNS-only olmalıdır.
- Bu ilk deployment TURN/UDP ve TURN/TCP 3478'i destekler. TLS/DTLS bilinçli
  olarak kapalıdır; `turns:` URL'si sertifika eklenmeden yayınlanmamalıdır.

## Gerekli portlar

| Protokol | Port | Amaç |
|---|---:|---|
| UDP | 3478 | TURN/STUN ve tercih edilen istemci taşıması |
| TCP | 3478 | UDP engellendiğinde TURN/TCP |
| UDP | 49160–49200 | Relay allocation portları |

Router arkasındaki Pi'de aynı portlar Pi'nin `TURN_RELAY_IP` adresine
yönlendirilmelidir. VPS güvenlik grubu ve işletim sistemi firewall'u da aynı
kuralları açmalıdır.

## Yapılandırma

Kök dizinde `.env.example` dosyasını `.env` olarak kopyalayın. En az aşağıdaki
değerleri gerçek ortamla değiştirin:

```dotenv
TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
TURN_SHARED_SECRET_FILE_HOST=./secrets/turn-shared-secret.key
COTURN_SHARED_SECRET_FILE_HOST=../../secrets/turn-shared-secret.key
TURN_REALM=turn.example.com
TURN_EXTERNAL_IP=<public-ip-veya-auto>
TURN_RELAY_IP=<pi-lan-ip-veya-vps-interface-ip>
TURN_MIN_PORT=49160
TURN_MAX_PORT=49200
TURN_CREDENTIAL_TTL_SECONDS=3600
```

Linux üzerinde örnek secret üretimi:

```bash
install -d -m 0700 ./secrets
(umask 077 && openssl rand -base64 48 > ./secrets/turn-shared-secret.key)
sudo chown 1000:1000 ./secrets/turn-shared-secret.key
chmod 0400 ./secrets/turn-shared-secret.key
```

İki path değişkeni farklı Compose proje dizinlerine göre aynı host dosyasını
gösterir. Özel bir yerleşimde ikisini de aynı dosyaya işaret eden mutlak path
olarak ayarlayın. Secret signaling ve coturn tarafından ortak kullanılır; container
environment'ına veya istemci paketine gömülmez. Eksik, gevşek izinli, sembolik,
4096 bayttan büyük ya da geçersiz karakterli dosya fail-closed reddedilir.
Coturn hem `lt-cred-mech` hem `use-auth-secret` ile başlar; böylece ortak sırdan
üretilmemiş kullanıcı/parola çiftleri anonim allocation açamaz.
Entrypoint, ürettiği geçici yapılandırmayı `-c` ile yükler; coturn'un
configuration dosyasını yok sayan `-n` seçeneği kullanılmaz.
Secret komut satırına yazılmaz; coturn yapılandırması oluşturulduktan sonra shell
environment ve değişkeninden kaldırılır. Container içindeki geçici config `0600`
izinli tmpfs üzerinde kalır.

Production coturn entrypoint'i hosttan runtime bind mount edilmez. Pinned resmi
coturn base'i kullanan `infra/coturn/Dockerfile`, yalnız Dockerfile ve entrypoint'i
içeren dar context'ten final image üretir. Container kapısı bu final image'ı
SBOM/vulnerability taramasından geçirir ve deployment manifestindeki exact local
image ID ile başlatır.

Signaling güvenlik audit'i için TURN secret'tan ayrı bir HMAC anahtar dosyası da
zorunludur. Üretim ve izin ayrıntıları `docs/SECURITY_AUDIT.md` dosyasındadır.
Production coturn ham bağlantı IP'si veya kısa ömürlü TURN kullanıcı adını Docker
stdout'una taşımamak için log çıktısını varsayılan olarak kapatır; izole test
modunda alınan tanılar ortak redaction katmanından geçirilir.

`TURN_EXTERNAL_IP=auto`, resmi coturn imajının DNS tabanlı public IPv4 keşfini
kullanır. `TURN_RELAY_IP`, Pi'nin sabit LAN adresi veya VPS'in coturn'un
dinleyeceği interface adresidir.

## Başlatma

Production signaling/web ve coturn aynı container audit manifestini tüketen tek
fail-closed komutla başlatılır:

```bash
npm run security:containers
npm run security:container:deploy
```

İkinci komut hedef platformun taze manifest/report hash'lerini, application ve
coturn local image ID'lerini doğrular; her iki Compose health kapısını ayrı ayrı
en fazla 120 saniye bekler. `docker-compose.yml` ve `infra/coturn/compose.yml`
doğrulama etiketi olmadan doğrudan başlamaz. Komut hata verirse mevcut
container'ları otomatik durdurmaz; sorun giderildikten sonra aynı komut yeniden
çalıştırılmalı ve iki servis de healthy görülmelidir.

Container host networking kullanır; bu tercih Raspberry Pi/Linux üzerinde UDP
relay port aralığının bire bir korunmasını sağlar. Coturn, signaling ile aynı
sabit UID/GID `1000:1000` altında ve capability olmadan çalışır; kullandığı 3478
ve relay portları ayrıcalıklı port aralığında değildir. CLI kapalıdır ve
private/loopback peer hedefleri üretimde reddedilir.

Signaling imajı sabit UID/GID `1000:1000` ile çalışır. Compose file-secret
izinlerinin engine tarafından taşınmasına güvenilmez; host key UID 1000 ve `0400`
olarak ayrıca doğrulanmalıdır. Rootless/user-namespace kurulumları hem key okuma
hem kalıcı audit volume yazma smoke testi geçmeden desteklenmiş sayılmaz.

## Yerel relay doğrulaması

Docker çalışan geliştirme makinesinde:

```powershell
npm run turn:probe
```

Probe her çalışmada rastgele bir ortak sır üretir, signaling'in gerçek
`createIceConfiguration` fonksiyonuyla 10 dakikalık credential oluşturur ve iki
coturn allocation arasında altı mesaj taşır. Başarı çıktısı `6/6` olmalıdır.
Test container'ları ve geçici ağ işlem sonunda kaldırılır.

Gecikme, jitter, paket kaybı ve bant kısıtı altında UDP/TCP relay doğrulaması:

```powershell
npm run turn:network-probe
```

Bu probe coturn network namespace'ine geçici olarak 80±20 ms gecikme, `%2`
paket kaybı ve 4 Mbit/s sınır uygular. Kısa ömürlü signaling HMAC credential ile
hem UDP hem TCP relay teslimatını ölçer ve bütün geçici container/volume'ları
sonunda kaldırır.

Bu probe coturn ve HMAC hattını doğrular; public firewall, NAT yönlendirmesi ve
gerçek tarayıcı/native uygulama relay testinin yerine geçmez.

## Zorlanmış native relay simülasyonu

Windows native H.264 taşımasını doğrudan ve `srflx` adaylar olmadan, yalnızca
TURN relay adaylarıyla doğrulamak için:

```powershell
npm run native:turn-simulation
```

Komut acceptance coturn'unu geçici olarak LAN adresinde ve Windows dinamik port
rezervasyonlarının dışında kalan küçük bir relay aralığında yayınlar. Signaling
koduyla 10 dakikalık HMAC credential üretir; iki native WebRTC eşinde
`relay-only` uygular ve DTLS-SRTP H.264 RTP teslimini önce UDP, sonra TCP TURN
üzerinden sınar. Test her iki uçta yalnızca `typ relay` adayları bulunduğunu da
doğrular. Credential çıktıya yazılmaz; geçici container, ağ ve volume işlem
sonunda kaldırılır.

LAN adresi otomatik seçilemiyorsa `TURN_SIMULATION_HOST` ile verilebilir. Port
çakışmasında `TURN_SIMULATION_MIN_PORT` ve `TURN_SIMULATION_MAX_PORT`
değiştirilebilir. Bu simülasyon native medya fallback'ini doğrular. Public
firewall/NAT, browser DataChannel/UI ve mobil veri kabulü ayrıca 2026-08-13
tarihinde fiziksel WAN oturumunda doğrulanmıştır.

## İki sanal NAT browser simülasyonu

Gerçek host/guest Chrome arayüzünü iki ayrı özel ağ ve NAT router arkasında,
direct adayları kapatılmış biçimde çalıştırmak için:

```powershell
npm run browser:turn-simulation
```

Komut gerekli Chrome test imajını üretir; iki özel ağ, iki NAT router ve yalnızca
container içinde yönlendirilen sentetik public TURN omurgasını kurar. Bağlantı
kodu, açık host onayı, UI'da `TURN relay`, iki DataChannel, sahte 1920×1080 ekran
akışı ve beş saniyelik guest ağ kesintisi sonrası ilerleyen video kontrol edilir.
Local ve remote ICE tanılarında yalnızca `relay` adayı kabul edilir; browser
warning/error kayıtları testi düşürür. Bütün geçici container ve ağlar işlem
sonunda kaldırılır.

Güvenlik kanıtı iki parçadır: üretim coturn entrypoint'i ile signaling HMAC
credential önce resmi coturn istemcisiyle doğrulanır. Chrome medya ayağı ise
yalnızca kapalı test omurgasında `no-auth` coturn ile çalışır. Bu nedenle komut
browser UI/medya/DataChannel ve iki NAT taşımasını kanıtlar. Public self-hosted
coturn credential, firewall ve mobil veri kabulü ayrıca fiziksel WAN direct ve
zorlanmış relay oturumlarıyla tamamlanmıştır.

## Public TURN preflight

Public Pi/VPS hazır olduğunda signaling ile aynı `.env` kullanılarak UDP ve TCP
listener, kısa ömürlü HMAC credential ve gerçek relay teslimatı tek komutla
doğrulanabilir:

```powershell
npm run turn:public-preflight
```

Komut `TURN_URLS`, `TURN_SHARED_SECRET` ve
`TURN_CREDENTIAL_TTL_SECONDS` değerlerini signaling kodunun gerçek
`loadIceServiceOptions`/`createIceConfiguration` hattından geçirir. Her
`turn:` URL için resmi coturn imajındaki `turnutils_uclient` ile ayrı allocation
ve relay testi çalıştırır. Secret veya üretilen credential çıktıya yazılmaz.

İsteğe bağlı test ayarları:

```dotenv
# DNS hedefinden farklı bir adrese bağlanmak için:
TURN_PREFLIGHT_HOST=host.docker.internal

# Her taşıma için tur sayısı; 1-50, varsayılan 3:
TURN_PREFLIGHT_MESSAGE_ROUNDS=3

# Kabul edilen en düşük teslim yüzdesi; 1-100, varsayılan 95:
TURN_PREFLIGHT_MIN_DELIVERY_PERCENT=95
```

Parser ve sınır testleri:

```powershell
npm run turn:public-preflight:test
```

2026-07-23 yerel dry-run sırasında LAN'a yayınlanan acceptance coturn'u,
signaling tarafından üretilen credential ile UDP 6/6 ve TCP 6/6 relay verdi.
2026-08-13 tarihinde aynı doğrulama public Pi coturn üzerinde UDP 6/6 ve TCP 6/6
geçti; ardından mobil veri tarayıcısıyla zorlanmış fiziksel WAN relay oturumunda
arayüzde `TURN relay` doğrulandı.

## Üretim doğrulama sırası

1. Coturn container `healthy` olmalı.
2. `npm run turn:public-preflight` UDP ve TCP için geçmeli.
3. Dış ağdan UDP 3478, TCP 3478 ve relay UDP aralığı erişilebilir olmalı.
4. Signaling onay mesajı `turn:` URL'lerini ve kısa ömürlü credential'ı taşımalı.
5. İki farklı internet bağlantısındaki gerçek uygulama oturumu kurulmalı.
6. Direct yol engellenerek arayüzde `TURN relay` görülmeli.
7. Coturn loglarında ortak secret, SDP veya ekran içeriği bulunmamalı.

Bu üretim doğrulama sırasının yedi maddesi de 2026-08-13 tarihinde geçti. Relay
testinden sonra web paketi normal P2P öncelikli `all` politikasına geri alındı.

Kullanılan imaj ve seçenekler coturn'un resmi kaynaklarına dayanır:

- https://github.com/coturn/coturn
- https://github.com/coturn/coturn/blob/master/docker/coturn/README.md
- https://github.com/coturn/coturn/blob/master/README.turnserver

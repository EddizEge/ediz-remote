# Ediz Remote sinyalleşme protokolü — belge v0.6 / wire v3

Taşıma katmanı `wss://<host>/ws` üzerinden JSON mesajlarıdır. Sunucu yalnızca
oturum eşleştirme ve ileride WebRTC için kullanılacak SDP/ICE sinyallerini taşır;
ekran veya kontrol verisi sinyalleşme sunucusundan geçmez.

## Bağlantı ve sürüm el sıkışması

İstemci WebSocket yükseltmesinde zorunlu `ediz-remote.v3` alt protokolünü
`Sec-WebSocket-Protocol` başlığıyla teklif eder. Sunucu desteklenen alt protokol
yoksa HTTP `426`, geçerli bir tarayıcı `Origin` değeri yoksa veya origin izinli
değilse HTTP `403` ile yükseltmeyi WebSocket kurulmadan reddeder. İzinli origin:

- request `Host` değeriyle aynı host/port üzerindeki HTTP(S) origin'i veya
- `SIGNALING_ALLOWED_ORIGINS` allowlist'indeki açık origin'dir.

Windows WebView2 kabuğu `https://app.ediz-remote.local` origin'ini kullanır ve bu
değer varsayılan ek allowlist'tedir. Origin kontrolü tarayıcı kötüye kullanımına
karşı bir giriş sınırıdır; bağlantı kodu, host onayı veya reconnect token yerine
geçmez.

Başarılı yükseltmeden sonra ilk sunucu mesajı şöyledir:

```json
{
  "type": "ready",
  "clientId": "00000000-0000-4000-8000-000000000000",
  "protocolVersion": 3,
  "minimumProtocolVersion": 3
}
```

Wire sürümü npm, masaüstü assembly veya ürün sürümünden bağımsızdır. Sunucu bu
sürümde yalnız v3'ü ve minimum v3'ü kabul eder; desteklenmeyen/eksik alt protokol
legacy moda düşmez. Bütün v3 wire nesneleri strict doğrulanır. V3, her SDP/ICE
sinyaline zorunlu negotiation kimliği, `native-video` zarfına version 2 ve bütün
oturum içi session mesajlarına version 2 + sıra alanı eklediği için v2'den bilinçli
bir wire kırılımıdır. V2 daha önce kaynak reddini create/join/resume/refresh/signal
işlemlerine bağlayan strict `operation` ve bounded `retryAfterSeconds` sözleşmesini
eklemişti. Yeni alan veya davranış aynı sürüm altında sessizce eklenmez; uyumsuz
değişiklik yeni alt protokol sürümü ve açık minimum sürüm kararı gerektirir.

## Güvenlik kuralları

- Strict doğrulama yalnız kök nesneyle sınırlı değildir. İstemci, sunucu ve
  control mesajları ile tek başına kullanılan peer, native-video, signaling payload
  ve ICE şemaları her derinlikte kendi `__proto__` anahtarını ve eşlenmemiş UTF-16
  surrogate içeren anahtar/metni reddeder. Meşru mesajların çok üzerindeki 2048 kap
  bütçesini aşan yapı da reddedilir; tarama yinelemelidir ve derin JSON yığın
  taşırmaz. Zod strict nesnesi iç içe `__proto__` anahtarını kendiliğinden hata
  vermeden attığı için bu ön tarama zorunludur.
- Bağlantı kodları kriptografik rastgelelik kaynağından üretilen 6 hanedir.
- Kullanılmamış kod 10 dakika sonra geçersiz olur. Kod süresi mesaj anında
  (`join_session`, `request_decision`) denetlenir ve yalnız onaysız oturuma uygulanır.
- Bir kod, onaylanmış ilk bağlantıdan sonra tekrar kullanılamaz. Kod bilgisi onaylı
  oturumu ya da host'u grace içinde askıdaki oturumu sonlandıramaz; böyle bir
  `join_session` oturumu etkilemeden `invalid_code` alır.
- Host açıkça izin vermeden iki cihaz arasında sinyal iletilmez.
- Varsayılan hard tavan global 256/IP başına 16 açık WebSocket ve global 96/
  creator IP başına 4 session'dır. Session tavanı 192 aktif eş üzerinde reconnect
  takeover için 64 socket headroom bırakır.
- Create/join/resume/bozuk mesaj için global+IP; inbound frame için global+socket;
  onaylı signal/ICE için global+kalıcı session-member token bucket uygulanır.
  Join başlangıç burst'ü IP başına 8'dir. Reconnect yeni socket açsa da member
  signal/ICE borcu sıfırlanmaz.
- IP subject store 4096 kayıt ve 15 dakika idle TTL ile bounded'dır. TTL tam
  refill ufkundan kısa olamaz; store dolduğunda yeni subject fail-closed kalır.
- Tek bir WebSocket mesajı en fazla 128 KiB olabilir. Ham SDP 60 KiB ile ayrıca
  sınırlıdır; SDP'de JSON kaçışını aşırı büyüten kontrol karakterleri reddedilir.
- WebSocket uygulama mesajları yalnız metin JSON olabilir; binary frame reddedilir.
- `CF-Connecting-IP` yalnız `TRUST_CLOUDFLARE_CONNECTING_IP=true` açıkça
  yapılandırıldığında kullanılır. Varsayılan davranış doğrudan soket adresidir;
  böylece istemci başlık taklidiyle IP kotasını aşamaz. Bu güven yalnız servis
  public porta doğrudan açılmadığında etkinleştirilmelidir.
- TURN ortak sırrı yalnızca signaling/coturn üzerinde tutulur ve istemciye
  verilmez. Kimlik bilgileri yalnızca host onayından sonra, istemciye özel ve
  kısa ömürlü olarak üretilir.
- Reconnect token bağlantı kodundan ve istemci kimliğinden ayrıdır; sunucu yalnızca
  SHA-256 özetini tutar. Token başarılı resume sonrasında döndürülür ve eski token
  replay'i reddedilir.
- Signaling sunucusu WebSocket ping/pong watchdog kullanır. İki ardışık heartbeat
  aralığında yanıt vermeyen soket sonlandırılır; sessiz TCP/WSS kopuşu onaylı
  oturumun grace period'unu belirsiz süre geciktiremez.
- İstemci bütün sunucu mesajlarını çalışma anında ortak Zod şemasıyla doğrular.
  Bozuk JSON, bilinmeyen tür, sınır dışı alan veya geçersiz ICE yapılandırması
  aktif görüntü/kontrol eşlerini fail-closed kapatır; unsafe soket protokol
  hatasıyla sonlandırılır ve yalnız açık `Yeniden bağlan` eylemiyle kurulur.
- Her WebSocket callback'i oluşturulduğu soket nesnesiyle bağlıdır. Yeni bağlantı
  veya ağ dönüşü devralması başladığında yalnız `socketRef.current` ile aynı olan
  aktif neslin `open/message/error/close` callback'leri durum değiştirebilir;
  önceki soket nesli kapanışı, mesajı veya reconnect zamanlayıcısı yeni nesli
  etkileyemez. Bu nesil guard'ı wire payload'ına güvenmez.
- Şemadan geçen sunucu mesajı ayrıca mevcut oturum fazı
  (`idle/waiting/joining/active/recovering`) ve rolle eşleşmelidir. Geç kalmış
  `session_created`/`join_pending`, onay, peer veya `signal` mesajı etkisiz
  bırakılır. İstemci açık kod oluşturma/katılım eylemini tek bir bekleyen istekle
  ilişkilendirir ve aynı eylemin yinelenmesini birleştirir; retry edilebilir hata
  strict `operation` alanıyla yalnız kendi create/join/resume/active fazında
  uygulanır. Create limiti pending latch'i temizler; resume limiti belirtilen
  bekleme sonunda fresh socket ile yeniden denenir. Guest answer sinyali
  sınırlandığında fresh-socket resume iki eşi de yeniden kurdurur; host signal/ICE
  limiti kontrollü ICE yenilemesi başlatır. Aktif onay düşürülmez. `request_rejected`,
  `session_ended` veya fail-closed terminal sonuçtan sonra istemci terminal
  latch'i oturum mesajlarını engeller; yalnız taşıma `ready/pong` mesajları yeni
  yetki oluşturamaz. Latch ancak açık yeni kod/katılım/yeniden bağlanma eylemiyle
  temizlenir.
- `not_authorized`, `invalid_message` ve süresi geçmiş resume erişim/onay
  durumunu temizler. `peer_unavailable` aynı onayı korusa da P2P eşlerini
  durdurup güvenli resume ister. Sunucunun serbest biçimli hata metni DOM'a,
  peer'e veya kullanıcı mesajına taşınmaz; yalnız allowlist hata kodu kullanılır.

## İstemciden sunucuya

- `create_session`: Yeni bir tek kullanımlık kod oluşturur.
- `join_session { code }`: Koda katılma isteği gönderir.
- `request_decision { requestId, approved, accessMode? }`: Host isteği onaylar
  veya reddeder. Onayda `accessMode`, `view` ya da `control` olarak zorunludur;
  red kararında alan bulunamaz.
- `resume_session { token }`: Kesilmiş onaylı üyeliği grace period içinde kurtarır.
- `refresh_ice`: Yalnızca aktif ve onaylı üye için yeni kısa ömürlü ICE/TURN
  yapılandırması ister.
- `{ type: "revoke_control", channel: "control", version: 1 }`: Yalnızca o
  anda aktif host kontrol erişimini kalıcı olarak görüntüleme moduna düşürür.
- `signal { payload }`: Onaylı eşler arasında strict ve bounded WebRTC SDP/ICE
  taşır. Payload yalnız `session-description` veya `ice-candidate`; ayrıca sürümlü
  `native-video` zarfı olabilir. SDP UTF-8 byte hesabıyla en fazla 60 KiB,
  candidate 4096 karakterdir. SDP offer yalnız host, answer yalnız guest rolünden
  kabul edilir; ICE candidate iki yönde de geçerlidir. Her sinyal zorunlu UUID
  `negotiationId` taşır. Host offer ile yeni kimliği açar; yalnız o kimliğe ait tek
  guest answer ve iki yönlü candidate'lar aktarılır. Eski, bilinmeyen veya tekrar
  kullanılan kimlikler eşe gönderilmez.
- `leave_session`: Mevcut oturumdan çıkar.
- `ping`: Bağlantı canlılık kontrolü.

## Sunucudan istemciye

- `ready`, `session_created`, `join_pending`, `incoming_request`; `ready` seçilen
  ve minimum wire sürümünü taşır.
- `session_approved`, `peer_joined`, `request_rejected`; onay mesajları seçilen
  `accessMode`, sürümlü `iceConfiguration`, role özel `resumeToken` ve
  `reconnectGraceSeconds` değerlerini iki uca da taşır.
- `session_resumed`, `peer_suspended`, `peer_resumed`, `ice_configuration`
- `peer_left`, `session_ended`, `signal`, `pong`, `error`

Kaynak reddi genel metin yerine işleme bağlı strict metadata taşır:

```json
{
  "type": "error",
  "code": "rate_limited",
  "message": "...",
  "operation": "refresh_ice",
  "retryAfterSeconds": 15
}
```

`rate_limited` için `operation`, `create_session`, `join_session`,
`resume_session`, `refresh_ice` veya `signal`; `retryAfterSeconds` 1–300
aralığındadır ve iki alan da zorunludur. Hard session kotası `capacity_exceeded`,
`operation: "create_session"` ve bounded retry ile ayrılır. Diğer error kodlarında
bu metadata alanları yasaktır. İstemci serbest biçimli `message` değerini
kullanıcıya göstermez. Bare ve `native-video` için ayrı tutulan görülmüş
negotiation kimliği kümesi lane başına 256 ile sınırlıdır. Bu güvenlik tavanı
dolduğunda sunucu ID/payload içermeyen `negotiation_exhausted` hatası gönderir;
istemci eski onayı fail-closed kapatıp yeni bağlantı kodu ister.

Mesajların güncel tipleri ve doğrulama şeması
`packages/protocol/src/index.ts` dosyasındadır.

## ICE sunucuları ve kısa ömürlü TURN credential

Onay mesajındaki yapılandırma biçimi:

```json
{
  "version": 1,
  "expiresAt": "2026-07-23T12:10:00.000Z",
  "iceServers": [
    { "urls": ["stun:stun.example.com:3478"] },
    {
      "urls": ["turn:turn.example.com:3478?transport=udp"],
      "username": "1784808600:istemci-kimliği",
      "credential": "<base64-hmac>"
    }
  ]
}
```

Coturn REST modeli kullanılır: kullanıcı adının ilk alanı Unix sona erme
zamanıdır; credential `HMAC-SHA1(TURN_SHARED_SECRET, username)` sonucunun Base64
karşılığıdır. Host ve guest için ayrı değer üretilir. Varsayılan ömür 3600
saniyedir ve 60–86400 arasında yapılandırılabilir. TURN yoksa `expiresAt: null`
olur ve liste yalnızca STUN içerebilir.

İstemci listeyi yalnızca şema doğrulaması başarılıysa kullanır. Tarayıcıdaki genel
eş ile native H.264 eşi aynı yapılandırmayı alır. URL, liste, kullanıcı adı ve
credential uzunlukları hem TypeScript sınırında hem WebView2/native sınırında
kısıtlıdır. Ortak sır, SDP, ICE candidate veya uygulama loglarına yazılmaz.

## Onaylı oturum kurtarma ve ICE yenileme

Onaylı host ve guest için ayrı 256 bit reconnect token üretilir. Token yalnızca
istemci belleğinde tutulur; bağlantı kodunun yerine geçmez ve onaysız oturum
oluşturmaz. WebSocket beklenmedik biçimde kapanırsa karşı tarafın görüntü, kontrol
ve native stream eşleri hemen kapatılır; signaling oturumu varsayılan 30 saniye
askıda tutulur.

İstemci yeni ve henüz hiçbir role/session'a bağlanmamış socket üzerinden
`resume_session` gönderir. Sunucu token özetini bounded O(1) indeksten bulur,
rolü, askıda üyeyi ve süreyi doğrular; üyeliği aynı sabit peer kimliğiyle geri
yükler, token'ı döndürür ve iki uca yeni ICE yapılandırması verir. İki taraf aynı
anda kesilirse süre ilk kesintide başlar ve ikisi de dönene kadar devam eder.
Süre dolarsa `session_ended { reason: "reconnect_timeout" }` gönderilir; eski
token tekrar kullanılamaz.

Mobil tarayıcı ağın geri geldiğini bildirdiğinde, eski WSS yerel olarak hâlâ
`OPEN` görünse bile mevcut reconnect token ile yeni soket açar. Token geçerliyse
sunucu aynı role ait eski soketi sonlandırır, token'ı döndürür ve peer'e yeni ICE
yapılandırması gönderir. Bu devralma yalnızca aktif onaylı üyeliğin güncel 256 bit
token'ıyla mümkündür; döndürülen eski token tekrar kullanılamaz.

WebRTC `failed` olduğunda veya `disconnected` durumu kısa beklemeyi aştığında
istemci en fazla üç kez exponential backoff ile `refresh_ice` ister. Güncel
credential geldiğinde eş bağlantıları kontrollü biçimde yeniden oluşturulur.
Sunucu aktif/onaylı üyelik olmadan bu isteği kabul etmez.

`peer_unavailable` aynı onaylı üyeliğin `accessMode` değerini değiştirmez;
istemci yalnız P2P kaynaklarını durdurup recovery'ye geçer. Kontrol daha önce
`revoke_control` ile geri alındıysa tarayıcıdaki revoke latch'i `view` durumunu
korur ve resume hiçbir zaman bu yerel geri almayı kendiliğinden açamaz.

### Negotiation kimliği ve bounded ICE kuyrukları

Genel peer ve `native-video` hatları birbirinden bağımsız negotiation lane'leridir.
Her lane için sunucu güncel kimliği, answer durumunu ve daha önce açılmış en fazla
256 kimliği session üzerinde tutar; reconnect veya aktif-socket takeover bu durumu
sıfırlamaz. Host'un yeni ve daha önce görülmemiş UUID ile gönderdiği offer güncel
negotiation'ı değiştirir. Guest yalnız güncel kimliğe bir kez answer verebilir;
candidate yalnız güncel kimlikte iki yönde aktarılır. A→B→A offer replay'i, eski
answer ve eski candidate sessizce düşürülür. Karşı eş askıdaysa kimlik state'i
değiştirilmeden `peer_unavailable` döner; aynı offer eş geri geldikten sonra hâlâ
geçerlidir.

Tarayıcı genel peer'i, tarayıcı native-video alıcısı ve WPF native göndericisi,
remote description hazır olmadan gelen ICE adaylarını negotiation kimliğine bağlı
olarak en fazla 64 aday ve toplam 64 KiB bellekte tutar. Yerel adaylar da SDP
offer/answer signaling'e yayınlanmadan önce aynı sınırda bekletilir; böylece aday
SDP'den önce gönderilmez. Tarayıcı her yerel offer/answer SDP'sinden en fazla 16
strict `ice-ufrag` değeri çıkarıp aday callback'ini bu nesle bağlar; adayın açık
veya candidate-line ufrag'i güncel nesille eşleşmiyorsa geç callback yeni
`negotiationId` ile yeniden etiketlenmeden düşürülür. Lane başına erken signaling
kuyruğu en fazla 64 mesaj ve 128 KiB'dır. Kimlik uyuşmazlığı etkisizdir; herhangi
bir ICE/erken-sinyal kuyruğu taşması o peer'i, ilgili DataChannel'ları ve native
kontrolü kapatan görünür fail-closed bağlantı hatasıdır. Fatal protokol kilidi aynı
onaylı oturumun `active`↔`recovering` geçişinde korunur; yalnız terminal/yeni
oturum sınırında veya açık kullanıcı retry'ında sıfırlanır.

## WebRTC veri kanalı

Host onaydan sonra iki DataChannel oluşturur ve SDP offer'ı `signal` mesajıyla
gönderir. Guest answer üretir; sunucu ters yönü `not_authorized` ile reddeder ve
peer'e taşımaz. İki taraf ICE candidate'larını aynı sinyal kanalı
üzerinden değiştirir:

- `ediz-remote-control`: sıralı ve güvenilir; ping/pong, ekran durumu, yetki,
  bütün `session` v2 mesajları, uzak imleç, pointer butonu/tekerlek ve klavye
  olaylarını taşır.
- `ediz-remote-pointer`: unordered, `maxRetransmits: 0`; yalnızca birleştirilmiş
  `pointer.move` olaylarını düşük gecikmeyle taşır. Kanal açılamazsa güvenilir
  kanala düşülür.

Host yalnız bu iki canonical kanalı oluşturur. Guest yalnız ilk doğru label ve
beklenen transport özelliklerine sahip kanalı kabul eder; duplicate, bilinmeyen,
yanlış `ordered` veya retransmit ayarlı kanal kapanır. Host remote-created bütün
kanalları reddeder. Inbound mesaj matrisi şöyledir:

| Kanal | Alıcı | İzin verilen mesaj |
|---|---|---|
| reliable | Her iki rol | Bounded `ping`; yalnız bekleyen ID ile eşleşen `pong` |
| reliable | Guest | Host'tan `screen-share-state`, `control.granted/revoked`, `display.list`, `quality.state`, `media.state`, `cursor.state` |
| reliable | Host | Guest'ten `display.select`, `quality.select`; yalnız kontrol izninde button/wheel/keyboard ve pointer-kanal kapalıysa `pointer.move` fallback |
| pointer | Host | Yalnız kontrol izninde `control.event(pointer.move)` |

`control.request`, pointer kanalındaki diğer mesajlar ve ters rol/yönler etkisizdir.
Oturum içi state/selection mesajları tam olarak şu v2 zarfını kullanır:

```json
{
  "channel": "session",
  "version": 2,
  "type": "screen-share-state",
  "sequence": 0,
  "active": true
}
```

Ping/pong session zarfından ayrıdır:

- `ping { id, sentAt }`
- `pong { id, sentAt }`

Kontrol yetkisi ve olayları aynı güvenilir/sıralı kanal üzerinde ayrı, sürümlü
bir zarfla taşınır:

```json
{
  "channel": "control",
  "version": 1,
  "type": "control.granted",
  "capabilities": ["pointer", "keyboard"]
}
```

Desteklenen türler:

- `control.request`: Şemada rezervlidir; mevcut ürün onayı signaling üzerinden
  verildiği için DataChannel matrisi bu mesajı kabul etmez.
- `control.granted`: Host açık onay sonrası yetkiyi bildirir.
- `control.revoked`: Host yetkiyi geri alır veya oturum kapanır.
- `control.event`: Artan `sequence` ile pointer/klavye olayı taşır.

`control.event` koordinatları 0–1 aralığında normalize edilir. Pointer buton
olayları kendi `x`/`y` konumunu da taşır; böylece güvenilir kanal, tıklama ve
sürüklemenin başlangıç/bitiş konumunu unordered hareket kanalından bağımsız
uygular. Buton, tekerlek, tuş kodu, konum ve basma/bırakma alanları şemada
sınırlandırılır.

Pointer hareketleri ve güvenilir kontrol olayları ayrı artan `sequence` alanları
kullanır. Bütün session v2 mesajları da yön başına tek ortak artan sıra kullanır.
Alıcı her sıra alanında eski/replay mesajları reddeder; oran reddi watermark'ı
ilerletmez. Tek DataChannel JSON mesajı UTF-8 hesabıyla 4 KiB ile sınırlıdır;
guest pointer hareketlerini animasyon karesi başına birleştirir. Parse öncesi
kanal mesaj kotaları malformed/binary flood'u sınırlar. Web host ve native Windows
pointer/güvenilir input hatlarına ayrı kota uygular; herhangi bir kontrol veya
kanal kota ihlali input'u kapatıp basılı girişleri bırakan fail-closed sonuçtur.
Windows input watermark'ı yalnız seçili monitöre doğrulanmış olay gerçekten
uygulandığında ilerler; başarısız enjeksiyon, geçersiz ekran ve kota reddi meşru
sonraki sırayı zehirlemez. Secure Attention Sequence girişimi kontrol oturumunu
anında kapatıp bütün basılı girdileri bırakır. Kontrol açıkken pencere kapatma
eylemi uygulamayı görünmez biçimde tepsiye gönderemez.

`control.event` yalnızca host rolündeki, aktif ve `control.granted` durumundaki eş
tarafından işlenir. Windows masaüstü host mesajı güvenilir WebView2 origin'inden
geldiğini doğrular, zarfı ikinci kez parse eder, native oturum kimliğini ve sıra
alanını kontrol eder; ardından `SendInput` katmanına aktarır. Yetki iptali,
reliable kanal close/error, WebRTC `disconnected/failed`, pencere odağı kaybı,
WebView navigation/process hatası ve acil durdurma basılı tuş/butonları bırakır.
Reliable kanal yokken pointer kanalı tek başına input uygulayamaz. Bağlantı yeniden
`connected` olduğunda native kontrol ancak aynı canonical reliable kanal açık ve
signaling erişimi hâlâ `control` ise etkinleşir. `Ctrl+Alt+Del` reddedilir; UAC
secure desktop veya Windows güvenlik sınırlarını aşan bir yol yoktur.

Web→WPF kontrol köprüsü de ayrı bir strict zarf kullanır. Hem
`desktop.control.set-enabled` hem `desktop.control.event` tam olarak
`channel: "control"`, `version: 1` ve UUID biçiminde `sessionId` taşır; eksik,
fazladan veya yanlış sürümlü alan native giriş yetkisini fail-closed kapatır.
`desktop.control.event.payload` ayrıca yukarıdaki strict `control.event` şemasına
ikinci kez doğrulanır. WPF köprü ayrıştırıcıları yinelenen anahtarı, eşlenmemiş
surrogate içeren adı veya metni ve okunamayan JSON metnini `Try*` sözleşmesini
istisnayla delmeden reddeder; tarayıcının DataChannel oturum ayrıştırıcısı da uzak
eşten gelen kimlik ve etiketlerde aynı metin kuralını uygular.

### Signaling üzerinden kalıcı kontrol geri alma

Host'un signaling oturumundaki kontrol erişimini geri alma mesajı tam olarak şu
sürümlü ve strict zarfı kullanır:

```json
{
  "type": "revoke_control",
  "channel": "control",
  "version": 1
}
```

Ek alan, farklı kanal/sürüm veya bozuk payload `invalid_message` ile reddedilir.
Mesajı yalnız aktif oturumun güncel host soketi gönderebilir; guest, onay öncesi
host veya eski soket `not_authorized` alır. Sunucu `accessMode: "control"`
durumunu `view` olarak düşürür; zaten `view` olan oturumdaki tekrar idempotenttir
ve canlı signaling'i kesmez. Sonraki `resume_session` sonucu da `view` döndürür.

Tarayıcı host mesajı göndermeden önce yerel erişimi `view` yapar ve oturum için
revoke latch'ini kurar. Geçici taşıma kaybından sonra sunucu beklenmedik biçimde
`control` döndürürse web istemcisi kontrolü yeniden açmaz; latch'i koruyup aynı
strict mesajı yeniden yollar. Latch yalnız açık yeni oturum denemesinde temizlenir.
Bu signaling mesajı DataChannel'daki `control.revoked` bildiriminin yanı sıra
yetki durumunu sunucuda da kalıcılaştırır; mevcut input bırakma yolu ikisinde de
hemen çalışır.

Windows WPF kabuğu yerel virtual-host `index.html` navigasyonunu yalnız kendi
`Initialize`/`Yeniden dene` `Navigate` çağrısından hemen önce kurduğu tek
kullanımlık expected-navigation latch'iyle kabul eder; `NavigationStarting` bu
izni tüketir. Aynı güvenilir origin'e F5, Ctrl+R, programatik reload veya başka
beklenmeyen top-level navigasyon da iptal edilir, input hemen bırakılır ve native
video/oturum kaynakları deterministik fail-closed kapanışa girer. Browser reload
accelerator'ları ayrıca WebView2 ayarında kapalıdır.

Native→WebView durum mesajları yalnız sabit `errorCode` değerleri taşır:
`initialization_failed`, `navigation_failed`, `capture_failed`,
`encoder_failed`, `gpu_input_failed`, `control_input_failed`,
`display_switch_failed`, `quality_switch_failed` ve `native_video_failed`.
Exception metni, recovery reason, dosya/sürücü yolu, ICE/SDP veya credential
köprü payload'ına yazılmaz. Web sınırı kodu yeniden allowlist ile doğrular ve
yalnız sabit Türkçe kullanıcı metnine dönüştürür.

Round-trip gecikmesi ping'i başlatan istemcinin kendi saatiyle ölçülür. Seçilen
ICE candidate pair istatistiklerinde `relay` adayı yoksa arayüz bağlantıyı
"Doğrudan P2P", varsa "TURN relay" olarak gösterir.

### Oturum içi monitör seçimi

Windows native host, aktif güvenilir DataChannel açıldığında bounded monitör
listesini sürümlü bir oturum zarfıyla guest'e yollar:

```json
{
  "channel": "session",
  "version": 2,
  "type": "display.list",
  "sequence": 12,
  "displays": [
    { "id": "display-id", "label": "Ekran 1", "width": 1920, "height": 1080 }
  ],
  "selectedDisplayId": "display-id"
}
```

Guest yalnızca bu listede bulunan bir kimliği `display.select` ile isteyebilir.
Host rol, mesaj sürümü, 4 KiB kanal sınırı, en fazla 16 ekran, kimlik/etiket
uzunlukları ve 1–16384 piksel boyutlarını doğrular. WebView2/native sınırı ekran
kimliğini o anda DXGI tarafından listelenen çıkışlarla tekrar eşleştirir; bilinmeyen
veya artık bağlı olmayan ekran reddedilir. Host saniyede en fazla dört seçim
isteğini işler; native köprü eşzamanlı ikinci geçişi yok sayar. Aynı ekranı seçen
eski/replay mesaj ortak session sıra koruması tarafından reddedilir. Seçim yeni
bir yetki oluşturmaz ve mevcut onaylı oturumun dışından uygulanamaz.

Monitör geçişinde native host tutulan girişleri bırakır, seçilen ekranın yakalama
ve kontrol koordinat alanını birlikte değiştirir ve native H.264 eşini yeni offer
ile aynı signaling oturumunda yeniden kurar. Guest yeni offer'a answer vererek
bağlantı kodu/onay akışını tekrarlamadan yayına devam eder.

### Oturum içi kalite profili

Guest operatör kalite tercihini aynı sürümlü oturum kanalında gönderir:

```json
{
  "channel": "session",
  "version": 2,
  "type": "quality.select",
  "sequence": 13,
  "profile": "speed"
}
```

Yalnızca `auto`, `speed` ve `quality` değerleri kabul edilir. Host seçimi
uyguladıktan sonra `quality.state` ile etkin profili iki tarafa da bildirir.
İstekler host rolü ve aktif onaylı DataChannel ile sınırlıdır; saniyede en fazla
dört seçim işlenir. Bilinmeyen profil, yanlış sürüm ve 4 KiB kanal sınırını aşan
mesaj reddedilir. `quality.select` aynı yönün ortak session sıra alanını kullanır;
eski veya replay seçim native kalite geçişine ulaşmaz.

Native Windows host profil değişiminde H.264 oturumunu aynı onaylı signaling
oturumu içinde yeniden kurar. `speed` 3 Mbps/24 FPS, `auto` 8 Mbps/30 FPS,
`quality` 12 Mbps/30 FPS tavanıyla başlar. RTCP receiver report adaptasyonu
seçilen tavanın üzerine çıkamaz. Tarayıcı host fallback'i aynı profilleri bounded
`MediaStreamTrack.applyConstraints` çözünürlük/FPS hedeflerine dönüştürür.

### Oturum içi medya durumu

Host, guest'in donmuş son kare yerine görüntünün hazırlanma, yayın, hata ve durma
durumlarını ayırt edebilmesi için güvenilir DataChannel üzerinde sürümlü bir
oturum mesajı gönderir:

```json
{
  "channel": "session",
  "version": 2,
  "type": "media.state",
  "sequence": 7,
  "state": "starting"
}
```

`state` yalnızca aşağıdaki allowlist değerlerinden biri olabilir:

- `starting`: Native H.264 hattı bağlanıyor veya tarayıcı ekran paylaşımı
  hazırlanıyor.
- `sharing`: Host görüntüyü etkin olarak paylaşıyor.
- `failed`: Görüntü hattı başarısız oldu; guest görünür hata ve güvenli iyileşme
  eylemi gösterir.
- `stopped`: Host görüntü paylaşmıyor veya paylaşım kapatıldı; guest son video
  karesini tutmaz.

Mesaj yalnızca aktif host rolünden gönderilir ve yalnız guest rolü tarafından
durum olarak uygulanır. Ters yöndeki mesaj yeni bir paylaşım, kontrol yetkisi ya
da native işlem başlatamaz. `sequence` oturum içinde artan, negatif olmayan
güvenli tamsayıdır; guest replay/sıra dışı mesajları React state'e ulaşmadan
reddeder. Bütün session v2 türlerinin ortak toplam kotası yön başına saniyede 128
mesajdır; ayrıca seçim türlerinin kendi dar kotaları korunur. Bilinmeyen
sürüm/değer ve 4 KiB kanal sınırını aşan mesaj da reddedilir.

Payload yalnızca allowlist durumunu taşır. Ham exception metni, sürücü veya dosya
yolu, ICE/SDP içeriği, token, credential, yerel URL ya da native hata ayrıntısı
eşe gönderilmez. Host ayrıntıyı yalnız kendi güvenli hata sınıflandırmasında
tutar; guest sabit, kullanıcıya dönük metin ve eylemi `state` değerinden üretir.

### Native uzak imleç durumu

DXGI masaüstü karesi imleci ayrı pointer metadata olarak verirse Windows host
seçili monitör içindeki konumu normalize eder ve güvenilir DataChannel üzerinden
gönderir:

```json
{
  "channel": "session",
  "version": 2,
  "type": "cursor.state",
  "sequence": 42,
  "x": 0.5,
  "y": 0.25,
  "visible": true
}
```

Mesaj yalnızca aktif host rolünden guest'e gider. `sequence` güvenli tamsayı ve
artan sıra olmalıdır; `x`/`y` sonlu 0–1 aralığındadır. Guest eski/replay mesajı,
yanlış sürümü, aralık dışı koordinatı ve ortak session v2 kotasını aşan akışı
fail-closed reddeder. Görüntü izni sürdüğü sürece kontrol yetkisinden bağımsız gösterilir;
oturum veya kanal kapanınca hemen gizlenir. DXGI imleci video karesine zaten
bileşik veriyorsa `visible: false` kalır ve guest ikinci bir imleç çizmez.
`cursor.state` yalnızca sıra, normalize konum ve görünürlük taşır; pointer kanalı
guest→host düşük gecikmeli `pointer.move` için ayrılmıştır. Pointer shape,
bitmap, piksel maskesi veya hotspot payload'ı protokole dahil değildir. Ayrı
pointer gerektiğinde guest generic metadata imlecini çizer; exact DXGI pointer
shape desteği Faz 6 GPU uyumluluk çalışmasına ertelenmiştir.

## Ekran video hattı

Host, kullanıcının tarayıcı ekran seçicisini onaylamasının ardından elde edilen
video track'ini mevcut `RTCPeerConnection` üzerine ekler ve yeni SDP offer ile
oturumu yeniden anlaşır. Guest offer'a answer verir ve gelen track'i yerel bir
`MediaStream` içinde görüntüler. Paylaşım durdurulunca host sender'ı kaldırır,
yeniden anlaşır ve DataChannel üzerinden sıralı session v2 `screen-share-state`
mesajını gönderir; guest böylece son video karesini ekranda tutmaz.

Bu aşamada ses aktarılmaz. Ekran içeriği sinyalleşme sunucusuna yüklenmez;
seçilen ICE yolunda cihazlar arasında veya ileride eklenecek TURN relay üzerinden
DTLS-SRTP ile taşınır.

## Native H.264 RTP hattı

Windows native host DXGI karelerinden kesintisiz H.264 access unit üretir. Aynı
oturumdaki native video sinyalleri kontrol eşinden ayrılır:

```json
{
  "channel": "native-video",
  "version": 2,
  "signal": {
    "kind": "session-description",
    "negotiationId": "00000000-0000-4000-8000-000000000000",
    "description": { "type": "offer", "sdp": "..." }
  }
}
```

`signal` alanı `session-description` veya `ice-candidate` taşır. Zarf, sinyal ve
iç SDP/ICE nesneleri strict doğrulanır; eksik/farklı sürüm, bilinmeyen alan ve
boyut sınırı aşımı signaling sınırında reddedilir. Masaüstü host H.264 `sendonly`
offer üretir; guest tarayıcı `recvonly` answer döndürür. Bu yön sunucu rol
sınırında da zorunludur. ICE adayları aynı negotiation kimliği ve etiketli
kanaldan trickle edilir.

WebView2 ile WPF arasındaki native-video köprüsü de strict `version: 2` zarfı ve
her React peer yaşam döngüsünde yeni UUID `sessionEpoch` kullanır. WPF, capture/
offer üretiminden önce payload'sız strict `desktop.native-video.negotiation`
zarfıyla güncel `negotiationId` değerini açar. Web yalnız daha önce görülmemiş bu
başlangıç zarfıyla aktif kimliği ilerletir; eski/replay başlangıç veya offer aktif
kimliği geri saramaz ve 256 farklı kimlikten sonra fail-closed olur. Signal/state/
metrics mesajları hem session epoch hem negotiation kimliğiyle eşleşmeden
uygulanmaz. WPF dispatcher'ı mesajı kuyruğa alırken ve gerçekten gönderirken aynı
native session neslini yeniden doğrular. Köprü toplam mesajı 128 KiB UTF-8,
SDP'yi 60 KiB ve remote/local pending ICE'i 64 aday/64 KiB ile sınırlar. Pre-offer
yerel ICE taşması `CreateOfferAsync` ile yarışır; offer takılsa bile başarısız durum
hemen görünür, native oturum dispose edilir ve geç offer fault'u gözlemlenir.
Taşma fatal latch'i yalnız bir kez tetikler ve eski callback'lerin yeni nesle durum
yazmasını engeller.

Native başlangıç zarfı tam olarak şöyledir; boş `payload` dahil ek/eksik alan
kabul edilmez:

```json
{
  "type": "desktop.native-video.negotiation",
  "channel": "native-video",
  "version": 2,
  "sessionEpoch": "00000000-0000-4000-8000-000000000000",
  "negotiationId": "00000000-0000-4000-8000-000000000001",
  "payload": {}
}
```

Encoded payload sözleşmesi:

- Codec: H.264 High Profile, 90 kHz RTP clock.
- Packetization mode: RFC 6184 non-interleaved mode (`packetization-mode=1`).
- Küçük NAL: tek NAL unit paketi.
- SPS/PPS: MTU sınırı uygunsa STAP-A.
- Büyük IDR/P-slice: FU-A.
- RTP marker: access unit'in yalnızca son paketinde `1`.
- RTP sıra numarası her pakette bir artar ve 16 bit sınırında doğal sarar.
- Timestamp aynı kareye ait tüm paketlerde aynıdır.

SIPSorcery eş bağlantısı ICE yolunu kurar, DTLS ile anahtar anlaşması yapar ve H.264
RTP paketlerini SRTP ile koruyarak gönderir. Raspberry Pi sinyalleşme servisi SDP
ve ICE JSON'u dışında görüntü içeriği almaz. SDP, generic NACK ile NACK/PLI RTCP
feedback desteğini ilan eder. PLI encoder'ın yenilenerek SPS/PPS içeren yeni IDR
üretmesini; NACK ise son 4096 RTP paketinden istenen sıra numaralarının aynı RTP
kimliğiyle yeniden gönderilmesini sağlar. Receiver report içindeki fraction-lost
değeri, en fazla iki saniyede bir 1–8 Mbps hedef aralığında bitrate uyarlamasına
girdi olur.

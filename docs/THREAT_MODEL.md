# Ediz Remote tehdit modeli

Durum: Faz 4 yaşayan güvenlik belgesi  
Son güncelleme: 2026-10-09  
Kapsam sürümü: signaling wire v3

Bu belge internetten erişilen self-hosted Ediz Remote kurulumunun güven sınırlarını,
korunan varlıklarını, saldırı yollarını ve henüz kapanmamış risklerini tanımlar.
Bir kontrolün burada yazılması onun canlı Raspberry Pi dağıtımına alındığı anlamına
gelmez; kod, test, paket ve production deployment kanıtları ayrı izlenir.

## 1. Güvenlik hedefleri

Öncelik sırasıyla:

1. Host açıkça onay vermeden görüntü, SDP/ICE veya kontrol verisi aktarmamak.
2. Görüntüleme iznini kontrol yetkisine yükselten, geri alınmış yetkiyi açan veya
   eski oturumu canlandıran hiçbir mesajı kabul etmemek.
3. Ekran, input, token, credential ve ağ ayrıntılarını signaling/log/audit
   katmanlarında gereksiz yere toplamamak.
4. P2P mümkünken medya sunucusu oluşturmamak; TURN'ü yalnız kontrollü fallback
   olarak kullanmak.
5. İnternete açık uçların tek istemci tarafından kaynak tüketimiyle devre dışı
   bırakılamamasını sağlamak.
6. Yayınlanan Windows binary'sinin kaynağını ve bütünlüğünü doğrulanabilir yapmak.

Gizli/gözetimsiz erişim, UAC secure desktop, kilit ekranı, Session 0 ve
`Ctrl+Alt+Del` desteği güvenlik hedefi değildir. Bu sınırları aşmak kabul edilen
tasarıma aykırıdır.

## 2. Korunan varlıklar ve veri sınıfları

| Varlık | Sınıf | Saklama ve log politikası |
|---|---|---|
| Ekran görüntüsü ve input olayları | Çok hassas | Signaling/log/audit'e yazılmaz; yalnız onaylı WebRTC/native akışında bellekte işlenir |
| Reconnect token | Secret/bearer | Yalnız istemci belleği; sunucuda SHA-256 özeti; başarılı resume'da döndürülür |
| TURN ortak sırrı | Uzun ömürlü secret | Yalnız signaling ve coturn; istemciye veya loga çıkmaz |
| Kısa ömürlü TURN credential | Geçici secret | Yalnız onay sonrası ilgili istemciye; payload/log/audit'e yazılmaz |
| Tek kullanımlık bağlantı kodu | Kısa ömürlü erişim tanımlayıcısı | 10 dakika; onay sonrası tek kullanımlık; production loguna yazılmaz |
| SDP/ICE ve ağ adresleri | Hassas ağ metadata'sı | Eşler arasında bounded relay; production loguna ve tanı paketine yazılmaz |
| Session/participant/request UUID | Geçici korelasyon verisi | Yetki yerine geçmez; minimal audit'e veya production loguna yazılmaz |
| Binary hash, sürüm ve build kimliği | Public bütünlük metadata'sı | Release manifestinde tutulabilir |

## 3. Bileşenler ve güven sınırları

| Sınır | Güvenilen taraf | Güvenilmeyen girdi | Zorunlu kontrol |
|---|---|---|---|
| Tarayıcı → Cloudflare/signaling | Güncel resmi web bundle | Origin, WebSocket frame, JSON, kod/token | TLS, origin allowlist, wire subprotocol, strict şema, boyut/oran, rol/oturum durumu |
| Cloudflare Tunnel → signaling | Yalnız açıkça yapılandırılan proxy hattı | Forwarded istemci IP başlıkları | Public origin portunu kapalı tutma, explicit proxy trust, IP doğrulama |
| Host ↔ guest signaling | Onaylı güncel session member | SDP/ICE ve lifecycle mesajı | Onay, role/state, wire v3, negotiation lane/kimliği, bounded strict payload |
| Host ↔ guest DataChannel | DTLS ile bağlanan onaylı eş | Kontrol/session mesajı | Strict label/transport/rol/yetki matrisi, sürüm, ortak sıra, hız, 4 KiB UTF-8 sınırı |
| WebView2 → WPF/native | Sabit HTTPS virtual-host ve beklenen navigasyon nesli | Web message JSON | Origin; genel mesajda 8192 karakter, native-video'da 128 KiB UTF-8; strict v2/session epoch, yetki/sıra ve fail-closed lifecycle |
| Native input → Windows | Aktif host onayı | Normalize pointer/keyboard olayı | İkinci hız/replay kontrolü, seçili monitör, `SendInput`, zorunlu input release |
| Signaling → coturn | Aynı HMAC ortak sırrı | Credential talebi/relay trafiği | Onay sonrası istemciye özel TTL, coturn kota/port sınırı |
| Build → release artifact | Kilitli kaynak ve güvenilir toolchain | npm/NuGet/container paketi | Audit, pin/digest, SBOM, tekrarlanabilir hash; Windows'ta GitHub attestation + provenance manifesti (sertifika gelince Authenticode) |

Raspberry Pi signaling servisi güvenilir eşleştirme ve signaling bileşenidir,
fakat ekran içeriği için güvenilir medya sunucusu değildir. Cloudflare Tunnel da
yalnız web/WSS girişidir; medya taşıma sınırı olarak kullanılmaz.

## 4. Saldırgan modeli ve varsayımlar

Kapsamdaki saldırganlar:

- İnternetten çok sayıda bağlantı/kod denemesi yapan anonim istemci.
- Kötü niyetli veya ele geçirilmiş bir web origin'inden tarayıcı WebSocket'i açan
  site.
- Geçerli kodu öğrenmiş ama host onayı almamış kişi.
- Daha önce onaylanmış oturumun eski frame/token/sequence değerlerini replay eden
  kişi.
- Onaylı guest olup bozuk/aşırı SDP, ICE, DataChannel veya TURN trafiği üreten eş.
- Build dependency'si, container etiketi veya imzasız binary'yi değiştiren
  supply-chain saldırganı.
- Host bilgisayarındaki başka düşük yetkili süreçten yerel WebView/native sınırını
  kötüye kullanmaya çalışan kişi.

Varsayımlar:

- Windows ve Chromium/WebView2 güvenlik güncellemeleri uygulanır.
- Host kullanıcısı gelen isteği görür ve görüntü/kontrol modunu bilinçli seçer.
- Production signaling origin portu loopback dışında public değildir; dış erişim
  Cloudflare Tunnel üzerinden gelir.
- TURN ortak sırrı ve ilerideki signing key repo dışında tutulur.
- Host işletim sistemi veya browser bütünüyle ele geçirilmişse ekran/input gizliliği
  uygulama katmanıyla garanti edilemez.

## 5. Risk değerlendirme yöntemi

- **Kritik:** Onaysız görüntü/kontrol, kalıcı secret sızıntısı veya release imza
  zincirinin aşılması.
- **Yüksek:** İnternetten pratik oturum takeover/downgrade, yaygın servis DoS'u veya
  yayınlanan binary'nin güvenilir biçimde değiştirilebilmesi.
- **Orta:** Sınırlı metadata sızıntısı, onaylı kötü niyetli eşten oturum DoS'u veya
  ek koşul gerektiren replay.
- **Düşük:** Güvenlik sınırını aşmayan bilgi/operasyonel sertleştirme eksikleri.

`Açık`, `Kısmi`, `v3 için kapalı` ve `Kabul edilen sınır` durumları kullanılır.
Faz 4 ancak açık yüksek riskler kapatılıp kabul kriterleri kanıtlandığında
tamamlanır.

## 6. Tehdit kaydı

| ID | Tehdit ve saldırı yolu | Mevcut savunma | Kalan iş | Önem / durum |
|---|---|---|---|---|
| ER-T01 | 6 haneli kod brute force ve host'a istek seli | Kriptografik kod, 10 dk TTL, tek kullanım, host onayı; global+IP create/join/resume/invalid kovaları; proxy IP yalnız explicit trust ile; kod bilgisi onaylı ya da host'u askıdaki oturumu sonlandıramaz (`join_session` yalnız misafiri olmayan oturumun süre sonunu uygular) | Production kapasite ölçümü, dağıtık saldırı metriği ve güvenli audit alarmı | Yüksek / Kısmi |
| ER-T02 | Bağlantı açarak/session oluşturarak bellek ve CPU tüketimi | 128 KiB frame, heartbeat, global/IP socket-session kotası, global/socket inbound byte+mesaj kovası, bounded TTL store, O(1) resume indeksi | Production kapasite/soak ölçümü ve güvenli operasyonel alarm | Yüksek / Kısmi |
| ER-T03 | Host onayı öncesi SDP/ICE veya ekran akışı | Sunucu yalnız aktif onaylı üyeliğin `signal` mesajını relay eder; capture ve peer onay sonrasında başlar; seed'li canlı sunucu fuzz'ı 2.500 kimliksiz frame sonrasında hiçbir sokete signal/onay mesajı ulaşmadığını doğrular; 326 testlik durum makinesi matrisi onaysız, reddedilmiş, bitmiş, süresi geçmiş ve askıdaki durumların hiçbirinde karşı tarafa signal/onay/ICE sızmadığını doğrular | v3 paketinin production'a alınması ve canlı doğrulama | Kritik / v3 için kapalı |
| ER-T04 | Reconnect token çalma/replay ile signaling takeover | 256 bit role özel token, yalnız hash saklama, 30 sn grace, başarılı resume'da rotation, global/IP resume bucket, O(1) indeks, yalnız boş sokette takeover ve strict resume reject/success audit olayı; public web'de inline script/attribute ve cross-origin bağlantıyı kapatan HTTP CSP; paketlenmiş WebView2'de WSS/loopback-connect sınırlı meta CSP; tehlikeli DOM/eval sink'i bulunmayan source taraması | Production CSP ihlal/operasyon alarmı | Yüksek / Kısmi |
| ER-T05 | Eski/uyumsuz istemciyle downgrade veya mesaj karışıklığı | Zorunlu `ediz-remote.v3`, minimum/current 3/3 `ready`, legacy fallback yok, strict root nesneler; v1/v2 istemci upgrade aşamasında reddedilir | Gelecek v4 capability/sürüm aralığı ve iki aşamalı rollout prosedürü | Yüksek / v3 için kapalı |
| ER-T06 | Bozuk/aşırı SDP/ICE ile parser, bellek veya peer DoS'u | Metin JSON, 128 KiB frame, güvenli metin + UTF-8 byte tabanlı 60 KiB SDP, 4096 karakter candidate, role göre offer/answer yönü, global/member mesaj+byte kovası, native-video v2, ayrı peer/native `negotiationId`; web/native 64 aday/64 KiB ve signaling erken 64 mesaj/128 KiB kuyruk sınırı; lane başına 256 görülen ID; yerel SDP `ice-ufrag` nesil bağı; native pre-offer başlangıç ve takılmış offer'dan bağımsız taşma kapanışı; her derinlikte `__proto__`, eşlenmemiş surrogate ve 2048 kap bütçesi ön taraması; protokol, canlı signaling, web DataChannel ve WPF köprüsü fuzz matrisi | Production negotiation-churn/soak ölçümü | Yüksek / Kısmi |
| ER-T07 | Kontrol izni olmadan input veya replay | Ayrı `view/control` onayı, control v1 ve session v2 zarfları, ortak session sequence, strict label/transport/rol/yetki matrisi, pointer kanalında yalnız `pointer.move`, web/native hız sınırı, yalnız başarılı uygulamada ilerleyen native watermark, recovery boyunca fatal latch, SAS/tray fail-closed input release ve revoke latch; DataChannel yetki matrisi fuzz'ı; yinelenen anahtar ve okunamayan metni istisnasız reddeden WPF köprü ayrıştırıcıları; signaling durum makinesi matrisinde negotiation ve resume token replay satırları | Production control soak ölçümü | Kritik / Kısmi |
| ER-T08 | Kötü origin'den Cross-Site WebSocket kullanımı | Origin zorunlu; same-host veya allowlist; unsupported subprotocol/eksik origin upgrade öncesi reddedilir; public web CSP `connect-src 'self'`, `frame-ancestors 'none'`, COOP/CORP ve no-referrer uygular | Production allowed-origin/host ve header deployment testi | Orta / v3 için kapalı |
| ER-T09 | Sahte proxy başlığıyla IP limitini aşma | `CF-Connecting-IP` varsayılan olarak yok sayılır; explicit trust ve geçerli IP gerekir; Compose portu loopback | Production ağ/topoloji testi; yanlış trust ayarını startup/health durumunda görünür kılma | Yüksek / Kısmi |
| ER-T10 | TURN credential/relay kötüye kullanımı | Onay sonrası istemciye özel HMAC credential, 60–86400 sn TTL, secret istemciye verilmez, coturn limitleri, global+kalıcı member `refresh_ice` kovası | Eşzamanlı allocation/kapasite alarmı ve secret rotation prosedürü | Orta / Kısmi |
| ER-T11 | Token, SDP, ICE, kod veya exception'ın log/audit'e sızması | Signaling ve native hata çıktıları sabit kod/allowlist kullanır; TURN/browser probe'ları ortak bounded redaction sınırındadır; strict sekiz alanlı JSONL audit günlük HMAC pseudonym, kısa retention ve private/no-symlink dosya koruması uygular; signaling TURN/audit secret loader'ları environment yerine bounded, no-follow, current-UID/private-mode ve tek-link doğrulamalı dosya kullanır; coturn entrypoint'i type/symlink/owner/mode/size kontrol eder ve production config raw stdout'u discard eder; sentinel testleri vardır | Canlı production stdout/stderr capture, gelecekteki destek paketi testi ve erişim/rotasyon operasyon kanıtı | Yüksek / Kısmi |
| ER-T12 | Zararlı/güvensiz dependency veya container | npm lockfile, SIPSorcery 10.0.16, güvenli transitive override'lar, `qs` 6.16.0, 2026-10-09 `proxy-addr` 2.0.8/`shell-quote` 1.12.0/`source-map-js` 1.2.2/`vitest` 4.1.11 yükseltmeleri ve bulguda duran `npm run security:audit`; Node 22.23.2/Alpine 3.24, coturn 4.17.0/Alpine ve Trivy multi-arch digest kilidi; hardened Node/application/custom-coturn için build-once immutable image ID, arşiv config SHA bağı, CycloneDX+SPDX native ID doğrulaması, güncel Trivy DB, HIGH/CRITICAL fail gate, hash bağlı şema v3 manifest ve `--pull never`/`--no-build` deployment tüketicisi; gerçek yerel amd64 taramasında 3/3 hedef 0 bulgu (son koşu 2026-10-09); Pi `linux/arm64` gerçek taramasında 3/3 hedef 0 bulgu (2026-10-11) | Pi `linux/arm64` deploy kanıtı, image provenance/imzası ve güvenli digest yenileme operasyonu | Yüksek / Kısmi |
| ER-T13 | İmzasız Windows EXE veya yayın ağacının değiştirilmesi | Store/HSM-only model ve PFX/parola reddi; EXE sonrası strict SHA-256 manifest; manifest dahil tüm `win-x64` ağacını kapsayan dış SHA-256 Catalog v2; EXE+katalog için Authenticode `Valid`, exact signer, timestamp ve `signtool /pa /all /v /tw`; `Test-FileCatalog=Valid/SHA256`; bounded/reparse/TOCTOU kontrolleri; EXE sürüm kaynağına gömülü sürüm, commit, temiz-ağaç bayrağı ve monoton sequence; bu kimliği birebir taşıyan strict manifest v2; imza öncesi temiz kaynak, `HEAD`/sürüm eşliği ve güvenilir tabanın altındaki sequence için `release_rollback_rejected`. 2026-10-11'den beri imzasız yayın yolu: GitHub-hosted runner'da derleme, EXE + provenance manifesti için Sigstore SLSA build provenance attestation; tüm `win-x64` ağacını yol/boyut/SHA-256 ile kapsayan strict, kanonik provenance manifesti ve SHA256SUMS; `gh attestation verify` ile depo, signer workflow, `refs/heads/main`, commit ve GitHub-hosted runner zorunluluğu; aynı kaynak/sequence/taban kapısı | **Artık risk (depo sahibi tarafından kabul edildi, 2026-10-11):** EXE Authenticode imzasız olduğundan işletim sistemi düzeyinde yayıncı güveni yoktur; SmartScreen ilk çalıştırmada uyarı verir ve kullanıcıya "Yine de çalıştır" dedirtmek sosyal mühendislik riskini artırır (sahte bir EXE de aynı uyarıyı verir). Windows attestation'ı kendiliğinden kontrol etmez. Azaltım: attestation + yayınlanan SHA-256 ile doğrulama talimatı, yalnız resmi GitHub yayın sayfasından indirme, `main` branch koruması ve hesap güvenliği; Faz 5'te kendi anahtarla imzalı güncelleme manifesti ve sequence karşılaştırması. İlk GitHub koşusu ve bağımsız attestation doğrulaması 2026-10-11'de geçti (`windows-v0.1.0.1` taslağı); kalan kanıt temiz Windows 10/11 doğrulamasıdır. Sertifika gelince OV/EV + RFC3161 Authenticode yolu ayrıca kullanılır | Yüksek / Kısmen azaltıldı; artık risk kabul edildi |
| ER-T14 | UAC/lock screen/Session 0 güvenlik sınırının aşılması | Tasarım gereği yakalanmaz ve input enjekte edilmez | Davranışı regresyon testleri ve kullanıcı belgesinde koruma | Kritik / Kabul edilen sınır |

## 7. Faz 4 ilk dilim kararı

İlk dilim şu güven sınırını kapatır:

- WebSocket yükseltmesi güncel `ediz-remote.v3` ve güvenilir origin olmadan
  kurulmaz. İlk dilimde bu sınır v1 ile kurulmuş, ikinci dilimde strict
  operation-aware hata sözleşmesi nedeniyle v2'ye ve üçüncü dilimde negotiation/
  oturum zarfı kırılımı nedeniyle current/minimum v3'e yükseltilmiştir.
- `ready` wire minimum/current sürümünü bildirir; eski istemci sessiz legacy moda
  düşmez.
- İstemci/sunucu wire nesneleri strict; SDP/ICE ve native-video payload'ları
  ortak şemada bounded ve sürümlüdür; binary frame reddedilir.
- Cloudflare istemci IP başlığı yalnız production topolojisinde açıkça güvenilir
  ilan edilirse oran limitinin anahtarı olur.
- Uygulanabilir iki yüksek önem dereceli SIPSorcery açığı 10.0.16 ile giderilir.
- Transitive `nanoid`/`postcss` sürümleri güvenli yamalara yükseltilir ve tam
  `npm audit` sonucu 0 açığa indirilir.

Bu değişiklik bilinçli olarak v1/v2 ve alt protokol teklif etmeyen yayınlanmış
EXE/web bundle'larıyla uyumlu değildir. Production sunucu güncellemesi yeni web ve
Windows paketi hazırlandıktan sonra birlikte yapılmalıdır. Faz 4 sırasında
güvenlik için legacy fallback açılmayacaktır.

## 8. Faz 4 ikinci dilim kararı

İkinci dilim kaynak tüketimini tek bir socket sayacıyla değil dört ayrı güven
kapsamıyla sınırlar:

- açık bağlantı ve inbound frame maliyeti global + socket/IP,
- onaysız create/join/resume/bozuk mesaj maliyeti global + kanonik IP,
- onaylı signal/ICE maliyeti global + reconnect boyunca değişmeyen session member,
- session belleği global + session'ın ilk `ownerIp` değeri.

Varsayılan hard tavan 256 açık WebSocket, IP başına 16 WebSocket, 96 session ve
creator IP başına 4 session'dır. 96×2 aktif eşin üzerinde reconnect takeover için
64 socket headroom bırakılır. Sayaç subject haritaları 4096 IP ve 15 dakika idle
TTL ile bounded kalır; TTL hiçbir bucket'ın tam refill ufkundan kısa
yapılandırılamaz. Store dolduğunda yeni subject fail-closed reddedilir.

`rate_limited` yanıtı zorunlu strict `operation` ve 1–300 saniye
`retryAfterSeconds` taşır; diğer hata kodlarında bu alanlar yasaktır.
`capacity_exceeded` yalnız `create_session` işlemi ve bounded retry ile geçerlidir.
Create, join, resume ve aktif signal/ICE hataları web state-machine'inde ayrı ele
alınır; throttled resume ve guest'in düşen answer sinyali fresh socket'le, host
signal/ICE kontrollü ICE refresh ile otomatik denenir ve aktif onay temizlenmez.

Resume token hash'i bütün session'larda doğrusal arama yerine bounded O(1)
indeksten bulunur. Kurtarma yalnız role/session'a henüz bağlanmamış yeni socket'te
kabul edilir; başka bir aktif session socket'i ikinci session token'ıyla iki
üyeliği birleştiremez. Bare ve `native-video` SDP offer yalnız host'tan, answer
yalnız guest'ten gelebilir; ICE candidate iki yönde de kabul edilir.

## 9. Faz 4 üçüncü dilim kararı

Üçüncü dilim oturum içi signaling ve DataChannel yetkilendirmesini şu sınırlarla
tamamlar:

- Her SDP/ICE sinyali UUID `negotiationId` taşır. Genel peer ve native-video
  lane'leri ayrı tutulur; yalnız host görülmemiş yeni offer kimliği açar, guest
  yalnız güncel kimliğe bir answer verir ve candidate yalnız güncel kimlikte
  aktarılır. Görülen en fazla 256 kimlik lane/session boyunca ve resume sonrasında
  korunur; sınırdan sonra yeni onaylı oturum gerekir.
- Web ve native pending ICE kuyruğu negotiation başına 64 aday/64 KiB; signaling
  aboneliği öncesi erken mesaj kuyruğu lane başına 64 mesaj/128 KiB'dir. Taşma
  sessiz büyüme yerine fail-closed sonlandırılır.
- Tarayıcı yerel ICE callback'ini SDP'den bounded çıkarılan `ice-ufrag` nesline
  bağlar; geç/eski nesil adayı yeni kimlikle göndermez. WPF offer öncesi strict
  negotiation başlangıcı yayınlar; web yalnız bu yeni zarfla ilerler ve replay
  offer ile geri sarılmaz. Pre-offer taşması offer takılsa bile oturumu hemen
  kapatır.
- Native-video signaling ile WebView2 bridge zarfı v2'dir; bridge UUID
  `sessionEpoch` ile önceki native callback ve sinyalleri ayırır.
- Session DataChannel mesajları v2 ve gönderen başına ortak artan `sequence`
  kullanır. Label, transport ayarı, rol ve `view/control` erişimi birlikte
  doğrulanır; pointer kanalında yalnız kontrol yetkili host'a gelen
  `pointer.move` kabul edilir.
- Matris/reliable taşıma veya güvenli hız sınırı ihlali fail-closed kapanır ve
  native input bırakılır. Eski/replay sıra state ya da kontrol uygulamaz; hız
  reddi meşru sonraki mesajı kilitleyecek biçimde watermark ilerletmez. Fatal
  kilit aynı onaylı recovery'de korunur; native watermark yalnız başarılı
  uygulamada ilerler, SAS girişimi ve kontrol açıkken gizli tepsi yolu input'u
  kapatıp tüm basılı girdileri bırakır.

## 10. Uygulanan minimal audit modeli

İzin verilen JSONL kayıt yalnız aşağıdaki sekiz alandan oluşur:

```text
timestamp, eventType, outcome, role, reasonCode, coarseClientBucket,
protocolVersion, buildId
```

`eventType` allowlist'i `upgrade_rejected`, `join_rate_limited`, `join_rejected`,
`approval_granted`, `approval_rejected`, `resume_rejected`, `resume_succeeded`,
`control_revoked` ve `session_ended` olaylarıyla sınırlıdır. Her olayın sonuç, rol
ve reason kombinasyonu sabit matrisle doğrulanır. Connection code, tam IP,
token/hash, request/session/peer UUID, SDP, ICE, TURN username/credential, ekran,
input, exception, stack veya dosya yolu yasaktır.

Ham IP ayrı audit anahtarıyla günlük değişen kısa HMAC pseudonym'ine çevrilir ve
saklanmaz. Bu bucket ile timestamp anonim değil pseudonymous operasyonel
metadata'dır; erişimi sınırlandırılır. Retention 1–30 gün, production varsayılanı
7 gündür. Anahtar, kuyruk rezervi, fail-closed hata davranışı ve dosya güvenliği
ayrıntıları `docs/SECURITY_AUDIT.md` dosyasındadır.

## 11. Faz 4 çıkış kapıları

- Onaysız/süresi geçmiş/replay durumları için state-machine ve fuzz matrisi. —
  **Test kapsamında tamamlandı: fuzz katmanı (protokol, canlı signaling, web
  DataChannel, WPF köprüsü) ve 326 testlik signaling durum makinesi matrisi; üç
  gerçek bulgu kapatıldı (iç içe `__proto__`, WPF eşlenmemiş surrogate, kodla
  onaylı oturumun sonlandırılması).**
- Negotiation ID/lane, bounded pending ICE ve DataChannel rol/yetki matrisi. —
  **Kod/test dilimi tamamlandı; production churn/soak kanıtı bekliyor.**
- Global/IP kaynak kotaları ve signal/ICE/message rate limitleri. — **Kod/test
  tamamlandı; production kapasite ölçümü bekliyor.**
- Signaling stdout/stderr, JSONL audit ve mevcut TURN/browser probe tanılarında
  secret sentinel sızıntı testi. — **Kod ve yerel test tamamlandı; canlı
  production capture ile gelecekteki destek paketi doğrulaması bekliyor.**
- Production npm/NuGet/container taraması, SBOM ve gerekçeli baseline. — npm/NuGet
  kapısı temiz, container kapı kodu ve yerel `linux/amd64` gerçek 3/3 sıfır-bulgulu
  scan tamamlandı (2026-10-09 yenilendi); Pi `linux/arm64` gerçek scan 2026-10-11'de
  3/3 hedef sıfır bulguyla geçti; deployment smoke kanıtı bekliyor.
- Authenticode imzalı Windows artifact ve bağımsız imza/hash doğrulaması. —
  Store/HSM, EXE+katalog, bütün ağaç, release kimliği ve anti-rollback/build
  provenance kodu tamamlandı. Depo sahibi 2026-10-11'de sertifika gelene kadar
  bu kapıyı GitHub attestation + provenance manifesti yoluyla karşılamaya karar
  verdi (ER-T13 artık riski kabul edildi); kod ve 234/234 yerel politika testi
  hazır. İlk GitHub koşusu `windows-v0.1.0.1` taslağını attest etti ve bağımsız
  doğrulama geçti (2026-10-11); temiz makine kanıtı bekliyor.
- Cloudflare origin/proxy policy ile gerçek HTTPS/WSS deployment testi. —
  **Kod/test hazır; v3 web/signaling/desktop paketiyle gerçek deployment testi
  bekliyor (Pi onayı).**
- Faz 4 kabul kanıtlarının `docs/PHASE4_ACCEPTANCE.md` altında toplanması. —
  **Tamamlandı ([`PHASE4_ACCEPTANCE.md`](PHASE4_ACCEPTANCE.md)); Pi, imza ve
  production kanıtı geldikçe güncellenir.**

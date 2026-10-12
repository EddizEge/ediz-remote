# Signaling güvenlik audit'i

Bu audit yalnız internete açık signaling sınırındaki güvenlik kararlarını
kaydeder. Oturum içeriği veya kullanıcı etkinliği günlüğü değildir.

## Sabit kayıt şeması

Her UTC günlük JSONL kaydı yalnız şu alanları içerir:

```text
timestamp, eventType, outcome, role, reasonCode, coarseClientBucket,
protocolVersion, buildId
```

İzin verilen olaylar upgrade reddi, join rate/reddetme, host onayı/reddi,
resume reddi/başarısı, kontrol geri alma ve oturum kapanışıdır. Event/outcome/role/
reason kombinasyonları kod içinde sabit bir matrisle doğrulanır; serbest metin veya
ek alan kabul edilmez.

Bağlantı kodu, tam IP, reconnect token/hash, request/session/peer kimliği, SDP,
ICE candidate, TURN username/credential/secret, ekran, input, exception, stack ve
dosya yolu kesinlikle audit'e yazılmaz. Ham istemci IP'si yalnız ayrı audit
anahtarından türetilen günlük HMAC kovasına çevrilir. Gün değiştiğinde aynı IP'nin
kovası da değişir.

Bu kayıtlar anonim veri değildir. Zaman damgası ve anahtarlı günlük istemci kovası
pseudonymous operasyonel metadata'dır; audit volume'una erişim production secret
ve uygulama verisiyle aynı dikkat düzeyinde sınırlandırılmalıdır.

## Production yapılandırması

Audit HMAC anahtarı TURN secret'tan farklı ve en az 32 bayt olmalıdır:

```bash
install -d -m 0700 ./secrets
(umask 077 && openssl rand -base64 48 > ./secrets/signaling-audit-hmac.key)
sudo chown 1000:1000 ./secrets/signaling-audit-hmac.key
chmod 0400 ./secrets/signaling-audit-hmac.key
```

`.env` içinde:

```dotenv
SIGNALING_AUDIT_ENABLED=true
SIGNALING_AUDIT_HMAC_KEY_FILE_HOST=./secrets/signaling-audit-hmac.key
SIGNALING_AUDIT_RETENTION_DAYS=7
EDIZ_REMOTE_BUILD_ID=ediz-remote@0.1.0
```

`EDIZ_REMOTE_BUILD_ID`, gerçek yayın hazırlanırken güvenli sürüm/hash etiketiyle
değiştirilmelidir; biçim `ediz-remote@...` ile başlar. Saklama süresi 1–30 gün
aralığındadır. Production Compose anahtarı environment içine kopyalamaz; salt
okunur container secret dosyası olarak bağlar. Anahtar ve audit dosyaları build
context ile sürüm kontrolünden dışlanır.

Production imajı sabit `1000:1000` kimliğiyle çalışır. Docker Compose'un yerel
dosya kaynaklı secret'larında `uid`, `gid` ve `mode` alanları her engine'de
uygulanmadığı için host anahtarının gerçekten UID 1000'e ait ve `0400` olması
deployment ön koşuludur. Bu dağıtım rootful Linux/Pi modeli içindir; rootless veya
user-namespace eşlemeli Docker, anahtar okuma ve audit volume yazma smoke testi
geçmeden production kabul edilmez. Yanlış izin servis başlamadan sabit hata ile
kapanır; daha gevşek izne otomatik düşüş yoktur.

Anahtar dosyası tek descriptor üzerinden ve sert boyut tavanıyla okunur. Desteklenen
platformlarda `O_NOFOLLOW`, bütün platformlarda açma öncesi/sonrası dosya kimliği,
regular-file, tek hard-link, current process UID sahipliği, private mode ve
symlink/junction kontrolleri uygulanır; geçici key buffer'ı writer oluşturulduktan
sonra sıfırlanır. TURN shared secret dosyası da signaling tarafında aynı
tek-descriptor/no-follow/tek-link/current-UID/private-mode sınırından geçer;
environment içinde secret taşınmaz.

Container içindeki audit dizini `/var/lib/ediz-remote/security-audit`, kalıcı
Compose volume'u `signaling-audit`'tir. Dosyalar `audit-YYYY-MM-DD.jsonl`
biçimindedir. Dizin ve dosya izinleri writer tarafından yeniden doğrulanır;
symlink hedefleri reddedilir. Varsayılan yedi günlük retention başlangıçta,
saatlik ve yeni kayıt gününde uygulanır.

## Hata davranışı

- Audit etkinken (production'da varsayılan) anahtar/yol/izin/retention/build
  kimliği geçersizse signaling HTTP portunu açmaz ve yalnız sabit
  `startup_failed` kodu üretir.
- Çalışma sırasında audit yazımı veya bounded kuyruk bozulursa `/health` yalnız
  `503 {"status":"unavailable"}` döndürür; yeni WebSocket upgrade'ları reddedilir
  ve mevcut soketin sonraki mesajı kapatılır. En geç bir saniyelik watchdog
  kontrolünde servis sabit `audit_unavailable` kodu ve sıfır olmayan çıkışla
  kapanır; Compose restart politikası servisi yeniden başlatır. Bozuk audit
  kuyruğu kapanışta temiz boşaltılamadığından ardından sabit `shutdown_failed`
  de yazılır (çıkış kodu yine 1). Arıza sürdükçe her yeniden başlatma
  `startup_failed` ile port açmadan kapanır; audit dizini düzeltilince servis
  kendiliğinden `healthy` olur (2026-10-12 tatbikatı, aşağıda).
- Dışarıdan üretilebilen upgrade/join gürültüsü kritik onay, başarılı resume,
  control revoke ve session-end kayıtlarının rezervini tüketemez.
- Shutdown, kuyruk drain'i ve dosya descriptor `sync()` işlemi tamamlanmadan
  başarılı sayılmaz. Yeni dosya ve retention silmelerinde parent dizin de
  platform destekliyorsa senkronize edilir; bu bir güç-kesintisi garantisi değildir.
- Production coturn yapılandırması `no-stdout-log` ile `/dev/null` üretir; source ve
  config testleri bu davranışı doğrular. Canlı production container stdout ölçümü
  ayrıca deployment kabulünde yapılmalıdır.
- TURN relay/network/native/public-preflight/interruption araçları ile browser TURN
  simülasyonunun child/browser/coturn tanıları ortak `safe-output` sınırından
  geçer. Exact secret'lar ve yaygın network/token/code kalıpları maskelenir;
  structured diagnostics boyut ve alan sayısıyla sınırlandırılır, top-level
  hatalar yalnız sabit kod üretir. Bu kapsam gelecekteki kullanıcı destek paketi
  için otomatik garanti sayılmaz.

Development/test ortamında audit varsayılan olarak kapalıdır; açıkça
`SIGNALING_AUDIT_ENABLED=true` verilirse aynı anahtar ve saklama kuralları geçerlidir.

## Audit arıza tatbikatı

Yukarıdaki çalışma zamanı hata davranışı gerçek bir container üzerinde
tekrarlanabilir biçimde şu komutla doğrulanır:

```powershell
npm run security:audit-drill                       # çalışma ağacından build + tatbikat
npm run security:audit-drill -- --image <image>     # var olan image ile, build etmeden
```

Araç (`scripts/audit-failure-drill.mjs`) yerel Docker engine'inde (`npipe://` /
`unix://` bağlamı; uzak engine reddedilir) çalışır ve production'a, Compose
projesine veya tatbikata ait olmayan hiçbir Docker kaynağına dokunmaz:

- Bütün kaynaklar `ediz-remote-audit-drill-<rastgele>-…` önekiyle oluşturulur
  (signaling container, bridge ağ, audit ve secret volume'ları, `--rm` yardımcı
  container'lar). Başlarken bu önekle kalıntı varsa silmeden
  `stale_resources_present` ile durur. Temizlik yalnız tam adlarla yapılır; hata
  ve Ctrl+C'de de denenir, sonunda önek listesi boş değilse `cleanup_failed`.
- Varsayılan image Dockerfile'ın son aşamasından (`runtime`, yani production
  application hedefi) `ediz-remote/audit-drill:local` etiketiyle build edilir ve
  bir sonraki `--image` koşusu için **bırakılır**.
- Container `docker-compose.yml`'deki sertleştirmeyi aynen yansıtır: read-only
  rootfs, `--cap-drop ALL`, `no-new-privileges`, PID sınırı 256, aynı `/tmp`
  tmpfs seçenekleri, UID 1000, `NODE_ENV=production`, audit etkin, aynı
  healthcheck (30 sn aralık; Compose'daki exec biçimi yerine `CMD-SHELL`),
  `--restart unless-stopped`, yalnız `127.0.0.1` üzerinde rastgele port. Ayarlar
  çalışan container'ın `inspect` çıktısından ayrıca doğrulanır.
- Audit HMAC anahtarı ve TURN secret'ı (TURN yapılandırılmış sayılır; `.invalid`
  adres hiç aranmaz) Node `crypto` ile üretilir, ağsız pinlenmiş Alpine yardımcı
  container'a stdin'den verilir ve named volume içinde `1000:1000 0400` dosya
  olarak salt-okunur bağlanır. Değerler argv'ye, dosya sistemine ya da çıktıya
  yazılmaz.

Aşamalar:

1. **Başlangıç:** container `healthy`, `/health` 200, `ediz-remote.v3` + izinli
   Origin ile upgrade 101 ve `ready`; yabancı Origin 403 (audit kaydı yazılır,
   servis sağlıklı kalır, volume'da günlük dosya oluşur); RestartCount 0; log
   yalnız `service.ready`.
2. **Arıza enjeksiyonu:** yardımcı container audit volume kökünün sahipliğini
   `0:0` yapar (mod `0700` kalır). Writer her yazımda dizini `open`/`stat`/`chmod`
   ile yeniden doğruladığından UID 1000 artık dizine erişemez; yalnız `chmod`
   yeterli olmaz, çünkü writer kendi dizinini `0700`'e geri çeker. Enjeksiyon
   tek başına sağlığı bozmaz; arıza bir sonraki audit yazımında görülür.
3. **Tetikleme ve gözlem:** yabancı Origin'li v3 upgrade (403) bir
   `upgrade_rejected` kaydı kuyruğa alır (başarılı upgrade audit kaydı üretmez,
   bu yüzden tetik reddedilen bir upgrade'dir). Ardından ≈50 ms aralıkla `/health` ve
   izinli Origin'li yeni upgrade denenir: `503 {"status":"unavailable"}` ve
   upgrade 503 görülmelidir. `docker events` ile sıfır olmayan çıkış kodu,
   `inspect` ile RestartCount artışı kaydedilir. Arıza sürerken yeniden başlayan
   süreç `startup_failed` ile kapanmaya devam eder. 503 penceresi en fazla bir
   watchdog aralığı sürdüğünden bir yoklama pencereyi kaçırırsa araç geri alıp
   enjeksiyonu yeniler (`--attempts`, varsayılan 3).
4. **Log:** ham log yazdırılmaz; yalnız sabit kodların sayısı ve sırası (sabit
   belirteçlerle, en çok 12) raporlanır. Beklenen dışında bir satır (serbest metin,
   ek alan, `unhandled_*`) tatbikatı düşürür. Gözlenen sıra
   `ready, audit_unavailable, shutdown_failed, startup_failed…`dır: arızalı süreç
   kapanırken audit kuyruğunu temiz kapatamadığı için `audit_unavailable`'dan sonra
   sabit `shutdown_failed` de yazar (çıkış kodu yine 1); arıza sürerken her yeniden
   başlatma `startup_failed` ile port açmadan kapanır.
5. **Geri alma:** sahiplik `1000:1000`, mod `0700`; container restart politikasıyla
   kendiliğinden `healthy` olur, `/health` 200, v3 upgrade 101 ve yeni audit
   yazımı servis yeniden başlamadan başarılı olur.

Çıktı yalnız sabit aşama adları, HTTP durum kodları, çıkış kodu, restart sayısı,
süreler ve image ID içerir; her satır `safe-output` redaksiyon sınırından değişmeden
geçmek zorundadır. Sonuç `audit_drill:passed` ya da
`audit_drill:failed:<sabit kod>` ve sıfır olmayan çıkıştır. Saf parçalar
`scripts/audit-failure-drill.test.mjs` ile `npm test` içinde Docker'sız sınanır;
gerçek tatbikat `npm test`'e girmez.

Tatbikatın gösterdiği bir sınır: arıza pasif algılanır. Dizin bozulduktan sonra
audit yazımı ya da saatlik retention taraması olmadıkça `/health` 200 kalır
(enjeksiyon sonrası, tetiklemeden önce ölçülen değer). Kayıt gerektiren ilk olayda
servis fail-closed davranır.

Sınır: tatbikat yerel olarak build edilmiş image ile yapılır; production'daki
`linux/arm64` image'ı ya da canlı servis değildir. Aynı tatbikat Pi'de ayrı,
izinli bir ortamda `--image <production image ID>` ile çalıştırılabilir; canlı
container'da arıza enjeksiyonu yapılmaz. Tatbikat Docker Desktop'ın restart
yöneticisini kullanır; Pi'deki rootful engine'in restart zamanlaması farklı
olabilir. Kayıtlı sonuç için [container release belgesine](CONTAINER_RELEASE.md)
bakın.

## Operasyonel sınırlar

Audit dosyaları pseudonymous olsa da destek talebine ham olarak eklenmemelidir.
`.env`, `secrets/`, `docker inspect`, `docker compose config`, WebView profili,
ekran görüntüsü, ham coturn logu ve raw stdout/stderr hiçbir destek paketine
alınmamalıdır. Gerekli analiz yalnız olay türü/reason bazında toplulaştırılmış
sayılarla yapılmalıdır.

Anahtar rotasyonu için signaling servisini durdurun, anahtar dosyasını güvenli
izinlerle değiştirin ve servisi yeniden başlatın. Eski anahtar güvenle yok edilmiş
ve yedeklerde tutulmamışsa önceki günlük kovalar yeni anahtarla yeniden üretilemez;
zaman damgası veya başka dış kayıtlarla korelasyon riski yine de ortadan kalkmaz.

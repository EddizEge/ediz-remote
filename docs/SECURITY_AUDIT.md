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
  kapanır; Compose restart politikası servisi yeniden başlatır.
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

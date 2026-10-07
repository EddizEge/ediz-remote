# Faz 3 — Uzaktan destek kullanıcı deneyimi

Durum: **TAMAMLANDI.** Bütün Faz 3 kabul kriterleri 2026-08-23 tarihinde
karşılandı. Kanıt matrisi `docs/PHASE3_ACCEPTANCE.md` dosyasındadır.

## Tamamlanan dilim: rol, monitör ve bağlantı durumu

- [x] Ana ekranda “destek al” ve “destek ver” rollerini açıklaştır.
- [x] Aktif host ve guest görünümünde rolü sürekli görünür tut.
- [x] Native Windows monitörlerini bounded WebView2 mesajıyla arayüze taşı.
- [x] Monitör listesini host'tan guest operatöre sürümlü DataChannel mesajıyla ilet.
- [x] Guest'in yalnızca ilandaki monitörlerden birini seçebilmesini sağla.
- [x] Seçimde DXGI yakalama ve kontrol koordinat alanını birlikte değiştir.
- [x] Geçişte basılı girişleri bırak, mevcut kontrol yetkisini koru.
- [x] Native video offer'ını aynı onaylı oturumda yeniden kur.
- [x] Direct/relay, gecikme, bitrate ve paket kaybını ayrı durum alanlarında göster.
- [x] Web, desktop test/build ve gerçek iki tarayıcılı render/etkileşim QA yap.

## Tamamlanan dilim: kalite ve ölçekleme

- [x] Otomatik, hız öncelikli ve kalite öncelikli profilleri tanımla.
- [x] Profil mesajlarını sürümle, host/native sınırında doğrula ve bitrate/çözünürlük
  davranışına bağla.
- [x] Guest görüntüsüne sığdır, gerçek piksel ve tam ekran seçenekleri ekle.
- [x] Ölçekleme değişiminde pointer koordinat eşlemesini test et.
- [x] Masaüstü ve mobil gerçek render ile iki tarayıcılı oturumu doğrula.

Profil sınırları:

- Hız öncelikli: 3 Mbps tavan, 24 FPS; browser fallback 1280×720.
- Otomatik: 8 Mbps tavan, 30 FPS; browser fallback en fazla 2560×1440.
- Kalite öncelikli: 12 Mbps tavan, 30 FPS; browser fallback en fazla 3840×2160.
- Native RTCP kayıp adaptasyonu seçilen tavanın altında çalışmaya devam eder.

## Tamamlanan dilim: uzak imleç ve bağlantı süresi

- [x] DXGI pointer konumunu seçili monitör alanında normalize et.
- [x] Bounded WebView2 köprüsü ve sürümlü/sıralı `cursor.state` mesajı ekle.
- [x] Guest'te replay, aralık, rol ve hız kontrollerini uygula.
- [x] Sık imleç güncellemelerini React state'e yazmadan video dikdörtgenine çiz.
- [x] DXGI imleci kareye zaten bileşikse ikinci imleci gizle.
- [x] Onaylı oturum süresini aktif panelde göster ve kısa recovery'de koru.
- [x] Native desktop→browser 1920×1080 akış, masaüstü ve 390×844 mobil görünümü
  gerçek render ve konsol kontrolüyle doğrula.

## Tamamlanan dilim: sistem tepsisi ve uygulama yaşam döngüsü

- [x] Boşta kapatma düğmesini sistem tepsisine gizlemeye bağla.
- [x] Tepsi menüsüne aç ve gerçek çıkış eylemlerini ekle.
- [x] Aktif bağlantının görünmeden sürmesini engelleyen çıkış onayı ekle.
- [x] Named mutex + activation event ile tek-instance ve mevcut pencereyi öne
  getirme davranışını uygula.
- [x] Girdi, hotkey, native stream, WebView ve synchronization kaynaklarını
  deterministik sırayla kapat.
- [x] PerMonitorV2 DPI davranışını WinForms/WPF ortak yapılandırmasına taşı.

## Tamamlanan dilim: güvenli hata ve yeniden deneme deneyimi

- [x] Signaling, peer/native video, ekran paylaşımı ve desktop durumlarını merkezi,
  allowlist kullanıcı hata kataloğunda birleştir; ham exception, token, SDP veya
  ICE ayrıntısını kullanıcı metnine taşıma.
- [x] Sunucu mesajlarını runtime şemayla doğrula; beklenmeyen mesaj veya geçersiz
  ICE yapılandırmasında signaling'i fail-closed durdur ve güvenli recovery göster.
- [x] WebSocket callback'lerini aktif soket nesli/nesliyle sınırla; eski soketin
  open/message/error/close olaylarının yeni bağlantı durumunu değiştirmesini önle.
- [x] Şemadan geçen mesajlara oturum fazı/rol matrisi uygula; geç create/join,
  onay, peer ve signal sonuçlarını etkisiz bırak, aynı bekleyen create/join
  eylemini birleştir ve terminal sonuçtan sonra açık yeni denemeye kadar mesaj
  latch'ini koru. Bozuk/bilinmeyen protokol verisi fail-closed kalır.
- [x] `peer_unavailable` recovery'sinde onaylı `accessMode` değerini koru; ağ
  arızasının kendiliğinden kontrol yetkisi eklemesine veya silmesine izin verme.
- [x] Strict `{ type: "revoke_control", channel: "control", version: 1 }`
  mesajını yalnız aktif host için kabul et. Sunucuda `control` → `view`
  düşüşünü idempotent ve resume'da kalıcı yap; web'de yerel revoke latch'iyle
  anında kapat ve taşıma kaybında mesajı yeniden gönder.
- [x] Recovery eylemlerini oturum rolüne ve gerçekten uygulanabilir işlemlere göre
  sınırla; guest'e host tarafında çalışamayacak yanıltıcı retry sunma.
- [x] WebView2 process ve navigation arızasında kontrol girdilerini bırak, native
  stream'i durdur ve görünür yükleme/crash ekranından yeniden yükleme veya WebView
  yeniden oluşturma akışı sağla. Yalnız WPF'nin `Initialize`/`Yeniden dene`
  `Navigate` çağrısı için tek kullanımlık expected-navigation izni ver; F5,
  Ctrl+R, programatik reload ve diğer beklenmeyen top-level navigasyonları aynı
  fail-closed kapanışa bağla.
- [x] Desktop bridge hata kodlarını capture, encoder, GPU input, control input,
  display switch, quality switch ve native video alanlarına ayır; yalnız allowlist
  kodların web katmanına çıkmasına izin ver.
- [x] Sürümlü `media.state` mesajlarını state, rol, sequence ve hız sınırında
  doğrula; replay ve sıra dışı durum güncellemelerini reddet.
- [x] Tarayıcı host mevcut paylaşımı değiştirirken picker iptal/başarısız olursa
  eski stream canlıysa `sharing` durumuna dön ve görünür allowlist uyarıyı koru;
  eski stream canlı değilse deterministik `idle` durumuna geç.
- [x] Signaling, peer/native video, desktop ve ekran paylaşımı retry eylemlerini
  merkezi recovery notice üzerinden çalıştır; retry öncesi ilgili medya ve input
  yaşam döngüsünü güvenli biçimde durdur.
- [x] Desktop publish'te web paketini source → güvenli staging → final sırasıyla
  deterministik kopyala; stale asset'leri temizle, `index.html` yerel
  `src`/`href` referanslarını fail-fast doğrula; final probe'da source/final
  yol-boyut-SHA bütünlüğünü ayrıca karşılaştır.

## Kapanış ürün kararları

- [x] Windows guest rolü: aynı `EdizRemote.exe`, WebView2 arayüzü üzerinden hem
  destek alan hem destek veren rolünü çalıştırır. Ayrı bir native guest uygulaması
  Faz 3 için gerekli değildir.
- [x] DXGI pointer shape: normalize konum ve çift çizimi önleme Faz 3 kapsamındadır;
  exact pointer shape/piksel maskesi birleşimi sürücü/GPU davranışıyla birlikte
  Faz 6 donanım matrisine ertelenmiştir.
- [x] Clipboard: hassas içerik, veri yönü, boyut/tür sınırı, görünür onay, iptal ve
  audit modeli gerektirdiği için Faz 3 ve V1 kapsamı dışındadır. Faz 4 güvenlik
  modelinden sonra post-V1 açık opt-in özellik olarak yeniden değerlendirilecektir.

## Doğrulama tabanı

- Web: 64/64 test.
- Signaling: 19/19 test.
- TURN public preflight: 7/7 test.
- Native: 40 test başarılı; zorlanmış TURN ortam testi 1 kez atlandı.
- Desktop: 66/66 test.
- Lint, protocol/signaling/web/desktop build ve desktop publish: başarılı.
- Gerçek iki tarayıcı: kod → onay → direct P2P DataChannel, rol/durum paneli ve
  terminal sonuç bildirimi çalıştı; iki konsolda da uyarı/hata yoktu.
- 390×844 mobil: yatay taşma yok; kod girişi düğme durumunu ve terminal bildirimi
  doğru güncelledi.
- İki localhost tarayıcı: guest kalite seçimi host'a gidip onaylı state olarak geri
  döndü; sığdır, 1:1 ve tam ekran giriş/çıkışı çalıştı.
- 390×844 aktif guest görünümü: kalite ve ölçekleme kontrolleri görünür, toolbar
  kırpılmıyor ve yatay taşma yok.
- İki localhost tarayıcı: beş alanlı durum paneli ve süre sayacı ilerledi;
  00:00:12 → 00:00:14 gözlendi, kalite state iki tarafta senkronlandı.
- Gerçek Windows desktop→browser: 1920×1080 native H.264 video, direct P2P,
  kontrol izni ve süre sayacı çalıştı. Bu GPU yolunda imleç kareye bileşik geldiği
  için ayrı HTML katmanı doğru biçimde gizli kaldı; metadata ayrık yolu parser,
  sıra/hız sınırı, koordinat eşleme ve native normalizasyon testleriyle kapsandı.
- 390×844 native aktif guest: beş durum alanı, süre, ölçekleme toolbar'ı ve video
  yatay taşma ve konsol uyarısı/hatası olmadan render edildi.
- Gerçek süreç probe'u: ikinci `EdizRemote.exe` başlatıldıktan sonra yalnızca ilk
  PID çalışmaya devam etti; duplicate süreç aktivasyon sinyali gönderip kapandı.
  Final yayın EXE'si boş ekran yerine dolu arayüz, canlı kod ve
  `2 ekran · H.264 GPU` durumuyla açıldı. Odaklanmış F5 input/native oturumu
  fail-closed durdurup görünür hata ekranını açtı; retry güvenli yüklemeden sonra
  yeni kod üretti. Boşta `Alt+F4` aynı closing yolundan pencereyi tepsiye gizledi;
  EXE'nin yeniden çağrılması yeni pencere açmadan aynı HWND'yi görünür yaptı.
- Final `EdizRemote.exe`: `184540144` bayt, `2026-08-23 22:59:29 +03:00`,
  SHA-256
  `E89F4CD1FE143166E2BDEDE92E0CB19AB92B54541FCF200BC20FD3DEDF70987B`.
  Kaynak ve yayınlanmış `Web` ağaçlarının her biri 4 dosya; göreli yol, boyut ve
  SHA karşılaştırmasında fark `0`.

## Bilinen fiziksel riskler ve ertelenen matris

- Çoklu monitör seçimi parser, native çözümleme, koordinat yaşam döngüsü ve build
  düzeyinde doğrulandı. Fiziksel iki monitörlü desktop→browser oturumunda gerçek
  1→2→1 geçişi henüz yapılmadı; ilk uygun donanım testinde yayın, pointer alanı ve
  kontrol yetkisinin korunması birlikte doğrulanmalıdır.
- Native kalite profilinin gerçek GPU oturumunda 3/8/12 Mbps encoder yeniden
  başlatmalarına dönüştüğü fiziksel desktop→browser testinde henüz ölçülmedi;
  sürücü/GPU matrisiyle Faz 6'da ölçülmelidir.
- Exact DXGI pointer shape/piksel maskesi NVIDIA/Intel/AMD ve farklı ölçekleme/
  rotasyon kombinasyonlarında fiziksel olarak doğrulanmadı; Faz 6 GPU matrisinde
  ele alınacaktır. Faz 3'te normalize konum ve çift çizimi önleme korunur.
- WebView2 renderer/browser process crash ve navigation failure politikaları
  testlerle kapsandı; farklı WebView2 Runtime ve GPU sürücülerinde gerçek fault
  injection/uzun süreli recovery matrisi Faz 6'da çalıştırılmalıdır.
- Tepsiye gizleme ve tek-instance yeniden aktivasyon gerçek yayın EXE'sinde geçti.
  Tepsi bağlam menüsündeki `Çıkış` eyleminin fiziksel tıklama matrisi henüz ayrı
  çalıştırılmadı; named handle, kapanış politikası ve kaynak bırakma testleriyle
  kapsanıyor ve Faz 6 Windows UI matrisinde tekrar doğrulanacaktır.
- Build, SIPSorcery 10.0.12 için iki yüksek önem dereceli NU1903 uyarısı veriyor.
  Bağımlılık yükseltmesi uyumluluk testiyle Faz 4 güvenlik sertleştirmesinde
  kapatılmalıdır.

Bu maddeler Faz 3'ün günlük destek UX kabulünü engellemez; donanım çeşitliliği,
uzun süreli fault injection ve bağımlılık güvenliği sırasıyla Faz 6 ve Faz 4'ün
açık kabul işleridir.

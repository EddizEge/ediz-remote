# Faz 3 kabul kanıtı

Tarih: 2026-08-23

Durum: **TAMAMLANDI. Rol/monitör/durum, kalite/ölçekleme, uzak imleç ve
bağlantı süresi, kalıcı kontrol geri alma, sistem tepsisi/yaşam döngüsü,
güvenli hata/yeniden deneme ve publish bütünlüğü dilimleri kabul matrisini
geçti.**

## Kabul kriterleri

| Kriter | Sonuç | Kanıt |
|---|---:|---|
| Teknik olmayan host yalnızca uygulamayı açıp kodu söyleyerek destek alabilir | Geçti | Aynı Windows EXE'de “Destek al” rolü, tek kullanımlık kod, açık görüntü/kontrol onayı, görünür aktif oturum ve tek tıkla iptal akışı; localhost tarayıcı ve gerçek desktop→browser oturumları |
| Operatör monitörü ve ölçeklemeyi bağlantıyı koparmadan değiştirebilir | Geçti | Sürümlü monitör ilanı/seçimi, host ve native doğrulaması, aynı oturumda native offer yenileme, koordinat alanının yakalamayla birlikte taşınması; sığdır, 1:1 ve tam ekran etkileşim testleri |
| Hata durumları donmuş ekran yerine görünür durum ve iyileşme yolu verir | Geçti | Merkezi allowlist hata kataloğu, runtime signaling şeması, fail-closed protokol ve WebView yaşam döngüsü, role uygun RecoveryNotice eylemleri, WPF yükleme/crash ekranı ve sınırlı medya retry akışları |

“Bütün hata durumları” kabulü, uygulamanın sınırlarında modellediği signaling,
WebRTC, ekran paylaşımı, native video, desktop bridge ve WebView2 hata
kategorilerini kapsar. Tanınmayan ham hata veya protokol verisi kullanıcıya
aktarılmaz; güvenli genel allowlist durumuna dönüştürülür ya da ilgili erişim
fail-closed durdurulur.

## Hata ve yeniden deneme kapanış matrisi

| Kaynak | Güvenli davranış | Kullanıcı iyileşmesi | Kanıt |
|---|---|---|---|
| Merkezi kullanıcı hata modeli | Yalnızca allowlist kod, başlık ve metin gösterilir; ham exception, token, SDP ve ICE ayrıntısı kullanıcı yüzeyine taşınmaz | Rol ve oturum durumunda gerçekten uygulanabilen tek recovery eylemi gösterilir | `userFacingIssue` eşleme/öncelik testleri ve App action yönlendirmesi |
| Signaling sunucu mesajı | Her mesaj runtime şemada doğrulanır. Yalnız güncel WebSocket neslinin callback'leri işlenir; faz/rol dışındaki geç create/join, onay, peer ve signal sonuçları ile eski nesil olayları etkisizdir. Aynı bekleyen create/join eylemi birleştirilir; bozuk/bilinmeyen protokol verisi fail-closed kapanır ve terminal latch açık yeni denemeye kadar oturum mesajlarını engeller | Güvenli genel hata ile signaling yeniden bağlama veya yeni kod yolu; eski callback, geç cevap ya da çift tıklama yetki/oturum oluşturamaz | Signaling hook şema, soket kimlik guard'ı, faz/rol late-message, pending-action coalescing ve terminal-geçiş testleri |
| Kontrol geri alma | İstemci yalnız strict `{ type: "revoke_control", channel: "control", version: 1 }` mesajını üretir. Yalnız aktif host kabul edilir; sunucu `control` → `view` düşüşünü idempotent uygular ve resume'da `view` döndürür. Web host erişimi önce yerelde kapatır, revoke latch'ini korur ve geçici kayıpta gerekirse mesajı yeniden yollar | Aynı oturum görüntüleme modunda sürer; açık yeni oturum olmadan kontrol kendiliğinden geri açılamaz | Protocol strict-schema; signaling rol/faz, duplicate revoke ve resume; web latch/retransmit testleri |
| Peer ve native video | Retry eski peer/native kaynaklarını dispose eder; host/guest yeteneğine göre yanıltıcı eylem gösterilmez. `peer_unavailable` onaylı `accessMode` değerini korur; yerel revoke latch'i varsa `view` önceliklidir | Aynı onaylı oturumda bağlantı veya yalnız görüntü yeniden kurulur; mümkün değilse yeni kod istenir | Peer/native retry, accessMode recovery ve merkezi issue öncelik testleri |
| Desktop bridge | Capture, encoder, GPU input, control input, display switch, quality switch ve native video hataları ayrı alanlarda tutulur; bir alan diğerinin sonucunu maskelemez | İlgili desktop durumunu yeniden sorgulama veya host tarafında native video retry | Desktop error-code allowlist ve web bridge parser/state testleri |
| WebView2 navigation/process arızası | Tutulan input bırakılır ve native stream durdurulur. Yalnız WPF'nin tek kullanımlık expected-navigation izni kabul edilir; F5, Ctrl+R, programatik reload ve beklenmeyen top-level navigasyon fail-closed kapanır | Güvenli hata ekranından yeni expected-navigation izniyle yerel navigasyon; browser arızasında WebView yeniden oluşturma | Saf navigation policy, reload accelerator, process-failure, loading overlay ve retry testleri |
| `media.state` | Kanal/sürüm/state/rol/sequence doğrulanır; replay, sıra dışı ve hız limiti üstü güncellemeler etkisizdir | Son geçerli görünür medya durumu korunur; host yeni sıralı durum yayınlayabilir | Parser, sequence ve rate-window testleri |
| Tarayıcı ekranını değiştirme | Picker iptal/başarısız olduğunda eski stream hâlâ canlıysa paylaşım gizlenmez: durum `sharing` olur ve allowlist uyarı görünür kalır. Canlı stream yoksa `idle` olur | Kullanıcı ekranı yeniden seçebilir veya görünür aktif paylaşımı durdurabilir | Stateful hook testi: `sharing → requesting → sharing`, aynı stream ve durdurulmayan track |
| WPF başlangıç/yükleme | Initialization veya navigation hatası boş/donmuş WebView bırakmaz; ayrı hata ekranı native erişim kapalıyken görünür. Failure bekleyen navigation iznini temizler | Uygun durumda tek kullanımlık yeni izin kuran “Yeniden dene”; retry mümkün değilse açık kalıcı yönlendirme | Desktop loading/retry, tek-kullanımlık navigation ve process-failure testleri |
| Desktop publish | Kaynak web dist'i doğrulanır, güvenli staging'e kopyalanır, stale final ağaç değiştirilir ve final `index.html` asset referansları fail-fast denetlenir; final probe source/final göreli yol-boyut-SHA eşitliğini ayrıca karşılaştırır | Asset eksikliği başarılı publish veya boş EXE ekranı olarak gizlenemez; paket yeniden üretilir | Paketleme testleri, 4 kaynak/4 yayın dosyası ve fark `0` karşılaştırması |

Recovery eylemi otomatik olarak yeni yetki üretmez. Host onayı, oturum rolü,
kontrol yetkisi ve mevcut disconnect sırasında input bırakma kuralları her retry
sonrasında yeniden uygulanır.

## Kapanış ürün kararları

| Konu | Karar | Gerekçe / sonraki adım |
|---|---|---|
| Native guest rolü | Aynı `EdizRemote.exe`, WebView2 arayüzü üzerinden hem destek alan hem destek veren rolünü destekler | Ayrı guest binary'si günlük destek UX'ine yeni değer eklemeden paketleme ve güncelleme yüzeyini büyütür |
| Exact DXGI pointer shape | Faz 6 GPU/sürücü matrisine ertelendi | Faz 3 normalize imleç konumunu ve çift çizimi önlemeyi sağlıyor; piksel maskesi/shape birleşimi farklı GPU, DPI ve rotasyonlarda fiziksel doğrulama gerektiriyor |
| Clipboard senkronizasyonu | Faz 3 ve V1 kapsamı dışında | Pano hassas veri taşıyabilir. Veri yönü, içerik türü/boyutu, görünür onay, iptal ve audit modeli Faz 4 sonrasında tasarlanır; özellik post-V1 ve açık opt-in olarak değerlendirilir |

Bu kararlar eksik Faz 3 kabul maddesi değildir. Guest rolü mevcut ürünle
karşılanmıştır; pointer shape görsel doğruluk iyileştirmesi Faz 6 donanım
kalitesidir; clipboard ise güvenlik modeli tamamlanmadan eklenmemesi gereken ayrı
bir post-V1 yetenektir.

## Otomatik doğrulama tabanı

| Paket | Sonuç |
|---|---:|
| Web | 64 test başarılı |
| Signaling | 19 test başarılı |
| TURN public preflight | 7 test başarılı |
| Native | 40 test başarılı, zorlanmış TURN ortam testi 1 kez atlandı |
| Windows desktop | 66 test başarılı |
| Lint, protocol/signaling/web/desktop build ve desktop publish | Başarılı |

## Render ve fiziksel kanıt

- Gerçek iki tarayıcıda kod → onay → direct P2P DataChannel, rol/durum paneli,
  kalite seçimi, monitör protokolü, ölçekleme etkileşimleri ve terminal sonuç
  bildirimi çalıştı; iki konsolda da hata/uyarı görülmedi.
- 390×844 guest görünümünde durum alanları, kalite/ölçekleme toolbar'ı, süre,
  terminal bildirim ve video yatay taşma olmadan render edildi.
- Gerçek Windows desktop→browser oturumunda 1920×1080 native H.264, direct P2P,
  kontrol izni, bağlantı süresi ve güvenli kapanış yaşam döngüsü çalıştı.
- Final self-contained EXE boş ekran yerine dolu arayüz, canlı kod ve
  `2 ekran · H.264 GPU` durumunu gösterdi. Odaklanmış F5, input ile native
  video/oturumu fail-closed durdurup görünür güvenli hata ekranını açtı;
  `Yeniden dene` güvenli yüklemeden sonra yeni kod üretti.
- İkinci gerçek `EdizRemote.exe` yalnızca activation sinyali göndererek kapandı ve
  tek pencere kaldı. Boşta `Alt+F4` pencereyi tepsiye gizledi; EXE tekrar
  çağrıldığında yeni pencere oluşturmadan aynı HWND yeniden görünür oldu.
- Faz 2'de kabul edilen fiziksel WAN direct/recovery/relay ve ekran modu recovery
  tabanı Faz 3 arayüzünde korunmuştur.

## Final artifact kimliği

| Alan | Değer |
|---|---|
| Dosya | `artifacts/windows-desktop/win-x64/EdizRemote.exe` |
| Boyut | `184540144` bayt |
| Son yazma | `2026-08-23 22:59:29 +03:00` |
| SHA-256 | `E89F4CD1FE143166E2BDEDE92E0CB19AB92B54541FCF200BC20FD3DEDF70987B` |
| Web ağacı | Kaynak 4 dosya, yayın 4 dosya; göreli yol/boyut/SHA farkı `0` |

## Bilinen fiziksel riskler ve ertelenen doğrulamalar

| Risk | Mevcut güvence | Kapanacağı faz |
|---|---|---|
| Fiziksel iki monitörde canlı 1→2→1 geçişi henüz çalıştırılmadı | Monitör parser'ı, native çözümleme, aynı oturum offer yenileme, input bırakma ve koordinat yaşam döngüsü otomatik testlerde kapsanıyor | Faz 6 çoklu monitör matrisi |
| Native 3/8/12 Mbps kalite profilleri gerçek GPU oturumunda birlikte ölçülmedi | Profil sınırları, state aktarımı ve encoder yapılandırması testlerde kapsanıyor; RTCP adaptasyonu profil tavanı altında kalıyor | Faz 6 NVIDIA/Intel/AMD matrisi |
| Exact DXGI pointer shape/piksel maskesi farklı GPU, DPI ve rotasyonda doğrulanmadı | Normalize konum, sıra/hız sınırı, DOM yerleşimi ve kareye bileşik imleçte çift çizimi önleme hazır | Faz 6 GPU/sürücü matrisi |
| WebView2 browser/renderer crash'i farklı Runtime ve GPU sürücülerinde fiziksel fault injection ile çalıştırılmadı | Process sınıflandırması, tek kullanımlık expected navigation, reload kısayolu/programatik reload reddi, fail-closed native stop/input release ve retry/recreate politikası desktop testlerinde kapsanıyor | Faz 6 fault-injection ve soak matrisi |
| Tepsi bağlam menüsündeki gerçek `Çıkış` tıklaması ayrı fiziksel matriste çalıştırılmadı | Boşta closing→tepsi ve aynı window id ile tek-instance aktivasyon yayın EXE'sinde geçti; çıkış/kaynak bırakma testleri hazır | Faz 6 Windows UI matrisi |
| SIPSorcery 10.0.12 için iki yüksek önem dereceli NU1903 uyarısı bulunuyor | Mevcut davranış test tabanıyla sabit; sürüm yükseltmesi uyumluluk/regresyon doğrulamasıyla yapılacak | Faz 4 dependency ve supply-chain sertleştirmesi |

Bu fiziksel matris maddeleri mevcut Faz 3 davranışının sessiz veya yetkisiz
çalışmasına izin vermez: bilinmeyen/protokol dışı durum fail-closed kalır, bilinen
runtime arızaları görünür retry yüzeyine gider. Donanım çeşitliliği ve uzun süreli
dayanıklılık V1 yayın kalitesi olan Faz 6'nın kabul kapsamındadır.

## Sonraki ana faz

Sıradaki çalışma **Faz 4 — güvenlik sertleştirmesi**dir. İlk çıktı; kod brute
force, signaling takeover, replay, yetkisiz input, TURN abuse, downgrade, hassas
loglar ve supply-chain risklerini var olan kontroller, eksikler ve testlerle
eşleyen yazılı threat model olmalıdır.

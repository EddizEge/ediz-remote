# Faz 1 kabul kaydı — güvenli fare ve klavye kontrolü

Faz 1, 23 Temmuz 2026 tarihinde Windows masaüstü host ile Chromium tabanlı guest
arasında gerçek DXGI/H.264 ve WebRTC P2P oturumunda doğrulandı.

## Kabul matrisi

| Kriter | Kanıt | Sonuç |
|---|---|---|
| Ayrı görüntü/kontrol onayı | Gerçek WPF onay penceresi ve desktop testleri | Geçti |
| Tek/çift tıklama | Hedef Windows tarayıcısında gerçek tıklama ve metin seçimi | Geçti |
| Sürükleme ve buton yaşam döngüsü | Native kayıtlı-enjektör dizisi ve bırakma testleri | Geçti |
| Dikey/yatay tekerlek | Gerçek hedef sayfada kaydırma; native delta testi | Geçti |
| Temel klavye ve kısayol | Gerçek hedef adres çubuğunda yazma ve `Ctrl+A`; `Ctrl+C` native testi | Geçti |
| Türkçe karakterler | `ğ`, `ş` parser/Unicode enjeksiyon testleri | Geçti |
| DPI/negatif/çoklu monitör koordinatı | Normalize→fiziksel ve virtual desktop testleri | Geçti |
| Disconnect/focus loss/revoke bırakması | Web yaşam döngüsü ve native `ReleaseAll` testleri | Geçti |
| Yetkisiz/replay/eski mesaj reddi | Oturum, sequence ve aktif grant testleri | Geçti |
| Pointer birleştirme ve hız sınırı | Web coalescing/rate limiter ve native 240 olay/s testi | Geçti |
| Görünür kontrol ve tek tıkla geri alma | WPF→browser gerçek oturum QA | Geçti |
| Global acil durdurma | `Ctrl+Alt+Shift+F12` ile gerçek oturumda native stop ve guest revoke | Geçti |
| Secure attention sınırı | `Ctrl+Alt+Del` bloklama testi; UAC/secure desktop bypass yok | Geçti |
| Masaüstü/mobil render | Normal ve 390×844 viewport tarayıcı QA; konsol hatası yok | Geçti |

## Son doğrulama tabanı

- Native host testleri: 34/34.
- Web testleri: 11/11.
- Signaling testleri: 5/5.
- Windows desktop testleri: 18/18.
- TypeScript lint ve production build başarılı.
- NVIDIA RTX 4060 Ti DXGI/GPU encode probe ve beş saniyelik stream probe başarılı.
- Gerçek desktop→browser oturumunda direct P2P, yaklaşık 0–2 ms yerel gecikme,
  native görüntü, kontrol, revoke ve temiz disconnect doğrulandı.

## Bilinçli güvenlik sınırları

- Kontrol yalnızca Windows masaüstü host'ta ve ayrı açık onayla çalışır.
- UAC secure desktop, kilit ekranı, Session 0 ve `Ctrl+Alt+Del` desteklenmez.
- Acil durdurma kısayolu kaydedilemiyorsa “Görüntüle + kontrol et” seçeneği açılmaz.
- Faz 2'ye bırakılan TURN/reconnect işleri, Faz 1'in input yetki modelini gevşetmez.

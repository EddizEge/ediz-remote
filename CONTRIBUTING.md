# Katkı rehberi

Ediz Remote, günlük danışmanlık desteğine odaklanan ve güvenlik sertleştirmesi
süren bir projedir. Küçük, test edilebilir değişiklikler ve tekrarlanabilir hata
bildirimleri değerlidir.

## Hata bildirme

Güvenlik dışındaki hatalar için bir issue aç. Beklenen ve gerçekleşen davranışı,
yeniden üretme adımlarını, uygulama/Windows/tarayıcı sürümünü belirt. Native
görüntü hatalarında GPU ve sürücü sürümü de yardımcı olur.

Token, bağlantı kodu, SDP/ICE, TURN credential, müşteri ekranı veya kişisel veri
paylaşma. Güvenlik bulguları için [SECURITY.md](SECURITY.md) yolunu izle.

## Geliştirme

1. [Teknik rehberi](docs/DEVELOPMENT.md) ve ilgili bileşenin belgesini oku.
2. Değişikliği tek bir davranışa odakla; mevcut kullanıcı değişikliklerini koru.
3. İlgili testleri, lint ve build kontrollerini çalıştır.
4. PR açıklamasında değişen davranışı, doğrulamayı ve kalan sınırları belirt.

Güven sınırlarında şema, rol, yetki, sıra, boyut ve hız doğrulaması gerekir.
Host onayı, anında revoke, görünür oturum ve disconnect sırasında input bırakma
kuralları korunmalıdır. Protokol değişiklikleri açıkça sürümlenmelidir.

Repo için henüz bir açık kaynak lisansı seçilmedi. Kullanım ve katkının hakları
konusunda proje sahibiyle anlaşılmadan bir lisans varsayma.

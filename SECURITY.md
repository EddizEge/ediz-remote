# Güvenlik politikası

Ediz Remote geliştirme aşamasındadır. İmzalı production Windows release kabulü
ve Faz 4 güvenlik kabulü henüz tamamlanmamıştır. Test sonuçları belirli sürüm ve
tarihlere aittir; tüm donanım ve ağ koşulları için garanti oluşturmaz.

## Bir güvenlik açığı bildirme

GitHub **Security → Report a vulnerability** üzerinden özel bir bildirim gönder:

https://github.com/EddizEge/ediz-remote/security/advisories/new

Güvenlik bulgularını public issue, PR veya tartışmada paylaşma. Bildirimde
etkilenen commit/sürüm, güven sınırı, yeniden üretme adımları ve beklenen etkiyi
anlat. Gerçek müşteri ekranı, credential, token, SDP/ICE veya kişisel veri ekleme.
Üretim sistemi yerine izinli bir yerel test ortamı kullan.

## Güvenlik tasarımı

- Host onayından önce sinyalleşme, yakalama ve input uygulaması başlamaz.
- Kontrol izni görünürdür; host anında iptal edebilir.
- UAC secure desktop, kilit ekranı ve Session 0 sınırları aşılmaz.
- TURN credential kısa ömürlüdür; kalıcı secret istemci paketine gömülmez.
- Protokol doğrulaması, kaynak kotaları, replay koruması ve minimal audit uygulanır.

Ayrıntılar: [tehdit modeli](docs/THREAT_MODEL.md),
[audit modeli](docs/SECURITY_AUDIT.md), [Faz 4 planı](docs/PHASE4_PLAN.md),
[container release](docs/CONTAINER_RELEASE.md) ve
[Windows release](docs/WINDOWS_RELEASE.md).

<p align="center">
  <img src="docs/assets/ediz-remote-banner.svg" alt="Ediz Remote — Kodunu paylaş. İzin ver. Birlikte çöz." width="100%">
</p>

<p align="center">
  <strong>Windows için P2P öncelikli, kendi sunucunda çalışan uzaktan destek.</strong><br>
  GPU destekli görüntü · Açık kullanıcı onayı · Türkçe arayüz
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows_10%2F11-2563eb?style=flat-square" alt="Windows 10 ve 11">
  <img src="https://img.shields.io/badge/transport-WebRTC_P2P-16a34a?style=flat-square" alt="WebRTC P2P">
  <img src="https://img.shields.io/badge/video-H.264_GPU-0ea5e9?style=flat-square" alt="H.264 GPU">
  <img src="https://img.shields.io/badge/self--hosted-Raspberry_Pi_5-f97316?style=flat-square" alt="Raspberry Pi 5">
  <img src="https://img.shields.io/badge/status-Faz_4_geliştirme-eab308?style=flat-square" alt="Faz 4 geliştirme">
</p>

<p align="center">
  <a href="#indir-ve-kullan">İndir</a> ·
  <a href="#hızlı-başlangıç">Hızlı başlangıç</a> ·
  <a href="#nasıl-çalışır">Mimari</a> ·
  <a href="#yol-haritası">Yol haritası</a> ·
  <a href="docs/DEVELOPMENT.md">Teknik rehber</a> ·
  <a href="SECURITY.md">Güvenlik</a>
</p>

---

Ediz Remote, günlük müşteri desteği için geliştirilen Windows öncelikli bir
uzaktan erişim projesidir. Destek alan kişi uygulamayı açar, altı haneli kodunu
paylaşır ve gelen isteği onaylar. Destek veren kişi modern bir Chromium
tarayıcısından veya aynı Windows uygulamasından bağlanabilir.

Görüntü ve kontrol mümkün olduğunda cihazlar arasında doğrudan WebRTC ile akar.
Kendi sunucundaki signaling servisi kod, onay ve bağlantı görüşmesini yönetir;
doğrudan bağlantı kurulamazsa coturn devreye girer.

> **Geliştirme durumu:** Faz 1–3 tamamlandı; Faz 4 güvenlik sertleştirmesi sürüyor.
> İlk kullanılabilir Windows sürümü [GitHub Releases](https://github.com/EddizEge/ediz-remote/releases/latest)
> sayfasında; imzasızdır, kaynağı ve bütünlüğü GitHub attestation ile doğrulanır.
> İmzalı installer ve temiz Windows 10/11 kabulü henüz tamamlanmadı.

## Neler sunuyor?

| | Özellik | Nasıl çalışıyor? |
|---|---|---|
| 🖥️ | GPU destekli masaüstü görüntüsü | DXGI yakalama, NV12 dönüşümü ve donanım H.264 encode |
| 🤝 | Kullanıcı onayı | 10 dakika geçerli tek kullanımlık kod; ayrı görüntüleme ve kontrol izni |
| 🖱️ | Fare ve klavye | Reliable giriş kanalı, düşük gecikmeli pointer ve güvenli input bırakma |
| 🌐 | P2P + TURN | Doğrudan bağlantı önceliği, kısa ömürlü HMAC credential ile relay fallback |
| 🔄 | Oturum kurtarma | 30 saniyelik grace period, reconnect ve kontrollü ICE yenileme |
| 🎛️ | Günlük destek araçları | Çoklu monitör, kalite profilleri, tam ekran, 1:1 ve sığdır |
| 🛑 | Görünür kontrol | Anında yetki iptali ve `Ctrl+Alt+Shift+F12` acil durdurma |
| 🏠 | Self-hosted altyapı | Raspberry Pi 5 / Linux, Docker Compose ve Cloudflare Tunnel |

Tarayıcı host fallback'i `getDisplayMedia` üzerinden yalnız görüntüleme sağlar.
Native fare ve klavye kontrolü Windows host uygulamasında uygulanır.

## Tasarım

Sade, Türkçe bir destek akışı: kodunu paylaş, isteği incele, izin ver.

<p align="center">
  <img src="docs/design/connection-screen-concept.png" alt="Ediz Remote bağlantı ekranı tasarım konsepti" width="900">
</p>

<details>
<summary><strong>Bağlantı onayı tasarımını göster</strong></summary>

<p align="center">
  <img src="docs/design/incoming-request-concept.png" alt="Ediz Remote açık kullanıcı onayı tasarım konsepti" width="900">
</p>

</details>

*Bu görseller arayüz tasarım konseptleridir; güncel uygulama ekran görüntüsü değildir.*

## Nasıl çalışır?

```mermaid
flowchart LR
    H["Windows host<br/>DXGI · GPU H.264 · SendInput"]
    G["Destek veren<br/>Chromium / Windows WebView2"]
    S["Self-hosted signaling<br/>Kod · Onay · SDP / ICE"]
    T["coturn<br/>TURN fallback"]

    H <-->|"HTTPS / WSS"| S
    G <-->|"HTTPS / WSS"| S
    H <-->|"Onay sonrası WebRTC<br/>Görüntü + DataChannel"| G
    H -.->|"Doğrudan bağlantı kurulamazsa"| T
    T -.-> G
```

Cloudflare Tunnel web arayüzü ve signaling içindir. Masaüstü medyası P2P veya
TURN üzerinden taşınır. Host onayından önce SDP/ICE aktarımı, ekran yakalama ve
giriş enjeksiyonu başlamaz.

**Teknoloji:** React 19 · TypeScript · Vite · Express · WebSocket · Zod ·
.NET 8 · WPF · WebView2 · SIPSorcery · D3D11 · Media Foundation

## İndir ve kullan

Windows sürümü [GitHub Releases](https://github.com/EddizEge/ediz-remote/releases/latest)
sayfasında yayınlanır; kurulum gerektirmez.

1. **Destek alan:** `EdizRemote.win-x64.zip` dosyasını indirip bir klasöre çıkarın
   ve `win-x64\EdizRemote.exe` dosyasını açın. Uygulama henüz imzasız olduğu için
   Windows SmartScreen uyarı gösterebilir: **Ek bilgi → Yine de çalıştır**. İlk
   oturumda Windows Güvenlik Duvarı izin isterse **İzin ver** seçin.
2. Ekrandaki 6 haneli kodu destek verene iletin; gelen isteği **Yalnızca görüntüle**
   ya da **Görüntüle + kontrol et** ile onaylayın.
3. **Destek veren:** <https://remote.edizegemercan.com.tr> adresini Chrome ya da Edge
   ile açıp kodu girin (veya aynı Windows uygulamasından bağlanın).
4. Kontrol izni ayrı verilir; **Kontrolü geri al**, **Bağlantıyı kes** ve
   `Ctrl+Alt+Shift+F12` acil durdurma her an kullanılabilir.

Arayüz "beklenmedik şekilde durdu" derse **Yeniden dene** yeterlidir. MSI
Afterburner/RivaTuner gibi ekran üstü gösterge araçları bunu açılışta tetikleyebilir;
o araçta `EdizRemote.exe` ve `msedgewebview2.exe` için uygulama algılamasını kapatın.

İndirilen dosyanın kaynağı ve bütünlüğü sürüm notlarındaki SHA-256 değerleri ve
`gh attestation verify` komutuyla doğrulanabilir
([Windows release rehberi](docs/WINDOWS_RELEASE.md#provenance-github-attestation-yolu)).

## Hızlı başlangıç

Node.js 22+ LTS ve Git gerekir.

```bash
git clone https://github.com/EddizEge/ediz-remote.git
cd ediz-remote
npm ci
npm run dev
```

Arayüz: **http://localhost:8080** · Signaling: **http://localhost:8788**

Ekran paylaşımı için localhost veya HTTPS gerekir. Yerel tarayıcı denemesinde
iki istemci açıp kod ve onay akışını kullanabilirsin.

### Windows masaüstü

Windows üzerinde yardımcı betikler gerekirse .NET 8 SDK'yı yerel `.tools`
dizinine hazırlar.

```powershell
npm run desktop:test
npm run desktop:run
npm run desktop:publish
```

Yerel çıktı: `artifacts/windows-desktop/win-x64/EdizRemote.exe`.
İmzalama ve katalog doğrulaması için [Windows release rehberini](docs/WINDOWS_RELEASE.md) oku.

### Self-hosted kurulum

Pi/Linux üzerinde secret dosyalarını ve TURN adreslerini hazırladıktan sonra
production imajlarını tarayıp aynı denetlenmiş imajlarla dağıt:

```bash
npm run security:containers
npm run security:container:deploy
```

Tam kurulum: [geliştirme ve dağıtım rehberi](docs/DEVELOPMENT.md#raspberry-pi-5-kurulumu),
[TURN](docs/TURN.md) ve [container release kapısı](docs/CONTAINER_RELEASE.md).

## Doğrulama

```powershell
npm test
npm run lint
npm run build
npm run native:test
npm run desktop:test
npm run release:windows:test
npm run security:audit
```

Native capture ve GPU probe'ları Windows donanımı, gerçek relay testleri Docker
ve uygun ağ ortamı gerektirir. Son kaydedilen 2026-10-12 GitHub yayın derlemesinde
seed'li fuzz, signaling durum makinesi matrisi ve audit tatbikatı birim testleri
dahil 614 npm testi başarılıdır (1 ortam testi atlanır); aynı derlemede 54 native
(+1 atlanan), 125 desktop ve 234 Windows release testi geçmiştir. Audit yazım
arızasının fail-closed davranışı `npm run security:audit-drill` ile yerel Docker'da
tatbik edilir. Bu sayılar tarihsel doğrulamadır; ayrıntılar
[teknik rehberde](docs/DEVELOPMENT.md).

## Yol haritası

| Faz | Kapsam | Durum |
|---|---|---|
| 1 | Güvenli fare ve klavye kontrolü | ✅ Tamamlandı |
| 2 | İnternet bağlantısı ve oturum kurtarma | ✅ Tamamlandı |
| 3 | Uzaktan destek kullanıcı deneyimi | ✅ Tamamlandı |
| 4 | Güvenlik sertleştirmesi | 🛠️ Devam ediyor |
| 5 | İmzalı installer ve güncelleme | ⏳ Sırada |
| 6 | Soak testleri ve GPU/ağ matrisi | ⏳ Sırada |

Production Pi 2026-10-12'de doğrulanmış Faz 4 container'larıyla (arm64 tarama
sıfır bulgu, read-only, UID 1000) wire v3'e geçti. Aynı gün GitHub'da derlenip
attest edilen ilk Windows paketiyle production üzerinden gerçek oturumlar
(doğrudan P2P ve TURN relay, kontrol/revoke) kuruldu; sonrasında production
log/audit dosyalarında hassas veri bulunmadı ve audit arıza davranışı izole
Docker tatbikatıyla doğrulandı. Bir arıza senaryosunda görülen masaüstü çökmesi
(NVIDIA donanım encoder'ının kapanış yarışı) aynı gün düzeltildi. Relay'de görüntü
hattı yenilemesinin kontrol bağlantısını düşürmesi ve web bileşeni çöktükten sonra
arayüzün yeniden kurulamaması da düzeltildi; güncel sürüm `windows-v0.1.0.5`.
Faz 4'te kalan iş Windows yayınının temiz Windows 10/11 doğrulamasıdır.
Ücretli sertifika gelene kadar Windows sürümleri imzasız yayınlanır;
bütünlük ve kaynak GitHub artifact attestation + SHA-256 ile doğrulanır
(`npm run release:windows:verify-provenance`), SmartScreen ilk çalıştırmada uyarı
verir. Anti-rollback ve build provenance kapısı hazırdır; yayın temiz klondan
artan release sequence ile üretilir. [Faz 4 planı →](docs/PHASE4_PLAN.md)

Ses, dosya aktarımı, clipboard ve gözetimsiz erişim V1 sonrası kapsamındadır.
UAC secure desktop, kilit ekranı, Session 0 ve `Ctrl+Alt+Del` sınırları aşılmaz.
Döndürülmüş ekran ve exact DXGI pointer shape desteği henüz tamamlanmadı.

## Belgeler ve katkı

| Belge | İçerik |
|---|---|
| [Geliştirme rehberi](docs/DEVELOPMENT.md) | Komutlar, deployment ve tarihsel doğrulama |
| [Protokol](docs/PROTOCOL.md) | Signaling, mesaj şemaları ve yetki sınırları |
| [Windows host](docs/WINDOWS_HOST.md) | Capture, encoder, RTP ve native WebRTC |
| [Windows desktop](docs/WINDOWS_DESKTOP.md) | WPF, WebView2 ve paketleme |
| [Tehdit modeli](docs/THREAT_MODEL.md) | Varlıklar, güven sınırları ve açık riskler |
| [Faz 4 kabul kanıtı](docs/PHASE4_ACCEPTANCE.md) | Kriter bazında kanıt, kanıt türü ve kalan engeller |
| [Audit modeli](docs/SECURITY_AUDIT.md) | Minimal olay şeması ve retention |
| [Katkı rehberi](CONTRIBUTING.md) | Hata bildirimi ve geliştirme yaklaşımı |
| [Güvenlik politikası](SECURITY.md) | Hassas bulguları özel bildirme |

Güvenlik dışındaki hata ve önerileri [Issues](https://github.com/EddizEge/ediz-remote/issues)
üzerinden paylaşabilirsin. Güvenlik bulguları için özel bildirim yolunu kullan.

**Lisans:** Henüz bir açık kaynak lisansı atanmadı. Repo görünürlüğü public olsa da
yeniden kullanım ve dağıtım koşulları için proje sahibinden izin alınmalıdır.

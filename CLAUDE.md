# Ediz Remote — Claude teslim ve devam rehberi

Teslim tarihi: **9 Ekim 2026** · Dil: **Türkçe**

Bu dosya projeyi devralan Claude için başlangıç bağlamıdır. Projeyi baştan kurma;
mevcut uygulamayı ve doğrulanmış güvenlik davranışlarını koruyarak ilerle.
Kök [AGENTS.md](AGENTS.md) çalışma kurallarını içerir; alt dizinde daha özel bir
ajan rehberi varsa ilgili alanda onu da oku. Bu teslim, kaynak kod ve diğer
belgelerin yerine geçmez.

## 1. İlk okuyuşta bilmen gerekenler

- Proje: Windows öncelikli, P2P uzaktan destek uygulaması; AnyDesk alternatifidir.
- Amaç: Ediz'in kendi müşterilerine güvenilir destek verebildiği kullanılabilir V1.
  Lisanslama/abonelik veya geniş yönetim paneli şu an öncelik değildir.
- Faz 1, 2 ve 3 kabulü tamamlandı. **Faz 4 güvenlik sertleştirmesi devam ediyor.**
- Faz 4'ün önemli kod ve politika işleri hazır; gerçek Pi arm64 deployment ve
  gerçek sertifikalı Windows release kabulü henüz tamamlanmadı.
- Installer ve otomatik güncelleme Faz 5; soak ve GPU/ağ matrisi Faz 6 kapsamındadır.
- GitHub: <https://github.com/EddizEge/ediz-remote> — public, varsayılan dal `main`.
- Yerel proje: `C:\Users\Eddiz\Remote Desk`.
- Teslim öncesi kaynak commit'i: `cc0dff9bda320e3851280734e328ce0ea48eecc6`.
  Yerel `origin/main` kaydı aynı commit'i gösteriyor; bu turda remote fetch yapılmadı.
- Teslim hazırlığı öncesinde çalışma ağacı temizdi. Bu dosya 2026-10-09'da devir
  sonrası çalışmalarla birlikte depoya eklendi.
- **2026-10-09 devir sonrası:** dependency, anti-rollback/provenance, fuzz ve durum
  makinesi dilimleri `main`'de; Faz 4 kriter bazında kanıt
  [`docs/PHASE4_ACCEPTANCE.md`](docs/PHASE4_ACCEPTANCE.md).

## 2. Teslim sırasında kontrol edilenler

9 Ekim'de yalnız repo durumu, belgeler ve yerel artifact kimlikleri kontrol edildi.
Test, dependency audit, container scan, Pi erişimi veya canlı production testi
bu teslim turunda yeniden çalıştırılmadı. Aşağıdaki başarı sayıları **2 Eylül
2026 tarihli kabul tabanıdır**, güncel tarama sonucu değildir.

| Doğrulama | Son kaydedilen sonuç |
|---|---|
| Toplu `npm test` | 233 başarılı, 1 ortam testi atlandı |
| Alt dağılım | TURN 13, safe-output 10, container policy 22, web 100, protocol 10, signaling 78 başarılı + 1 atlanan |
| Native host | 42 başarılı, zorlanmış TURN ortamı isteyen 1 test atlandı |
| Windows desktop | 106 başarılı |
| Windows release politika/katalog | 31 başarılı |
| Lint / build / publish | Başarılı |
| npm ve dört NuGet proje denetimi | 0 açık |
| Gerçek Docker Desktop `linux/amd64` | 3 hedefte HIGH/CRITICAL 0 |
| Yerel HMAC TURN relay | 6/6 |

**2026-10-09 yenilenen taban:** ilk `npm audit` 6 yeni bulgu verdi ve lockfile'da
kapatıldı (`d71b739`). Anti-rollback/provenance (`971506f`) ve fuzz matrisi
(`6bdf2a5`) sonrası toplu test 250 + 1 atlanan, native 42 + 1, desktop 113,
Windows release 111, lint/build ve `security:audit` (npm + dört NuGet 0 açık)
geçti; yerel amd64 container kapısı yeniden 3/3 hedefte 0 bulgu verdi. Fuzz iki
gerçek bulguyu kapattı (iç içe `__proto__`, WPF'de eşlenmemiş surrogate).

### Yerel Windows artifact'i

2026-10-09 güncel geliştirme adayı (`6bdf2a5`'ten, kirli ağaç, sequence 0):

- Dosya: `artifacts/windows-desktop/win-x64/EdizRemote.exe`, `184835328` bayt.
- SHA-256: `330D033CE3AC08C0E011E2DEEF0B477D15F71754570DB76CD091DC6E838D20E0`.
- `ProductVersion 0.1.0+6bdf2a5f7a070a56a7c70593e4ff464db56be155.dirty`,
  `FileVersion 0.1.0.0`; şema v2 manifest mevcut. Authenticode **NotSigned**.

Teslim anındaki önceki aday (artık yerinde değil):

- Boyut: `184835328` bayt.
- SHA-256: `FB9FB3B74E045A76E5677875BDC98E61198A06A48694CABE29D492A6FD25E6BC`.
- Authenticode: **NotSigned**.
- Beklenen kardeş katalog: `artifacts/windows-desktop/EdizRemote.win-x64.cat`;
  teslim sırasında bulunmuyor.
- Önceki `release:windows:verify` sonucu `catalog_missing`; production kabulü yok.
  Kodun/politika testinin hazır olması gerçek imza kanıtı değildir.

### Yerel container kanıtı

- Dizin: `artifacts/security/containers/linux-amd64/`.
- Manifest: `container-audit-manifest.json`, şema `3`, `gatePassed=true`.
- 2026-10-09 yeniden koşu manifest SHA-256:
  `0C82A7B08C7BC21A88B1A85E727EBC2AF87129C35A537C6605A80DAEF003CB55`
  (teslimdeki `5F9C90D5…12E8` kanıtının yerini aldı).
- Hedefler: `node-base`, `application`, `coturn`; kayıtlı HIGH/CRITICAL sayısı 0.
- DB updated: `2026-10-09T13:10:00Z`; DB downloaded: `2026-10-09T13:51:44Z`.
  **48 saatlik tazelik sınırı 2026-10-11 civarında dolar**; deploy öncesi yeniden
  build/scan gerekir. Bu image'lar `6bdf2a5` ve `20b972b` kaynak değişikliklerinden
  önce build edildi.
- Bu kanıt Pi `linux/arm64` kabulü değildir. Yerel image ID ve `deployment.env`
  farklı hosta taşınarak production kabulü verilemez.

`artifacts/`, `.tools/`, secret dosyaları, bağımlılıklar ve build çıktıları
GitHub'a dahil değildir. Temiz klonda bunların bulunmaması beklenir.

## 3. Mimari ve değişmez güvenlik kuralları

Windows host → DXGI Desktop Duplication → D3D11 NV12 → Media Foundation donanım
H.264 → RFC 6184 RTP → SIPSorcery ICE/DTLS-SRTP → Chromium guest görüntüsü.
Kontrol olayları ayrı WebRTC DataChannel'lardan WPF/WebView2 köprüsüne, oradan
doğrulama sonrası `SendInput` katmanına gider.

1. **P2P önceliklidir.** Direct mümkün değilse ayrı coturn üzerinden TURN kullanılır.
2. Pi signaling/kod/onay servisidir; medya sunucusu değildir. Cloudflare Tunnel
   web ve WSS içindir; masaüstü medyasını HTTP/WebSocket'e taşıma.
3. Host açıkça onaylamadan SDP/ICE aktarımı, yakalama ve input başlatma.
4. Görüntüleme ve kontrol izinleri ayrıdır. Revoke sonrası `view` yetkisi resume'da
   da korunur; eski `control` yanıtı yetkiyi geri açamaz.
5. Disconnect, focus loss, revoke, bridge hatası ve kapanışta basılı input bırakılır.
   Host'ta görünür oturum, anında revoke ve `Ctrl+Alt+Shift+F12` acil stop korunur.
6. UAC secure desktop, kilit ekranı, Session 0 ve `Ctrl+Alt+Del` sınırlarını aşma.
7. Tarayıcı host için `getDisplayMedia` fallback'ini koru; bu host yalnız görüntüleme
   sağlar. Fare/klavye kontrolü native Windows host'ta uygulanır.
8. Secret/token/kod/SDP/ICE/ham IP/ekran içeriğini log, issue, commit veya teslim
   dosyasına koyma. Audit ve probe çıkışı mevcut allowlist/redaction yolunu kullanır.

### Güncel protokol — eski doküman örnekleriyle karıştırma

- Signaling alt protokolü: `ediz-remote.v3`; current/minimum wire: `3/3`.
- v1/v2 ve alt protokol teklif etmeyen eski istemciler fail-closed reddedilir.
- Her SDP/ICE sinyalinde UUID `negotiationId`; genel peer/native-video lane'leri ayrı.
- `native-video` signaling ve WebView2 bridge zarfı v2; bridge UUID `sessionEpoch` taşır.
- Session DataChannel zarfı `channel: "session", version: 2`; gönderen başına ortak
  artan `sequence`. Control zarfı `channel: "control", version: 1` olarak kalır.
- Pointer kanalında yalnız yetkili host'a gelen `pointer.move` kabul edilir.
- SDP 60 KiB, ICE candidate 4096 karakter, toplam WebSocket zarfı 128 KiB.
- Pending ICE negotiation başına 64 aday/64 KiB; erken signaling kuyruğu lane
  başına 64 mesaj/128 KiB. Lane başına oturum boyunca en fazla 256 offer kimliği.
- Fatal protokol kilidi aynı onaylı oturumun recovery geçişinde sıfırlanmaz.

Kesin şema kaynağı [packages/protocol/src/index.ts](packages/protocol/src/index.ts)
ve [protokol belgesidir](docs/PROTOCOL.md).

## 4. Kodda nereden başlamalı?

| Alan | Ana dosyalar |
|---|---|
| Ekranlar ve oturum UI | `apps/web/src/App.tsx`, `apps/web/src/features/webrtc/RemoteViewer.tsx` |
| Signaling istemci state machine | `apps/web/src/features/session/useSignaling.ts`, `signalingQueue.ts` |
| Browser WebRTC / negotiation / input | `apps/web/src/features/webrtc/usePeerConnection.ts`, `useNativeVideoPeer.ts`, `negotiation.ts`, `peerProtocol.ts`, `remoteControl.ts` |
| WebView2 istemci köprüsü | `apps/web/src/features/desktop/useDesktopBridge.ts` |
| Signaling sunucusu | `services/signaling/src/server.ts`, `index.ts`, `ice.ts`, `rateLimit.ts` |
| Minimal audit / secret yükleme | `services/signaling/src/securityAudit.ts`, `securityAuditConfig.ts`, `ice.ts` |
| WPF köprüsü / input / yaşam döngüsü | `apps/windows-desktop/MainWindow.xaml.cs`, `NativeVideoBridgeProtocol.cs`, `Input/`, `Lifecycle/` |
| Native capture / encode / RTP / peer | `apps/windows-host/Capture/`, `Encoding/`, `Transport/`, `WebRtc/`, `Streaming/` |
| Güvenli tanı çıktısı | `scripts/safe-output.mjs`, `apps/windows-host/SafeHostDiagnostics.cs` |
| Container release/deploy | `scripts/container-security-audit.mjs`, `container-deploy.mjs`, `Dockerfile`, `infra/coturn/` |
| Windows imzalama/katalog | `scripts/windows-release.ps1`, `windows-release-lib.psm1`, `windows-release.test.ps1` |

Son teknik düzeltme: Docker/containerd runtime image ID ile Trivy'nin Docker
archive config digest'i aynı olmayabilir. `imageId` ve `imageConfigDigest` ayrı
tutulur; config blob SHA-256 ve CycloneDX/SPDX/Trivy native kimlikleri tekil
doğrulanır. Bu ayrımı kaldırma veya manifest şemasını sessizce geri düşürme.

## 5. İlk oturum ve doğrulama komutları

Önce `AGENTS.md`, bu dosya, `docs/PHASE4_PLAN.md` ve `docs/THREAT_MODEL.md` oku.
Ardından çalışma ağacını incele; varsa kullanıcı değişikliklerini koru.
Node.js 22+ LTS gerekir. Bu teslim makinesinde Node `v24.18.0`, npm `11.16.0`
görüldü; lockfile'ı sebepsiz güncelleme.

```powershell
git status --short
git log -4 --oneline
npm ci
npm test
npm run lint
npm run build
npm run native:test
npm run desktop:test
npm run release:windows:test
npm run security:audit
```

Native/WPF komutları Windows gerektirir. Yardımcı betikler .NET 8 SDK'yı
gerekirse `.tools/dotnet` altına indirir; NuGet cache `.tools/nuget` içindedir.
Windows release sign/verify yolu PowerShell 7 ve gerçek imza için Windows SDK
SignTool gerektirir. Policy testleri gerçek sertifikaya ihtiyaç duymaz.

UI oturumu için `npm run dev`: web `http://localhost:8080`, signaling
`http://localhost:8788`. `npm run desktop:run` görünür uygulama açar.
GPU/capture probe'ları host donanımını, TURN/browser simülasyonları Docker ve
uygun ağ ortamını kullanır; sıradan doküman kontrolünde otomatik çalıştırma.

Görünür uygulama açan UI/donanım testlerini ve Computer Use'u yalnız kullanıcı
istediğinde çalıştır; arka plan dosya/komut çalışmasını tercih et.

## 6. Claude'un öncelikli devam işi

**En erken tamamlanmamış faz Faz 4'tür.** Önce mevcut dependency/test tabanını
yenile; yeni bir açık çıkarsa fail-closed kapıyı gevşetmeden çöz. Sonra şu işleri
sırayla, erişim ve gerçek kanıt bulunduğunda tamamla. Fuzz katmanı, 326 testlik
durum makinesi matrisi ve `docs/PHASE4_ACCEPTANCE.md` 2026-10-09'da tamamlandı
(toplu `npm test` 576 + 1 atlanan); kalan Faz 4 kabulü Pi, imza sertifikası ve
temiz Windows 10/11 girdisine bağlıdır.

### A. Pi arm64 container kabulü

1. Mevcut production sürümü, Compose proje adları, health, secret sahiplik/izinleri
   ve audit volume durumunu salt-okunur doğrula. Pi erişimi bu dosyada yoktur;
   SSH hesabı, key veya parola uydurma. Mevcut diğer servisleri koru.
2. Pi'nin yerel `linux/arm64` Docker engine'inde güncel kaynakla
   `npm run security:containers` çalıştır. 3 hedef, SBOM'lar ve HIGH/CRITICAL 0 gerekir.
3. Node/coturn/Trivy digest kilitleri gerekiyorsa Dockerfile, script lock metadata,
   Compose/test referansları ve belgeler birlikte güncellenmelidir.
4. Deployment'ta `npm run security:container:deploy` doğrulama tüketicisini kullan;
   UID 1000 secret, audit volume ve application/coturn health kanıtını kaydet.
5. Audit arızasında 503/restart, coturn raw stdout suppression ve dış HTTPS/WSS
   akışını doğrula. Arıza enjeksiyonunu izinli izole ortamda yap; canlı müşteri
   oturumunu deney için kesme.

Production Compose doğrudan build/pull yapmaz. `AGENTS.md` içindeki eski
`docker compose up -d --build` kısa örneği production kabul yöntemi değildir;
[güncel container release belgesini](docs/CONTAINER_RELEASE.md) izle.

### B. Gerçek Windows release kabulü

1. Gerçek OV/EV store/HSM sertifikası, non-exportable key, trusted signer public
   SHA-256 allowlist'i ve HTTPS RFC3161 timestamp sağlayıcısı gerekir.
2. Güncel `desktop:publish` sonrası `release:windows:sign` EXE'yi imzalar,
   manifesti üretir, bütün `win-x64` ağacı için dış SHA-256 Catalog v2 oluşturur,
   kataloğu aynı signer ile imzalar ve doğrular.
3. İki Authenticode/SignTool sonucu ve `Test-FileCatalog=Valid/SHA256` zorunludur.
   PFX/parola girdisi, sahte sertifika veya allowlist bypass ekleme.
4. Temiz Windows 10/11 üzerinde doğrula. Anti-rollback/build provenance kapısı
   2026-10-09'da tamamlandı (`docs/WINDOWS_RELEASE.md`): yayın temiz klondan,
   `EDIZ_REMOTE_RELEASE_SEQUENCE` ≥ 1 ile publish edilir; sign/verify
   `EDIZ_REMOTE_RELEASE_MINIMUM_SEQUENCE` tabanını ister. Sertifika yoksa bu kabulü
   tamamlandı sayma.

Wire v3 rollout'ta web/signaling/desktop birlikte güncellenmelidir. Pi'de daha
önce direct/recovery/relay kabulü yapıldı; ancak **bugünkü canlı sürüm bu teslimde
kontrol edilmedi**. Kaynak kodun güncelliğini canlı production'a eşitleme.

## 7. Kapsam dışında kalanlar ve teslim alışkanlığı

- Ses, dosya aktarımı, clipboard ve gözetimsiz erişim V1 sonrasındadır.
- Exact DXGI pointer shape birleşimi, döndürülmüş ekranlar, uyku/GPU reset ve
  geniş sürücü/ağ/soak matrisi tamamlanmış kabul edilmez.
- README/design görselleri tasarım konseptidir; canlı ekran görüntüsü değildir.
- Açık kaynak lisansı henüz seçilmedi. Public repo için kendiliğinden MIT vb. atama.
- GitHub sunumu 7 Ekim'de eklendi: kapak, README, teknik arşiv, güvenlik/katkı
  rehberi, issue/PR şablonları ve dar sentinel istisnalı Gitleaks yapılandırması.
- `.env`, `.npmrc`, key/certificate, audit, dump, `artifacts`, `bin/obj`,
  `.tools` ve `node_modules` dosyalarını commit etme. Üretim secret'larını isteme
  veya genel sohbet çıktısına kopyalama; güvenli yerel yapılandırmayı kullan.
- İlgili testleri riskle orantılı çalıştır. Test, simülasyon, gerçek donanım ve
  production kanıtını ayrı kaydet; atlanan testleri başarılı sayma.
- Her geliştirme sonunda değişen davranışı, testleri ve kalan kabul engelini
  Türkçe bildir. Yeni EXE üretildiyse kesin yolu ve kimliğini ver.
- Mimari/protokol/kabul değişince `AGENTS.md`, ilgili `docs/` ve README'yi güncelle.
  Commit/push/deployment kapsamını kullanıcının mevcut talebiyle sınırla.

## 8. Başvuru belgeleri

- [Çalışma kuralları ve tam yol haritası](AGENTS.md)
- [Proje ana sayfası](README.md)
- [Geliştirme/dağıtım komutları ve tarihsel kanıtlar](docs/DEVELOPMENT.md)
- [Faz 4 planı](docs/PHASE4_PLAN.md) ve [tehdit modeli](docs/THREAT_MODEL.md)
- [Protokol](docs/PROTOCOL.md) ve [audit modeli](docs/SECURITY_AUDIT.md)
- [Container release](docs/CONTAINER_RELEASE.md) ve [Windows release](docs/WINDOWS_RELEASE.md)
- [Windows host](docs/WINDOWS_HOST.md), [desktop](docs/WINDOWS_DESKTOP.md), [TURN](docs/TURN.md)
- [Faz 1 kabulü](docs/PHASE1_ACCEPTANCE.md), [Faz 2 kabulü](docs/PHASE2_ACCEPTANCE.md),
  [Faz 3 kabulü](docs/PHASE3_ACCEPTANCE.md)

**Başlangıç görevi:** Belgeleri ve çalışma ağacını doğrula; güncel test/audit
sonuçlarıyla mevcut tabanı yenile. Ardından Faz 4'ün en erken açık kabul işini
gerçek ortamda tamamla. Gerekli Pi erişimi veya signing sertifikası bulunamazsa
bağımsız ilerleyebilen kod/politika işini yap ve yalnız eksik girdiyi net olarak
belirt. Faz 4 kapanmadan Faz 5'i tamamlandı ilan etme.

# Myne için Plugin Sistemi Tasarımı: Derin Araştırma

**Tarih:** 2026-04-29
**Hazırlayan:** Claude (Opus 4.7) — kullanıcı talebi üzerine
**Kapsam:** Privacy-first, sıfır-bilgi E2EE markdown notlar uygulaması Myne için, Obsidian tipi "vault'a tam erişimli" trust modelini reddeden, capability-scoped ve sandboxed bir plugin sisteminin mimari seçenekleri.
**Kaynak sayısı:** 32 incelendi, 30 rapora dahil edildi.
**Güven seviyesi:** Yüksek — ekosistem (Wasmtime/Component Model, MetaMask Snaps, Zed extensions) 2024-2026 arasında olgunlaştı; üç bağımsız üretim örneği var. Tek belirsizlik: Wasm Component Model'in halen draft statüsü (Wasmtime'da 25.0+ ile production-ready ama RFC olarak finalize değil).

> **Not.** Bu doküman **araştırma raporudur, normatif spec değildir.** Plugin sistemi `vision.md`'de "v1'de yok, belki hiç olmayacak; olursa ilk tasarımdan capability-scoped + sandboxed" olarak işaretlenmiş bir ileri-faz konusudur. Buradaki öneriler doğrudan kabul edilirse, `docs/threat-model.md` ve `docs/spec/` altında yeni dokümanlara dönüştürülmesi gerekir (en azından bir TB10, A14 ve `spec/plugin-protocol.md` taslağı).

---

## TL;DR

1. **Obsidian-style "tam erişim" model Myne için yapısal olarak yasaktır.** Obsidian'ın kendi resmi dokümanı *"due to technical limitations, Obsidian cannot reliably restrict plugins to specific permissions"* diyor; 14 Nisan 2026 tarihli Elastic Security Labs raporu (PHANTOMPULSE RAT) bu kararın gerçek dünya bedelini kanıtlıyor. Myne'in `threat-model.md` §5'teki "*Plugins run inside the trust boundary of the client and can read decrypted notes*" cümlesi mimari hedef değil, **kaçınılması gereken dipnottur**.

2. **Tek tercih edilen runtime: Wasm Component Model üzerinde Wasmtime + WIT**. Default-empty host interface, capability'ler explicit-grant. Zed editörünün üretimde kullandığı, RustCrypto/`#![no_std]` ekosistemiyle uyumlu, audit anchor'ı en güçlü olan stack. `protocol/` crate'inin `#![no_std] + alloc` disiplini buradaki sandbox tasarımına doğrudan uygundur.

3. **"Plugin nedir?" soruları kod yapısı sorularından önce yanıtlanmalı.** Standard Notes 2022 yazısının gösterdiği gibi, plugin **sınıfını** kısıtlamak (sadece *editor*, *renderer*, *importer*, *theme*) — plugin **gücünü** kısıtlamaktan daha sağlam bir savunmadır. Myne için önerilen ilk plugin sınıfları: **Renderer** (markdown blok render), **Importer** (dış format → Myne plaintext), **Theme** (sadece CSS/varsayılan token), **Slash-command** (read-only, içerik dönüştürme). Bunların hiçbiri vault-wide read, file system, ya da raw network gerektirmemeli.

4. **Manifest-only permission anti-pattern'dir.** Joplin 2021'de "permissions array ekleyelim" denildi, hâlâ enforce edilmedi; Logseq 2025'te aynı tartışma sürüyor. Myne'in modeli, MetaMask Snaps'in "endowment + caveat + runtime user prompt" üçlüsünü kopyalamalı: declared manifest → IPC katmanında zorlayıcı kontrol → kullanıcının ilk kullanımda runtime onayı.

5. **"Curated marketplace güvenliği sağlar" tezi 2025-2026 olaylarıyla yıkıldı.** Wiz Research (Ekim 2025) VS Code Marketplace'te 550+ canlı secret buldu — bunlardan 100+ extension update token'ıydı, yani saldırgan tüm install base'e malware itecek pozisyondaydı. GlassWorm (Ekim 2025) ve OctoRAT (Aralık 2025) marketplace'leri zaten compromise etti. Myne'in plugin distribution modeli **reproducible plugin builds + per-publisher hardware-backed signing keys + per-update review** üzerine kurulmalı; "review on submit only" Obsidian modeli yetersiz olduğunu kanıtlamış.

---

## 1. Arka plan ve kapsam

### Myne'in mevcut taahhütleri

`docs/vision.md` ve `docs/threat-model.md`'den çıkarılan, plugin tasarımını sınırlandıran yedi taahhüt:

| # | Taahhüt | Plugin tasarımına etkisi |
|---|---|---|
| 1 | Plaintext mod yok, opt-in encryption yok | Plugin'in plaintext olarak gördüğü her şey AS1 sızıntı vektörüdür |
| 2 | Sıfır-bilgi: server hiçbir şey bilmez | Plugin "sync üzerinden phone home" yapamamalı; plugin networking = ayrı bir trust boundary |
| 3 | Reproducible signed builds, hash-pinned deps | Plugin'ler de reproducible olmalı; aksi halde TB7/TB8/TB9 zayıflar |
| 4 | Minimal direct-dependency surface | Wasmtime tek runtime; çoklu sandbox engine = audit yüzeyini ikiye katlar |
| 5 | A7 malware Best-effort | Plugin sistemi A7'yi kötüleştirmemeli; yani plugin ≠ rastgele kod execute edebilen path |
| 6 | TB1 (kullanıcı belleği) ve TB2 (cihaz process) plugin'lere kapalı | `root_key`, `item_key` plugin process'ine asla geçmemeli |
| 7 | "No proprietary format, plain markdown after decryption" | Plugin notu plaintext olarak görüyorsa, ürettiği şey de plaintext markdown kalmalı; binary blob plugin formatları yasak |

### Kapsam

- **Bu raporda var:** Plugin sandbox runtime seçenekleri, capability/permission modelleri, mevcut benzer projelerin (privacy-first ve genel) tasarımları, distribution & marketplace güvenliği, kullanıcıya yönelik permission UX kalıpları.
- **Bu raporda yok:** v0.1 protocol spec değişiklikleri, Phase 3 mobile için plugin (mobile sandbox kısıtları ayrı bir araştırma), tam UI tasarımı (`docs/design/` altında ayrı çalışılır), backend sync'le plugin etkileşimi (Phase 2 sonrası).
- **Varsayım:** Plugin sistemi en erken Phase 4'te (yani v1.0 ship'ten en az 12-18 ay sonra) ele alınacak. Bu zaman aralığında WASI Preview 3 async streams, Wasm Component Model RFC stable hale gelmiş, Snaps ekosistemi olgunlaşmış olacak — bu yüzden bugün kararlaştırılacak şey "v1'de bu yola sokmamak için ne yapmamalıyız" + "Phase 4 başladığında hangi tabloyla geleceğiz".

---

## 2. Bulgular

### 2.1 Privacy/notes uygulamalarında mevcut plugin tasarımları

Aşağıdaki tablo, her ürün için trust modelini özetliyor. **"Plugin = renderer first-party"** demek, plugin'in uygulamayla aynı süreçte ve aynı yetkilerle çalışması demektir; bu, Myne için kabul edilemez referans noktadır.

| Ürün | Sandbox | Capability/permission modeli | Plugin sınıfı | Olay/uyarı |
|---|---|---|---|---|
| **Obsidian** | Yok (Electron renderer first-party) | Sadece `Restricted Mode` binary toggle | Genel | PHANTOMPULSE RAT (2026-04-14): Shell Commands plugin'iyle ilk-erişim; Obsidian'ın resmi dokümanı *"plugins inherit Obsidian's access levels"* itirafı |
| **Logseq** | Marketplace plugins iframe/shadow DOM-izole; dev-mode side-loaded plugins full access | Resmi yok; topluluk soruyor (2023-2025) | Genel | Plugin developer'ları DOM/asset folder erişimi olmadığı için bloke; pure-deny + side-load loophole |
| **Joplin** | Desktop: ayrı `BrowserWindow` (process-level) + IPC proxy + JSON serialization. Mobile: WebView + RemoteMessenger | Manifest `permissions` array 2021'de **önerildi, hâlâ enforce edilmiyor**; `nodeIntegration` açık, `require('fs')` plugin'lerde mevcut | Genel | Joplin lead Laurent Cozic on-record: *"we give lower level access to the app, but we know that it can result in them crashing the app"* |
| **Standard Notes** | Editor extensions iframe-izole + JSON message bridge | Yapısal: extension classes = sadece **editor + theme**. Power-vs-access tradeoff açık taahhüt | Sınırlı (editor, theme) | Mart 2022 yazısı: *"Less broad power certainly, but it's a trade off between power and access. For us, that's a no-brainer."* |
| **Notesnook** | Web Clipper var (browser extension); resmi extensions API roadmap'te | Henüz yok; planlanan | Henüz yok | — |
| **Anytype** | Yok (REST-style local API; Raycast extension, Python/Go SDK) | API key + endpoint scope; sandbox/ izolasyon dokümante değil | API integration | Resmi dev portal extension sandbox tasarımı hakkında **sessiz** — Myne'in tekrarlamaması gereken doc gap |

**Önemli alıntı (Standard Notes, Mart 2022):** *"Many local-only apps tout themselves as 'privacy focused' simply by virtue of the fact they operate on local data. Yet what does privacy really mean, if apps that allow system-access plugins use that term?"* Myne'in tam olarak yanıtlaması gereken soru budur.

**Önemli olay (Elastic Security Labs, 14 Nisan 2026):** PHANTOMPULSE/PHANTOMPULL kampanyası, kurbana shared bir Obsidian vault gönderiyor, "community plugin sync'i aç" diyor, **legitimate** Shell Commands plugin'i üzerinden base64 PowerShell loader → DLL reflective load → Ethereum on-chain C2 resolver çalıştırıyor. SHA-256 IOC: `70bbb38b...327980`. Ders: **shared vault enable + community plugin enable iki ayrı trust kararı olmalı, default-deny.**

### 2.2 WebAssembly tabanlı plugin sandbox seçenekleri

#### Wasmtime + Component Model (WIT) — Zed pattern

- **Üretim örneği:** Zed editor (Ekim 2024 mühendislik blog yazısı). Extensions `wasmtime` + `wit-bindgen` ile Rust → wasm32-wasip2 hedefine derleniyor. WasmHost API v0.1.0 → v0.8.0 versiyonlanmış, geriye uyumlu.
- **Default posture:** Empty `host` interface. *"In this case, the `host` interface is empty, indicating that there is no functionality in the host that a plugin can call"* (Wasmtime WASIp2 plugins doc). Her host capability'si `Linker` üzerinden explicit-grant.
- **Güvenlik garantileri (Wasmtime):**
  - Linear memory bounds-check + 2 GiB guard region
  - Type-checked control transfers
  - Stack guard pages → abort on hit
  - Memory zeroing of instance memory
  - Spectre mitigations: deterministic `br_table`, optional `csdb` aarch64
  - cap-std capability-based filesystem (path access explicit-grant)
- **Audit/üretim anchor:** Bytecode Alliance ekosistemi, Wasmtime 25.0+ Component Model full support, `chacha20poly1305` RustCrypto NCC Group audit (zaten Myne'in audit-substitute story'sinin parçası).
- **Maliyet:** "No shared memory" memory-isolation tax (büyük buffer pas hızı için sorun) — Myne için sorun değil, plugin payload'ları markdown-boyut/byte-küçük.
- **Tek riski:** Component Model halen RFC olarak draft. Ama Zed gibi production'da kullanılıyor; Wasmtime stabil API garantisi veriyor.

**Verbatim alıntı (Sy Brand, Microsoft, Ağustos 2025):** *"WebAssembly components can help you build secure, fast plugin systems with well-defined interfaces... The one with the best support for Wasm components at the time of writing is Wasmtime."*

#### Extism (Dylibso)

- **Üretim örneği:** moonrepo, Reactor, çeşitli edge/serverless tool'lar. 5.5k+ GitHub star, BSD-3, aktif (son push 2026-03-26).
- **Tasarım felsefesi:** "Wasm-but-easier". 15 host SDK (Rust dahil), 10 PDK (guest SDK). WASI'**siz**, kendi host-controlled HTTP'si var; runtime limiters, timers, persistent memory built-in.
- **Trade-off:** Wasm value types I32/I64/F32/F64/V128/FuncRef/ExternRef ile sınırlı. String/struct/list gibi zengin tip Wasmtime+WIT seviyesinde değil. Myne için "byte buffer geçirip serialize-yourself" patternini gerektirir.
- **Myne için karar:** Şık alternatif ama Wasmtime+WIT'in granülerlik avantajı kaybolur; ek dependency = TB9'a yeni audit yüzeyi.

#### Cap-std

- **Bytecode Alliance crate** (`cap-std`). `std::fs`'e capability-oriented alternatif. *"cap-std's `Dir` type performs sandboxing, including for multiple-component paths."*
- Wasmtime'ın WASI implementation'ı bunun üzerine kurulu. Myne plugin host'u plugin'e `Dir` handle'ı verirse, plugin sadece o dir altında dolaşabilir — `..` traversal yapısal olarak engellenir.
- **Myne için kullanım:** Eğer bir plugin sınıfı (örneğin Importer) "tek bir input dosyası seçtim, oku" yapacaksa, host plugin'e tek bir File capability'si (cap-std handle) geçirir; plugin başka hiçbir path'a ulaşamaz.

### 2.3 JavaScript tabanlı sandbox seçenekleri

#### SES / Hardened JavaScript / Compartments (Endo, Agoric)

- **TC39 standartlarına aday.** `lockdown()` + `Compartment` + `harden()` API'sı. npm: `ses`. *"All compartments have the same shared intrinsics... lockdown freezes primordials."*
- **Üretim deployment:** MetaMask Snaps (milyonlarca kullanıcı). Snaps execution environment = SES + iframe `sandbox="allow-scripts"` + LavaMoat policy + Compartment.
- **MetaMask Snaps permission catalog (Myne için referans değer):**

  ```
  endowment:cronjob              endowment:network-access
  endowment:ethereum-provider    endowment:rpc
  endowment:page-home            endowment:signature-insight
  endowment:keyring              endowment:transaction-insight
  endowment:lifecycle-hooks      endowment:webassembly
  endowment:name-lookup          (+ caveats: maxRequestTime, allowedOrigins)
  ```

  Manifest `snap.manifest.json` → `initialPermissions` → kurulum onayı.

- **Bilinen kırılganlık:** OtterSec audit (Kasım 2023) Snaps sandbox'ı bypass'ladı. PoC: `JSON.parse(JSON.stringify(value))` sanitize sonrası `toJSON` override → `snap_dialog` permission'ı `eth_sendTransaction` çağrısına dönüştü. Ders: **sanitize-then-assert ordering load-bearing.** Defense-in-depth (iframe + LavaMoat + SES) yine de bu hatayı yakalamadı.
- **Figma'nın SES'ten kaçışı:** Figma 2019 blog yazısı SES Realms shim ile başladı; sonradan Realms shim'de bir vulnerability açıklandı (public exploit'ten önce), Figma **WebAssembly-compiled JS VM (Duktape/QuickJS)** tarafına geçti. Bu, "SES production'da bir kez kırılabilir" emsalidir — fragility riski gerçek.

#### rquickjs / QuickJS

- **Pure-Rust binding** (`DelSkayn/rquickjs`, MIT, ~907 star, stabil). ES2020 + modules + async + bytecode embed. wasm32-wasip2 target shipping.
- **Avantaj:** Myne'in `protocol/` crate'i `#![no_std] + alloc` — rquickjs bu disipline çok yakın. Wasmtime'a göre çok daha küçük dependency surface.
- **Eksik:** Memory limit, interrupt handler, stack-size limit QuickJS C API'sinde mevcut ama rquickjs README'sinde load-bearing şekilde dokümante değil. Myne'in plugin host'u bu API'leri **explicit** kullanmalı; aksi halde plugin sonsuz döngü = host crash.
- **Tipler:** WIT seviyesi tip sistemi yok; `IntoJs`/`FromJs` trait'leri ile Rust↔JS marshalling.
- **Myne için karar:** Wasmtime+WIT'e göre daha hafif ama daha az isolation garantisi. Plugin tipi *theme* ya da *renderer* gibi gerçekten "küçük JS hesaplaması" ise düşünülebilir; *importer* ya da *cron-like background* için tercih edilmemeli.

#### iframe + postMessage (Standard Notes / Figma UI bölümü)

- **Avantaj:** Browser primitive, ek dependency yok, well-understood. Standard Notes editor extensions tam olarak bu modelde çalışıyor.
- **Tauri özelinde:** Tauri 2 capability ACL'i window/webview-bazlı; bir `<iframe>` ek webview'i gibi ele alınabilir, ama: *"On Linux and Android, Tauri is unable to distinguish between requests from an embedded `<iframe>` and the window itself"* (Tauri 2 capabilities doc). Yani Linux'ta iframe-based izolasyon Tauri capability sistemiyle yetersiz.
- **Karar:** Plugin'in **UI yüzeyi** için iframe makul (Standard Notes pattern); ama Myne'in herhangi bir vault verisi gören kod için iframe alone yetmez — Linux platform-spesifik delik nedeniyle.

### 2.4 Tauri 2 capability ACL — Myne'in mevcut altyapısı

`design-notes.md` 2026-04-26 entry'lerine göre Myne zaten Tauri 2'nin capability sistemini kullanıyor (`src-tauri/capabilities/default.json`). Plugin sistemi bu altyapının ÜZERİNE kurulmalı, paralel bir altyapı olmamalı.

**Tauri 2 ACL'in plugin tasarımını desteklediği yerler:**
- **Default-deny:** *"If a webview or its window is not matching any capability then it has no access to the IPC layer at all"* — Myne plugin'lerini ayrı bir window/webview etiketine bağlarsa (`plugin-host`, `plugin-renderer`), plugin window'undan gelen tüm IPC çağrıları default-deny olur.
- **Per-capability scope:** `commands.allow` + `scope.allow`/`scope.deny`. Plugin'e özgü Rust komutları, `plugin-id` parametresiyle filtrelenip per-plugin scope'a tabi tutulabilir.
- **Plugin-prefixed permissions:** Tauri'de `tauri-plugin-X:permission-Y` formatı zaten mevcut; Myne plugin sistemi `myne-plugin-host` adlı bir Tauri plugin'i altında topladığında bu prefix doğal hale gelir.

**Tauri 2 ACL'in YETERSİZ kaldığı yerler:**
- ACL Rust komutu → IPC katmanını korur. Plugin **kendi içinde** ne yapıyor (loop, hesaplama, memory) bu seviyede görünmez. Sandbox runtime gerekli.
- ACL "scope.allow" path string'leri statik. Runtime'da kullanıcının verdiği file capability'sine (cap-std `Dir`) ya da kullanıcının onayladığı tek-seferlik permission'a (Snaps caveat tarzı) doğal yer yok. Myne'in kendi plugin permission tablosunu üst-katman olarak yazması gerekir.
- Tauri 2 IPC = JSON over postMessage (v1) + native HTTP intercept (v2). Plugin'e geçen JSON serialize/deserialize edilirken Snaps OtterSec bypass'ı tipi açıklar var; Myne `serialize-then-assert-then-re-validate` disiplinini Rust tarafında zorlamalı.

### 2.5 Permission UX — kullanıcının capability vermesi

Üç pattern karşılaştırılır:

1. **Manifest-only declared permissions** (Chrome MV3 host_permissions, Joplin'in 2021 önerisi). Plugin manifest'te ne istediğini söyler, kullanıcı kuruluda toplu onay verir. **Anti-pattern**: kullanıcı "tıkla geç" alışkanlığına girer; permission grants kalıcı; OtterSec Snaps bypass'ında olduğu gibi enforce edilmezse anlamsız.

2. **Runtime user prompt** (MetaMask Snaps `snap_dialog`, MacOS TCC, Android 6+ runtime perms). Plugin işlem yaparken "X plugin'i Y vault notunu okumak istiyor — izin?" diye sorar. **Avantaj:** kullanıcı bağlamı görür. **Dezavantaj:** prompt fatigue; kullanıcı her zaman OK'ler.

3. **Capability handoff** (cap-std `Dir`, OCAP). Kullanıcı UI üzerinden plugin'e tek bir nesneyi (bir not, bir dosya) elden teslim eder; plugin başka hiçbir şey göremez. **Avantaj:** bağlamsal, açık, kalıcı izin yok. **Dezavantaj:** UI patternleri (drag-drop, "share with plugin" menü) implementasyon işi.

**Myne için önerilen kombinasyon:**

| Plugin sınıfı | Ana permission modeli | Ek gereksinim |
|---|---|---|
| Renderer (markdown blok render) | **Capability handoff**: render edilecek bloğun plaintext'i input olarak verilir; başka hiçbir capability yok | Network endowment kapalı (default); FS endowment yok |
| Importer (dış format → markdown) | **Capability handoff**: kullanıcı dosya seçer, host plugin'e o dosyanın `cap-std::fs::File` handle'ını verir | Network endowment kapalı; output sadece host'a stream |
| Theme | Ne capability ne IPC; pure CSS + tasarım token JSON | Sandbox bile gerekmez (CSP yeterli) |
| Slash-command (read-only transform) | **Capability handoff**: kullanıcı bir not seçer, plugin'e o notun plaintext'i verilir; plugin **read-only**, sonuç host'a döner | Network: opt-in `endowment:network-access` + `allowedOrigins` |

Manifest declared permissions yine var ama **sadece ilan amaçlı** (UI'da "bu plugin şu capabilities'i isteyecek" göstermek için); zorlayıcı kontrol her zaman runtime IPC katmanında.

### 2.6 Distribution, signing, marketplace güvenliği

#### 2025-2026 olayları (curated marketplace yetersizliği)

| Tarih | Olay | Ders |
|---|---|---|
| Mart 2026 | Open VSX Bug → bypass security checks | Marketplace'in sahibi de zayıf halka |
| Aralık 2025 | OctoRAT (`prettier-vscode-plus`, Hunt.io 2025-12-03): 4 saat içinde marketplace'e girdi, multi-stage RAT (Anivia loader → OctoRAT, 70+ komut) | Marketplace TTR (time-to-removal) **floor** 4 saattir, tavan değil |
| Ekim 2025 | GlassWorm (Koi Security): görünmez Unicode kod ile self-propagating worm | Manuel review insan gözüne karşı kör |
| Ekim 2025 | Wiz Research: 550+ canlı secret VS Code marketplace'te + 100+ extension update token = full install base RCE | Token leak = silent supply-chain saldırı |
| Mayıs 2024 | Building Automation impersonation campaign | Publisher verification sıkı olmazsa typosquatting çalışır |

**2025'te VS Code malware artışı:** 27 → 105 vaka (4× artış, Visual Studio Magazine, 2025-12-08).

#### Curated review yapanlar (model olarak)

- **Trail of Bits skills-curated** (Claude Code plugins): Trail of Bits staff her PR'a code review yapıyor; review public.
- **JetBrains Marketplace**: Manuel + automated Plugin Verifier + UI integration tests. Tüm yeni plugin ve update'ler review.
- **VS Code Marketplace** (Microsoft): Domain verification + 6 ay good standing → trusted publisher; her paket sandbox dynamic detection; flag ⇒ manual security engineer review.
- **Apple App Store / Google Play**: Ücretli developer + signed binary + automated + manual review. En sıkı, en yavaş.
- **Obsidian Community**: Initial review only; sonraki release'ler review yok. **Bu modeli Myne tekrarlamamalı.**

#### Reproducible plugin builds — Myne'in TB7/TB8/TB9 ile uyum

`docs/threat-model.md` §6: "*Reproducible builds — for desktop (Tauri), web, and server binaries.*" Myne plugin'leri de aynı disipline tabi olmalı:

1. Plugin source = açık (AGPL veya permissive). Tek satır kapalı plugin = audit story collapse.
2. Plugin build script + Cargo.lock + rustc/wasi-sdk pinned (toolchain.toml).
3. Yayınlanan `.wasm` artifact'ı (a) public source'tan reproducible olmalı (b) Myne plugin marketplace'inde SHA-256 ile pin edilmeli (c) hardware-backed signing key ile imzalanmalı (per-publisher, organization değil — bireysel maintainer).
4. Auto-update: signature + hash verification; başarısızsa refused (TB7 disiplini).
5. **Per-update token revocation:** Wiz olayının dersi — publisher token'ı leak olursa marketplace bunu auto-revoke edebilmeli; install base'e güvenilen plugin'in compromised version'u itildiyse "downgrade & quarantine" yapabilmeli.

---

## 3. Çelişen görüşler / tartışmalı noktalar

### 3.1 SES vs. Wasm — JS sandbox runtime'a güvenilebilir mi?

- **Pozisyon A (SES yeterlidir):** MetaMask milyonlarca kullanıcıda canlı, TC39 standartlarına aday, npm `ses` shim olgun, performans yakın-native. Hardened JS docs.
- **Pozisyon B (Wasm daha sağlam):** Figma 2019'da SES Realms shim ile başladı, vulnerability çıkınca QuickJS-on-WASM'a geçti. OtterSec Snaps bypass'ı SES'in defense-in-depth bile yetmediğini gösterdi. Wasm: linear memory + bounds check + type-checked control transfers + 12+ yıllık formal sandbox literatürü.
- **Benim okumam:** **Wasm Component Model + Wasmtime.** Sebep: Myne'in `protocol/` crate'i Rust + `#![no_std]`, plugin host stack'inin Rust olması doğal; Zed'in production precedent'i; Wasmtime'ın "no segfault from public API" formal garantisi; Component Model'in tipli WIT API'si argument tampering ataklarını yapısal olarak zorlaştırıyor (Snaps'in `JSON.parse/JSON.stringify` toJSON bypass'ı WIT'te imkânsız çünkü tipler runtime'da ABI seviyesinde garanti). SES Phase 4'te ek bir UI-only sandbox olarak (Standard Notes editör pattern'i) düşünülebilir, ama load-bearing veri yolu için Wasm.

### 3.2 Curated marketplace vs. side-load

- **Pozisyon A (curated marketplace):** Apple/JetBrains/Trail of Bits modeli — kullanıcı güvenliği için manuel review, signed publisher, verification.
- **Pozisyon B (side-load özgürlüğü):** Obsidian/VS Code modeli — kullanıcı kendi sorumluluğunda istediğini kurabilir, marketplace sadece keşif.
- **Benim okumam:** **İkisi de**, ama farklı trust seviyelerinde. Marketplace plugin'leri = Myne tarafından reproducible build doğrulanmış + signed + permission diff her update'te yeniden onaylanan; side-load plugin'leri = "developer mode" altında, kullanıcı app'in başlığında "untrusted plugin loaded" rozetiyle gördüğü, kapsayıcı bir uyarı sonrası. Logseq'in yaptığı tam tersi (marketplace'i daha sıkı sandbox'lamak) bence yanlış mesaj; marketplace güveni *ödüllendiren* yer olmalı, ama yine de architectural sandbox aynı kalır — "marketplace plugin'inin DOM erişimi var, side-load'unkinin yok" gibi bir farkı **architectural** yapma, **trust badge** yap.

### 3.3 Plugin permission modeli: declarative manifest vs. capability handoff

- **Pozisyon A (manifest declarative):** Chrome MV3, Snaps, AppStore. Plugin "şu permission'ları istiyorum" der, kullanıcı toplu onaylar.
- **Pozisyon B (capability handoff):** OCAP, cap-std. Plugin sadece ona elden verilen referansları görür; manifest neredeyse yok.
- **Benim okumam:** **Hibrit, manifest secondary**. Manifest *ilan* için (UI: "bu plugin şu yetkileri kullanacak"), kullanıcı onayı *runtime* ve *bağlamsal* (handoff). Saf manifest yetersizdir (Joplin 2021 → 2026 hâlâ enforce yok). Saf handoff developer ergonomics'i öldürür — plugin yazarı her seferinde kullanıcıdan "bu notu plugin'e ver" dramaturjisini çekemez. Myne'in modeli: plugin sınıfı (renderer/importer/slash) → o sınıfa özgü doğal handoff trigger'ı (örneğin slash-command tetiklenince aktif not handoff'a hazır) + manifest'te ilan + runtime onay (yalnızca network/external resource).

### 3.4 Plugin distribusyon zaman ufku — şimdi mi, sonra mı?

- **Pozisyon A (early reservation):** Plugin sistemini şimdi tasarla, v1'de boş bir Tauri plugin scaffold koy; Phase 4 başladığında migration ucuz olsun.
- **Pozisyon B (defer fully):** v1'in altın yolu zaten yoğun (recovery flow, sync, mobile, web). Plugin sistemini şimdi düşünmek scope creep, Phase 4'e kadar Wasm Component Model olgunlaşacak.
- **Benim okumam:** **Defer the implementation, write the principles now.** Myne `vision.md` ve `decisions.md` disiplinini bu sayede koruyor — bu rapor exactly bu rolde. Phase 4 başlayana kadar yapılacak tek somut iş: `docs/threat-model.md`'nin "*plugin support eventually ships*" cümlesinin altına bir sub-section eklemek (önerilen: §7 veya yeni §9 "Plugin support — design constraints"), bu raporun TL;DR'ını oraya 6-8 maddeli mimari taahhüt olarak işlemek. Implementation Phase 4'te.

---

## 4. Güncellik notu

| Kategori | İddia | Geçerlilik |
|---|---|---|
| Stabil | Capability-based security model (OCAP, cap-std, WASI) | Yıllarca geçerli; yeni primitif beklenmez |
| Stabil | Reproducible builds + signed releases + hash-pinned deps disiplini | Yıllarca geçerli; sadece tooling iyileşir |
| Hızlı değişen | Wasm Component Model RFC stable mi, draft mı | 6-12 ay içinde Phase 4 başlamadan önce yeniden kontrol |
| Hızlı değişen | WASI Preview 3 async streams — Spin v3.5 RC, 2025 sonu | Phase 4'te muhtemelen mainstream |
| Hızlı değişen | Marketplace saldırı landscape (GlassWorm, OctoRAT türevleri) | 6 ayda bir threat-intel taraması gerekli |
| Hızlı değişen | Tauri 2 capability ACL semantics (Linux iframe distinguishability vs.) | Tauri 2 stable major release'lerinde takip edilmeli |
| Belirsiz | SES Realms / Compartment shim'inin uzun-dönem audit hikâyesi | Figma'nın geçişi precedent; 12 ayda bir review |
| Belirsiz | rquickjs README'sinde memory limit / interrupt handler dokümantasyonu | Maintainer'a issue açılması faydalı; karar değişmesi olası |

---

## 5. Öneri (Myne için somut tasarım taslağı)

Aşağıdaki taslak, eğer Myne v1.0 ship'ten 12-18 ay sonra plugin sistemini ele alırsa **starting point** olarak önerilen mimaridir. Bu doküman normatif değildir; gerçek karar Phase 4 başında, mevcut Wasm/SES landscape'iyle yeniden taranarak verilmelidir.

### 5.1 Plugin sınıfları (sınırlandırılmış kümeler)

v1 plugin sistemi (eğer ship olursa) yalnızca **dört plugin sınıfı** tanımlar:

1. **Renderer** — markdown blok düzeyinde özel render. Input: bir markdown bloğun plaintext'i + içerik tipi tag. Output: HTML/JSX. Capability: hiçbir şey (network yok, FS yok, IPC yok). Sandbox: Wasm + WIT, host empty.

2. **Importer** — dış format (Obsidian vault, Notion HTML, Apple Notes export) → Myne markdown. Input: kullanıcının seçtiği tek bir dosyanın `cap-std::fs::File` capability handle'ı. Output: stream of `(filename, markdown_plaintext, frontmatter)` host'a. Capability: tek bir File handle, başka hiçbir şey. Sandbox: Wasm + WIT, host = `read-input-file`, `emit-note`.

3. **Theme** — sadece CSS + design token JSON. Sandbox: yok (CSP yeterli, JS plugin sayılmaz). Tema = pasif veri.

4. **Slash-command** (read-only transform) — kullanıcının tetiklediği aktif notun plaintext'i üzerinde tek-seferlik dönüştürme (örneğin "tüm linkleri sırala", "tablo formatla"). Input: aktif notun plaintext'i. Output: replacement plaintext. Capability: opt-in `endowment:network-access` + `allowedOrigins`. Sandbox: Wasm + WIT, host = `network-fetch` (gated), nothing else.

**Yasak plugin sınıfları (v1'de hiçbir zaman):**
- Vault-wide read/write
- Filesystem path access (kullanıcı handoff dışı)
- Background daemon / cron
- Inter-plugin IPC
- Raw TCP/UDP socket
- Native code execution
- WebAssembly içinde başka WebAssembly yükleme

### 5.2 Sandbox stack

```
[Tauri 2 main window]
       │
       │ IPC (capability-ACL gated, plugin-prefixed permissions)
       ▼
[Plugin host (Rust, src-tauri/src/plugins/plugin_host/)]
       │
       │ wasmtime::Linker — empty host interface by default
       ▼
[Wasmtime runtime]
       │
       │ Component Model + WIT bindings (per-plugin-class)
       ▼
[Plugin .wasm artifact]
```

- **Runtime:** `wasmtime` crate, Component Model enabled, WASIp2.
- **Bindings:** `wit-bindgen` ile her plugin sınıfı için ayrı WIT world (`wit/myne.v0.1/renderer.wit`, `wit/myne.v0.1/importer.wit`, vb.).
- **AAD-style discipline (Myne'a özgü):** Plugin'in döndürdüğü her output bytes payload'ına Wasmtime host tarafında `"myne.v0.1 plugin-output|"` AAD prefix bağlanır. Plugin output'u, host tarafında her kullanım yerinde (örneğin Renderer çıktısı DOM'a yazılırken) AAD doğrulanır → plugin'in process internal state'inden eski output sızdırması saldırıları yapısal engellenir.
- **Memory hygiene:** Plugin'in plaintext gördüğü her byte için Wasmtime instance memory zeroing (Wasmtime default). `Zeroize` crate plugin host crate'inde plugin instance teardown zamanı zorunlu.
- **Side-channel:** Wasmtime Spectre mitigations ON. Eğer Phase 4'te timer endowment verilirse, MetaMask Snaps tarzı **reduced timer precision** (millisecond, not nanosecond) zorunlu.

### 5.3 Permission modeli

Plugin manifest schema (`plugin.manifest.toml`):

```toml
[plugin]
id = "com.example.markdown-mermaid"
class = "renderer"            # one of: renderer, importer, theme, slash-command
api_version = "myne.v0.1"
publisher = "0xABCD...EF"     # hardware-key-backed signing public key

[capabilities]
network = false
allowed_hosts = []
max_input_bytes = 65536       # caveat: defaults from class table
max_runtime_ms = 200

[reproducible-build]
source_url = "https://github.com/example/markdown-mermaid"
source_commit = "..."
toolchain = "rust-1.90.0 + wasi-sdk-22"
```

- **Manifest permissions are declared, not enforced by themselves.** Enforcement plugin host'un Rust kodunda WIT linker'da yapılır (ilgili host fonksiyonu sadece `network = true` ise linker'a bağlanır).
- **Runtime user prompt** sadece Slash-command sınıfında ve sadece network endowment varsa: "Bu plugin şu domain'lere fetch yapacak: [...]". Onay session-bounded (next app restart prompt yine).
- **Capability handoff:** Importer plugin'i çalıştığında host UI dosya seçici açar; seçilen dosyanın cap-std handle'ı plugin'e geçirilir; plugin manifestteki `allowed_paths` listelemez — sadece o handle'ı görür.

### 5.4 Distribution

- **Curated official marketplace** (Phase 4): `myne-md/myne-plugins-curated`. Trail of Bits skills-curated modeli — her plugin PR'a kod review yapılır, review public, GitHub Actions reproducible build doğrulaması zorunlu.
- **Side-load:** desteklenir, ama uyarı UI'sı zorunlu. App başlığında "[!] untrusted plugin loaded" rozet, ana pencere kenarında colored stripe.
- **Signing:** her plugin maintainer kendi hardware-backed signing key'ini kayıt ettirir (Yubikey, Secure Enclave). Marketplace bu public key'leri tutar; binary'ye bound.
- **Updates:** auto-update Tauri updater pattern'i — signature + hash verification, fail = refused. Per-publisher token (Wiz olayı dersi) leak edilirse marketplace tarafında auto-revoke + install base downgrade-and-quarantine workflow.
- **Permission diff her update'te:** plugin v1.0 sadece read isterken, v1.1 network ister hale gelirse, kullanıcı update almadan önce diff'i görür; sessizce daha geniş permission almak yapısal engelli.

### 5.5 Threat model amendments (eğer plugin sistemi onaylanırsa)

`docs/threat-model.md`'ye eklenmesi önerilen (taslak):

- **A14 — Malicious plugin (capability-bounded).** Status: 🔒 Mitigated. Wasm sandbox + capability-handoff + runtime user prompt sınırları içinde plugin saldırısı, vault'un bütününü değil sadece kullanıcının elden verdiği nesneleri (notlar, dosyalar) hedefleyebilir.
- **AS18 — Plugin manifest, capability declarations, source artifact hash.** Sensitivity: Public. Stored: marketplace + local plugin install dir.
- **TB10 — Plugin sandbox boundary.** Trusted with: plugin's input handles, declared capabilities. Crossing requires: explicit linker grant in plugin host Rust code; runtime user prompt for network endowments.
- **§5 NOT Protected Against:** "*A signed plugin from a hardware-backed publisher key whose key has been compromised. Until the marketplace revocation lands, the plugin can run with the capabilities it was granted at install time. Mitigation: minimal capability grants, short-lived tokens for sensitive endowments.*"

### 5.6 Anti-features (asla yapılmayacaklar — `vision.md` paralelinde)

- **Native code plugin loading yok.** `.so`/`.dylib`/`.dll` yüklemek yasak.
- **Vault-wide capability yok.** "Tüm notlarımı oku" diye bir endowment Myne'da olmayacak.
- **Plugin'lere root_key, item_key, password, recovery phrase erişimi yasak — yapısal.** Plugin sandbox'ı ve `protocol/` crate'i process katmanında ayrı; plugin host plaintext'i sadece geçici (call lifetime) olarak görür ve aldıktan sonra zeroize.
- **Inter-plugin IPC yok.** Plugin'ler birbirine mesaj atamaz; tüm communication host üzerinden.
- **Plugin'ler kendi telemetrisini gönderemez.** Network endowment opt-in olsa bile Myne plugin telemetry'yi sistem genelinde **devre dışı bırakır** — `endowment:network-access` sadece kullanıcının açıkça tetiklediği request'ler içindir, background telemetry yok.
- **Plugin marketplace'inde reklam yok, ücretli plugin yok, sponsored placement yok.** Vision'ın "*paid tier is exclusively the hosted sync convenience*" çizgisi plugin ekosistemine de uzanır.

---

## 6. Kaynakça

### Privacy/notes app plugin tasarımları (8 kaynak)

1. [Plugin security — Obsidian Help](https://help.obsidian.md/plugin-security) — official, son commit 2025-11-25. Obsidian'ın "we cannot reliably restrict plugins" itirafı.
2. [Phantom in the vault: Obsidian abused to deliver PhantomPulse RAT — Elastic Security Labs](https://www.elastic.co/security-labs/phantom-in-the-vault) — independent-expert, 2026-04-14. In-the-wild Obsidian plugin RAT kampanyası, IOCs ve detaylı attack chain.
3. [Plugin security — Obsidian Forum thread](https://forum.obsidian.md/t/how-concerned-should-one-be-about-security-when-using-community-plugins/89829) — community, 2024-10-13. CVE-counting tartışması, architectural ceiling'e ulaşmıyor.
4. [Security for plug-ins — Logseq Discuss](https://discuss.logseq.com/t/security-for-plug-ins/32996) — community, 2025-07-30. Marketplace plugin'leri DOM/asset folder'a erişemiyor; pure-deny kalıbı.
5. [Plugin Security — logseq/logseq Discussion #9230](https://github.com/logseq/logseq/discussions/9230) — community, 2023-04-25. Logseq team'inden cevap yok; trust model documentation gap.
6. [Plugin system architecture — Joplin](https://joplinapp.org/help/dev/spec/plugins/) — official. BrowserWindow process isolation + IPC proxy + JSON serialization. Permission model dokümante değil.
7. [Improving Plugin Security — Joplin Forum](https://discourse.joplinapp.org/t/improving-plugin-security/16163) — community + lead-on-record, 2021-03-27. Manifest permissions önerisi, nodeIntegration açık itirafı.
8. [On the security of plugins — Standard Notes Decrypted blog](https://standardnotes.com/blog/on-the-security-of-plugins) — vendor-blog, 2022-03-14. Power-vs-access tradeoff açık taahhüt; editor+theme sınırlandırması.

### Wasm tabanlı plugin sandbox (8 kaynak)

9. [Zed Decoded: Extensions](https://zed.dev/blog/zed-decoded-extensions) — vendor-blog, 2024-10-21. Wasmtime + wit-bindgen + WIT, üretim örneği, async Rust, host function listesi.
10. [Extensible Language Support in Zed — Part 1](https://zed.dev/blog/language-extensions-part-1) — vendor-blog, 2024-04-18. Untrusted-code-first framing, Wasmtime + Tree-sitter wasm scanners.
11. [Wasmtime Security](https://docs.wasmtime.dev/security.html) — official. Sandbox guarantees, Spectre mitigations, cap-std.
12. [Wasmtime — An Application with Plugins (WASIp2)](https://docs.wasmtime.dev/wasip2-plugins.html) — official. Empty host interface default + WIT example.
13. [Extism — framework for building with WebAssembly](https://github.com/extism/extism) — vendor + community, son push 2026-03-26. 15 host SDK, 10 PDK, WASI'siz host-controlled HTTP.
14. [Extism — Host Functions](https://extism.org/docs/concepts/host-functions/) — vendor docs. Wasm value type'larıyla sınırlı host function ergonomics.
15. [Building Native Plugin Systems with WebAssembly Components — Sy Brand](https://tartanllama.xyz/posts/wasm-plugins/) — independent-expert (Microsoft engineer), 2025-08-05. Wasmtime + Component Model production hazır; "no shared memory" tax detayları.
16. [WASI and the WebAssembly Component Model: Current Status — eunomia](https://eunomia.dev/blog/2025/02/16/wasi-and-the-webassembly-component-model-current-status/) — independent-expert, 2025-02-16. Component Model halen draft + Wasmtime 25.0 + Preview 3 async 2025+.

### JS tabanlı plugin sandbox (8 kaynak)

17. [Hardened JavaScript — hardenedjs.org](https://hardenedjs.org/) — official. Lockdown + Compartment + harden API'leri.
18. [SES Guide — endojs/endo](https://github.com/endojs/endo/blob/master/packages/ses/docs/guide.md) — official. OCAP discipline, eval filtering, mutable-state-inside-frozen-surface footgun.
19. [MetaMask Snaps Execution Environment](https://docs.metamask.io/snaps/learn/about-snaps/execution-environment/) — official. SES-based sandbox, exposed/blocked globals.
20. [Snaps Permissions reference](https://docs.metamask.io/snaps/reference/permissions/) — official. ~12 endowment + caveat catalog, manifest schema.
21. [Snaps Security Guidelines](https://docs.metamask.io/snaps/learn/best-practices/security-guidelines/) — official. Reduced timer precision, supply-chain pinning, LavaMoat.
22. [How we built the Figma plugin system — Figma Engineering](https://www.figma.com/blog/how-we-built-the-figma-plugin-system/) — vendor-blog, 2019-08-22. Realms shim → QuickJS-on-WASM geçişi precedent.
23. [Figma — How Plugins Run](https://developers.figma.com/docs/plugins/how-plugins-run/) — official current state. Two-context architecture (sandbox + iframe).
24. [DelSkayn/rquickjs](https://github.com/DelSkayn/rquickjs) — community, MIT, ~907 star. Pure-Rust QuickJS embed, ES2020, async.
25. [Metamask Snaps: Playing in the Sand — OtterSec](https://osec.io/blog/2023-11-01-metamask-snaps/) — independent-expert, 2023-11-01. Sanitize-then-assert ordering bypass, defense-in-depth fail.

### Tauri 2 ACL + supply chain + adjacent (6 kaynak)

26. [Tauri 2 Capabilities](https://v2.tauri.app/security/capabilities/) — official, son güncelleme 2025-08-01. Default-deny IPC, Linux iframe distinguishability caveat.
27. [Tauri 2 Permissions](https://v2.tauri.app/security/permissions/) — official, son güncelleme 2025-04-08. TOML grammar, scope.allow/deny.
28. [Tauri 2 Capability reference](https://v2.tauri.app/reference/acl/capability/) — official. JSON capability example, URLPattern remote, platform targets.
29. [Tauri, wasm and wasi — discussion #9521](https://github.com/orgs/tauri-apps/discussions/9521) — community + maintainer, 2024-04-20. Tauri'de WASI yok confirmation.
30. [Supply Chain Risk in VSCode Extension Marketplaces — Wiz Research](https://www.wiz.io/blog/supply-chain-risk-in-vscode-extension-marketplaces) — vendor-blog, 2025-10-15. 550+ leaked secret, 100+ extension update token; reproducible-build + per-update revocation gerekçesi.
31. [Malicious VSCode Extension Anivia/OctoRAT Attack Chain — Hunt.io](https://hunt.io/blog/malicious-vscode-extension-anivia-octorat-attack-chain) — vendor-blog, 2025-12-03. 4-saatlik marketplace TTR floor; multi-stage RAT.
32. [Anytype Developer Portal](https://developers.anytype.io/) — official, son güncelleme 2025-11-08. E2EE notes app extensibility yapan rakibin docs gap'ı.

---

## 7. Dahil edilmeyen kaynaklar

- Çeşitli "top 10 Obsidian plugins" listicle siteleri — content farm, mimari içerik yok.
- WordPress plugin marketplace yazıları — sektör eşleşmiyor (server-side PHP vs. client-side desktop), mekanizmalar transfer olmuyor.
- Bazı genel "supply chain security 2026" blog yazıları — Wiz/Hunt.io/Visual Studio Magazine zaten yeterli kapsama veriyor.
- Cryptsidian/VaultGuard gibi Obsidian community-encryption plugin'leri — Myne için anti-pattern (bu projeler tam olarak Myne'in çözmek istediği problem).
- Bitwarden architecture docs — extensibility modeli aday değil; client'lar farklı runtime'larda (browser ext, mobile, desktop) ama plugin sistemi yok, bu yüzden değil emsal.

---

## 8. Sonraki adımlar

Bu rapor onaylanırsa, yapılması önerilen takip işleri:

1. **`docs/threat-model.md` §5'e plugin disclaimer'ını netleştir.** Mevcut "*plugins run inside the trust boundary of the client*" cümlesini, bu raporun TL;DR maddesi 1-3'ündeki language ile güncelle. Mimari taahhüt: "*if a plugin system ever ships, it ships with capability-handoff sandbox by construction; vault-wide read is a permanent anti-feature.*"
2. **`design-notes.md`'ye giriş ekle** — bu raporun varlığı + plugin tasarım kararının Phase 4'e ertelenmesi + buradaki TL;DR'ın taahhüt olarak korunması.
3. **`docs/glossary.md`'ye terimler:** "plugin sandbox", "capability handoff", "endowment" (MetaMask anlamı), "host function", "WIT".
4. **Phase 4 başında bu raporu re-validate et:** Wasm Component Model RFC stable mi? WASI Preview 3 mainstream mi? rquickjs interrupt API dokümante edildi mi? Marketplace threat landscape ne durumda? Karar reset.

---

*Bu doküman Myne projesinin `docs/research/` klasörü altında ilk dosyadır. Konvansiyon: research raporları normatif değildir, spec değildir, decisions log'a girmez. Onaylanmış bulgular `decisions.md`'ye, mimari taahhütler `threat-model.md`'ye, terimler `glossary.md`'ye taşınır.*

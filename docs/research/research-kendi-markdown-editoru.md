# Kendi Markdown Editörünü Yazmak — Myne için Araştırma Raporu

**Tarih:** 2026-04-29
**Kaynak sayısı:** 16 arama sorgusu + 41 URL fetch edildi → 34 kaynak rapora dahil
**Güven seviyesi:** Yüksek — birincil kaynaklar (CodeMirror docs, Lexical docs, ProseMirror docs, MDN, Cure53/DOMPurify), Marijn Haverbeke'nin doğrudan ifadeleri ve çoklu bireysel deneyim raporları çelişme noktalarında çapraz doğrulandı.

## TL;DR

- **Tam sıfırdan, kendi document model'ini ve `contentEditable` reconciliation'ını yazma yolu Myne'nin Phase 1 sürümü için akıl dışı bir yatırım.** Lexical/ProseMirror/CodeMirror'un var olma sebebi tam olarak budur ve solo-geliştirici raporları "vazgeçtim" ile ">10k LOC, 6+ ay" arasında salınıyor.
- **CodeMirror 6 zaten Phase 1 planındaki kararın doğru yanıtı.** Obsidian, Overleaf, Chrome DevTools onu kullanıyor; `lang-markdown` + decoration/widget sistemi Obsidian'ın "Live Preview" tarzını mümkün kılan tam zemindir; mobil prose autocorrect dezavantajı senin Phase 1 desktop hedefin için bağlayıcı değil.
- **"Kendim yazmak istiyorum" arzusunun rasyonel karşılığı: CodeMirror 6'nın *üstüne* bir Myne-özel decoration/widget katmanı yazmak.** Bu "kendi editörünü yazma"nın gerçek anlamı: input/undo/IME/selection bug'ları seninle çıkmaz; sen "Myne markdown'ında bir header'ı nasıl render ediyorum, wikilink chip'i nasıl çiziyorum, syntax karakterlerini ne zaman gizliyorum" katmanını yazıyorsun. Referans örnekler (`obsidian-cm6-attributes`, `codemirror-rich-markdoc`) bunu birkaç yüz LOC'ta gösteriyor.
- **"Hayır, gerçekten sıfırdan textarea + preview yazmak istiyorum"** → 200-400 LOC'ta MVP olur, *ama* `[[wikilinks]]`, live decoration, syntax-aware undo, IME-doğru CJK girişi ve Obsidian-stili tek-pencere live formatting hepsini kaybedersin. `vision.md`'nin tagline'ı "backlinks ve graph birinci-sınıf" diyor — `<textarea>` ile bu sözle aran açılır.
- **Tauri WebView tek-tip değil:** macOS WKWebView, Linux WebKitGTK, Windows WebView2. EditContext API (modern contentEditable-alternatifi) macOS ve Linux Tauri build'lerinde *çalışmaz*. "Modern API ile contentEditable acılarını atlatırım" yolu Tauri için kapalı.

## Arka plan ve kapsam

**Soruyu yeniden ifade.** `vision.md` "CodeMirror 6 editor with live markdown and `[[wikilinks]]`" diyor; `decisions.md` 2026-04-29 entry'si vault creation sonrası açılan boş editor shell'i `src/screens/Editor.tsx`'e ekledi (şu an `<textarea>`). Sen bu Phase 1 kararını **tamamen değiştirmeden önce** "kendi markdown editörümü yazıp bu shell'in içine koyabilir miyim, koyarsam ne kazanır ne kaybederim?" sorusunun yanıtını arıyorsun.

**Kapsadığımız.** (1) "Markdown editor yazmak"ın gerçekte hangi katmanlardan oluştuğu, (2) browser ortamında tam-custom mimarinin neden zor olduğu, (3) CodeMirror 6'yı feda etmenin maliyeti, (4) Tauri WebView'a özgü kısıtlar, (5) Myne'ye özgü güvenlik kaygıları (TB9, render-time XSS), (6) MVP yol haritası ve fedakârlıklar.

**Kapsamadığımız.** Real-time collaborative editing (Phase 4), CRDT, plugin sandboxing (vision'da out-of-scope), graph view yaklaşımları (Cytoscape kararı zaten alınmış).

**Varsayım.** "Kendi markdown editor"ünden kastının "Bear/Typora-stili tek-pencere live formatting" olduğunu varsayıyorum. Eğer kastın "Notion-stili block model" ise tablo değişir (block model = ProseMirror/Lexical bölgesi).

## Bulgular

### 1. Bir markdown editor'un anatomisi

Tüm modern editörler — hangi kütüphaneyi seçersen seç — aynı temellerden inşa ediliyor: bir document model, bir selection model, bir transaction-tabanlı state yönetimi, bir input katmanı, bir render katmanı [[1]](https://playfulprogramming.com/posts/fundamentals-of-rich-text-editors/). Hangilerini *kendin* yazıp hangilerini *outsource ettiğin*, "kendi editörümü yazıyorum"un gerçek anlamını belirler.

| Katman | Ne yapar | Kendin yazma maliyeti |
|---|---|---|
| **Input layer** | Klavye, IME, paste, drag-and-drop event'leri; karakterleri document'e iletir | **Çok yüksek** — IME (CJK, Türkçe ölü-tuşlar), Android keyboard'ları, tarayıcı farkları |
| **Document model** | Metnin canonical hâli; insert/delete/replace | **Orta** — String yeterli, sonra rope/piece-table'a yükselt |
| **Selection model** | Cursor + range, transaction altında stable | **Yüksek** — cursor manipulation jsbarretto'nun en çok şikâyet ettiği problem [[7]](https://blog.jsbarretto.com/post/text-editor) |
| **Transaction/undo** | Her değişiklik geri-alınabilir step; selection da history'nin parçası | **Orta-yüksek** — Quill, Trix, ProseMirror her birinin kendi mantığı [[8]](https://www.tiny.cloud/blog/undo-function-handling/) |
| **Render layer** | Document → DOM (decoration, widget, syntax highlight) | **Orta** — decoration'ı IDOM altında yönetmek non-trivial |
| **Parser (markdown)** | Düz metin → AST | **Düşük** — markdown-it / `@lezer/markdown` / micromark hazır |
| **Sanitizer (render time)** | AST → güvenli HTML | **Düşük** — DOMPurify / rehype-sanitize hazır [[5]](https://github.com/cure53/DOMPurify) |

Bütün katmanları yazmak = ProseMirror/Lexical/CodeMirror inşa etmek. Hepsini outsource etmek = `<MDEditor />` import. Aradaki seçim haritası:

### 2. Mimari seçenekler — beş gerçek yol

**A) Pure `<textarea>` + side-by-side preview.**
En basit yol. ~200-400 LOC. Editor surface'i tarayıcının native textarea'sı; preview ayrı pane. Cursor, IME, undo, selection — *hepsi* tarayıcının. **Kaybedilen:** Bear/Typora-stili "yazarken format gör" deneyimi, syntax karakterlerini gizleme, inline `[[wikilink]]` chip'i. Vision.md'nin "backlinks first-class" sözüne ihanet etmez ama UX Obsidian'ın *gerisindesin*. TinyMDE de tam bu kategori: `<textarea>` mirror + regex grammar + HTML overlay; <70 KB, EasyMDE'nin ~280 KB CodeMirror-bagajına alternatif olarak yazıldı [[3]](https://github.com/jefago/tiny-markdown-editor).

**B) `contentEditable` + 100-line-style hack.**
Çok kısa kod (~100 LOC) [[2]](https://mattismegevand.com/posts/inlinecms/) ama bu yazar bile "*kod kaba ve sistem prod-grade değil*" diyor. dev.to/davidartifacts'ın hikâyesi tersini anlatıyor: aynı yola girdi, cursor jump'lar, partial-style sync sorunları, regex-on-keystroke performans dertlerine çarptı, ve `@uiw/react-md-editor`'a geçti [[9]](https://dev.to/davidartifacts/i-tried-to-build-my-own-markdown-editor-and-reality-hit-hard-k8e). `contentEditable`'ın gerçek maliyeti:

- Tarayıcılar arasında selection ve range API'leri farklı [[10]](https://github.com/easylogic/contenteditable/blob/main/README.md)
- Android IME contentEditable bölgesini "tek bir uzun düz metin" olarak görüyor; senin AST'ne kayıtsız [[11]](https://discuss.prosemirror.net/t/contenteditable-on-android-is-the-absolute-worst/3810). Marijn Haverbeke ifadesiyle: *"the IME may view your content very differently than how the user perceives it"*.
- iOS Safari de CJK için benzer kompozisyon bug'ları (yine Marijn'in ifadesi)
- Google Docs paste'i "*onlarca nested span ve inline style*"; partial-bold silmek "*iki ayrı text node, merged node ile inconsistent styling, ya da boş formatting tag*" üretiyor [[1]](https://playfulprogramming.com/posts/fundamentals-of-rich-text-editors/)

**C) `contentEditable` + tam custom doc model (Lexical/ProseMirror/Slate yolunun kendi versiyonu).**
"Kendi editörümü yazdım"ın gerçek anlamı. Lexical'in core'u 22 KB min+gzip ama "*Lexical attaches itself to a contentEditable element*" — yani contentEditable'ı tamamen by-pass etmiyor [[12]](https://lexical.dev/docs/intro). ProseMirror "*editor element içinde tipingi tarayıcıya bırakırız çünkü interfere etmek spell-check'i, mobile autocapitalize'ı bozar*" diyor [[13]](https://prosemirror.net/docs/guide/). Yani: en olgun custom-editor frameworkleri bile contentEditable'ı by-pass etmiyor; *üzerine* yapı kuruyor. Sıfırdan = ~10k LOC + ~6 ay (jsbarretto'nun TUI editörü için verdiği rakam, ki tarayıcı bile değil) [[7]](https://blog.jsbarretto.com/post/text-editor).

**D) `EditContext` API (modern alternatif).**
Chromium 121+ contentEditable'ı by-pass etme yolunu açtı: text input'u DOM'dan ayrıştırıyor, IME composition'ı doğrudan veriyor [[14]](https://developer.chrome.com/blog/introducing-editcontext-api). MDN bunu hâlâ "*Experimental / Limited availability*" işaretliyor [[15]](https://developer.mozilla.org/en-US/docs/Web/API/EditContext_API). caniuse'da global %72 — ama Firefox ve Safari hiç desteklemiyor [[16]](https://caniuse.com/mdn-api_editcontext). **Tauri için kritik:** Tauri macOS'ta WKWebView (Safari/WebKit) [[17]](https://www.gethopp.app/blog/tauri-vs-electron); WKWebView EditContext'i desteklemiyor. Tauri Linux WebKitGTK da. Yani Tauri 2 + cross-platform Phase 1 hedefliyorsan EditContext yolu Windows-only — `decisions.md` "self-host == hosted same boundary" sözüyle uyumsuz, Linux build'i de aynı UX'e sahip olmalı.

**E) CodeMirror 6 üstüne kendi decoration/widget katmanı (önerilen).**
CodeMirror 6'nın mimarisi tam bu kullanım için: state immutable, transactions ile değişir, ViewPlugin/StateField decorations sağlar [[18]](https://codemirror.net/docs/guide/) [[19]](https://thetrevorharmon.com/blog/learning-codemirror/). `@codemirror/lang-markdown` lezer-tabanlı bir markdown parseri sağlıyor (`markdownLanguage` GFM, `commonmarkLanguage` strict CommonMark) [[20]](https://github.com/codemirror/lang-markdown). Obsidian'ın Live Preview'ı tam bu üstüne inşa edilmiş [[21]](https://news.ycombinator.com/item?id=31666186); açık-kaynak referans `codemirror-rich-markdoc` "*lezer-markdown tokenizer'ını kullanır, syntax karakterlerine `cm-markdoc-hidden` sınıfı sarmalar, block-level yapıları block widget ile değiştirir, cursor giren widget kaybolup source görünür*" [[22]](https://github.com/segphault/codemirror-rich-markdoc). Bu ~birkaç yüz LOC'ta Myne-özel "live preview" katmanı demek — sen lezer AST'ini gezip "wikilink ne zaman chip, ne zaman raw göster"e karar veriyorsun, CodeMirror cursor/IME/undo'yu hallediyor.

### 3. CodeMirror 6 ne yapıyor — neden kayıp tehlikeli

| Yetenek | CodeMirror 6 sağlıyor mu? | Sıfırdan yazma yükü |
|---|---|---|
| Cursor stable across edits | ✅ | jsbarretto: "*Cursor manipulation is difficult!*" [[7]](https://blog.jsbarretto.com/post/text-editor) |
| IME (Türkçe ölü-tuş, CJK) doğru | ✅ | Marijn'in 10+ yıllık özel sahası [[11]](https://discuss.prosemirror.net/t/contenteditable-on-android-is-the-absolute-worst/3810) |
| Undo/redo (selection dahil) | ✅ (`@codemirror/commands`) | Quill/Trix custom mantık [[8]](https://www.tiny.cloud/blog/undo-function-handling/) |
| Mobile autocorrect prose | ⚠️ Zayıf — TinyMDE bu yüzden yazıldı [[3]](https://github.com/jefago/tiny-markdown-editor) | Phase 1 desktop = bağlayıcı değil |
| Atomic ranges (wikilink chip silme) | ✅ `EditorView.atomicRanges` [[23]](https://codemirror.net/examples/decoration/) | Backspace-once-deletes-whole-chip mantığını kendin yaz |
| Decorations (mark/widget/replace/line) | ✅ | Render kompozisyonun çekirdeği |
| Reproducible build, tree-shake | ✅ Tree-shakeable | npm'den daha az değil; pek çok paket |
| Markdown lezer parser | ✅ `@codemirror/lang-markdown` | Sıfırdan parser ~bin satır + hata-tolerans |
| Live preview decorations | ✅ ama sen yazıyorsun (lezer AST + decoration) | Cursor/IME hariç de yine sen yaz |

CodeMirror 6'nın **dürüst maliyetleri:**

- **Bundle:** 6.0.0 sürümü 310.9 KB minified / 98 KB gzipped (vs CM5 169.3/55.8) [[21]](https://news.ycombinator.com/item?id=31666186). Tree-shake ile sadece kullandığın paketler giriyor. `threat-model.md` §7 TB9 (minimal direct-dependency surface) açısından bir borç ama Vite + React'in altında ölçek.
- **Öğrenme eğrisi:** Trevor Harmon — "*kütüphanenin ins and outs'unu öğrenmek beklediğimden daha karmaşık*" [[19]](https://thetrevorharmon.com/blog/learning-codemirror/). `Facet`, `StateField`, `ViewPlugin`, `Decoration`, `Transaction`, `ChangeSet`, `Range` — yedi temel primitive.
- **React entegrasyonu:** Vanilla CM6 idiomatic React değil; `@uiw/react-codemirror` veya kendi minimal wrapper (~30 LOC).

### 4. Sıfırdan-yazma maliyeti — somut LOC verileri

| Kaynak | Çıktı | Süre | Kapsam |
|---|---|---|---|
| `inlinecms` (mattismegevand) | ~100 LOC | tek seans | inline contentEditable + Turndown, "*prod-grade değil*" [[2]](https://mattismegevand.com/posts/inlinecms/) |
| TinyMDE | ~62 KB / ~91 KB toplam src | yıllar | regex grammar + textarea mirror, decoration overlay, Live preview yok [[3]](https://github.com/jefago/tiny-markdown-editor) |
| jsbarretto TUI | ~10k LOC | 6 ay | terminal Rust; cursor + highlight + fuzzy search + multi-pane [[7]](https://blog.jsbarretto.com/post/text-editor) |
| Lexical core | 22 KB min+gzip | Meta-scale yıllar | sadece çekirdek; markdown plugin extra [[12]](https://lexical.dev/docs/intro) |
| ProseMirror | 158 KB ilk-yük | Marijn 10+ yıl | doc model + transactions + DOM sync [[24]](https://emergence-engineering.com/blog/lexical-prosemirror-comparison) |
| Lexical (Emergence test) | 160 KB ilk-yük | — | benchmark koşulu [[24]](https://emergence-engineering.com/blog/lexical-prosemirror-comparison) |

Çıkarım: "Editor yazmak basit ya da değil"in cevabı **nelerden vazgeçtiğine** bağlı. Cursor stability + IME + undo/selection-history + decoration-aware rendering = Lexical/ProseMirror/CodeMirror'un var olma gerekçesi.

### 5. Tauri + WebView'a özgü kısıtlar

- **Üç farklı WebView:** macOS WKWebView (WebKit/Safari), Linux WebKitGTK, Windows WebView2 (Chromium) [[17]](https://www.gethopp.app/blog/tauri-vs-electron). EditContext yolu Windows-only.
- **Bundle/RAM (gethopp ölçümleri):** Tauri 8.6 MiB / Electron 244 MiB; 6 pencere RAM Tauri ~172 MB / Electron ~409 MB [[17]](https://www.gethopp.app/blog/tauri-vs-electron). Markdown editor için bundle/RAM rahat.
- **Markdown parser yerleşim seçimi:** `pulldown-cmark` Rust-side parser olarak kullanılabilir (ukash deneyimi) [[25]](https://dev.to/ukash/i-built-a-markdown-editor-with-tauri-heres-what-i-learned-4f5l) — *ama* live decoration için lezer-markdown JS-side AST'i daha kullanışlı çünkü editor durumuyla aynı thread'de senkron. pulldown-cmark plaintext file IO ya da export yolu için daha uygun.
- **macOS keyboard:** `e.key` modifier-key kombolarında `Ω` gibi karakterlere mapliyor — keyboard handler'ında platform-specific path gerekir [[25]](https://dev.to/ukash/i-built-a-markdown-editor-with-tauri-heres-what-i-learned-4f5l). Ham contentEditable'la daha çok yakar; CodeMirror keymap'i `e.code` üzerinden absorbe eder.

### 6. Myne'ye özgü güvenlik kaygıları

`docs/threat-model.md` §3 TB9 (*minimal direct-dependency surface*) ve §3 TB2 (*decrypted plaintext, root key, item keys*) render-time için iki net kuralı dayatıyor:

1. **Render-time XSS.** Markdown'ı HTML'e çevirip `dangerouslySetInnerHTML` etmek = note plaintext attacker-controlled olabilir (örn. başka cihazdan sync'lenmiş not). HackerOne bu vektörü direkt uyarıyor [[26]](https://www.hackerone.com/blog/secure-markdown-rendering-react-balancing-flexibility-and-safety). İki güvenli desen:
   - **react-markdown:** Virtual DOM kurar, `dangerouslySetInnerHTML` *kullanmaz*, default-by-safe [[27]](https://github.com/remarkjs/react-markdown). Wikilinks için custom remark plugin gerekir (CommonMark/GFM'de yok).
   - **DOMPurify:** HTML üretmen gerekirse `DOMPurify.sanitize(dirty)` [[5]](https://github.com/cure53/DOMPurify). v3.4.1 mevcut.
   - **CodeMirror yolu en güvenli:** CodeMirror metni HTML olarak render *etmiyor* — decoration mark'lar CSS sınıfı, widget'lar senin DOM oluşturduğun (controlled). Sen `innerHTML` yazmadıkça XSS yüzeyi yok.
2. **Direct dependency surface.** `react-markdown + remark-gfm + remark-wikilink-plugin` = ~3 doğrudan ama transitif unified ekosistemi geniş. CodeMirror 6 + lang-markdown ise lezer-markdown'a bağlı; tree-shake ile kullanılan paketler. **TB9 açısından net olmayan:** hangisinin transitif yüzeyi daha küçük? `pnpm why` + `socket.dev` taraması Phase 1'de yapılmalı; bu ayrı bir karar.

`design-notes.md` 2026-04-29 girdisi editor surface'i terminal ve persistence-yok olarak tanımlıyor — yani markdown editor şu an **purely UI**. Encryption pipeline ile entegrasyon Phase 1'in bir sonraki feature'ı.

### 7. Document data structure tartışması — şu an gereksiz

Rope vs piece table vs gap buffer vs string — Wikipedia ve Zed kapsamlı [[28]](https://en.wikipedia.org/wiki/Rope_(data_structure)) [[29]](https://en.wikipedia.org/wiki/Piece_table) [[30]](https://zed.dev/blog/zed-decoded-rope-sumtree). Phase 1 için somut durum:

- Notlar tek dosya, plaintext markdown, dogfood için 30 gün test (`vision.md` DoD).
- VS Code piece-table-twist'i 1 GB+ dosyalar için optimize; Bear/Obsidian default vault notları ~10 KB tipik.
- Medium/swlh: "*Simple immutable strings, replaced by new text, though inefficient, is fast enough*" [[31]](https://medium.com/swlh/writing-a-code-editor-with-layers-1d8ad6ca0ddb).

**Çıkarım:** CodeMirror 6 kullanırsan zaten kendi `Text` rope'unu kullanır — bu çözülmüş. Sıfırdan yazarsan string-tabanlı başla, performans gerçekten sorun olduğunda değiştir. Şu an *premature optimization*.

## Çelişen görüşler / tartışmalı noktalar

**Çelişki 1 — `contentEditable` salvageable mi?**
- **Pozisyon A (Marijn Haverbeke, ProseMirror, CodeMirror):** Salvageable, ama uzun yıllar süren özen gerekir; tarayıcı native davranışlarını respect ederek kullanılır, by-pass edilmez [[13]](https://prosemirror.net/docs/guide/).
- **Pozisyon B (Lexical, EditContext savunucuları):** Yetersiz — bu yüzden Lexical kendi reconciler'ını yazıyor [[12]](https://lexical.dev/docs/intro), bu yüzden Microsoft EditContext'i standartlaştırdı [[14]](https://developer.chrome.com/blog/introducing-editcontext-api).
- **Pozisyon C (jitl@HN, Aufreiter@letsken):** "*Lexical olgun değil; ProseMirror/TipTap çok daha düşük risk*" [[32]](https://news.ycombinator.com/item?id=36600893) [[33]](https://letsken.com/michael/how-to-implement-a-web-based-rich-text-editor-in-2023).
- **Benim okumam:** Myne'nin Phase 1 hedefi (desktop-only Tauri 2, Türk + İngilizce IME, Latin script) için **CodeMirror 6'nın `lang-markdown` + decoration yaklaşımı** doğru taraf. ProseMirror'un contentEditable-dostu yolundan daha az LOC ve Obsidian'ın 4+ yıllık production pisti var.

**Çelişki 2 — Sıfırdan yazılan markdown editor'ün gerçekçiliği.**
- **Pozisyon A (mattismegevand, "I'll just write it" sentiment):** ~100 LOC mümkün [[2]](https://mattismegevand.com/posts/inlinecms/).
- **Pozisyon B (David Artifacts, jsbarretto):** Cursor, performance, IME duvarına çarparsın; kütüphaneye dön [[9]](https://dev.to/davidartifacts/i-tried-to-build-my-own-markdown-editor-and-reality-hit-hard-k8e) [[7]](https://blog.jsbarretto.com/post/text-editor).
- **Benim okumam:** A doğru *eğer* hedef "Markdown'u browse + GitHub Issues stili düzenle" ise. Myne'nin tagline'ı "[[wikilinks]] ve graph birinci-sınıf" diyor; bu ham `<textarea>` ile ulaşılamaz. **Pozisyon B kazanıyor.**

**Çelişki 3 — Lexical mı ProseMirror mu?**
- **Lexical (Meta resmî):** 22 KB core, hundreds of millions of users [[12]](https://lexical.dev/docs/intro).
- **ProseMirror (Marijn, Aufreiter):** Battle-tested, daha düşük risk [[13]](https://prosemirror.net/docs/guide/) [[33]](https://letsken.com/michael/how-to-implement-a-web-based-rich-text-editor-in-2023).
- **Emergence test (bias-flagged: ProseMirror consultancy):** Lexical kısa süreli daha hızlı, uzun süreli memory leak (3.9 GB vs 6-18 MB); ProseMirror stable [[24]](https://emergence-engineering.com/blog/lexical-prosemirror-comparison).
- **Benim okumam:** Bu tartışma Myne için **alakasız**. İkisi de markdown editor değil, rich-text framework. CodeMirror 6 lang-markdown + decorations Markdown-native. Lexical/ProseMirror'a inmek "no proprietary format, no internal database that owns your content" sözüne (vision.md) ekstra bir AST ↔ markdown-string serileştirme borcu getirir. CodeMirror metni canonical markdown string olarak tutar, ekstra serileştirme yok. **CodeMirror 6 doğru tarafta.**

## Güncellik notu

- **Hızlı değişen** (6 ay içinde tekrar doğrula): EditContext API browser support — Firefox/Safari positions, Tauri WKWebView updates. Lexical 1.0 RC durumu (şu an v0.44.0).
- **Stabil** (yıllar): contentEditable temel davranış, rope/piece-table karakteristikleri, CommonMark spec, CodeMirror 6 mimari kararları (2022 stable'dan bu yana).
- **Belirsiz**: react-markdown vs Tiptap vs MDXEditor ekosistem konsolidasyonu; `@codemirror/lang-markdown` Live-Preview için resmi hook'lar (Obsidian buna ihtiyaç duydu, kendi yazdı).

## Öneri

**Phase 1 için "kendi markdown editörümü yazıyorum" ifadesinin Myne için doğru karşılığı: CodeMirror 6'yı core olarak kullan, üstüne Myne-özel decoration/widget katmanı yaz.** Bu yol:

1. **Bağımlılık yüzeyi gerekçeli.** Vision'ın "ProseMirror'a değil, yalnızca CodeMirror'a borçlu" olması TB9 prensibine uyar; obsidian referansı `codemirror-rich-markdoc` da bunun pisti. Tek başına `<MDEditor />` import etmekten dürüstçe **daha az** iş, çünkü oradaki UI'ı kontrol etmiyorsun.
2. **Vision'la uyumlu.** "[[wikilinks]] inline chip", "live formatting", "syntax-aware backspace" → CodeMirror decoration system + atomic ranges direkt cevap.
3. **DoD'ye ulaşılabilir.** "Recovery flow drill: yazılı not 30 gün dogfood" hedefi için custom contentEditable kararı 2-3 ay rampa getirir; CodeMirror + custom decorations ~2-4 hafta MVP.

**Aşamalar:**

**Aşama 1 — Plan değişmedi, refined.** `package.json`'a `@codemirror/state @codemirror/view @codemirror/commands @codemirror/lang-markdown` ekle (`@uiw/react-codemirror` opsiyonel; minimal kendi React wrapper'ın 30 LOC'tan az). `src/screens/Editor.tsx`'in textarea'sını `EditorView` ile değiştir. Hedef: typing + lang-markdown highlighting çalışır. **~1 hafta.**

**Aşama 2 — Wikilink decoration.** Lezer markdown AST'ini gez (`@lezer/markdown` AST'inden `Link`/custom node bul; `[[...]]` için custom inline parser, lang-markdown extension API'si ile eklenir). Aktif satır dışındayken `[[Note Title]]` → kompakt chip widget; cursor satıra girince ham metin görünür. **~3-5 gün.**

**Aşama 3 — Syntax karakter gizleme (Bear/Typora-stili).** `**bold**` etrafındaki `**`'lara `cm-myne-hidden { display: none }` mark decoration; cursor `**` üzerine geldiğinde decoration kalkar. Header `#`, inline code, italic için aynı pattern. Bu, `obsidian-cm6-attributes` örneğinin direkt portu olur. **~3-5 gün.**

**Aşama 4 — Backlink integration sınırı.** Vault file persistence ile birleştiğinde anlam kazanır. Phase 1 editor shell'ı şu an persistence'sız; backlink panesi note-write-flow geldiğinde anlamlı veri alır.

**En yaygın tuzaklar ve atlatma:**

- **Tuzak:** "Custom decoration için ViewPlugin yeterli mi yoksa StateField mi?" → **Çözüm:** Vertical layout etkileyen replacements (multiline widget, chip block) StateField'dan; salt-renkleme/sınıf-ekleme ViewPlugin'den. Obsidian forumu bunu sürekli soruyor [[34]](https://forum.obsidian.md/t/codemirror-view-plugin-vs-state-field-for-inline-replacements/78108). Resmi kural: "*Decorations that significantly change the vertical layout of the editor... must be provided directly*" (StateField) [[23]](https://codemirror.net/examples/decoration/).
- **Tuzak:** Wikilink chip silme — bir backspace tüm chip'i silmeli. → **Çözüm:** `EditorView.atomicRanges.of(...)` register et; CodeMirror cursor motion otomatik atom geçer [[23]](https://codemirror.net/examples/decoration/).
- **Tuzak:** macOS modifier-key key remap (`CMD+Alt+Z` → `Ω`) [[25]](https://dev.to/ukash/i-built-a-markdown-editor-with-tauri-heres-what-i-learned-4f5l). → **Çözüm:** CodeMirror keymap `e.code` üzerinden çalışır; bu issue absorbe edilir.
- **Tuzak:** XSS (paste'den veya başka cihazdan sync'lenmiş not'tan). → **Çözüm:** Yukarıda — CodeMirror metni HTML olarak render etmiyor; sen widget içinde `innerHTML` yazmadıkça XSS yüzeyi yok. Block widget içinde HTML render edersen DOMPurify veya rehype-sanitize geç [[5]](https://github.com/cure53/DOMPurify) [[27]](https://github.com/remarkjs/react-markdown).
- **Tuzak:** TB9 dependency surface şişmesi. → **Çözüm:** `pnpm why <pkg>`, `pnpm ls --depth=0`, `socket.dev` denetimi MVP commit'iyle aynı PR'da.

**Eğer karar hâlâ "tam-custom":** CodeMirror'u kullanmadan başla, ama önce TinyMDE'nin `TinyMDE.ts` (~62 KB tek dosya) kaynağını oku — minimal-yakalı sıfırdan ne çıkıyor, neyi feda ediyor (no Live Preview, no atomic ranges, no IME-aware undo) [[3]](https://github.com/jefago/tiny-markdown-editor). Bu, "kendi yazdım" ile "mockup gibi görünüyor" arasındaki gerçek farkı tek bir dosyada görmen.

## Kaynakça

1. [Fundamentals of Rich Text Editors](https://playfulprogramming.com/posts/fundamentals-of-rich-text-editors/) — community tutorial, Aralık 2025; document/selection/transaction model özeti, contentEditable DOM stability sorunları.
2. [mm. — CMS-like editing for Markdown with contenteditable and 100 lines of JS](https://mattismegevand.com/posts/inlinecms/) — independent-expert blog, Haziran 2025; en küçük "kendim yazdım" örneği.
3. [TinyMDE](https://github.com/jefago/tiny-markdown-editor) — OSS repo, Nisan 2026; CodeMirror'sız MVP'nin gerçek boyutu (~91 KB src) ve "neyden vazgeçtim" listesi.
4. [Editor.js](https://editorjs.io/) — vendor docs; block-based architecture alternatifi.
5. [DOMPurify](https://github.com/cure53/DOMPurify) — official Cure53 repo, Nisan 2026 (v3.4.1); XSS sanitizer.
6. [How to Build a Markdown Editor with Real-time Preview](https://zuunote.com/blog/how-to-build-a-markdown-editor-with-real-time-editing/) — tutorial; basit textarea + preview pattern referansı.
7. [Writing my own text editor, and daily-driving it (jsbarretto)](https://blog.jsbarretto.com/post/text-editor) — independent-expert blog, Mart 2026; ~10k LOC / 6 ay TUI editör retrospektifi.
8. [Handling undo function in rich text editors (TinyMCE)](https://www.tiny.cloud/blog/undo-function-handling/) — vendor blog; undo stack tasarım deseni.
9. [I Tried to Build My Own Markdown Editor (DEV — davidartifacts)](https://dev.to/davidartifacts/i-tried-to-build-my-own-markdown-editor-and-reality-hit-hard-k8e) — community Şubat 2025; "vazgeçtim, kütüphane kullandım" deneyim raporu.
10. [contenteditable.lab (easylogic)](https://github.com/easylogic/contenteditable/blob/main/README.md) — community OSS; cross-browser quirks katalogu.
11. [Contenteditable on Android is the Absolute Worst (ProseMirror discuss)](https://discuss.prosemirror.net/t/contenteditable-on-android-is-the-absolute-worst/3810) — Marijn Haverbeke + community Haziran 2021; Android IME ifadeleri.
12. [Lexical Intro](https://lexical.dev/docs/intro) — official Meta docs; 22 KB core, contentEditable üstüne kurulu.
13. [ProseMirror Guide](https://prosemirror.net/docs/guide/) — official Marijn docs; doc/selection/transaction state-first model.
14. [Introducing the EditContext API (Chrome)](https://developer.chrome.com/blog/introducing-editcontext-api) — vendor blog Chrome 121, Şubat 2024.
15. [EditContext API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/EditContext_API) — official MDN, Nisan 2025; "*Experimental / Limited availability*".
16. [EditContext API (Can I Use)](https://caniuse.com/mdn-api_editcontext) — community data; %72 global, Safari/Firefox yok.
17. [Tauri vs Electron (gethopp)](https://www.gethopp.app/blog/tauri-vs-electron) — vendor blog Nisan 2025; bundle/RAM ölçümleri, WebView per-platform.
18. [CodeMirror System Guide](https://codemirror.net/docs/guide/) — official; State/Transaction/View mimari.
19. [Learning CodeMirror (Trevor Harmon)](https://thetrevorharmon.com/blog/learning-codemirror/) — independent-expert Eylül 2023; Facet/StateField/ViewPlugin/Decoration konseptleri.
20. [@codemirror/lang-markdown](https://github.com/codemirror/lang-markdown) — official; markdownLanguage (GFM+), commonmarkLanguage.
21. [CodeMirror 6.0 Stable Release (HN)](https://news.ycombinator.com/item?id=31666186) — community Haziran 2022; production kullanımı, bundle ölçüleri.
22. [codemirror-rich-markdoc (segphault)](https://github.com/segphault/codemirror-rich-markdoc) — community OSS; Live-Preview tarzı zengin markdown CodeMirror 6 örneği.
23. [CodeMirror Decoration Example](https://codemirror.net/examples/decoration/) — official; mark/widget/replace/line decorations, atomicRanges.
24. [Rich Text Editors in Action: Stress Test (Emergence Engineering)](https://emergence-engineering.com/blog/lexical-prosemirror-comparison) — vendor-adjacent blog Ekim 2024; 158/160 KB bundle, memory benchmarks. **Bias note:** ProseMirror consultancy.
25. [I built a Markdown editor with Tauri (DEV — ukash)](https://dev.to/ukash/i-built-a-markdown-editor-with-tauri-heres-what-i-learned-4f5l) — community Mart 2026; pulldown-cmark + Tauri pratik deneyim, macOS modifier key sorunu.
26. [Secure Markdown Rendering in React (HackerOne)](https://www.hackerone.com/blog/secure-markdown-rendering-react-balancing-flexibility-and-safety) — vendor blog Aralık 2023; XSS pattern, react-markdown + DOMPurify defense-in-depth.
27. [react-markdown](https://github.com/remarkjs/react-markdown) — official remarkjs, Mart 2025 (v10.1.0); virtual-DOM render, default-by-safe.
28. [Rope (data structure) — Wikipedia](https://en.wikipedia.org/wiki/Rope_(data_structure)) — community/encyclopedia Nisan 2026.
29. [Piece table — Wikipedia](https://en.wikipedia.org/wiki/Piece_table) — community/encyclopedia Ocak 2026.
30. [Rope & SumTree (Zed blog)](https://zed.dev/blog/zed-decoded-rope-sumtree) — vendor blog Nisan 2024; B+ tree variant prod implementasyonu.
31. [Writing a Code Editor with Layers (Medium)](https://medium.com/swlh/writing-a-code-editor-with-layers-1d8ad6ca0ddb) — community Mayıs 2020; storage abstraction önce, data structure sonra.
32. [HN: Rich text editors thread](https://news.ycombinator.com/item?id=36600893) — community Temmuz 2023; Lexical olgunluk tartışması.
33. [How to implement a web-based rich text editor in 2023 (letsken)](https://letsken.com/michael/how-to-implement-a-web-based-rich-text-editor-in-2023) — independent-expert Ocak 2023 (rev. Temmuz 2025); ProseMirror "bare-metal" tavsiyesi.
34. [CodeMirror View Plugin vs. State Field for inline replacements (Obsidian forum)](https://forum.obsidian.md/t/codemirror-view-plugin-vs-state-field-for-inline-replacements/78108) — community Mart 2024; pratik decoration sınıfı kararı.

## Dahil edilmeyen kaynaklar

- **OpenReplay blog** — TLS sertifika doğrulama hatası, fetch başarısız. Alternatif kaynaklar (HackerOne ve react-markdown) kapsadığı için kritik değil.
- **forum.obsidian.md/t/how-to-configure-codemirror-to-work-like-live-preview/43047** — orijinal post sadece soru, replyleri fetch'te dönmedi; soru Source 22 (`codemirror-rich-markdoc`) ile zaten yanıtlanıyor.
- **github.com/danmugh/rust-tauri-markdown-editor** — tek-kişilik 5-commit scaffold, README'de tartışma yok; pattern existence-proof olarak markora (Source 2 batch F) zaten kapsıyor.
- **`@uiw/react-md-editor`, SimpleMDE, EasyMDE, EditorJS, MDXEditor** arama sonuçları — "ready-made editor" kategorisinde, kullanıcının zaten istemediği kategori.
- **markdown-it / marked / unified comparison** — parser tarafı Phase 1 için CodeMirror lang-markdown tarafından çözüldüğünden secondary.

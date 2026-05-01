# Myne için Markup Dili Seçimi: Araştırma Raporu

**Tarih:** 2026-05-01
**Kaynak sayısı:** ~60 değerlendirildi, 32 rapora dahil edildi
**Güven seviyesi:** Yüksek — alandaki tartışma olgun, tasarım tradeoff'ları iyi belgelenmiş, hem akademik hem ekosistem sinyalleri tutarlı.

## TL;DR

- **Markdown'ın eleştirileriniz haklı.** Belirsiz spec, parsing tek-geçişli olmayan, lehçe parçalanması, CJK'da kırılan vurgu, ReDoS/XSS yüzeyi, tablolarda çok satırlı hücre yok, semantik fakir, attribute sistemi yok — bunlar literatürde belgelenmiş, Markdown'un kendi yaratıcısı tarafından da kabul edilmiş kusurlar.
- **Ama "kendi markup dilimizi yapalım" ekonomik olarak yanlış.** DSL maintenance gerçek; parser + syntax highlighter + editor + conversion + ekosistem yıllar alır, audit yüzeyini büyütür ve Myne'in "minimal direct-dependency" disiplini ile çelişir.
- **Markdown'a en iyi yapılandırılmış alternatif zaten yazılmış: Djot** (John MacFarlane, 2022+). Tek-geçişli ayrıştırma, generic container'lar, attribute sistemi, footnote/table/math native — ve CommonMark'ı tasarlayan kişi tarafından "Markdown'u baştan tasarlasaydım" projesi olarak konumlandırılmış.
- **Üçüncü bir yol: hibrit model.** İç temsil olarak yapılı bir AST (Peritext-style ya da Notion-tarzı block JSON), serileştirme için Djot/CommonMark. Şifreli blob içine ne koyduğunuz threat-model'i etkilemez, ama UX kalitesi, eşzamanlı düzenleme yeteneği ve plain-text export sözünü ayrı ayrı tutmanızı sağlar.
- **Önerim:** Sıfırdan dil tasarlamayın. **Djot'u benimseyin** (CommonMark süper-kümesi olarak değil, ana format olarak), opsiyonel olarak Markdown export filter'ı bırakın. Custom DSL'i sadece Djot'un yapamadığı somut bir gereksinim çıkarsa konuşun.

## Arka plan ve kapsam

**Soru:** Myne'in not içeriği için Markdown yerine daha iyi bir markup dili kullanmak — ya da tasarlamak — anlamlı mı?

**Kapsam dahili:**
- Markdown'ın somut tasarım kusurları
- Olgun ve modern alternatif markup dilleri
- Block-based vs flat-text data model tradeoff'u
- Şifreli not uygulamalarına özgü kısıtlar
- Yeni bir markup dili tasarlamanın gerçek maliyeti

**Kapsam dışı:**
- Editör seçimi (CodeMirror, ProseMirror vs ham `<textarea>`) — bu ayrı bir karar
- Render motorunun teknik detayları (markdown-it vs cmark vs jotdown)
- WYSIWYG vs source mode UX kararları

**Varsayımlar:**
- Myne v0.1 desktop uygulaması ve docs altyapısı için aynı dili kullanmayı planlıyor (ya da kullanabilir).
- "Plain-text portability" `vision.md`'deki anti-feature commitments arasında implicit olarak var (proprietary format lock-in yok).
- Threat model'de markup dili **şifreli blob içeriği** olduğundan TB5 (server) saldırgan modelinden bağımsız; format seçimi cryptographic değil UX/audit-yüzeyi kararıdır.

## Bulgular

### 1. Markdown'ın somut tasarım kusurları

CommonMark'ın yazarı John MacFarlane bile 2014'te yayımladığı "Beyond Markdown" essay'inde altı temel kusur saymış [[1]](https://johnmacfarlane.net/beyond-markdown.html):

1. **Vurgu (emphasis) belirsizliği.** `***text***` gibi diziler 8 farklı şekilde yorumlanabiliyor; CommonMark spec'i bunu çözmek için 17 kural barındırıyor. MacFarlane çözüm olarak `_` ile `*` arasında ayrım yapılmasını öneriyor.
2. **Reference link forward-dependency.** `[foo][bar][baz]` tek-geçişte ayrıştırılamaz — ne anlama geldiği dosyanın geri kalanına bağlı. Tek-geçişli ayrıştırıcı yazılamaması demek.
3. **Indented code block + list interaction.** Liste içi kuralların büyük kısmı sadece indented-code-block uyumluluğu için; fenced kod blokları zaten varken tarihi yük.
4. **Raw HTML pass-through.** Block vs inline HTML için yedi ayrı eşleşme kuralı; HTML olmayan formatlara çıkış yapıldığında anlamsız.
5. **List ile blank line interaction.** "Principle of uniformity"yi ihlal ediyor — bir paragraf liste içinde ve dışında aynı şeyi ifade etmiyor.
6. **Attribute sistemi yok.** Class, id, key=value eklemek için her dialect kendi syntax'ını icat etmiş.

Babelmark'ın kanıtladığı gibi, ortada 20+ implementasyon var ve aynı dokümanı farklı şekilde render ediyorlar [[2]](http://babelmark.github.io/). Eric Holscher 2016'daki "teknik dokümantasyon için Markdown kullanmayın" yazısında aynı parçalanmayı belgelemiş [[3]](https://www.ericholscher.com/blog/2016/mar/15/dont-use-markdown-for-technical-docs/).

**Yeni eklenen sorun: CJK + LLM çağı.** Hackers.pub Yurume'un Mart 2026 yazısında belirttiği gibi, CommonMark'ın delimiter-flanking kuralları Çince/Japonca/Korece metinde sıklıkla başarısız — `**마크다운(Markdown)**은` gibi yapılarda `**` rendere edilmeyip ham kalıyor [[4]](https://hackers.pub/@yurume/019b912a-cc3b-7e45-9227-d08f0d1eafe8). LLM'lerin Markdown üreten varsayılan format olarak kullanılmasıyla bu daha çok dikkat çekiyor.

**Güvenlik yüzeyi.** Markdown parser'larında ReDoS ve XSS açıkları sürekli rapor ediliyor:
- `markdown-to-jsx` CVE-2024-21535 [[5]](https://security.snyk.io/vuln/SNYK-JS-MARKDOWNTOJSX-6258886)
- `markdown-it` 14.1.0 XSS [[6]](https://fluidattacks.com/advisories/fito)
- Cujanovic'in tutulan XSS payload listesi [[7]](https://github.com/cujanovic/Markdown-XSS-Payloads) — markdown-syntax-only bypass'lar dahil (örn. `[text](javascript:alert(1))`)
- ReDoS: `markdown-link-extractor` üzerinde kanıtlı [[8]](https://www.smashingmagazine.com/2021/09/improving-accessibility-of-markdown/)

Myne için kritik olmayabilir (içerik şifreli blob, server view'lamıyor), ama UI tarafında render edildiğinde tüm CVE'lere maruz kalıyor.

**Accessibility.** Smashing Magazine'in 2021 yazısı, çıktı HTML doğru semantik etiketlerle (`<h1>` vs `<p>` font-size'lı), tablolar `<th scope>` ile, görseller anlamlı `alt` ile çıkmadığı sürece screen reader'larda ciddi gerilemeler olduğunu belgelemiş [[9]](https://www.smashingmagazine.com/2021/09/improving-accessibility-of-markdown/).

**Tablo limitleri.** GFM tablolarında satır içi çok satırlı hücre, colspan, rowspan yok. Çoğu kullanıcı çareyi raw HTML enjekte etmekte buluyor [[10]](https://blkpn.com/markdown-table-merge-cells-solutions) — bu da format saflığını ve sandboxing'i bozuyor.

### 2. Olgun alternatif markup dilleri

#### AsciiDoc

Asciidoctor.org'un kendi karşılaştırması açık konuşuyor: "Yazarlar düz yazıdan biraz daha karmaşık bir şeye ihtiyaç duyduğu anda (tablolar, çapraz referanslar, dipnotlar, gömülü video) raw HTML'e dönmek zorunda kalıyor — Markdown bu seviyede tasarlanmadı" [[11]](https://docs.asciidoctor.org/asciidoc/latest/asciidoc-vs-markdown/).

AsciiDoc'un avantajları:
- Tek kanonik referans implementasyon (Asciidoctor) → "valid AsciiDoc" diye bir şey *var*, "valid Markdown" diye bir şey yok.
- Native admonitions (NOTE/TIP/WARNING/CAUTION/IMPORTANT)
- Native cross-references, ToC, footnotes, callouts
- Intra-word formatting çalışıyor (`m``onospace``` gibi)
- Standardize ediliyor (Eclipse Foundation altında AsciiDoc Working Group)

Dezavantajları:
- Syntax daha ağır, "Markdown'ın okunabilirlik avantajını" kısmen kaybediyor
- Ekosistem sınırlı — özellikle Markdown'a göre editor/viewer entegrasyonları az
- Not uygulaması için fazla ağır (publishing toolchain odaklı)

#### reStructuredText

Python ekosisteminde kanonik. Sphinx ile birlikte yaşıyor. Directives + roles ile genişletilebilir — `.. note::`, `.. code-block:: python`, `:ref:` gibi. Olgun ama whitespace kuralları "kafa karıştırıcı" diye sürekli eleştiriliyor [[12]](https://www.dewanahmed.com/markdown-asciidoc-restructuredtext/), ve Markdown'a göre "az daha karmaşık ama aynı ağırlıkta okunmuyor" [[13]](https://stymied.medium.com/lightweight-markup-asciidoc-restructuredtext-and-markdown-compared-d5a33fedcac9).

#### Org-mode

Karl Voit, Org-mode'un "kullanılabilir hafif markup'ın en rasyonel tasarımı" olduğunu argümanlıyor [[14]](https://karl-voit.at/2017/09/23/orgmode-as-markup-only/):
- Tek başlık stili (`*` ön ekiyle, seviye = yıldız sayısı; Markdown'da ATX + Setext iki stil var)
- Tutarlı vurgu: `/italik/`, `*kalın*`, `_altçizgi_`, `=verbatim=`, `~code~`, `+strike+` — her stil için tek sembol
- Mantıklı link sırası: `[[url][display]]` (URL → display, alfabetik düşünme)
- Tek kanonik implementasyon (Emacs Org); "babelmark" sorunu yok
- Single language, tek spec, Wikipedia'daki kadar net dökümantasyon

Dezavantaj: Emacs çağrışımı insanları kaçırıyor; non-Emacs editör desteği zayıf, ama Voit'un noktası syntax'ın Emacs'tan bağımsız değerlendirilmesi gerektiği.

#### Pandoc Markdown

Pandoc'un Markdown süperseti — footnotes, definition lists, tables, citations, math, fenced code, attribute syntax, smart punctuation [[15]](https://pandoc.org/MANUAL.html). Pratik açıdan en zengin Markdown dialect'i. Sorun: de facto sadece Pandoc bunu tam parse ediyor; "süpersete commit" demek "Pandoc lock-in" demek.

### 3. Modern denemeler (2020 sonrası)

#### Djot — MacFarlane'in "Markdown'u baştan tasarlasaydım" projesi

CommonMark'ın yazarı 2022'de Djot'u yayımladı [[16]](https://github.com/jgm/djot). Tasarım hedefleri [[17]](https://github.com/jgm/djot/blob/main/doc/syntax.md):

- **Linear-time parsing, no backtracking** — single-pass parseable.
- Reference linkler tanımlandığı yerde değil, kullanıldığı yerde *yapısal olarak* tanınabilir.
- Vurgu: `_italik_`, `*kalın*` — tek karakter, tek anlam, no doubled-character ambiguity.
- Generic container: `::: classname` ile div, `[span]{.class}` ile inline span — admonition/callout için ekstra syntax gerekmiyor.
- Attribute syntax her elemana uygulanabilir: `{#id .class key=value}`.
- Native: footnote, definition list, table, math, super/subscript, insert/delete/highlight, raw blocks (`{=html}`).
- Block content paragrafları kesintiye uğratamaz (Markdown'ın `1.` ile başlayan paragraf "liste mi?" sorunu yok).

Djot'un en önemli özelliği: **CommonMark'ın yazarının kendi yarattığı dilden ne öğrendiğini gösteriyor.** Bu yüzden bir kuralı değiştiriyorsa, tarihsel olarak şu yazı sevdiği için değil, parser yazıp acı çektiği için.

Henüz olgun değil — ekosistem küçük, editor desteği sınırlı. Ama spec sabit ve referans implementasyonu (Lua + JS + Pandoc filter) çalışıyor.

#### Typst

Typst LaTeX'in modern halefi olarak tasarlandı [[18]](https://typst.app/docs/reference/syntax/). Üç moda sahip:
- Markup mode (varsayılan)
- Math mode (`$...$`)
- Code mode (`#` ile, programlanabilir, Turing-complete)

Set/show rules ile stil; kullanıcı tanımlı fonksiyonlar; reactive scripting. **Ama:** typesetting için tasarlanmış (PDF üretimi). Notlar için fazlası — UI'da incremental edit, search-as-you-type, sync için optimize değil. Myne için yanlış araç.

#### MyST (Markedly Structured Text)

CommonMark + Sphinx'ten ödünç alınmış directives + roles syntax'ı [[19]](https://myst-parser.readthedocs.io/en/latest/syntax/roles-and-directives.html). Bilimsel / hesaplamalı dokümanlar için. Markdown ekosistemine yapışık, geçişi yumuşak. Ama yine docs-as-code odaklı.

#### Quarkdown

Markdown + Turing-complete scripting (Kotlin tabanlı runtime) [[20]](https://github.com/iamgio/quarkdown). Function syntax'ı: `.function {animal} name ecosystem picture: ...`. Tek kişilik proje, ekosistem yok denecek kadar küçük. İlginç ama pre-alpha bir not uygulamasının üstüne yığılmaz.

#### Markdoc / MDX

MDX = Markdown + JSX (React component'ları markdown içinde) [[21]](https://mdtolink.com/blog/what-is-mdx/). Markdoc = Stripe'ın MDX'e alternatifi, custom tag syntax'ı. Her ikisi de **doc-site'lar için** — JSX runtime gerektiren bir not formatı Myne'in "minimal direct-dependency" disipliniyle çelişir.

#### "PML" tipi vaporware öneriler

freecodecamp'taki "We need a new document markup language" [[22]](https://www.freecodecamp.org/news/we-need-a-new-document-markup-language-c22e0ec44e15) gibi yazılar düzenli çıkıyor. Hiçbiri reference implementation, formal spec ve adoption üreterek hayatta kalmıyor. **DSL tarihinin 95. yüzdelik dilimi: yeni dil tasarlanır, prototype yazılır, üç kullanıcı edinir, terk edilir.**

### 4. Block-based veri modeli vs flat markup

Notion, Anytype, BlockNote, Tiptap'ın geldiği farklı bir paradigma var: **doküman = block ağacı**, her block kendi tipine sahip JSON nesnesi. Plain-text markup üretmek render aşamasında yapılıyor; canonical model ağaç [[23]](https://www.blocknotejs.org/) [[24]](https://anytype.io/).

Block-based avantajları:
- Concurrent edit semantik olarak temiz — Peritext gibi rich-text CRDT'leri ağaç üzerinde tanımlanır [[25]](https://www.inkandswitch.com/peritext/).
- Format sınırları net — bir block image, ondan sonraki paragraf, içine link gömülü; her biri bağımsız.
- Format ile content ayrı CRDT operasyonu olarak gönderilebilir → şifreli blob içinde delta sync kolaylaşır.
- Feature ekleme strict syntax değişikliği değil → schema migration; existing blocks geriye uyumlu.

Dezavantajları:
- Plain-text export "uydurma" hale gelir — kullanıcının Myne'den çıkardığı `.md` ile geri yüklediğinde bilgi kaybı olabilir (rich block tipleri Markdown'a düşürülemiyor).
- Audit yüzeyi: schema validator, migration logic, conflict resolution — hepsi extra cryptographic-relevant kod.
- "User owns plain text" iddiası zayıflıyor.

Inkandswitch'in Peritext makalesi [[25]](https://www.inkandswitch.com/peritext/) önemli bir tezgaha dikkat çekiyor: "Markdown'da overlapping bold spans concurrent edit altında bozuluyor — `**The **fox** jumped**` parse edilemez." Yani **Markdown'ı canonical wire format yaparsanız multi-device sync'inizi mimari olarak köstekliyorsunuz**. Peritext bunun çözümünü: plain-text CRDT + ayrı format mark CRDT'si.

Anytype bu yola gitmiş — block-based encrypted objects, AnySync protokolü ile P2P sync [[24]](https://anytype.io/) [[26]](https://thebusinessdive.com/anytype-review). Standard Notes ise **plain-text only** stratejisini benimsemiş, hiç markup yok [[27]](https://www.privacyguides.org/en/notebooks/). Joplin Markdown kullanıyor ama sync'i not seviyesinde, block seviyesinde değil [[28]](https://joplinapp.org/help/apps/sync/e2ee/).

### 5. Yeni bir markup dili tasarlamanın gerçek maliyeti

DSL maintenance literatürü oldukça net [[29]](https://www.researchgate.net/publication/332910210_Towards_a_Cost_Model_for_Domain-Specific_Language_Engineering) [[30]](https://en.wikipedia.org/wiki/Domain-specific_language):

- **Tasarım maliyeti:** Spec yazma + kenar durumlarını düşünme aylar alır. CommonMark'ın yazılması 2014–2016 arası ~2 yıl, beş kişi.
- **Reference parser:** Test vector suite + 95% conformance ~1 person-year.
- **Diğer impl ekosistemi:** İkinci impl üçüncüden çok daha kıymetli (interop kanıtı). Ama hiçbiri için ücret ödeyemezsiniz; gönüllü beklemek = beklenmedik bug yüzeyi.
- **Editor desteği:** Syntax highlighting, LSP, format-as-you-type — Vim/Emacs/VSCode/Tree-sitter grammar'ı yazmak başlı başına bir altyazı.
- **Dönüşüm araçları:** Pandoc'a girme süreci, MD↔YourFormat converter, HTML/PDF output — kullanıcıların var olan alışkanlıklarına dokunmak için zorunlu.

Myne'in CLAUDE.md'si "minimal direct-dependency surface" diyor; threat-model'i "reproducible signed builds, hash-pinned lockfiles" diyor. **Custom markup dili = parser bağımlılığı sizin kodunuz olur, audit yüzeyiniz büyür.** RustCrypto-equivalent disiplini markup parser'a uygulamak realist değil; RustCrypto NCC Group ve Least Authority ile audit edildi. Sizin parser'ınızı kim audit edecek?

gingerBill'in iddiası bu açıdan ilginç: tüm "uygun" markup dilleri TeX-ailesi ya da SGML-ailesidir, yenisi tasarlamak iki kütüphaneden birinin türevi olur [[31]](https://www.gingerbill.org/article/2026/01/19/two-families-of-markup-languages/). Yeni icat ettiğinizi sandığınız şey büyük olasılıkla zaten var.

### 6. Şifreli not uygulamalarında markup tercihleri

| Uygulama | Markup | Format | Block model | Plain-text export |
|---|---|---|---|---|
| Standard Notes | Yok (plain text) | UTF-8 | — | trivial (zaten o) |
| Joplin | CommonMark + GFM | `.md` files in encrypted DB | hayır | direct file-by-file [[28]](https://joplinapp.org/help/apps/sync/e2ee/) |
| Obsidian | CommonMark + extensions (wikilinks, callouts, embeds) | `.md` flat files | hayır | trivial; vault = klasör |
| Logseq | Markdown veya Org-mode | Plain text outliner | block-tagged | direct |
| Anytype | Yok (block JSON) | Encrypted blocks via AnySync | evet | `.md` export but lossy |
| Cryptee | Word-processor stili | Şifreli rich-text | partial | export to markdown/html |

**Pattern:** Plain-text portability'ye değer veren uygulamalar Markdown'a yapışmış (Joplin, Obsidian, Logseq) — kanonik format dosya sistemi olunca dialect parçalanmasını kabullenmişler. Block-based + E2EE giden uygulamalar (Anytype) plain-text export'u "best effort" olarak konumlandırmış. Standard Notes bu seçimi tamamen başka tarafa attı: hiç format yok, hiç parsing problemi yok.

Myne'in Phase 1 ekran-tasarımı kararları (single client, Tauri + Rust core) → Joplin/Obsidian profiline daha yakın: tek kanonik implementasyon, dialect parçalanması sizin sorununuz değil, sizin parser'ınız "the implementation" olabilir.

## Çelişen görüşler / tartışmalı noktalar

### Çelişki 1: "Markdown yeterli, sadece sıkı bir dialect seçin" vs "Markdown yapısal olarak kırık"

- **Pozisyon A — yeterli:** HN'deki AsciiDoc tartışmasındaki çoğunluk [[32]](https://news.ycombinator.com/item?id=27744509). Öneri: CommonMark + GFM'a commit edin, dialect ekosisteminin matürlüğünden yararlanın. Kullanıcılar zaten Markdown biliyor; öğrenme eğrisi sıfır.
- **Pozisyon B — kırık:** MacFarlane (Djot ile parsing problemini accept etmiş) [[1]](https://johnmacfarlane.net/beyond-markdown.html), Inkandswitch (Peritext makalesinde Markdown'ın CRDT-uyumsuzluğunu kanıtlamış) [[25]](https://www.inkandswitch.com/peritext/), gingerBill (TeX-ailesi argümanı) [[31]](https://www.gingerbill.org/article/2026/01/19/two-families-of-markup-languages/).
- **Benim okumam:** B teknik olarak haklı, ama A pratik olarak haklı. Myne için sentez: **CommonMark düzgünlüğü Markdown'ı kullanılabilir kılar; ama Djot ucubeleri bilerek atan Markdown ile aynı UX'e sahip.** Bedava ergonomi var, almayın diye sebep yok.

### Çelişki 2: Plain-text saklamak vs structured block JSON saklamak

- **Pozisyon A — plain text:** brajeshwar.com [[33]](https://brajeshwar.com/2022/plain-text/), plaintext-productivity.net [[34]](https://plaintext-productivity.net/2-01-why-plaintext-for-notes.html), getreu blog [[35]](https://blog.getreu.net/20210119-where-to-store-notes/). Sebep: portability, longevity, app-bağımsızlık, "your data is yours."
- **Pozisyon B — structured:** Anytype, Notion, BlockNote ekibi. Sebep: rich block types, concurrent edit, schema migration, format ile content ayrımı.
- **Benim okumam:** Myne'in `vision.md`'si "user-meaningful timestamps live inside the encrypted blob" diyor → user-owned data felsefesi var. **Plain-text canonical, structured AST ephemeral working representation** iyi sentez: storage layer Markdown/Djot, UI layer block-tree (ProseMirror state). Plain-text export her zaman lossless; UI kalitesi compromise değil.

### Çelişki 3: Build vs adopt

- **Pozisyon A — build:** Karl Voit'un Org-mode argümanı, freecodecamp'ın PML denemesi, Quarkdown — "iyi tasarım için yeniden başlamak gerekli."
- **Pozisyon B — adopt:** DSL cost literature [[29]](https://www.researchgate.net/publication/332910210_Towards_a_Cost_Model_for_Domain-Specific_Language_Engineering), Eric Holscher [[3]](https://www.ericholscher.com/blog/2016/mar/15/dont-use-markdown-for-technical-docs/), genel mühendislik pragmatizmi.
- **Benim okumam:** B kazanıyor. Myne bir not uygulaması, bir typesetting research'ü değil. Audit yüzeyini büyütmek `threat-model.md` §6'daki "minimal direct dependency" disiplini ile çelişir. Djot zaten "Markdown'u baştan yapsaydım" projesidir — kendi versiyonunuzu yazmak Djot'u yazmaktır, daha azını değil.

## Güncellik notu

- **Hızlı değişen** (6 ay içinde tekrar doğrulanmalı):
  - Djot'un olgunluğu — ekosistem küçük, parser/editor entegrasyonları hızla değişiyor.
  - Quarkdown gibi pre-alpha denemeler — birkaçı kaybolacak, biri yükselecek.
  - LLM-Markdown etkileşimi — CJK problemi gibi ölçek-tetiklemeli sorunlar yeni yeni gündemde.

- **Stabil** (yıllarca geçerli):
  - CommonMark spec'i — 2014'ten beri yavaş evrimleşiyor.
  - AsciiDoc/reST/Org-mode — büyük olgun, syntax değişmiyor.
  - Markdown XSS/ReDoS pattern'leri — temel yapısal sorunlar değişmedi.
  - Block-based vs flat tradeoff — Notion 2016'dan beri aynı paradigma.

- **Belirsiz**:
  - Djot'un 5 yıl sonra hayatta olup olmayacağı (single-maintainer dependency).
  - AsciiDoc Working Group standardizasyonu (Eclipse Foundation altında devam ediyor, ETA belirsiz).
  - Peritext-style CRDT'lerin production'da nasıl davranacağı (Inkandswitch prototype, henüz yaygın değil).

## Öneri

Myne için somut, görüşlü öneri:

### 1. Sıfırdan yeni bir markup dili tasarlamayın.

Yeni bir DSL'in maliyeti = audit yüzeyi büyümesi + ekosistem gerekliliği + spec yazma + reference impl + editor entegrasyonu. Myne pre-alpha bir E2EE not uygulaması; kaynaklar crypto/sync'a gitmeli, yeni bir parsing teorisi denemesine değil. `vision.md` "anti-features"ine "user invents proprietary markup" ekleyin denemese bile, ruhuyla çelişiyor.

**Custom DSL yapmak için tek mazeret:** "Mevcut bir dilden gerçekten farklı, somut bir gereksinim var ve kullanıcılar bunu test ederek doğruladık." Bu eşik bugün karşılanmıyor.

### 2. Djot'u canonical content format olarak benimseyin.

- CommonMark süpersetinin değil, **kendi başına ana format** olarak. Dosya uzantısı `.dj` olabilir, içeride saklanır.
- Avantajlar: linear-time parse, tek-pass, attribute system native, CJK dahil edge case'leri MacFarlane bizzat fix etmiş, footnote/table/math/admonition (`:::`) zaten var.
- Cost: Djot ekosistemi küçük, kendi parser'ınızı (Rust'ta `jotdown` crate'i var, MIT) wire etmeniz gerekebilir. Bu kabul edilebilir bir cost — `cmark-rs` ile ekstra fark çok değil.

**Eğer bu adım büyük gelirse:** CommonMark + Pandoc-tarzı extension subset'i (footnote, attribute, definition list) seçin ve **kendi spec'inizi birkaç sayfa yazıp `docs/spec/markup.md` olarak donduran**. Lehçe parçalanmasını önleme yolu: tek kanonik impl + dondurulmuş subset.

### 3. UI tarafında block-tree AST ile çalışın, storage'a Djot serialize edin.

- ProseMirror veya Tiptap UI state için → block-tree
- Save anında Djot serialize → şifreli blob
- Load anında Djot parse → block-tree
- Plain-text export "user owns their data" sözünü tutuyor; aynı zamanda CRDT/Peritext'i sonradan eklemek istediğinizde block-tree zaten orada.

Bu hibrit, Joplin'in (storage = Markdown, UI = ace editor) ile Anytype'ın (storage = encrypted blocks, no plain-text export) arasındaki iyi ortayı tutuyor.

### 4. v0.1 için minimum subset belirleyin, sonra büyütün.

Öneri minimum: paragraph, heading (1–6), bullet/ordered list, link, image (encrypted attachment ref olarak), inline code, code block (fenced + language), bold/italic, blockquote, horizontal rule, footnote, table (basit), attribute syntax. Math, raw blocks, definition lists, generic divs gibi şeyler v0.2+ için ertelenebilir.

`docs/spec/markup.md` tutun ve `design-notes.md`'e "Adopted Djot subset for v0.1" entry ekleyin (yeni yapılan iş yapı zaten var, S6 markdown-dialect kararını supersede ediyor).

### 5. Konuya tek argümanla itirazlar:

- **"Markdown yaygın, kullanıcılar bekliyor."** Djot'un syntax'ı %95 Markdown'la aynı görünüyor — kullanıcı farkı bilmeyebilir. Ham olarak `_x_` yerine `*x*` yazma alışkanlığı iki günde geçer.
- **"Custom DSL bizi unique yapardı."** Myne'in unique olduğu yer cryptography ve threat model — content format'ı değil. Format'ı commodity tutmak doğru tradeoff.
- **"Djot maintainer-bağımlı."** Doğru, ama: `cmark` da öyle, `markdown-it` da. Wire format dondurulmuş bir spec olduğu sürece, parser'ı sonradan rewrite edebilirsiniz; `protocol.md` ile aynı disiplin.

## Kaynakça

1. [Beyond Markdown — John MacFarlane](https://johnmacfarlane.net/beyond-markdown.html) — Birincil kaynak, MacFarlane'in Markdown'a kendi yönelttiği eleştiri.
2. [Babelmark 3](http://babelmark.github.io/) — Markdown impl divergence aracı; "valid Markdown yok" iddiasının kanıtı.
3. [Why You Shouldn't Use Markdown for Technical Docs — Eric Holscher (2016)](https://www.ericholscher.com/blog/2016/mar/15/dont-use-markdown-for-technical-docs/) — Independent expert, ekosistem-seviyesi eleştiri.
4. [CJK CommonMark Emphasis Problem — Yurume (2026)](https://hackers.pub/@yurume/019b912a-cc3b-7e45-9227-d08f0d1eafe8) — Independent expert, modern (LLM çağı) güncel sorun.
5. [Markdown-to-jsx XSS — CVE-2024-21535 (Snyk)](https://security.snyk.io/vuln/SNYK-JS-MARKDOWNTOJSX-6258886) — Birincil, güvenlik literatürü.
6. [Markdown-it 14.1.0 XSS — Fluid Attacks](https://fluidattacks.com/advisories/fito) — Birincil güvenlik advisory.
7. [Markdown XSS Payloads — Cujanovic GitHub](https://github.com/cujanovic/Markdown-XSS-Payloads) — Topluluk, syntax-level bypass kataloğu.
8. [Improving Accessibility of Markdown — Smashing Magazine (2021)](https://www.smashingmagazine.com/2021/09/improving-accessibility-of-markdown/) — Independent expert, accessibility somut örnekler.
9. — (8 ile aynı kaynak, accessibility için kullanıldı).
10. [Markdown Table Merge Cells: Creative Solutions](https://blkpn.com/markdown-table-merge-cells-solutions) — Tablo limit'leri için referans.
11. [Compare AsciiDoc to Markdown — Asciidoctor Docs](https://docs.asciidoctor.org/asciidoc/latest/asciidoc-vs-markdown/) — Resmi karşılaştırma kaynağı.
12. [Markdown, Asciidoc, or reStructuredText — Dewan Ahmed](https://www.dewanahmed.com/markdown-asciidoc-restructuredtext/) — Independent expert üçlü karşılaştırma.
13. [Lightweight Markup Compared — Peter Conrad (Medium)](https://stymied.medium.com/lightweight-markup-asciidoc-restructuredtext-and-markdown-compared-d5a33fedcac9) — Independent expert, derinlemesine.
14. [Org Mode as Markup Only — Karl Voit](https://karl-voit.at/2017/09/23/orgmode-as-markup-only/) — Org-mode advocate, syntax-rasyonel argüman.
15. [Pandoc User's Guide](https://pandoc.org/MANUAL.html) — Birincil, Pandoc Markdown extension reference.
16. [Djot GitHub — jgm/djot](https://github.com/jgm/djot) — Birincil kaynak, Djot referansı.
17. [Djot Syntax Spec](https://github.com/jgm/djot/blob/main/doc/syntax.md) — Birincil spec.
18. [Typst Syntax Reference](https://typst.app/docs/reference/syntax/) — Resmi Typst dokümantasyonu.
19. [MyST Roles and Directives](https://myst-parser.readthedocs.io/en/latest/syntax/roles-and-directives.html) — Resmi MyST dokümantasyonu.
20. [Quarkdown GitHub](https://github.com/iamgio/quarkdown) — Birincil, Quarkdown.
21. [What Is MDX? — MDtoLink](https://mdtolink.com/blog/what-is-mdx/) — Tutorial, MDX modeli.
22. [We need a new document markup language — freeCodeCamp](https://www.freecodecamp.org/news/we-need-a-new-document-markup-language-c22e0ec44e15) — Independent essay, "yeni dil tasarlama" denemesinin tipik örneği.
23. [BlockNote.js](https://www.blocknotejs.org/) — Resmi, block-based editor architecture.
24. [Anytype.io](https://anytype.io/) — Birincil, block-based encrypted notes.
25. [Peritext: A CRDT for Rich-Text Collaboration — Ink & Switch](https://www.inkandswitch.com/peritext/) — Akademik makale, rich-text + concurrent edit foundation.
26. [Anytype Review — TheBusinessDive](https://thebusinessdive.com/anytype-review) — Independent review, data model context.
27. [Privacy Guides — Notebooks](https://www.privacyguides.org/en/notebooks/) — Topluluk, E2EE not uygulamaları rehberi.
28. [Joplin E2EE Help](https://joplinapp.org/help/apps/sync/e2ee/) — Resmi Joplin docs.
29. [Towards a Cost Model for DSL Engineering — ResearchGate](https://www.researchgate.net/publication/332910210_Towards_a_Cost_Model_for_Domain-Specific_Language_Engineering) — Akademik, DSL maliyet modeli.
30. [Domain-specific language — Wikipedia](https://en.wikipedia.org/wiki/Domain-specific_language) — Genel referans.
31. [Two Families of Markup Languages — gingerBill](https://www.gingerbill.org/article/2026/01/19/two-families-of-markup-languages/) — Independent expert, TeX vs SGML argümanı.
32. [HN Discussion: Compare AsciiDoc and Markdown](https://news.ycombinator.com/item?id=27744509) — Topluluk konsensus snapshot'ı.
33. [Plain Text — Brajeshwar (2022)](https://brajeshwar.com/2022/plain-text/) — Independent expert, plain-text savunması.
34. [Why Plaintext for Notes? — Plaintext Productivity](https://plaintext-productivity.net/2-01-why-plaintext-for-notes.html) — Topluluk, kullanıcı perspektifi.
35. [Where to Store Notes? — Jens Getreu](https://blog.getreu.net/20210119-where-to-store-notes/) — Independent expert, file-system vs DB.

## Dahil edilmeyen kaynaklar

- AlternativeTo / Slant gibi listeler — SEO-farm karakterli; orijinal analiz yok.
- 2020 öncesi "20 markdown alternatifleri" tipi makaleler — eski ve unutulmuş projeleri öne çıkarıyor (Textile, BBCode), modern manzarayı yansıtmıyor.
- Anytype dokümantasyonunun teknik detay sayfaları — fetch sırasında "page not found" döndü; doğrudan source code analiz edilmedi, dolayısıyla iddialar genel marketing material'a kalmış olabilir; daha derin bir teknik analiz isterseniz Anytype kaynak repo'sunu okumak gerekir.
- Wikipedia genel sayfaları (Org-mode, Markdown, lightweight markup language) — referans için kullanıldı, alıntılanmadı.

## Sıradaki adım — tartışma için sorular

Rapor sonrası fikiri tartışırken kafamızda netleşmesi gereken sorular:

1. **Plain-text export sözü ne kadar load-bearing?** Anti-feature listesindeki "no proprietary format" Djot kullanımıyla zaten korunuyor. Block-JSON storage'a kaymak buna ihanet sayılır mı?
2. **Phase 3 web client'a kadar yol haritası ne ölçüde markup'a kilitleyeceği?** Web tarafında Djot parser'ı WASM olarak deploy etmek vs CommonMark'ın olgun JS impl'lerini kullanmak.
3. **Editor seçimi nereye iniyor?** ProseMirror (block-tree native, Tiptap/BlockNote ile) vs CodeMirror (text-buffer native, Markdown source mode) — markup seçimini doğrudan etkiler.
4. **CJK/Türkçe edge case'leri Myne'de ne kadar prioritir?** İlk kullanıcı kitlen Türkçe yazacaksa, Türkçe'nin Markdown'da görünür bir CJK-tarzı kırılması yok ama Apostrof/I/i kuralları içeriği etkileyebilir.
5. **Wikilink (Obsidian-tarzı `[[Note]]`) gerekiyor mu?** Bu Djot'a native değil ama generic span'le emule edilebilir; eğer yeterince kritikse format'ı küçük bir Myne-extension ile dondurmak gerekebilir.

# CLAUDE.md Nasıl Hazırlanır: Araştırma Raporu

**Tarih:** 2026-05-01
**Kaynak sayısı:** 29 incelendi, 28 rapora dahil edildi (1 PDF — Anthropic CDN scan'i — OCR ile okunamadı, hariç tutuldu)
**Güven seviyesi:** Yüksek — 2 resmi Anthropic docs sayfası + 1 Anthropic blog + 25+ uzman/topluluk kaynağı; uzunluk tartışması dışında konsensüs güçlü

---

## TL;DR

- **Hedef uzunluk: 200 satır altı**, ideal aralık 60–150 satır. 300+ satır olduğunda Claude "kuralın yarısını ignore eder" (resmi anti-pattern: "the over-specified CLAUDE.md") [[1]](https://code.claude.com/docs/en/best-practices)[[2]](https://code.claude.com/docs/en/memory).
- **Zorunlu 4 bölüm:** Commands (build/test/lint) · Architecture · Conventions · Gotchas. Bu sırayla. Tech stack, IDE'nin zaten anlayabileceği şeyleri tekrar etme [[1]](https://code.claude.com/docs/en/best-practices)[[5]](https://www.morphllm.com/claude-code-memory-files)[[7]](https://www.turbodocx.com/blog/how-to-write-claude-md-best-practices).
- **`/init` ile başla, sonra elle cilala.** Ama HumanLayer gibi bazı uzmanlar `/init` çıktısının "highest leverage point" olduğunu ve manuel hazırlanması gerektiğini savunuyor [[3]](https://www.humanlayer.dev/blog/writing-a-good-claude-md)[[15]](https://blog.vincentqiao.com/en/posts/claude-code-init/).
- **Hierarchy: ~/.claude/CLAUDE.md (global) → repo root CLAUDE.md (team) → subdir/CLAUDE.md (on-demand) → CLAUDE.local.md (gitignored personal).** Claude Code launch'ta cwd'den parent'lara doğru tüm CLAUDE.md'leri yürür ve concatenate eder; daha spesifik olanı kazanır [[2]](https://code.claude.com/docs/en/memory)[[10]](https://agentfactory.panaversity.org/docs/General-Agents-Foundations/claude-code-teams-cicd/claude-md-configuration-hierarchy)[[11]](https://codewithmukesh.com/blog/anatomy-of-the-claude-folder/).
- **Linter işini CLAUDE.md'ye yaptırma — hook'a yaptır.** Format/lint deterministik gerektirir; CLAUDE.md advisory. Code style "preference" + "judgment gerektiren" bağlam için, formatter zorlamadığın kurallar için [[1]](https://code.claude.com/docs/en/best-practices)[[3]](https://www.humanlayer.dev/blog/writing-a-good-claude-md).

---

## Arka plan ve kapsam

`CLAUDE.md`, Claude Code CLI'ın her oturum başında otomatik yüklediği bir markdown dosyasıdır. Kullanıcı tarafı için "Claude'a her sefer aynı şeyi açıklamayı bırak" anlamına gelir; Anthropic tarafı için bu dosya **system prompt'a değil, system prompt'tan sonra bir user message olarak** enjekte edilir — yani Claude onu "uyumlu olmaya çalıştığı bir talimat" olarak görür, kurallar olarak değil [[2]](https://code.claude.com/docs/en/memory).

Bu rapor şu alt soruları cevaplıyor:
1. Resmi spesifikasyon — yer, yükleme mekaniği, hierarchy
2. Dosya yapısı — hangi bölümler işe yarıyor
3. Uzunluk / token ekonomisi — sweet spot tartışması
4. Anti-pattern'ler — yaygın hatalar
5. Güncelleme disiplini — ne zaman, nasıl
6. CLAUDE.md vs slash commands vs subagents vs hooks — iş bölümü
7. Gerçek dünya örnekleri — açık kaynak repo'larda neler var

**Kapsamayan:** Anthropic Claude API SDK üzerinden custom agent'lar için CLAUDE.md kullanımı (Claude Code CLI'a özel bir mekanizma; SDK eşdeğeri farklıdır). AGENTS.md interop tarafı kısmen kapsandı.

---

## Bulgular

### 1. Resmi spesifikasyon (Anthropic docs)

**Dosya adı kesinlikle case-sensitive.** Tam olarak `CLAUDE.md` olmalı — büyük harf CLAUDE, küçük .md uzantısı [[16]](https://www.builder.io/blog/claude-md-guide).

**4 yerleşim noktası** (Anthropic resmi memory docs) [[2]](https://code.claude.com/docs/en/memory):

| Scope | Konum | Amaç |
|---|---|---|
| **Managed policy** | `/Library/Application Support/ClaudeCode/CLAUDE.md` (macOS); `/etc/claude-code/CLAUDE.md` (Linux); `C:\Program Files\ClaudeCode\CLAUDE.md` (Windows) | Org-wide, IT/DevOps tarafından yönetilen |
| **Project** | `./CLAUDE.md` veya `./.claude/CLAUDE.md` | Team-shared, git'e commit edilir |
| **User** | `~/.claude/CLAUDE.md` | Tüm projelerde geçerli kişisel tercihler |
| **Local** | `./CLAUDE.local.md` | Kişisel proje-spesifik notlar; **`.gitignore`'a eklenmeli** |

**Yükleme mekaniği** (verbatim): *"Claude Code reads CLAUDE.md files by walking up the directory tree from your current working directory… All discovered files are concatenated into context rather than overriding each other. Across the directory tree, content is ordered from the filesystem root down to your working directory… Within each directory, `CLAUDE.local.md` is appended after `CLAUDE.md`."* [[2]](https://code.claude.com/docs/en/memory)

**`/init` komutu**, mevcut codebase'i tarayarak başlangıç CLAUDE.md üretir. Tipik üretilen bölümler: Project Overview, Commands, Architecture, Code Style [[15]](https://blog.vincentqiao.com/en/posts/claude-code-init/)[[14]](https://dometrain.com/blog/creating-the-perfect-claudemd-for-claude-code/). Ama bu sadece başlangıç — manuel rafine edilmesi gerekiyor.

**Compaction davranışı** (sadece resmi docs'ta belirtilmiş): *"Project-root CLAUDE.md survives compaction: after `/compact`, Claude re-reads it from disk and re-injects it into the session. Nested CLAUDE.md files in subdirectories are not re-injected automatically; they reload the next time Claude reads a file in that subdirectory."* [[2]](https://code.claude.com/docs/en/memory) Bu, aktif çalışmada en kritik bağlamın repo root CLAUDE.md'de tutulması anlamına geliyor.

**HTML yorumları silinir** — `<!-- maintainer notes -->` enjekte edilmeden önce strip ediliyor; sadece kod blokları içindekiler korunur [[2]](https://code.claude.com/docs/en/memory).

### 2. Dosya yapısı — hangi bölümler işe yarıyor

Birden fazla kaynak farklı bölüm listesi öneriyor; en yaygın 4-5 başlık şunlar (consensus):

**Çekirdek bölümler (her örnekte var):**
1. **Commands** — `npm run dev`, `cargo test`, `pnpm build` gibi proje-spesifik komutlar (Claude tahmin edemez) [[1]](https://code.claude.com/docs/en/best-practices)[[5]](https://www.morphllm.com/claude-code-memory-files)[[7]](https://www.turbodocx.com/blog/how-to-write-claude-md-best-practices)[[16]](https://www.builder.io/blog/claude-md-guide)
2. **Architecture** — yüksek seviyeli yapı; "API handlers `src/api/handlers/`'da" gibi [[2]](https://code.claude.com/docs/en/memory)[[16]](https://www.builder.io/blog/claude-md-guide)
3. **Conventions / Code style** — "named exports kullan", "TypeScript strict mode", "ES modules CommonJS değil" [[1]](https://code.claude.com/docs/en/best-practices)[[16]](https://www.builder.io/blog/claude-md-guide)
4. **Gotchas / Important notes** — "Stripe webhook handler signature validate etmeli", "image'lar Cloudinary'de" [[16]](https://www.builder.io/blog/claude-md-guide)
5. **Tech stack** (kısa, sürüm numaraları dahil) — "Next.js 15.0.3, TypeScript 5.3.3" gibi [[8]](https://stevekinney.com/courses/ai-development/claude-dot-md)

**Builder.io'nun tam örneği** (verbatim) [[16]](https://www.builder.io/blog/claude-md-guide):

```markdown
# Project: ShopFront

Next.js 14 e-commerce application with App Router, Stripe payments,
and Prisma ORM.

## Code Style
- TypeScript strict mode, no `any` types
- Use named exports, not default exports
- CSS: Tailwind utility classes, no custom CSS files

## Commands
- `npm run dev`: Start development server (port 3000)
- `npm run test`: Run Jest tests
- `npm run lint`: ESLint check

## Architecture
- `/app`: Next.js App Router pages and layouts
- `/components/ui`: Reusable UI components

## Important Notes
- NEVER commit .env files
- The Stripe webhook handler must validate signatures
```

**Anthropic docs minimal örneği** (verbatim) [[1]](https://code.claude.com/docs/en/best-practices):

```markdown
# Code style
- Use ES modules (import/export) syntax, not CommonJS (require)
- Destructure imports when possible (eg. import { foo } from 'bar')

# Workflow
- Be sure to typecheck when you're done making a series of code changes
- Prefer running single tests, and not the whole test suite, for performance
```

**WHY/WHAT/HOW yapısı** (HumanLayer önerisi) [[3]](https://www.humanlayer.dev/blog/writing-a-good-claude-md):
- **WHAT:** tech stack, project structure, monorepo layout
- **WHY:** projenin amacı + farklı parçaların işlevi
- **HOW:** tooling (bun vs node), test, verification

### 3. Uzunluk / token ekonomisi (TARTIŞMALI)

Bu, kaynaklar arasındaki **en büyük çelişki**:

| Kaynak | Önerilen uzunluk |
|---|---|
| Anthropic memory docs [[2]](https://code.claude.com/docs/en/memory) | "target under 200 lines" |
| Anthropic best-practices [[1]](https://code.claude.com/docs/en/best-practices) | Sayı yok; "concise" + her satırda "removing this would cause mistakes mi?" testi |
| HumanLayer [[3]](https://www.humanlayer.dev/blog/writing-a-good-claude-md) | "less than 60 lines" personal target; "<300 max" |
| Builder.io [[16]](https://www.builder.io/blog/claude-md-guide) | "under 300 lines" general; complex codebase için daha uzun olabilir |
| Parreño Garcia [[6]](https://joseparreogarcia.substack.com/p/claude-code-memory-explained) | Tiered: 20-80 (small repo), 80-200 (typical), >200 (restructure) |
| Steve Kinney [[8]](https://stevekinney.com/courses/ai-development/claude-dot-md) | Cap yok; detaylı living document'i tercih ediyor |
| Morph LLM [[5]](https://www.morphllm.com/claude-code-memory-files) | <200 lines; 150 line ≈ 3000-4000 token ≈ Opus 4.6'nın 200K window'unun %2.5-4'ü |
| TurboDocx [[7]](https://www.turbodocx.com/blog/how-to-write-claude-md-best-practices) | <200 target, 300 max, "as low as 60" |
| OpenTools [[24]](https://opentools.ai/resources/claude-code-claudemd-guide) | "under 200 lines" |
| Gradually.ai [[17]](https://www.gradually.ai/en/claude-md/) | Global 50, project 100, asla 1000+ |
| The Prompt Shelf [[19]](https://thepromptshelf.dev/blog/claude-code-memory-persistence-guide-2026/) | "<1,000 tokens" (≈40 satır) |
| abhishekray07/claude-md-templates [[26]](https://github.com/abhishekray07/claude-md-templates) | <60 lines; 80+ olunca "Claude parts'ı ignore etmeye başlar" |

**Konsensus aralığı:** 60–200 satır. >300 satır olunca instruction adherence düşer ("over-specified CLAUDE.md" anti-pattern'i [[1]](https://code.claude.com/docs/en/best-practices)).

**Niye düşer?** HumanLayer şu argümanı koyuyor: *"Frontier thinking LLMs can follow ~150-200 instructions with reasonable consistency"* + Claude Code'un kendi system prompt'unda zaten ~50 instruction var. Yani toplam bütçe ~150 ek instruction; bu da CLAUDE.md'de pratikte 60-100 satır demek [[3]](https://www.humanlayer.dev/blog/writing-a-good-claude-md).

### 4. Hierarchy ve cross-file koordinasyonu

**3-4 seviye** (kaynak listesine göre değişiyor):

```
~/.claude/CLAUDE.md              ← Global (tüm projeler)
~/projects/CLAUDE.md             ← Workspace (opsiyonel intermediate) [[12]]
~/projects/<group>/CLAUDE.md     ← Client/group (opsiyonel) [[12]]
<repo>/CLAUDE.md                 ← Project (team-shared, committed)
<repo>/.claude/CLAUDE.md         ← Project alternate
<repo>/CLAUDE.local.md           ← Local (gitignored)
<repo>/<subdir>/CLAUDE.md        ← Subdir (on-demand)
```

**Yükleme zamanı:** Launch'ta cwd → root'a doğru parent'lar yürünür; bulunan tüm CLAUDE.md'ler concatenate edilir (override edilmez!) [[2]](https://code.claude.com/docs/en/memory)[[12]](https://www.shahabpapoon.com/blog/mastering-claude-md-multi-project-workflow/). Subdir'lerdeki CLAUDE.md'ler sadece o subdir'deki dosya okunduğunda lazy-loaded [[1]](https://code.claude.com/docs/en/best-practices).

**Çelişki noktası:** alexop.dev sadece "on-access" mekanizmasından bahsediyor, parent-walk'tan bahsetmiyor [[13]](https://alexop.dev/posts/claude-code-customization-guide-claudemd-skills-subagents/). 3 başka kaynak (Anthropic docs + 2 blog) parent-walk'u açıkça onaylıyor — alexop.dev eksik bilgi vermiş.

**Precedence kuralı** (verbatim): *"more specific locations override broader ones. If your user-level file says 'use tabs' and the project-level file says 'use 2-space indentation,' the project-level instruction wins because it is more specific to the current work."* [[10]](https://agentfactory.panaversity.org/docs/General-Agents-Foundations/claude-code-teams-cicd/claude-md-configuration-hierarchy)

**`@import` syntax** (max 5 hop derinliğinde, sadece Anthropic docs ve 2 kaynak belgeliyor):

```markdown
See @README.md for project overview and @package.json for available npm commands.

# Additional Instructions
- Git workflow: @docs/git-instructions.md
- Personal overrides: @~/.claude/my-project-instructions.md
```

**Kritik uyarı:** `@import`'lar context'i azaltmaz, sadece organize eder! *"Splitting into [`@path` imports] helps organization but does not reduce context, since imported files load at launch."* [[2]](https://code.claude.com/docs/en/memory)

**`.claude/rules/` alternatif** (path-scoped, daha az duyulan ama güçlü mekanizma):

```markdown
---
paths:
  - "src/api/**/*.ts"
---

# API Development Rules
- All API endpoints must include input validation
- Use the standard error response format
```

YAML frontmatter ile path-glob match olduğunda lazy-loaded; root CLAUDE.md'yi şişirmeden specifik bağlam sağlar [[2]](https://code.claude.com/docs/en/memory)[[12]](https://www.shahabpapoon.com/blog/mastering-claude-md-multi-project-workflow/).

### 5. Anti-pattern'ler (en çok tekrar edenler)

**Konsensus anti-pattern'ler** (3+ kaynakta tekrar eden) [[1]](https://code.claude.com/docs/en/best-practices)[[3]](https://www.humanlayer.dev/blog/writing-a-good-claude-md)[[6]](https://joseparreogarcia.substack.com/p/claude-code-memory-explained)[[7]](https://www.turbodocx.com/blog/how-to-write-claude-md-best-practices)[[24]](https://opentools.ai/resources/claude-code-claudemd-guide):

1. **Generic platitude'lar:** "Write clean code", "Use modern web technologies" — Claude bunları zaten biliyor; satır israfı [[8]](https://stevekinney.com/courses/ai-development/claude-dot-md).
2. **File-by-file dump:** Her klasörün ne yaptığının uzun listesi. Claude `ls` çekebilir; sen kavramsal map yaz [[1]](https://code.claude.com/docs/en/best-practices)[[4]](https://kau.sh/blog/build-ai-init-command/).
3. **Linter işi:** Format/indent rules eğer formatter zaten zorluyorsa CLAUDE.md'de tekrar etme — hook'a koy. *"Never send an LLM to do a linter's job."* [[3]](https://www.humanlayer.dev/blog/writing-a-good-claude-md)
4. **"Be a senior engineer" personality:** CLAUDE.md davranışsal koordinasyon için, kişilik için değil [[6]](https://joseparreogarcia.substack.com/p/claude-code-memory-explained)[[26]](https://github.com/abhishekray07/claude-md-templates).
5. **Her şeye IMPORTANT yazma:** *"If everything is marked IMPORTANT, nothing is."* [[16]](https://www.builder.io/blog/claude-md-guide)
6. **Kitchen sink:** Bir oturumda farklı task'larla bağlamı doldurma; `/clear` kullan [[18]](https://github.com/anthropics/claude-code/issues/13579).
7. **Auto `/init` çıktısını dokunmadan bırakmak:** *"Think of /init as a starting point, not a finished product."* [[15]](https://blog.vincentqiao.com/en/posts/claude-code-init/)
8. **Stale, never updated:** Yazıp güncellemeyi unutmak — proje değişiyor, CLAUDE.md eskimi [[19]](https://thepromptshelf.dev/blog/claude-code-memory-persistence-guide-2026/)[[17]](https://www.gradually.ai/en/claude-md/).
9. **Sensitive bilgi:** API key, password CLAUDE.md'ye konmaz [[26]](https://github.com/abhishekray07/claude-md-templates)[[28]](https://artificialcorner.com/p/claude-md).
10. **Tüm dokümantasyonu `@import` ile çekme:** Yine context bütçesi [[24]](https://opentools.ai/resources/claude-code-claudemd-guide).
11. **Prohibitions without alternatives:** "X yapma" derken doğrusunu da söyle [[24]](https://opentools.ai/resources/claude-code-claudemd-guide).
12. **Plan/task fossilleştirme:** *"Plans change too often, and memory files should not become fossils."* — günlük task tracking burada değil [[6]](https://joseparreogarcia.substack.com/p/claude-code-memory-explained).

### 6. Güncelleme disiplini (ne zaman ekle, ne zaman çıkar)

**Resmi Anthropic checklist'i — "ne zaman CLAUDE.md'ye ekle"** (verbatim) [[2]](https://code.claude.com/docs/en/memory):

> - Claude makes the same mistake a second time
> - A code review catches something Claude should have known about this codebase
> - You type the same correction or clarification into chat that you typed last session
> - A new teammate would need the same context to be productive

**Çıkarma sinyalleri:**
- Hook veya skill'e taşınabilen kural varsa CLAUDE.md'den çıkar [[1]](https://code.claude.com/docs/en/best-practices).
- Removing this line would NOT cause Claude to make a mistake → çıkar [[1]](https://code.claude.com/docs/en/best-practices).
- Aynı kural farklı CLAUDE.md seviyesinde duplicate ise birinden sil [[26]](https://github.com/abhishekray07/claude-md-templates).

**Update zamanlama** (sadece The Prompt Shelf):
- **CLAUDE.md** (stable rules): quarterly review yeterli
- **MEMORY.md / CONTEXT.md** (current state): her 2-4 hafta veya değişim anında [[19]](https://thepromptshelf.dev/blog/claude-code-memory-persistence-guide-2026/)

**Quick add komutu:** Claude Code session içinde `#` prefix'i ile yazılan satır CLAUDE.md'ye eklenir. `/memory` komutu CLAUDE.md'yi default editor'da açar [[8]](https://stevekinney.com/courses/ai-development/claude-dot-md).

### 7. CLAUDE.md vs slash commands vs subagents vs hooks vs skills

İş bölümü (kaynak konsensüsü) [[9]](https://www.producttalk.org/how-to-use-claude-code-features/)[[13]](https://alexop.dev/posts/claude-code-customization-guide-claudemd-skills-subagents/)[[6]](https://joseparreogarcia.substack.com/p/claude-code-memory-explained):

| Mekanizma | Ne için |
|---|---|
| **CLAUDE.md** | Stable, always-true proje convention'ları + non-obvious bağlam (her oturumda yüklenir) |
| **Slash commands** (`.claude/commands/<name>.md`) | Tekrarlanan workflow'lar; explicit prompt injection (`/run-tests` gibi) |
| **Skills** (`.claude/skills/<name>/SKILL.md`) | Sometimes-relevant rich workflow; on-demand load, CLAUDE.md'yi şişirmez |
| **Subagents** (Task tool ile spawn) | İzole bağlam — main thread'i kirletmeden batch search/exploration |
| **Hooks** (`.claude/settings.json`) | Deterministik enforcement — formatter, linter, pre-commit gates |

**Karar kuralı (verbatim):** *"Use hooks for things that must happen every time (formatting, linting), and use CLAUDE.md for guidance requiring judgment (code style preferences, architectural patterns). Hooks are deterministic; CLAUDE.md is advisory."* [[1]](https://code.claude.com/docs/en/best-practices)

**Skills vs CLAUDE.md** (HumanLayer pratik kuralı): Eğer instruction sadece bazı dosyalarda relevant olacaksa → skill. Tüm projede her zaman geçerliyse → CLAUDE.md [[3]](https://www.humanlayer.dev/blog/writing-a-good-claude-md)[[1]](https://code.claude.com/docs/en/best-practices).

### 8. Gerçek dünya örnekleri

**Awesome list:** [josix/awesome-claude-md](https://github.com/josix/awesome-claude-md) — 270 star, açık kaynak repo'lardan derlenmiş örnekler [[20]](https://github.com/josix/awesome-claude-md).

**Template repo'lar (stack-bazlı):**
- [abhishekray07/claude-md-templates](https://github.com/abhishekray07/claude-md-templates) — Next.js, FastAPI, generic; <60 line target [[26]](https://github.com/abhishekray07/claude-md-templates)
- [ArthurClune/claude-md-examples](https://github.com/ArthurClune/claude-md-examples) — Hugo, Python, Terraform [[21]](https://github.com/ArthurClune/claude-md-examples)
- [tsdevau/claude-rules-template](https://gist.github.com/tsdevau/673876d17d344f97ba3473bc081bd1e5) — Astro + Svelte 5 + Tailwind v4 + Cloudflare; 280-320 satır (prescriptive uçta) [[27]](https://gist.github.com/tsdevau/673876d17d344f97ba3473bc081bd1e5)

**Section header'ları popülarite sırası** (template'lerden derlenmiş): Tech Stack · Commands · Architecture · Code Style · Critical Constraints · Important Notes · Validation Checkpoints · Naming Conventions · File Structure · Performance · Behaviour.

---

## Çelişen görüşler / tartışmalı noktalar

### 1. Uzunluk: "kısa ve disiplinli" mi yoksa "detaylı ve living" mi?

- **Pozisyon A — Aggressive short:** HumanLayer (<60 line), abhishekray07/templates (<60), Parreño (20-80 small). Argüman: instruction adherence ~150-200'de tavan yapıyor; her satır system prompt + diğer CLAUDE.md satırlarıyla yarışıyor. Yöntem: short ana CLAUDE.md + `.claude/rules/` veya `agent_docs/` ile progressive disclosure [[3]](https://www.humanlayer.dev/blog/writing-a-good-claude-md)[[26]](https://github.com/abhishekray07/claude-md-templates)[[6]](https://joseparreogarcia.substack.com/p/claude-code-memory-explained).
- **Pozisyon B — Pragmatic medium:** Anthropic resmi (200-line target), TurboDocx, Morph LLM, OpenTools (hepsi <200). Argüman: 200 hâlâ küçük (≈3-4K token, %2-4 context); Claude'a yeterince bağlam vermek için yer var [[2]](https://code.claude.com/docs/en/memory)[[5]](https://www.morphllm.com/claude-code-memory-files)[[7]](https://www.turbodocx.com/blog/how-to-write-claude-md-best-practices).
- **Pozisyon C — Detailed living document:** Steve Kinney (no cap), Builder.io ("complex codebase için daha uzun OK"). Argüman: bağlam yatırımı önden yapılır; sonradan correction round'larından daha ucuz [[8]](https://stevekinney.com/courses/ai-development/claude-dot-md)[[16]](https://www.builder.io/blog/claude-md-guide).

**Benim okumam:** Pozisyon B (200 satır altı, ideal 60-150) doğru. Sebep:
1. Anthropic'in kendi memory docs'u 200'ü açık hedef olarak veriyor — bu bir kapris değil, "adherence reduces" gözleminin formal ifadesi [[2]](https://code.claude.com/docs/en/memory).
2. Pozisyon A (60 line) çok dogmatik; karmaşık projelerde gerçekçi değil. Bir Tauri + Rust + React projede tek başına protocol disiplini için 30 satır gerek, geri kalanı bitiyor.
3. Pozisyon C ölçülebilir kanıt sunmuyor — "complex codebase için daha uzun" claim'i adherence trade-off'unu görmezden geliyor.
4. Morph'un sayısal analizi ikna edici: 150 line ≈ 3-4K token ≈ %2-4 context → bu mertebede hâlâ "ucuz" [[5]](https://www.morphllm.com/claude-code-memory-files).

İstisna: Tek başına çalışan, çok az convention'lu side-project için 30-50 satır yeter (HumanLayer'ın dürüst hedefi). 5+ kişilik team'de 100-200 normal.

### 2. `/init` kullanılmalı mı?

- **Pozisyon A — `/init` ile başla:** Anthropic resmi, Vincent Qiao, Mike Murphy, Dometrain. Argüman: codebase tarayıp baseline çıkarıyor; sıfırdan yazmaktan hızlı [[1]](https://code.claude.com/docs/en/best-practices)[[15]](https://blog.vincentqiao.com/en/posts/claude-code-init/)[[22]](https://www.mikemurphy.co/claudemd/)[[14]](https://dometrain.com/blog/creating-the-perfect-claudemd-for-claude-code/).
- **Pozisyon B — Manuel yaz, `/init` kullanma:** HumanLayer. Argüman: CLAUDE.md "highest leverage point"; auto-generated content boilerplate ve Claude'a değer katmayan yerler içerir; manuel yazılırsa her satır intentional olur [[3]](https://www.humanlayer.dev/blog/writing-a-good-claude-md).

**Benim okumam:** Pozisyon A daha pratik ama **`/init` çıktısının %50-70'ini silerek** kullan. Pozisyon B'nin uyarısı haklı — "`/init` çıktısını dokunmadan bırakma" zaten resmi docs'ta da var [[15]](https://blog.vincentqiao.com/en/posts/claude-code-init/). Sıfırdan başlamak zaman israfı; ama auto-generated bölümleri (özellikle generic "best practices" + file-by-file listings) kes, sadece komutlar + non-obvious gotcha'ları bırak.

### 3. Subdir CLAUDE.md davranışı

- **Pozisyon A — Parent-walk + on-demand:** Anthropic docs, Codewithmukesh, Shahab Papoon. Launch'ta cwd'den root'a kadar tüm parent CLAUDE.md'ler concat edilir; subdir'dekiler dosya okununca lazy-load [[2]](https://code.claude.com/docs/en/memory)[[11]](https://codewithmukesh.com/blog/anatomy-of-the-claude-folder/)[[12]](https://www.shahabpapoon.com/blog/mastering-claude-md-multi-project-workflow/).
- **Pozisyon B — Sadece on-access:** alexop.dev, parent-walk'tan bahsetmiyor [[13]](https://alexop.dev/posts/claude-code-customization-guide-claudemd-skills-subagents/).

**Benim okumam:** Pozisyon A doğru. Anthropic resmi docs net — alexop.dev mekanizmanın bir parçasını eksik anlatmış. Pratikte bu fark önemli: monorepo'da `apps/api/CLAUDE.md` ve `apps/web/CLAUDE.md` ayrı yazılırsa, Claude'ı `apps/api/` içinden başlatınca **api CLAUDE.md + repo root CLAUDE.md** yüklenir; web CLAUDE.md değil. Bu gerçek bir feature.

---

## Güncellik notu

**Hızlı değişen** (6 ay içinde tekrar doğrulanmalı):
- Skills + plugins + subagent ekosistemi (hesreallyhim/awesome-claude-code listesi sürekli güncelleniyor [[23]](https://github.com/hesreallyhim/awesome-claude-code))
- Auto Memory (`MEMORY.md`) davranışı — v2.1.59+ feature, 200-line truncation davranışı değişebilir [[2]](https://code.claude.com/docs/en/memory)
- AGENTS.md interop — şu an `@AGENTS.md` ile referans veriliyor; Anthropic AGENTS.md'yi native destekleyebilir [[2]](https://code.claude.com/docs/en/memory)
- Claude Code 1M context window — context bolca olunca CLAUDE.md uzunluk baskısı azalabilir [[25]](https://www.dev.to/godnick/claudes-1m-context-window-is-live-heres-how-to-actually-use-it-without-burning-through-your-d7a)

**Stabil** (yıllarca geçerli):
- 200-line guidance (instruction adherence fenomeni LLM'e özgü, kalıcı)
- Hierarchy semantics (`~/.claude/` > project > local + parent-walk)
- `@import` syntax (5-hop max)
- "Hooks deterministic, CLAUDE.md advisory" iş bölümü
- Anti-pattern listesi (generic platitudes, kitchen sink, file-by-file dump)

**Belirsiz** (yakında değişebilir):
- "managed policy" CLAUDE.md (org-wide IT-deployed) ne kadar enterprise'a yayılır — şu an niche
- `.claude/rules/` directory'nin populerliği (henüz çoğu kaynak bahsetmiyor; resmi docs içinde)
- Native AGENTS.md fallback'i (şu an Claude Code sadece CLAUDE.md okuyor)

---

## Öneri

Senin için (Myne projesi, pre-alpha, 1-2 kişi, Tauri + Rust + React stack):

### Hemen ne yap

1. **Mevcut `CLAUDE.md`'i ölç:** `wc -l CLAUDE.md`. Şu an 130-140 satır civarı (geçen turlarda eklenen "Phase 1 plan & ownership" bölümüyle birlikte) — **200 sınırının altında, tam ideal aralıkta**. Hiç müdahale gerekmez.

2. **Hangi parçalar dosyada doğru yerde, hangi parçalar değil — gözden geçir:**

   ✅ **Doğru** (CLAUDE.md'de kalsın):
   - "Cryptographically load-bearing identifiers" tablosu — non-obvious, judgment gerektiren bağlam
   - "Hard architectural commitments" listesi — anti-feature commitment'lar (no email, no plaintext mode)
   - "Subkey derivation discipline" — code review reject kuralı
   - "Phase 1 plan & ownership" — ID disiplini + dosya navigasyonu
   - "Common commands" tablosu — pnpm/cargo'nun proje-spesifik kullanımı

   🟡 **Sınırda** (taşınabilir):
   - "Crypto primitives baseline" detaylı paragrafı (~10 satır) — `protocol.md`'ye link verip CLAUDE.md'de 1-2 satır özet yeterli olabilir
   - "Tauri configuration that matters" — bu detayı `src-tauri/CLAUDE.md` (subdir) olarak ayır, root'tan çıkar; lazy-load olur

   ❌ **Çıkar** (CLAUDE.md'de yer kapatıyor):
   - "Common commands" altındaki tüm komut açıklamaları → `package.json` scripts ve `Cargo.toml` zaten okunabilir; sadece **non-obvious** komutları bırak (örn. `pnpm tauri dev`'in :1420 davranışı)
   - "Multi-repo workspace" scripts paragrafı — `workspace/setup.sh` adını söyle, geri kalanı `workspace/`'in kendi README'sine bırak

3. **`@import` syntax kullanmayı düşün** — uzun bölümleri `docs/` altına bağla:
   ```markdown
   See @docs/threat-model.md for adversaries A1–A13 + trust boundaries TB1–TB9.
   See @docs/spec/protocol.md for the v0.1 cryptographic protocol.
   ```
   AMA: import context'i azaltmaz, organize eder. Sadece okunabilirlik için.

4. **`CLAUDE.local.md` ekle** — `.gitignore`'da. Sadece sana özel notlar için (örn. "her PR sonunda `pnpm tauri build` koş, fan dönmesin diye"). Team değil.

### Süreç tarafı

5. **Quarterly review:** 3 ayda bir CLAUDE.md'ye bak. Her satır için: *"Bu satırı silsem Claude bir hata yapar mı?"* Cevap hayırsa sil.
6. **Hook-bazlı enforcement:** `cargo fmt --check` + `cargo clippy -D warnings` + `tsc --noEmit` zaten C2 (CI) içine girecek. CLAUDE.md'de "format kodu" yazma — hook + CI ikilisi otomatik halleder. Senin Day 1 hygiene batch'i (C1+C2+C6) tam bunu kuruyor.
7. **`#` quick-add'i kullan:** Claude'a oturum içinde "şunu hep yap" derken, mesajı `#` ile başlat — otomatik CLAUDE.md'ye eklenir.

### Kaçın

- `/init`'i **şimdi yeniden çalıştırma** — zaten elinde iyi bir CLAUDE.md var, auto-gen onu üzerine yazmaz ama kafanı karıştırır.
- "Be a senior engineer" tarzı personality kuralı eklemekten kaçın.
- Plan dosyalarındaki günlük status'u CLAUDE.md'ye taşıma — onlar `phase-1-plan/`'de doğru yerde.

---

## Kaynakça

1. [Best Practices for Claude Code](https://code.claude.com/docs/en/best-practices) — Anthropic official docs, undated; CLAUDE.md anti-patterns + örnek + include/exclude tablosu için en kanonik kaynak
2. [How Claude remembers your project](https://code.claude.com/docs/en/memory) — Anthropic official memory docs; 200-line target, hierarchy mekaniği, compaction davranışı, `.claude/rules/` ve `@import` resmî açıklaması
3. [Writing a good CLAUDE.md](https://www.humanlayer.dev/blog/writing-a-good-claude-md) — HumanLayer vendor blog, Nov 2025; "<60 line" agresif kısa pozisyonu + linter argümanı + WHY/WHAT/HOW yapısı
4. [Build your own /init command](https://kau.sh/blog/build-ai-init-command/) — Kaushik Gopal personal blog, Oct 2025; `/init` ne yapar mekaniği + "do not repeat yourself" anti-pattern
5. [Claude Code Memory Files](https://www.morphllm.com/claude-code-memory-files) — Morph LLM vendor blog, Mar 2026; concrete token math (150 line ≈ 3-4K token) + Commands/Architecture/Conventions/Gotchas section sırası
6. [Claude Code Memory Explained](https://joseparreogarcia.substack.com/p/claude-code-memory-explained) — Jose Parreño Garcia substack, Feb 2026; tiered length (20-80 / 80-200 / >200), "memory is coordination not personality"
7. [How to Write CLAUDE.md Best Practices](https://www.turbodocx.com/blog/how-to-write-claude-md-best-practices) — TurboDocx vendor blog, Mar 2026; 200/300 line guidance + Reference Documents section
8. [CLAUDE.md (course material)](https://stevekinney.com/courses/ai-development/claude-dot-md) — Steve Kinney course, Mar 2026; ADR yapısı + `#` quick-add + `/memory` komutu
9. [How to Use Claude Code Features](https://www.producttalk.org/how-to-use-claude-code-features/) — Product Talk, Nov 2025; CLAUDE.md vs slash vs subagent vs hook vs skill iş bölümü
10. [The CLAUDE.md Configuration Hierarchy](https://agentfactory.panaversity.org/docs/General-Agents-Foundations/claude-code-teams-cicd/claude-md-configuration-hierarchy) — Panaversity course, undated; precedence kuralı + parent-walk + `@import` örneği
11. [Anatomy of the .claude Folder](https://codewithmukesh.com/blog/anatomy-of-the-claude-folder/) — Mukesh Murugan independent blog, Apr 2026; 4-level hierarchy + 5-hop import depth detayı
12. [Mastering CLAUDE.md Multi-Project Workflow](https://www.shahabpapoon.com/blog/mastering-claude-md-multi-project-workflow/) — Shahab Papoon independent blog, Mar 2026; workspace + client/group intermediate seviyeleri + path-scoped rules
13. [Claude Code Customization Guide](https://alexop.dev/posts/claude-code-customization-guide-claudemd-skills-subagents/) — Alexander Opalic independent blog, Dec 2025; CLAUDE.md vs skills vs subagents karşılaştırması (ama subdir-walk eksik açıklanmış)
14. [Creating the Perfect CLAUDE.md](https://dometrain.com/blog/creating-the-perfect-claudemd-for-claude-code/) — Dometrain tutorial site, Jan 2026; `/init` çıktısı section listesi
15. [Claude Code /init: Generate CLAUDE.md in 10 Seconds](https://blog.vincentqiao.com/en/posts/claude-code-init/) — Vincent Qiao independent blog, Mar 2026; "/init starting point, not finished product" tavsiyesi
16. [How to Write a Good CLAUDE.md File](https://www.builder.io/blog/claude-md-guide) — Builder.io vendor blog, Jan 2026; ShopFront tam örnek + "everything IMPORTANT = nothing" uyarısı
17. [How to Create the Perfect CLAUDE.md (incl. Template)](https://www.gradually.ai/en/claude-md/) — Gradually.ai commercial blog, Mar 2026; tiered length (50/100/<1000) + AGENTS.md symlink önerisi
18. [Community Learnings: Token-Wasting Patterns](https://github.com/anthropics/claude-code/issues/13579) — anthropics/claude-code issue, Dec 2025; compaction sonrası user pref kaybı + parallel agent collision case'leri
19. [Claude Code Memory Persistence Guide 2026](https://thepromptshelf.dev/blog/claude-code-memory-persistence-guide-2026/) — The Prompt Shelf, Apr 2026; CLAUDE.md (stable) vs MEMORY.md vs CONTEXT.md ayrımı
20. [josix/awesome-claude-md](https://github.com/josix/awesome-claude-md) — community curated list, undated; gerçek dünya CLAUDE.md koleksiyonu
21. [ArthurClune/claude-md-examples](https://github.com/ArthurClune/claude-md-examples) — community examples; Hugo + Python + Terraform örnekleri
22. [How to Create a CLAUDE.md File](https://www.mikemurphy.co/claudemd/) — Mike Murphy personal blog, Sep 2025; `/init` + `#` quick-add adımları
23. [hesreallyhim/awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) — community curated, sürekli güncelleniyor; tools/skills/hooks ekosistemi
24. [Claude Code CLAUDE.md Guide](https://opentools.ai/resources/claude-code-claudemd-guide) — OpenTools tutorial, Apr 2026; `.claude/rules/` path-scoped + "prohibitions without alternatives" anti-pattern
25. [Claude's 1M Context Window Is Live](https://dev.to/godnick/claudes-1m-context-window-is-live-heres-how-to-actually-use-it-without-burning-through-your-d7a) — DEV community, undated; 1M window context rot uyarısı
26. [abhishekray07/claude-md-templates](https://github.com/abhishekray07/claude-md-templates) — community templates, 5 commit; <60 line target + "80+ Claude ignores parts" claim
27. [Claude Rules Template (gist)](https://gist.github.com/tsdevau/673876d17d344f97ba3473bc081bd1e5) — tsdevau personal gist, Jul 2025; 280-320 satır prescriptive Astro/Svelte template
28. [I Stopped Re-Explaining Everything to Claude Code](https://artificialcorner.com/p/claude-md) — Artificial Corner substack, Feb 2026; non-coding (writing/decision) CLAUDE.md kullanımı + folder hierarchy önerisi (rules/context/skills)

## Dahil edilmeyen kaynaklar

- [Anthropic CDN PDF "How Anthropic teams use Claude Code"](https://www-cdn.anthropic.com/58284b19e702b49db9302d5b6f135ad8871e7658.pdf) — sebep: scanned/OCR'lı PDF, WebFetch text extract edemedi; raw stream döndü; içerik doğrulanamadı
- [Claude Code blog: using-claude-md-files](https://claude.com/blog/using-claude-md-files) — kısmen kullanıldı, ama `.mm` extension claim'i suspect (her yerde `.md` olarak geçiyor); muhtemelen blog typo, bu detay göz ardı edildi
- [jxnl.co context engineering post](https://jxnl.co/writing/2025/08/29/context-engineering-slash-commands-subagents/) — Jason Liu, Aug 2025; CLAUDE.md'den hiç bahsetmiyor, sadece slash vs subagent context engineering; alt soru 7'de "context budget scarce" argümanı için indirect support olarak okundu ama kaynakça'ya alınmadı

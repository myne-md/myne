---
title: "Unsupported and malformed"
---

# Values Myne refuses to type

Refusing is the point: a silently shifted due date is worse than one the editor
shows as raw text with a hint.

- [ ] half-written date [due:: 2026-08]
- [ ] impossible date [due:: 2026-02-31]
- [ ] out-of-range time [due:: 2026-08-01 25:00]
- [ ] a Z offset [due:: 2026-08-01T10:00:00Z]
- [ ] a numeric offset [due:: 2026-08-01T10:00:00+03:00]
- [ ] an unknown priority word [priority:: urgent]
- [ ] empty value [due:: ]

# Fields Myne recognizes but does not type

- [ ] obsidian's other keys [scheduled:: 2026-08-05] [start:: 2026-08-01] [cancelled:: 2026-08-09] [created:: 2026-07-01] [id:: abc] [dependsOn:: xyz]
- [ ] an action language Myne never runs [onCompletion:: delete]

# Not fields at all

- [ ] inside a code span `[due:: 2026-08-01]`
- [ ] a dangling label [label] and an ordinary [link](https://example.com)
- [ ] a shortcode :calendar: 2026-08-01

```
- [ ] inside a fence [due:: 2026-08-01] 📅 2026-08-02
```

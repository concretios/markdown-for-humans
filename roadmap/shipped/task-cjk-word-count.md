# Task: Count words correctly in Chinese and Japanese

## 1. Task Metadata

- **Task name:** Count words correctly in Chinese and Japanese
- **Slug:** cjk-word-count
- **Status:** shipped in 0.4.4 (2026-10-12)
- **Created:** 2026-10-11
- **Last updated:** 2026-10-11
- **Shipped:** 2026-10-12 (0.4.4)

---

## 2. Context & Problem

**Current state:**
- `src/features/wordCount.ts` counted words by splitting on whitespace.
- Chinese and Japanese put no spaces between words, so a whole sentence counted as 1 word.

**Pain points:**
- **Wrong count:** a 14-character Chinese sentence showed "1 words"; a long document showed a near-zero count.
- **Wrong reading time:** it is derived from the word count, so it was near zero too.
- **Now visible:** the extension is being translated into Chinese and Japanese (`task-localization.md`, audit row B21), so those users will look at this number.

**Why it matters:**
- **Convention exists:** Microsoft Word's "Words" figure is the non-Asian words plus one per Asian character; Korean is counted by its spaces. Translators and writers in Chinese and Japanese work with that figure (字数) [1][2].
- **Other tools do the same:** Jekyll's `number_of_words` and MkDocs Material count one per CJK character [3].

---

## 3. Desired Outcome & Scope

**Success criteria:**
- Chinese and Japanese text counts one per Han, hiragana or katakana character.
- Text in spaced languages counts exactly as before.
- Mixed text adds the two.
- Reading time is sensible for all three.
- No measurable slowdown on a 10,000-line document.

**In scope:**
- `calculateStats` in `src/features/wordCount.ts` (status bar, tooltip, detailed stats).
- Simplified Chinese label for the count.

**Out of scope:**
- Thai, Lao, Khmer and Burmese, which are also written without spaces but need dictionary segmentation. They still count by whitespace.
- A setting to choose the counting rule or the reading speed.
- Excluding Markdown syntax from the count.

---

## 4. UX & Behavior

**Entry points:**
- Status bar word count, its tooltip, and the detailed statistics command.

**Behavior rules:**
- A whitespace-separated token with no Chinese or Japanese character counts as 1, as before.
- In a token that has such characters, each one counts as 1, and each run of other letters or digits counts as 1. Punctuation and Markdown markers in that token count as 0.
- The katakana long vowel mark `ー` counts as a character.
- Reading time is `words / 200 + characters / 500` minutes, rounded up, at least 1 for non-empty text.

| Text | Before | After |
| ---- | -----: | ----: |
| `我喜欢吃苹果，你喜欢吃什么水果？` | 1 | 14 |
| `今日は天気がいいので、公園を散歩しましょう。` | 1 | 20 |
| `使用 VS Code 打开 Markdown 文件，然后点击 Export 按钮。` | 8 | 16 |
| `打开Markdown文件` | 1 | 5 |
| `오늘은 날씨가 좋아서 공원에 갑니다.` | 5 | 5 |
| `A well-known, state-of-the-art approach` | 4 | 4 |
| `See https://example.com/docs/page?id=1 for details` | 4 | 4 |

---

## 5. Technical Plan

**Surfaces:**
- Extension host only.

**Key changes:**
- `src/features/wordCount.ts` - `countWords()` returns spaced words and unspaced characters; `calculateStats` adds them and derives reading time from both.
- `src/__tests__/features/wordCount.test.ts` - Chinese, Japanese, mixed, Korean, and pinned English cases.
- `l10n/drafts/bundle.l10n.zh-cn.json` - the count is labelled 字数 / 字 again.

**Alternatives measured and rejected:**

| Option | English "well-known, state-of-the-art approach" | English sentence with a URL | Chinese sentence | Verdict |
| ------ | ----: | ----: | ----: | ------- |
| Whitespace split (before) | 4 | 4 | 1 | Wrong for Chinese and Japanese |
| `Intl.Segmenter` for all text | 8 | 9 | 9 | Rejected: changes English counts; result depends on the ICU version shipped with VS Code |
| `Intl.Segmenter` only for tokens with CJK | 4 | 4 | 9 | Rejected: linguistic words are not the figure these users expect, and results vary with ICU dictionaries |
| One per CJK character, whitespace otherwise | 4 | 4 | 14 | **Chosen**: the word-processor convention, deterministic, no dictionary |

**Performance (10,000 lines, measured in Node, whole `calculateStats`):**

| Document | Before | After |
| -------- | -----: | ----: |
| English, Latin-1 only | 7.9 ms | 7.9 ms (the check for these scripts costs 0.0 ms) |
| English with curly quotes, or Russian | 8.8 ms, 6.5 ms | about 2 ms more |
| Chinese, 310,000 characters | under 1 ms for the old word split | 9.9 ms |
| Mixed Chinese and English, 620,000 characters | 3.8 ms for the old word split | 14.5 ms |

The count runs in the extension host on document change, not in the webview typing path.

---

## 6. Work Breakdown

- [x] Measure current and candidate rules on English, Chinese, Japanese, Korean, Thai, Russian and mixed samples
- [x] Tests first: 6 new cases failed, English cases passed unchanged
- [x] Implement `countWords` and the reading-time rule
- [x] Simplified Chinese labels
- [ ] Real VS Code check with a Chinese and a Japanese document
- [ ] Native review of the Japanese label (see section 8)

---

## 7. Implementation Log

### 2026-10-11 - Implemented

- **What:** Counting rule, reading time, tests, Chinese label.
- **Files:** `src/features/wordCount.ts`, `src/__tests__/features/wordCount.test.ts`, `l10n/drafts/bundle.l10n.zh-cn.json`.
- **Notes:** Done on the localization branch at the owner's request, since it came out of that audit.

---

## 8. Decisions & Tradeoffs

- **Character count over linguistic words:** matches Word and what Chinese and Japanese writers quote. A dictionary segmenter would give "words" nobody asks for and would vary between VS Code versions.
- **English untouched:** documents with no such character take the old code path, so their count cannot change.
- **Reading speed of 500 characters a minute:** the figure Medium's read-time formula uses for Chinese, Japanese and Korean, as reported by several implementations of it [4]. One native commenter in [3] suggests about 300. The evidence is secondary; treat 500 as a starting value.
- **Japanese label left as 単語:** the count for Japanese text is now effectively characters. Japanese Word labels the same figure 単語数, but 文字数 may read more naturally; it would then clash with the separate "characters" line. Needs a native reader.
- **Korean unchanged:** it uses spaces, and Word counts Korean by words.

---

## 9. Follow-up & Future Work

- Thai, Lao, Khmer and Burmese with `Intl.Segmenter`, if requested.
- A setting for reading speed.
- Skip Markdown syntax and code blocks when counting.

---

## Sources

- [1] How Word reports "Asian characters, Korean words": https://davidsmithtranslation.com/articles/how-to-count-chinese-characters/
- [2] Discussion of Word's rule, "Words" = non-Asian words + Asian characters: https://forum.literatureandlatte.com/t/live-counts-show-provide-characters-no-spaces-or-a-new-cjk-word-count-algorithm/152243
- [3] MkDocs Material, read time for Chinese, Japanese and Korean (also cites Jekyll): https://github.com/squidfunk/mkdocs-material/issues/8161
- [4] Medium read-time formula, 500 characters a minute for CJK: https://www.freecodecamp.org/news/how-to-more-accurately-estimate-read-time-for-medium-articles-in-javascript-fb563ff0282a/

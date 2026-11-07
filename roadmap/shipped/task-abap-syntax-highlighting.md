# Task: ABAP Syntax Highlighting für Code-Blöcke

## 1. Task Metadata

- **Task name:** ABAP syntax highlighting
- **Slug:** task-abap-syntax-highlighting
- **Status:** shipped
- **Created:** 2026-10-10
- **Last updated:** 2026-10-10
- **Shipped:** 2026-10-10

---

## 2. Context & Problem

**Current state:**
- Code-Block-Syntax-Highlighting basiert auf lowlight 2.9 + highlight.js 11.12 (Worker-Pipeline in `src/webview/highlighting/`), 36 registrierte Grammatiken via `GRAMMAR_ALIASES` in `languageRegistry.ts`.
- highlight.js besitzt **keine** ABAP-Grammatik (weder 11.12 noch ältere Versionen).

**Pain points:**
- **ABAP-Entwickler:** ```` ```abap ````-Fences bleiben unhighlightet (plain), da keine Grammatik registriert ist.
- **Discoverability:** Selbst wenn per Fence verfügbar, fehlt ein Eintrag im Code-Block-Sprachmenü des BubbleMenus.

**Why it matters:**
- ABAP ist eine der meistgenutzten Enterprise-Sprachen; das offizielle Community-Paket `highlightjs-sap-abap` (MIT, ~60k Downloads/Monat, gepflegt unter der highlightjs-Org) ist der sanctioned Path.
- Konsistente Nutzererfahrung: ABAP verhält sich wie jede andere unterstützte Sprache (Highlighting, Menü, Roundtrip).

---

## 3. Desired Outcome & Scope

**Success criteria:**
- ```` ```abap ````-Code-Blöcke werden im Editor hervorgehoben (Keywords, Strings, Kommentare) — Spans mit gültigen UTF-16-Offsets, Klassen innerhalb der `hljs-*`-Allowlist.
- `abap` und `sap-abap` resolvieren via `resolveGrammar` → `abap`; unbekannte Tokens bleiben plain (kein Auto-Detect).
- Dropdown im BubbleMenu zeigt "ABAP"; `isActive` greift für ```` ```abap ```` inkl. Metadata-Suffix-Erhaltung.
- Fence-Roundtrip: gespeicherte Datei behält `abap`-Info-String unverändert.
- `npm test` vollständig grün, keine Regression bestehender Fingerprints/Tripwires.

**In scope:**
- Dependency `highlightjs-sap-abap` (MIT), Worker-Grammatik-Registration, Alias-Registry, Menüeintrag, Tests, Doku-Updates.

**Out of scope:**
- Kein highlight.js/lowlight-Upgrade (Version-Tripwires bleiben).
- Keine Auto-Detection, keine neuen CSS-Farben (generisches Scope-Mapping reicht).
- Mermaid-Fences bleiben plain (bewusste Design-Entscheidung).

---

## 4. UX & Behavior

**Entry points:**
- Code-Block-Dropdown im BubbleMenu ("Code block" → Sprache wählen) und manuelle Fence-Sprache ```` ```abap ````.

**User flows:**

### Flow 1: Sprache im Menü wählen
1. Nutzer öffnet Code-Block, klickt ins BubbleMenu → "Code block" → "ABAP".
2. Fence-Info-String wird via `replaceFenceLanguage` auf `abap` gesetzt (Metadata bleibt erhalten).
3. Block wird hervorgehoben; Dropdown zeigt "ABAP" als aktiv.

### Flow 2: Fence manuell tippen
1. Nutzer tippt ```` ```abap ```` + Code.
2. `resolveGrammar('abap')` → `abap`; Worker tokenisiert im Hintergrund.
3. Speichern → Reopen: Fence-Token bleibt `abap` (verbatim Roundtrip).

**Behavior rules:**
- Aliase (`sap-abap`) zeigen im Dropdown denselben aktiven Eintrag wie `abap` (Vergleich via `resolveGrammar`).
- Unbekannte/`plaintext`-Tokens: kein Highlighting, kein Raten (bestehende Invariante).
- ABAP ist `case_insensitive` in der Grammatik; die Registry-Auflösung bleibt wie bisher case-insensitive über Lowercase-Tokens.

---

## 5. Technical Plan

**Surfaces:**
- Webview-Worker (Grammatik-Tokenizer), Webview-Editor (Registry + BubbleMenu), Tests, Doku.

**Key changes:**
- `src/webview/highlighting/tokenize.ts` – `import abap from 'highlightjs-sap-abap'` + `lowlight.registerLanguage('abap', abap)` am Ende der Registrationsliste (Reihenfolge bestehender Sprachen bewahren).
- `src/webview/types/highlightjs-sap-abap.d.ts` – Ambient-Typ (LanguageFn) analog zu `katex.d.ts` (Paket liefert keine Types).
- `src/webview/highlighting/languageRegistry.ts` – `abap` (Canonical) + `sap-abap` (Alias) in `GRAMMAR_ALIASES`; `SUPPORTED_GRAMMARS` 36 → 37.
- `src/webview/BubbleMenuView.ts` – Menüeintrag `['ABAP', 'abap']`.
- `THIRD_PARTY_LICENSES.md` – Eintrag für `highlightjs-sap-abap` (MIT).
- Tests: `languageRegistry.test.ts` (Inventory-Guard 36→37, Alias-Cases), `tokenize.test.ts` (ABAP-Sample, Offsets, `hljs-*`-Allowlist), `codeFenceMenu.test.ts` (Dropdown, isActive, Metadata).

**Architecture notes:**
- Grammatik-Code lebt ausschließlich im Worker-Bundle (`scripts/build-webview.js` → `dist/highlighting-worker.js`) — keine Grammar-Imports auf dem Typing-Thread (`languageRegistry.ts` bleibt grammar-frei).
- `highlightjs-sap-abap` exportiert CommonJS `module.exports = fn` (hljs `LanguageFn`), interop-fähig via esbuild/esModuleInterop.
- Bestehende Golden-Fingerprints und Version-Tripwires (lowlight 2.9.0 / highlight.js 11.12.0) bleiben unangetastet — neue Registrierung am Ende stört keine existierenden Sprachen.

**Performance considerations:**
- Grammatik-Datei ist klein (~15 KB); Bundle-Budget laut `vibe-coding-rules/performance.md` prüfen (`npm run verify-build`).
- Highlighting läuft weiterhin im Worker — keine Änderung an Typing-Latency-Budgets.

---

## 6. Work Breakdown

- [x] **Phase 1: Setup** - Dependencies + Planfile
  - [x] `npm install` + `npm install highlightjs-sap-abap`
  - [x] Export-Shape verifiziert (CJS `LanguageFn`, Aliase `['sap-abap', 'abap']`, MIT)
  - [x] `THIRD_PARTY_LICENSES.md`-Eintrag
- [x] **Phase 2: Tests (RED)** - Fehlende Tests zuerst geschrieben, Fehlschlag verifiziert (5 Assertions rot, 139 bestehend grün)
  - [x] `languageRegistry.test.ts`: Aliase + Inventory-Guard 37
  - [x] `tokenize.test.ts`: ABAP-Sample-Fall
  - [x] `codeFenceMenu.test.ts`: Dropdown-Eintrag
- [x] **Phase 3: Implementierung (GREEN)**
  - [x] `tokenize.ts` Registration + `highlightjs-sap-abap.d.ts`
  - [x] `languageRegistry.ts` Aliase
  - [x] `BubbleMenuView.ts` Menüeintrag
- [x] **Phase 4: Verifikation**
  - [x] `npm test`: alle 144 Tests der 3 betroffenen Suites grün; Voll-Lauf: 205/211 Suites grün (6 Fehlschläge vorbestehend, siehe Log)
  - [x] `npm run build:release` + `npm run verify-build` grün (Worker 219 KB inkl. ABAP-Grammatik, Bundle-Budget eingehalten)
  - [x] `npx tsc --noEmit` sauber (0 Fehler)
  - [x] Realer VS Code Extension Development Host via `npm run test:integration` (vscode-test): 8/8 grün, u. a. "ships the self-contained worker at a readable extension resource URI"
  - [ ] Manuelle Native-QA (Dropdown-Klick, Tippen, Theme-Wechsel visuell) — kein Computer-Use-Werkzeug in der Session verfügbar, an User/QA übergeben
- [x] **Phase 5: Doku & Ship**
  - [x] README.md (36→37), wiki (Features/User-Guide/FAQ/Troubleshooting), env-context.md, docs/ARCHITECTURE.md, issue-triage-2026-10.md, CHANGELOG.md
  - [x] Planfile → `roadmap/shipped/` (kein Commit/Push ohne User-Review)

**Testing:**
- Unit: Alias-Resolution, Inventory-Guard, Tokenizer-Sample (Node-Subprocess mit echtem Lowlight)
- UI: Dropdown-Verhalten in `codeFenceMenu.test.ts`
- Manual: `docs/QA_MANUAL.md`-Checkliste + Real-Host-Flow

---

## 7. Implementation Log

### 2026-10-10 – Setup

- **What:** `npm install highlightjs-sap-abap@^0.3.0` (MIT, Autor Lars Hvam Petersen / highlightjs-Org). Export-Shape geprüft: `src/abap.js`, CJS `LanguageFn`, `case_insensitive: true`, Aliase `['sap-abap', 'abap']`.
- **Files:** `package.json`, `package-lock.json`
- **Notes:** Paket hat keine TypeScript-Declarations → eigene Ambient-Declaration nötig (analog `katex.d.ts`). highlight.js-Typen decken nur `highlight.js/lib/languages/*` per Wildcard ab.

### 2026-10-10 – TDD RED → GREEN

- **What:** 5 neue Test-Assertions geschrieben (Alias-Resolution `abap`/`sap-abap`, Inventory-Guard 36→37, ABAP-Tokenizer-Sample mit `hljs-comment`/`hljs-keyword`/`hljs-string`-Scopes + UTF-16-Offset-Gültigkeit + Klassen-Allowlist, Dropdown-Eintrag "ABAP" inkl. Metadata-Erhaltung). RED verifiziert (5 rot, 139 bestehend grün), dann Implementierung, GREEN verifiziert (144/144).
- **Files:** `src/webview/highlighting/tokenize.ts`, `src/webview/highlighting/languageRegistry.ts`, `src/webview/BubbleMenuView.ts`, `src/webview/types/highlightjs-sap-abap.d.ts` (neu), 3 Testfiles
- **Notes:** ABAP-Registration am Ende der `lowlight.registerLanguage`-Liste — bestehende Reihenfolge und Golden-Fingerprints unangetastet (Version-Tripwires lowlight 2.9.0 / hljs 11.12.0 / nested 11.8.0 bestehen weiter).

### 2026-10-10 – Verifikation + vorbestehende Umgebungs-Funde

- **What:** `npm run build:release` + `verify-build` grün (Worker 219 KB, ABAP-Grammatik per Bundle-Grep bestätigt). `tsc --noEmit` sauber. `npm run test:integration` (echter VS Code Extension Development Host via vscode-test): 8/8 grün.
- **Vorbestehender Fund 1 (behoben):** `jest.config.js` verwies auf `node_modules/marked/lib/marked.esm.js` mit Slash-Pfaden — unter Windows matchen die Transform-Regexes die Backslash-Pfade nie, sodass 47 Suites schon beim Parsen scheiterten (`SyntaxError: Unexpected token 'export'` aus `marked@17` via `@tiptap/markdown`). Patterns jetzt separator-agnostisch (`[/\\\\]`) — auf POSIX unverändert wirksam, auf Windows behebend. Danach 205/211 Suites grün.
- **Vorbestehender Fund 2 (offen, ABAP-unabhängig):** 6 Suites schlagen auch ohne diese Änderung fehl: `wordCount.test.ts` (Locale-sensitiv: `toLocaleString` liefert auf dt. Windows `5.678` statt erwartetem `5,678`), `imagePathResolution.test.ts`, `feedbackReportV2.test.ts`, `feedbackEvidenceV2.golden.test.ts`, `feedbackProvider.test.ts`, `feedbackSessionStore.test.ts` (`FeedbackSessionError: Could not create the feedback bundle: unknown error`). Nicht Teil dieses Tasks; separat triagieren.
- **Vorbestehender Fund 3 (offen, Maschinen-Setup):** `npm run lint` meldet repo-weit Prettier-`Delete`-Fehler (166k+) auf jeder Zeile — `git config core.autocrlf=true` ohne `.gitattributes` checked out CRLF, Prettier/ESLint erwartet LF. Auch unveränderte Dateien betroffen; in den geänderten Dateien sind nur solche EOL-Fehler, keine echten. Empfehlung: `.gitattributes` mit `* text=auto eol=lf` ergänzen (Repo-Owner-Entscheidung, weil Checkout-Rewrite).
- **Offene Native-QA:** Manuelle Sichtprüfung im laufenden Editor (Dropdown-Klick, Tipplatenz, Theme hell/dunkel, 10-Min-Lesetest) blieb offen — in dieser Session standen keine Computer-Use-Werkzeuge für die VS Code UI zur Verfügung. Der automatisierte vscode-test-Lauf hat die Host-Integration (Worker-Asset, Editor-Öffnen, Splits/Reopen/Save) abgedeckt. Browser-Tests gelten laut AGENTS.md nicht als VS-Code-Nachweis.

---

## 8. Decisions & Tradeoffs

- **Grammatik-Quelle:** `highlightjs-sap-abap` (npm) statt Eigenentwicklung oder Vendoring — User-Entscheidung. Offizielles Community-Paket unter der highlightjs-Org, MIT, gepflegt.
- **UI-Eintrag im Dropdown:** ja — User-Entscheidung, bessere Discoverability.
- **Registration am Ende der Liste:** bestehende Reihenfolge (Lowlight-Common → 11.12-Overrides) ist fingerprint-relevant; ABAP wird angehängt.
- **`jest.config.js`-Fix mitgenommen:** Der Windows-Transform-Bug blockierte das Pflicht-Gate „alle Tests grün" repo-weit; separator-agnostische Patterns sind die minimal korrekte Behebung und auf POSIX wirkungsgleich. Kein Scope-Verlust, da test-infra nur.
- **Vorbestehende Test-/Lint-Fehlschläge NICHT gefixt:** Locale-sensitive Assertions, Feedback-Bundle-Fehler und das CRLF/Lint-Setup sind eigene Aufgaben mit eigener Risikoabdeckung (s. Implementation Log).

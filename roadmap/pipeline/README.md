# Pipeline: active plans only

Agents: boot from this list. Every file in this folder is listed here with its state; a file that is not listed is stale and should be moved to `roadmap/shipped/` or deleted. Shipped plans live under `roadmap/shipped/`.

## Live post-merge index
- `task-fix-postmerge-00-overview.md`: single live index (02 to 07 and 01-R1 shipped in 0.4.0; chunk 08 dropped with the AI reviewer)

## Open post-merge work
- `task-fix-postmerge-01-markdown-roundtrip.md`: R2 to R5 remainder
- `task-followups-postmerge.md`

## Findings awaiting an owner decision (not plans)
- `fidelity-audit-2026-10.md`: the source fidelity bug class measured on 0.4.4; decisions pending in its section 7
- `html-loss-findings-2026-10.md`: raw HTML loss measured on 0.4.4; the loss guard (option B) shipped in 0.4.4, the rest waits on section 5
- `issue-triage-2026-10.md`: all 25 open issues bucketed on 2026-10-10; replies drafted, not posted

## Ready to merge, waiting for a release
- `task-mermaid-lightbox.md`: zoom and pan viewer for Mermaid diagrams (PR 78 by a contributor, brought current on 2026-11-07)

## True backlog
- `task-p0-mermaid-split-view.md`
- `task-p0-slash-commands.md`: general `/` menu (math slash already exists)
- `task-p0-source-view-toggle.md`: scroll/cursor sync and command palette (toolbar split exists)
- `task-p1-collapsible-headers.md`
- `task-p1-frontmatter.md`: richer metadata UX (wrap/unwrap already shipped)
- `task-p1-wikilinks.md`
- `task-pdf-advanced-export.md`
- `task-soft-breaks.md`: TODO, CommonMark soft breaks (#69); prior work on branch `cursor/soft-breaks-retest-ad7a`

## Moved to shipped on 2026-11-07
`task-localization.md` and `task-cjk-word-count.md` (0.4.4), `task-html-loss-guard.md`, `task-fix-duplicate-link-definitions.md` and `task-fix-feedback-link-definitions.md` (0.4.4), `task-marketplace-discoverability.md` (0.4.3), `task-qa-0.4.1-findings.md` (0.4.2).

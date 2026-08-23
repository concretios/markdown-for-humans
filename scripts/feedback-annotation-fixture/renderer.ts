import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import katex from 'katex';
import mermaid from 'mermaid';

import {
  layoutFeedbackAnnotations,
  type FeedbackAnnotationLayoutItem,
  type FeedbackAnnotationLayoutResult,
} from '../../src/webview/features/feedbackAnnotationLayout';
import { createFeedbackReviewController } from '../../src/webview/features/feedbackReview';
import { evaluateAnnotationScenario, evaluateAnnotationStress } from './verification.mjs';
import { evaluateRealControllerScenario } from './verification.mjs';

type FixtureTheme = 'light' | 'dark' | 'high-contrast';
type FixtureViewport = 'wide' | 'narrow';

interface AnnotationScenarioConfig {
  id: string;
  theme: FixtureTheme;
  viewport: FixtureViewport;
  zoom: number;
  reducedMotion: boolean;
}

interface AnnotationScenarioMetrics {
  maxTargetPinDriftCssPx: number;
  maxAsyncReflowDriftCssPx: number;
  reviewActivationMaxElementShiftCssPx: number;
  reviewActivationMaxTargetYShiftCssPx: number;
  reviewActivationScrollTopShiftCssPx: number;
  cardOverlapCount: number;
  minimumCardGapCssPx: number;
  maxConnectorEndpointErrorCssPx: number;
  panelScrollTop: number;
  panelOverflowY: string;
  horizontalOverflowCssPx: number;
  deactivationArtifactCount: number;
  initialRenderMs: number;
  interactionMs: number;
  scrollLayoutPassDelta: number;
  scrollGeometryReadDelta: number;
  scrollScheduledFrameDelta: number;
  scrollLongTaskDelta: number;
  scrollListenerRegistrations: number;
  expectedCardPlacementCount: number;
  cardPlacementCount: number;
  activeCardPlacementCount: number;
  hiddenCardConnectorCount: number;
  phantomEofOverflowCssPx: number;
  composerSavedPlacementCount: number;
  composerConnectorCount: number;
  composerSpacerCssPx: number;
  themeApplied: boolean;
  reducedMotionApplied: boolean;
  renderedWordCount: number;
  commentCount: number;
  denseClusterSize: number;
  initialViewportWidth: number;
  feedbackPalette: FeedbackPaletteMetrics;
}

interface FeedbackPaletteMetrics {
  theme: FixtureTheme;
  warningColor: string;
  accentColor: string;
  actionSurfaceColor: string;
  savedTokenColor: string;
  savedHighlightColor: string;
  activeMarkerColor: string;
  primaryActionColor: string;
  widgetBackgroundColor: string;
  primaryActionTextColor: string;
  contrastBorderColor: string;
  savedHighlightEdge: string;
  activeMarkerBorderColor: string;
  activeMarkerBorderWidthCssPx: number;
  primaryActionBorderColor: string;
  primaryActionBorderWidthCssPx: number;
}

interface AnnotationScenarioResult {
  config: AnnotationScenarioConfig;
  devicePixelRatio: number;
  metrics: AnnotationScenarioMetrics;
  passed: boolean;
  failures: string[];
}

interface AnnotationStressResult {
  metrics: {
    sourceLines: number;
    comments: number;
    measuredTargets: number;
    measuredCards: number;
    geometryReads: number;
    finalTargetReachable: boolean;
    layoutMs: number;
  };
  passed: boolean;
  failures: string[];
}

interface RealControllerResult {
  metrics: {
    maxScrollDriftCssPx: number;
    beforeScrollDriftCssPx: number;
    afterScrollDriftCssPx: number;
    visibleCardCount: number;
    activeCardCount: number;
    connectorCount: number;
    eofSpacerCssPx: number;
    markerFocusMoved: boolean;
    hiddenHighContrastTargetSuppressed: boolean;
    teardownArtifactCount: number;
  };
  passed: boolean;
  failures: string[];
}

interface AnnotationController {
  root: HTMLElement;
  prose: HTMLElement;
  layer: HTMLElement;
  markerLayer: HTMLElement;
  cardLayer: HTMLElement;
  connectorLayer: SVGSVGElement;
  spacer: HTMLElement;
  targets: Map<string, HTMLElement>;
  cards: Map<string, HTMLElement>;
  activeId: string;
  latestLayout: FeedbackAnnotationLayoutResult;
  layoutPasses: number;
  geometryReads: number;
  scheduledFrames: number;
  scrollListenerRegistrations: number;
  observer: ResizeObserver | null;
  scheduledFrame: number | null;
  performLayout: () => FeedbackAnnotationLayoutResult;
  scheduleLayout: () => void;
  activate: (id: string) => void;
  disconnect: () => void;
}

declare global {
  interface Window {
    fixtureReady?: boolean;
    runAnnotationScenario?: (config: AnnotationScenarioConfig) => Promise<AnnotationScenarioResult>;
    runAnnotationStress?: () => Promise<AnnotationStressResult>;
    runRealControllerScenario?: () => Promise<RealControllerResult>;
  }
}

const COMMENT_COUNT = 200;
const ACTIVE_COMMENT_ID = 'F100';
const COMPACT_CARD_HEIGHT = 56;
const ACTIVE_CARD_HEIGHT = 168;
const MARKER_DIAMETER = 27;
const MINIMUM_CARD_GAP = 8;
const CONNECTOR_THRESHOLD = 4;
const REVIEW_ACTIVATION_TARGET_IDS = ['F1', 'F9', 'F100', 'F200'] as const;
const WORD_BANK = [
  'review',
  'context',
  'reader',
  'clarity',
  'structure',
  'evidence',
  'example',
  'language',
  'design',
  'system',
  'workflow',
  'document',
  'annotation',
  'feedback',
  'precise',
  'source',
  'stable',
  'rendered',
  'accessible',
  'focused',
  'thoughtful',
  'section',
  'revision',
  'implementation',
];

let mermaidSequence = 0;

function nextAnimationFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

async function settleLayout(frames = 2): Promise<void> {
  for (let index = 0; index < frames; index += 1) await nextAnimationFrame();
}

function feedbackId(number: number): string {
  return `F${number}`;
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

function themeVariables(theme: FixtureTheme): Record<string, string> {
  if (theme === 'light') {
    return {
      background: '#ffffff',
      primaryColor: '#dbeafe',
      primaryBorderColor: '#2563eb',
      primaryTextColor: '#111827',
      lineColor: '#374151',
      secondaryColor: '#dcfce7',
      tertiaryColor: '#fef3c7',
    };
  }
  if (theme === 'dark') {
    return {
      background: '#17191d',
      primaryColor: '#1e3a5f',
      primaryBorderColor: '#75b7ff',
      primaryTextColor: '#f3f4f6',
      lineColor: '#d1d5db',
      secondaryColor: '#14532d',
      tertiaryColor: '#713f12',
    };
  }
  return {
    background: '#000000',
    primaryColor: '#000000',
    primaryBorderColor: '#ffffff',
    primaryTextColor: '#ffffff',
    lineColor: '#ffffff',
    secondaryColor: '#000000',
    tertiaryColor: '#000000',
  };
}

function configureTheme(config: AnnotationScenarioConfig): void {
  document.body.dataset.fixtureTheme = config.theme;
  document.body.dataset.fixtureViewport = config.viewport;
  document.body.dataset.fixtureReducedMotion = String(config.reducedMotion);
  document.body.classList.toggle('vscode-light', config.theme === 'light');
  document.body.classList.toggle('vscode-dark', config.theme === 'dark');
  document.body.classList.toggle('vscode-high-contrast', config.theme === 'high-contrast');
  document.body.classList.remove('vscode-high-contrast-light');
  document.body.classList.add('feedback-review-active');
}

function paragraphWords(paragraphIndex: number, count: number): string[] {
  return Array.from(
    { length: count },
    (_, wordIndex) => WORD_BANK[(paragraphIndex * 7 + wordIndex * 5) % WORD_BANK.length]!
  );
}

function registerTarget(
  targetMap: Map<string, HTMLElement>,
  element: HTMLElement,
  ids: readonly string[],
  kind: 'inline' | 'node'
): void {
  element.dataset.feedbackIds = ids.join(' ');
  element.classList.add(
    kind === 'inline' ? 'md4h-feedback-annotation-inline' : 'md4h-feedback-annotation-node'
  );
  for (const id of ids) targetMap.set(id, element);
}

async function renderRichNodes(): Promise<void> {
  const mermaidOutput = document.querySelector<HTMLElement>('[data-fixture-mermaid]');
  const katexOutput = document.querySelector<HTMLElement>('[data-fixture-katex]');
  const image = document.querySelector<HTMLImageElement>('[data-fixture-local-image]');
  if (!mermaidOutput || !katexOutput || !image) {
    throw new Error('The rich annotation fixture is incomplete.');
  }

  mermaidSequence += 1;
  const theme = document.body.dataset.fixtureTheme as FixtureTheme;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    themeVariables: themeVariables(theme),
    fontFamily: 'system-ui, sans-serif',
  });
  const diagram = await mermaid.render(
    `annotationFixture${mermaidSequence}`,
    'flowchart LR\n  Target[Rendered target] --> Pin[Document pin]\n  Pin --> Card[Feedback card]'
  );
  mermaidOutput.innerHTML = diagram.svg;
  diagram.bindFunctions?.(mermaidOutput);

  katex.render(String.raw`\int_0^1 x^2\,dx = \frac{1}{3}`, katexOutput, {
    displayMode: true,
    throwOnError: true,
    output: 'htmlAndMathml',
  });

  await document.fonts.ready;
  await image.decode();
  await settleLayout(2);
}

function buildLongDocument(config: AnnotationScenarioConfig): {
  shell: HTMLElement;
  editor: HTMLElement;
  prose: HTMLElement;
  primaryAction: HTMLButtonElement;
  targets: Map<string, HTMLElement>;
  asyncReflowTarget: HTMLElement;
  wordCount: number;
} {
  const fixtureRoot = document.querySelector<HTMLElement>('#fixture-root');
  if (!fixtureRoot) throw new Error('Fixture root is missing.');
  fixtureRoot.replaceChildren();
  window.scrollTo(0, 0);

  const shell = createElement('main');
  shell.id = 'fixture-shell';
  const toolbar = createElement('div');
  toolbar.id = 'fixture-toolbar';
  const toolbarLabel = createElement('span');
  toolbarLabel.textContent = `Feedback review alignment · ${config.theme} · ${Math.round(
    config.zoom * 100
  )}%${config.reducedMotion ? ' · reduced motion' : ''}`;
  const primaryAction = createElement('button', 'feedback-primary-button');
  primaryAction.type = 'button';
  primaryAction.dataset.fixturePrimaryFeedbackAction = '';
  primaryAction.textContent = 'Add feedback';
  toolbar.append(toolbarLabel, primaryAction);
  const editor = createElement('section', 'feedback-review-surface');
  editor.id = 'editor';
  const prose = createElement('article', 'markdown-editor');
  prose.setAttribute('aria-readonly', 'true');
  editor.append(prose);
  shell.append(toolbar, editor);
  fixtureRoot.append(shell);

  const targets = new Map<string, HTMLElement>();
  let wordCount = 0;

  const heading = createElement('h1');
  heading.textContent = 'A long rendered document for aligned feedback';
  prose.append(heading);

  const intro = createElement('p');
  intro.append('The reviewer can attach several notes to ');
  const repeated = createElement('span');
  repeated.textContent = 'the same repeated phrase';
  registerTarget(
    targets,
    repeated,
    Array.from({ length: 7 }, (_, index) => feedbackId(index + 1)),
    'inline'
  );
  intro.append(repeated, ' while preserving source order and a calm reading surface. ');
  const link = createElement('a');
  link.href = '#fixture-end';
  link.textContent = 'Linked and marked text remains exact.';
  registerTarget(targets, link, ['F8'], 'inline');
  intro.append(link);
  prose.append(intro);
  wordCount += 25;

  const code = createElement('pre');
  const codeContent = createElement('code');
  codeContent.textContent =
    'function alignFeedback(targetY, cardTop) {\n  return Math.abs(targetY - cardTop);\n}';
  code.append(codeContent);
  registerTarget(targets, code, ['F9'], 'node');
  prose.append(code);

  const table = createElement('table');
  table.innerHTML =
    '<thead><tr><th>Invariant</th><th>Budget</th></tr></thead>' +
    '<tbody><tr><td>Target drift</td><td>2 CSS px</td></tr>' +
    '<tr><td>Card gap</td><td>8 CSS px</td></tr></tbody>';
  registerTarget(targets, table, ['F10'], 'node');
  prose.append(table);

  const richGrid = createElement('div', 'fixture-rich-grid');
  const localImage = createElement('div', 'fixture-nodeview');
  const image = createElement('img', 'fixture-local-image');
  image.dataset.fixtureLocalImage = '';
  image.src = './assets/local-image.svg';
  image.alt = 'Local rendered landscape';
  localImage.append(image);
  registerTarget(targets, localImage, ['F11'], 'node');

  const mermaidOutput = createElement('div', 'fixture-nodeview');
  mermaidOutput.dataset.fixtureMermaid = '';
  registerTarget(targets, mermaidOutput, ['F12'], 'node');

  const screenshot = createElement('figure', 'fixture-screenshot');
  const screenshotImage = createElement('img');
  screenshotImage.src = './assets/local-image.svg';
  screenshotImage.alt = 'Persisted screenshot feedback preview';
  const screenshotCaption = createElement('figcaption');
  screenshotCaption.textContent = 'Flattened screenshot feedback preview';
  screenshot.append(screenshotImage, screenshotCaption);
  registerTarget(targets, screenshot, ['F13'], 'node');

  const katexOutput = createElement('div', 'fixture-nodeview');
  katexOutput.dataset.fixtureKatex = '';
  registerTarget(targets, katexOutput, ['F14'], 'node');
  richGrid.append(localImage, mermaidOutput, screenshot, katexOutput);
  prose.append(richGrid);

  const multiBlock = createElement('section');
  const quote = createElement('blockquote');
  quote.textContent = 'A multi-block target uses an honest containing bracket.';
  const afterQuote = createElement('p');
  afterQuote.textContent = 'Its pin and card stay associated while the page scrolls.';
  multiBlock.append(quote, afterQuote);
  registerTarget(targets, multiBlock, ['F15'], 'node');
  prose.append(multiBlock);
  wordCount += 18;

  let asyncReflowTarget: HTMLElement | null = null;
  for (let paragraphIndex = 0; paragraphIndex < 240; paragraphIndex += 1) {
    const paragraph = createElement('p');
    const words = paragraphWords(paragraphIndex, 18);
    wordCount += words.length;
    if (paragraphIndex < 184) {
      const target = createElement('span');
      target.textContent = words.slice(0, 4).join(' ');
      registerTarget(targets, target, [feedbackId(paragraphIndex + 16)], 'inline');
      paragraph.append(target, ` ${words.slice(4).join(' ')}.`);
    } else {
      paragraph.textContent = `${words.join(' ')}.`;
    }
    if (paragraphIndex === 92) {
      paragraph.dataset.asyncReflowTarget = '';
      asyncReflowTarget = paragraph;
    }
    prose.append(paragraph);
  }

  const endParagraph = createElement('p');
  endParagraph.id = 'fixture-end';
  endParagraph.append('The final source target remains reachable at the end of the document: ');
  const finalTarget = createElement('strong');
  finalTarget.textContent = 'sealed feedback complete';
  registerTarget(targets, finalTarget, ['F200'], 'inline');
  endParagraph.append(finalTarget, '.');
  prose.append(endParagraph);
  wordCount += 15;

  if (targets.size !== COMMENT_COUNT || !asyncReflowTarget) {
    throw new Error(
      `Expected ${COMMENT_COUNT} targets and an async reflow target, found ${targets.size}.`
    );
  }
  return { shell, editor, prose, primaryAction, targets, asyncReflowTarget, wordCount };
}

function createCard(id: string, active: boolean): HTMLElement {
  const card = createElement('article', 'feedback-comment-card');
  card.dataset.feedbackCardId = id;
  card.dataset.feedbackCardState = active ? 'active' : 'compact';
  card.tabIndex = active ? 0 : -1;
  card.innerHTML =
    `<h3 class="feedback-card-title">${id}</h3>` +
    `<p class="feedback-card-preview">Clarify this rendered passage and preserve its exact source context.</p>` +
    `<div class="fixture-card-detail"><strong>Selected text</strong>` +
    `<p>Clarify this rendered passage and preserve its exact source context for the implementing agent.</p>` +
    `<code>docs/review.md:120-124</code></div>`;
  return card;
}

function installAnnotationController(
  editor: HTMLElement,
  prose: HTMLElement,
  targets: Map<string, HTMLElement>,
  asyncReflowTarget: HTMLElement
): AnnotationController {
  const layer = createElement('aside', 'feedback-comment-rail feedback-annotation-layer expanded');
  layer.dataset.feedbackAnnotationLayer = '';
  layer.setAttribute('aria-label', 'Feedback comments');
  const connectorLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  connectorLayer.classList.add('feedback-connectors');
  connectorLayer.setAttribute('aria-hidden', 'true');
  const markerLayer = createElement('div', 'feedback-marker-layer');
  const cardLayer = createElement('div', 'feedback-card-layer');
  cardLayer.dataset.feedbackCardLayer = '';
  layer.append(connectorLayer, markerLayer, cardLayer);
  const spacer = createElement('div', 'feedback-annotation-spacer');
  spacer.dataset.feedbackAnnotationSpacer = '';
  editor.append(layer, spacer);

  const cards = new Map<string, HTMLElement>();
  for (let number = 1; number <= COMMENT_COUNT; number += 1) {
    const id = feedbackId(number);
    const card = createCard(id, id === ACTIVE_COMMENT_ID);
    cards.set(id, card);
    cardLayer.append(card);
  }

  let activeId = ACTIVE_COMMENT_ID;
  let latestLayout: FeedbackAnnotationLayoutResult = {
    placements: [],
    clusters: [],
    requiredBottom: 0,
    eofOverflow: 0,
  };
  let layoutPasses = 0;
  let geometryReads = 0;
  let scheduledFrames = 0;
  let scheduledFrame: number | null = null;
  let measuring = false;
  let observer: ResizeObserver | null = null;

  const readRect = (element: Element): DOMRect => {
    if (measuring) geometryReads += 1;
    return element.getBoundingClientRect();
  };

  const performLayout = (): FeedbackAnnotationLayoutResult => {
    measuring = true;
    try {
      const editorBounds = readRect(editor);
      const proseBounds = readRect(prose);
      const firstCard = cards.get(activeId);
      if (!firstCard) throw new Error(`Active fixture card is missing: ${activeId}`);
      const cardBounds = readRect(firstCard);
      const cardWidth = Math.max(1, cardBounds.width);
      const cardLeft = cardBounds.left - editorBounds.left;
      const narrow = editorBounds.width <= 840;
      const items: FeedbackAnnotationLayoutItem[] = [];

      for (let number = 1; number <= COMMENT_COUNT; number += 1) {
        const id = feedbackId(number);
        const target = targets.get(id);
        const card = cards.get(id);
        if (!target || !card) throw new Error(`Fixture annotation is missing ${id}.`);
        const targetBounds = readRect(target);
        readRect(card);
        const targetStart = targetBounds.top - editorBounds.top;
        const targetEnd = Math.max(targetStart + 1, targetBounds.bottom - editorBounds.top);
        items.push({
          id,
          sourceOrder: number - 1,
          targetX: targetBounds.right - editorBounds.left,
          targetY: targetStart + (targetEnd - targetStart) / 2,
          targetStart,
          targetEnd,
          compactHeight: COMPACT_CARD_HEIGHT,
          expandedHeight: ACTIVE_CARD_HEIGHT,
          cardVisible: !narrow || id === activeId,
        });
      }

      latestLayout = layoutFeedbackAnnotations({
        items,
        activeId,
        topBound: 8,
        documentBottom: Math.max(8, proseBounds.bottom - editorBounds.top),
        minimumGap: MINIMUM_CARD_GAP,
        markerDiameter: MARKER_DIAMETER,
        connectorThreshold: CONNECTOR_THRESHOLD,
        cardLeft,
        cardWidth,
      });
      layoutPasses += 1;

      markerLayer.replaceChildren();
      for (const cluster of latestLayout.clusters) {
        const marker = createElement('button', 'feedback-marker');
        marker.type = 'button';
        marker.dataset.feedbackClusterId = cluster.id;
        marker.dataset.feedbackIds = cluster.memberIds.join(' ');
        marker.classList.toggle('active', cluster.memberIds.includes(activeId));
        // Match FeedbackReview: CSS translateY(-50%) centers the fixed-diameter
        // marker on this document-space target coordinate.
        marker.style.top = `${cluster.targetY}px`;
        marker.textContent = cluster.memberIds.length > 1 ? String(cluster.memberIds.length) : '';
        marker.setAttribute(
          'aria-label',
          cluster.memberIds.length > 1
            ? `${cluster.memberIds.length} comments: ${cluster.memberIds.join(', ')}`
            : `${cluster.memberIds[0]} feedback comment`
        );
        markerLayer.append(marker);
      }

      connectorLayer.replaceChildren();
      const svgHeight = Math.max(
        proseBounds.bottom - editorBounds.top,
        latestLayout.requiredBottom
      );
      connectorLayer.setAttribute('width', String(editorBounds.width));
      connectorLayer.setAttribute('height', String(svgHeight));
      connectorLayer.setAttribute('viewBox', `0 0 ${editorBounds.width} ${svgHeight}`);
      for (const placement of latestLayout.placements) {
        const card = cards.get(placement.id)!;
        card.style.top = `${placement.top}px`;
        if (!placement.connector) continue;
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.dataset.feedbackConnectorId = placement.id;
        path.setAttribute('d', placement.connector.path);
        connectorLayer.append(path);
      }
      spacer.style.setProperty('--fixture-eof-space', `${latestLayout.eofOverflow}px`);
      return latestLayout;
    } finally {
      measuring = false;
    }
  };

  const scheduleLayout = (): void => {
    if (scheduledFrame !== null) return;
    scheduledFrames += 1;
    scheduledFrame = requestAnimationFrame(() => {
      scheduledFrame = null;
      performLayout();
    });
  };

  const activate = (id: string): void => {
    const previous = cards.get(activeId);
    const next = cards.get(id);
    if (!next) throw new Error(`Cannot activate missing fixture card ${id}.`);
    if (previous) {
      previous.dataset.feedbackCardState = 'compact';
      previous.tabIndex = -1;
    }
    next.dataset.feedbackCardState = 'active';
    next.tabIndex = 0;
    activeId = id;
    performLayout();
  };

  const controller: AnnotationController = {
    root: editor,
    prose,
    layer,
    markerLayer,
    cardLayer,
    connectorLayer,
    spacer,
    targets,
    cards,
    get activeId() {
      return activeId;
    },
    get latestLayout() {
      return latestLayout;
    },
    get layoutPasses() {
      return layoutPasses;
    },
    get geometryReads() {
      return geometryReads;
    },
    get scheduledFrames() {
      return scheduledFrames;
    },
    scrollListenerRegistrations: 0,
    get observer() {
      return observer;
    },
    get scheduledFrame() {
      return scheduledFrame;
    },
    performLayout,
    scheduleLayout,
    activate,
    disconnect: () => {
      observer?.disconnect();
      observer = null;
      if (scheduledFrame !== null) cancelAnimationFrame(scheduledFrame);
      scheduledFrame = null;
    },
  };

  if (typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(() => scheduleLayout());
    observer.observe(prose);
    observer.observe(asyncReflowTarget);
  }
  return controller;
}

function maximumTargetPinDrift(controller: AnnotationController): number {
  const editorBounds = controller.root.getBoundingClientRect();
  let maximum = 0;
  for (const cluster of controller.latestLayout.clusters) {
    const marker = controller.markerLayer.querySelector<HTMLElement>(
      `[data-feedback-cluster-id="${CSS.escape(cluster.id)}"]`
    );
    if (!marker) return Number.POSITIVE_INFINITY;
    const markerBounds = marker.getBoundingClientRect();
    const expectedViewportY = editorBounds.top + cluster.targetY;
    const markerCenter = markerBounds.top + markerBounds.height / 2;
    maximum = Math.max(maximum, Math.abs(markerCenter - expectedViewportY));
  }
  return maximum;
}

function cardPackingMetrics(layout: FeedbackAnnotationLayoutResult): {
  overlapCount: number;
  minimumGap: number;
} {
  let overlapCount = 0;
  let minimumGap = Number.POSITIVE_INFINITY;
  for (let index = 1; index < layout.placements.length; index += 1) {
    const previous = layout.placements[index - 1]!;
    const current = layout.placements[index]!;
    const gap = current.top - previous.bottom;
    minimumGap = Math.min(minimumGap, gap);
    if (gap < 0) overlapCount += 1;
  }
  return {
    overlapCount,
    minimumGap: Number.isFinite(minimumGap) ? minimumGap : MINIMUM_CARD_GAP,
  };
}

function maximumConnectorEndpointError(controller: AnnotationController): number {
  let maximum = 0;
  for (const placement of controller.latestLayout.placements) {
    if (!placement.connector) continue;
    const path = controller.connectorLayer.querySelector<SVGPathElement>(
      `[data-feedback-connector-id="${CSS.escape(placement.id)}"]`
    );
    if (!path) return Number.POSITIVE_INFINITY;
    const start = path.getPointAtLength(0);
    const end = path.getPointAtLength(path.getTotalLength());
    maximum = Math.max(
      maximum,
      Math.hypot(start.x - placement.connector.start.x, start.y - placement.connector.start.y),
      Math.hypot(end.x - placement.connector.attachment.x, end.y - placement.connector.attachment.y)
    );
  }
  return maximum;
}

function measureComposerOnlyLayout(controller: AnnotationController): {
  savedPlacementCount: number;
  connectorCount: number;
  spacerCssPx: number;
} {
  const editorBounds = controller.root.getBoundingClientRect();
  const proseBounds = controller.prose.getBoundingClientRect();
  const documentBottom = Math.max(8, proseBounds.bottom - editorBounds.top);
  const activeCard = controller.cards.get(controller.activeId);
  const activeBounds = activeCard?.getBoundingClientRect();
  const cardWidth = Math.max(1, activeBounds?.width ?? 320);
  const cardLeft = (activeBounds?.left ?? editorBounds.right - 364) - editorBounds.left;
  const items: FeedbackAnnotationLayoutItem[] = [];

  for (let number = 1; number <= COMMENT_COUNT; number += 1) {
    const id = feedbackId(number);
    const target = controller.targets.get(id);
    if (!target) throw new Error(`Composer fixture target is missing ${id}.`);
    const bounds = target.getBoundingClientRect();
    const targetStart = bounds.top - editorBounds.top;
    const targetEnd = Math.max(targetStart + 1, bounds.bottom - editorBounds.top);
    items.push({
      id,
      sourceOrder: number - 1,
      targetX: bounds.right - editorBounds.left,
      targetY: targetStart + (targetEnd - targetStart) / 2,
      targetStart,
      targetEnd,
      compactHeight: COMPACT_CARD_HEIGHT,
      expandedHeight: ACTIVE_CARD_HEIGHT,
      cardVisible: false,
    });
  }

  const layout = layoutFeedbackAnnotations({
    items,
    topBound: 8,
    documentBottom,
    minimumGap: MINIMUM_CARD_GAP,
    markerDiameter: MARKER_DIAMETER,
    connectorThreshold: CONNECTOR_THRESHOLD,
    cardLeft,
    cardWidth,
  });
  const composerTarget = items[99]!;
  const composer = createElement('form', 'feedback-composer');
  composer.innerHTML =
    '<h2 class="feedback-composer-title">What should change?</h2>' +
    '<label class="feedback-composer-label">Feedback<textarea rows="4"></textarea></label>';
  composer.style.top = `${Math.max(8, composerTarget.targetY - 24)}px`;
  composer.style.left = `${cardLeft}px`;
  composer.style.right = 'auto';
  composer.style.width = `${cardWidth}px`;
  for (const card of controller.cards.values()) card.hidden = true;
  controller.cardLayer.append(composer);
  const composerBottom =
    Number.parseFloat(composer.style.top) + (composer.getBoundingClientRect().height || 180);
  const spacerCssPx = Math.max(0, Math.max(layout.requiredBottom, composerBottom) - documentBottom);
  composer.remove();
  for (const card of controller.cards.values()) card.hidden = false;

  return {
    savedPlacementCount: layout.placements.length,
    connectorCount: layout.placements.filter(placement => placement.connector !== null).length,
    spacerCssPx,
  };
}

function countDeactivationArtifacts(root: HTMLElement): number {
  return root.querySelectorAll(
    [
      '.feedback-annotation-layer',
      '.feedback-annotation-spacer',
      '.feedback-marker',
      '.feedback-comment-card',
      '.feedback-connectors',
      '.md4h-feedback-annotation-inline',
      '.md4h-feedback-annotation-node',
      '.md4h-feedback-highlight',
      '.md4h-feedback-block-target',
    ].join(',')
  ).length;
}

function deactivateAnnotations(controller: AnnotationController): void {
  controller.disconnect();
  controller.layer.remove();
  controller.spacer.remove();
  controller.root.classList.remove('feedback-review-surface');
  document.body.classList.remove('feedback-review-active');
  for (const target of new Set(controller.targets.values())) {
    target.classList.remove(
      'md4h-feedback-annotation-inline',
      'md4h-feedback-annotation-node',
      'is-feedback-active'
    );
    delete target.dataset.feedbackIds;
  }
}

function themeWasApplied(
  config: AnnotationScenarioConfig,
  controller: AnnotationController
): boolean {
  const marker = controller.markerLayer.querySelector<HTMLElement>('.feedback-marker');
  if (!marker) return false;
  if (config.theme === 'high-contrast') {
    return (
      document.body.classList.contains('vscode-high-contrast') &&
      Number.parseFloat(getComputedStyle(marker).borderTopWidth) >= 2
    );
  }
  return getComputedStyle(document.body).colorScheme.includes(config.theme);
}

function reducedMotionWasApplied(
  config: AnnotationScenarioConfig,
  controller: AnnotationController
): boolean {
  if (!config.reducedMotion) return true;
  const marker = controller.markerLayer.querySelector<HTMLElement>('.feedback-marker');
  if (!marker) return false;
  const style = getComputedStyle(marker);
  return style.transitionDuration === '0s' && style.animationName === 'none';
}

function resolveBackgroundColor(value: string): string {
  const probe = createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.position = 'absolute';
  probe.style.pointerEvents = 'none';
  probe.style.backgroundColor = value;
  document.body.append(probe);
  const resolved = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return resolved;
}

function measureFeedbackPalette(
  config: AnnotationScenarioConfig,
  controller: AnnotationController,
  targets: ReadonlyMap<string, HTMLElement>,
  primaryAction: HTMLButtonElement
): FeedbackPaletteMetrics {
  const savedTarget = targets.get('F16');
  const activeMarker = controller.markerLayer.querySelector<HTMLElement>('.feedback-marker.active');
  if (!savedTarget || !activeMarker) {
    throw new Error('Feedback palette targets are missing from the annotation fixture.');
  }

  const savedStyle = getComputedStyle(savedTarget);
  const activeMarkerStyle = getComputedStyle(activeMarker);
  const primaryActionStyle = getComputedStyle(primaryAction);
  return {
    theme: config.theme,
    warningColor: resolveBackgroundColor('var(--vscode-editorWarning-foreground)'),
    accentColor: resolveBackgroundColor('var(--md4h-feedback-accent)'),
    actionSurfaceColor: resolveBackgroundColor('var(--md4h-feedback-action-surface)'),
    savedTokenColor: resolveBackgroundColor('var(--md4h-feedback-highlight-saved)'),
    savedHighlightColor: savedStyle.backgroundColor,
    activeMarkerColor: activeMarkerStyle.backgroundColor,
    primaryActionColor: primaryActionStyle.backgroundColor,
    widgetBackgroundColor: resolveBackgroundColor('var(--vscode-editorWidget-background)'),
    primaryActionTextColor: primaryActionStyle.color,
    contrastBorderColor: resolveBackgroundColor('var(--vscode-contrastActiveBorder)'),
    savedHighlightEdge: savedStyle.boxShadow,
    activeMarkerBorderColor: activeMarkerStyle.borderTopColor,
    activeMarkerBorderWidthCssPx: Number.parseFloat(activeMarkerStyle.borderTopWidth),
    primaryActionBorderColor: primaryActionStyle.borderTopColor,
    primaryActionBorderWidthCssPx: Number.parseFloat(primaryActionStyle.borderTopWidth),
  };
}

interface ReviewActivationGeometrySnapshot {
  elementCoordinates: number[];
  targetYs: number[];
  scrollTop: number;
}

interface ReviewActivationGeometryMetrics {
  reviewActivationMaxElementShiftCssPx: number;
  reviewActivationMaxTargetYShiftCssPx: number;
  reviewActivationScrollTopShiftCssPx: number;
}

function rectangleCoordinates(rectangle: DOMRect): number[] {
  return [
    rectangle.left,
    rectangle.top,
    rectangle.right,
    rectangle.bottom,
    rectangle.width,
    rectangle.height,
  ];
}

function maximumCoordinateShift(before: readonly number[], after: readonly number[]): number {
  if (before.length !== after.length) return Number.POSITIVE_INFINITY;
  return before.reduce(
    (maximum, coordinate, index) =>
      Math.max(maximum, Math.abs(coordinate - (after[index] ?? Number.POSITIVE_INFINITY))),
    0
  );
}

function readReviewActivationGeometry(
  editor: HTMLElement,
  prose: HTMLElement,
  targets: ReadonlyMap<string, HTMLElement>
): ReviewActivationGeometrySnapshot {
  const sampledTargets = REVIEW_ACTIVATION_TARGET_IDS.map(id => {
    const target = targets.get(id);
    if (!target) throw new Error(`Review activation geometry target is missing: ${id}.`);
    return target;
  });
  const editorBounds = editor.getBoundingClientRect();
  const targetBounds = sampledTargets.map(target => target.getBoundingClientRect());
  return {
    elementCoordinates: [editor, prose, ...sampledTargets].flatMap(element =>
      rectangleCoordinates(element.getBoundingClientRect())
    ),
    targetYs: targetBounds.map(bounds => bounds.top - editorBounds.top + bounds.height / 2),
    scrollTop: document.scrollingElement?.scrollTop ?? window.scrollY,
  };
}

/**
 * Verifies that the Feedback-only perimeter and target accents are paint-only.
 * DOM rectangles and scroll positions are CSS-pixel values, even when Electron
 * applies a non-default page zoom and reports a larger devicePixelRatio.
 */
async function measureReviewActivationGeometry(
  editor: HTMLElement,
  prose: HTMLElement,
  targets: ReadonlyMap<string, HTMLElement>
): Promise<ReviewActivationGeometryMetrics> {
  document.body.classList.remove('feedback-review-active');
  try {
    await settleLayout(2);
    const maximumScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    window.scrollTo(0, Math.min(640, maximumScroll / 2));
    await settleLayout(2);
    const before = readReviewActivationGeometry(editor, prose, targets);

    document.body.classList.add('feedback-review-active');
    await settleLayout(2);
    const after = readReviewActivationGeometry(editor, prose, targets);

    return {
      reviewActivationMaxElementShiftCssPx: maximumCoordinateShift(
        before.elementCoordinates,
        after.elementCoordinates
      ),
      reviewActivationMaxTargetYShiftCssPx: maximumCoordinateShift(before.targetYs, after.targetYs),
      reviewActivationScrollTopShiftCssPx: Math.abs(after.scrollTop - before.scrollTop),
    };
  } finally {
    document.body.classList.add('feedback-review-active');
    window.scrollTo(0, 0);
    await settleLayout(2);
  }
}

async function runAnnotationScenario(
  config: AnnotationScenarioConfig
): Promise<AnnotationScenarioResult> {
  configureTheme(config);
  const { shell, editor, prose, primaryAction, targets, asyncReflowTarget, wordCount } =
    buildLongDocument(config);
  await renderRichNodes();
  const reviewActivationGeometry = await measureReviewActivationGeometry(editor, prose, targets);

  const initialRenderStart = performance.now();
  const controller = installAnnotationController(editor, prose, targets, asyncReflowTarget);
  controller.performLayout();
  const initialRenderMs = performance.now() - initialRenderStart;
  await settleLayout(3);
  // ResizeObserver may deliver an initial notification. Establish the scroll
  // baseline only after that legitimate layout work has settled.
  const initialDrift = maximumTargetPinDrift(controller);
  const themeApplied = themeWasApplied(config, controller);
  const reducedMotionApplied = reducedMotionWasApplied(config, controller);

  const interactionStart = performance.now();
  controller.activate('F150');
  const interactionMs = performance.now() - interactionStart;
  const packing = cardPackingMetrics(controller.latestLayout);
  const connectorError = maximumConnectorEndpointError(controller);

  let longTaskCount = 0;
  let longTaskObserver: PerformanceObserver | null = null;
  if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
    longTaskObserver = new PerformanceObserver(entries => {
      longTaskCount += entries.getEntries().length;
    });
    longTaskObserver.observe({ entryTypes: ['longtask'] });
  }
  const beforeScroll = {
    layouts: controller.layoutPasses,
    reads: controller.geometryReads,
    frames: controller.scheduledFrames,
    longTasks: longTaskCount,
  };
  const maximumScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  for (const proportion of [0.2, 0.75, 0.35, 0.9, 0.62]) {
    window.scrollTo(0, maximumScroll * proportion);
  }
  await settleLayout(3);
  const driftAfterScroll = maximumTargetPinDrift(controller);
  const afterScroll = {
    layouts: controller.layoutPasses,
    reads: controller.geometryReads,
    frames: controller.scheduledFrames,
    longTasks: longTaskCount,
  };
  longTaskObserver?.disconnect();

  asyncReflowTarget.style.paddingBottom = '96px';
  asyncReflowTarget.append(
    ' Asynchronous rendered content expanded after fonts and diagrams settled.'
  );
  controller.scheduleLayout();
  await settleLayout(4);
  const driftAfterAsyncReflow = maximumTargetPinDrift(controller);
  const composerOnly = measureComposerOnlyLayout(controller);

  const panelOverflowY = getComputedStyle(controller.cardLayer).overflowY || 'visible';
  const narrow = controller.root.getBoundingClientRect().width <= 840;
  const expectedCardPlacementCount = narrow ? 1 : COMMENT_COUNT;
  const activeCardPlacementCount = controller.latestLayout.placements.filter(
    placement => placement.active
  ).length;
  const hiddenCardConnectorCount = controller.latestLayout.placements.filter(
    placement => placement.id !== controller.activeId && placement.connector !== null
  ).length;
  const horizontalOverflowCssPx = Math.max(
    0,
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  const denseClusterSize = Math.max(
    ...controller.latestLayout.clusters.map(cluster => cluster.memberIds.length)
  );
  const feedbackPalette = measureFeedbackPalette(config, controller, targets, primaryAction);
  const beforeDeactivateHtml = shell.outerHTML;
  deactivateAnnotations(controller);
  const deactivationArtifactCount =
    countDeactivationArtifacts(shell) +
    (document.body.classList.contains('feedback-review-active') ? 1 : 0);

  const metrics: AnnotationScenarioMetrics = {
    maxTargetPinDriftCssPx: Math.max(initialDrift, driftAfterScroll),
    maxAsyncReflowDriftCssPx: driftAfterAsyncReflow,
    ...reviewActivationGeometry,
    cardOverlapCount: packing.overlapCount,
    minimumCardGapCssPx: packing.minimumGap,
    maxConnectorEndpointErrorCssPx: connectorError,
    panelScrollTop: controller.cardLayer.scrollTop,
    panelOverflowY,
    horizontalOverflowCssPx,
    deactivationArtifactCount,
    initialRenderMs,
    interactionMs,
    scrollLayoutPassDelta: afterScroll.layouts - beforeScroll.layouts,
    scrollGeometryReadDelta: afterScroll.reads - beforeScroll.reads,
    scrollScheduledFrameDelta: afterScroll.frames - beforeScroll.frames,
    scrollLongTaskDelta: afterScroll.longTasks - beforeScroll.longTasks,
    scrollListenerRegistrations: controller.scrollListenerRegistrations,
    expectedCardPlacementCount,
    cardPlacementCount: controller.latestLayout.placements.length,
    activeCardPlacementCount,
    hiddenCardConnectorCount: narrow ? hiddenCardConnectorCount : 0,
    phantomEofOverflowCssPx: narrow ? controller.latestLayout.eofOverflow : 0,
    composerSavedPlacementCount: composerOnly.savedPlacementCount,
    composerConnectorCount: composerOnly.connectorCount,
    composerSpacerCssPx: composerOnly.spacerCssPx,
    themeApplied,
    reducedMotionApplied,
    renderedWordCount: wordCount,
    commentCount: COMMENT_COUNT,
    denseClusterSize,
    initialViewportWidth: window.innerWidth,
    feedbackPalette,
  };
  const verification = evaluateAnnotationScenario(metrics);
  if (!themeApplied) verification.failures.push(`theme styles did not apply for ${config.theme}`);
  if (!reducedMotionApplied)
    verification.failures.push('reduced-motion styles did not disable motion');
  if (wordCount < 3_000) {
    verification.failures.push(`fixture rendered ${wordCount} words (minimum 3000)`);
  }
  if (denseClusterSize < 5) {
    verification.failures.push(
      `largest dense cluster contained ${denseClusterSize} comments (minimum 5)`
    );
  }
  if (config.viewport === 'narrow' && window.innerWidth > 840) {
    verification.failures.push(`narrow viewport was ${window.innerWidth} CSS px (maximum 840)`);
  }
  if (config.viewport === 'wide' && window.innerWidth <= 840) {
    verification.failures.push(`wide viewport was ${window.innerWidth} CSS px (must exceed 840)`);
  }
  verification.passed = verification.failures.length === 0;

  if (!verification.passed) {
    // Keep the useful pre-deactivation view for the main process screenshot and
    // HTML artifact while still measuring teardown against the real DOM first.
    shell.outerHTML = beforeDeactivateHtml;
    document.body.dataset.fixtureFailure = config.id;
  } else {
    delete document.body.dataset.fixtureFailure;
  }

  return {
    config,
    devicePixelRatio: window.devicePixelRatio,
    metrics,
    passed: verification.passed,
    failures: verification.failures,
  };
}

async function runAnnotationStress(): Promise<AnnotationStressResult> {
  const fixtureRoot = document.querySelector<HTMLElement>('#fixture-root');
  if (!fixtureRoot) throw new Error('Fixture root is missing.');
  fixtureRoot.replaceChildren();
  window.scrollTo(0, 0);

  const editor = createElement('main');
  editor.id = 'stress-editor';
  editor.style.position = 'relative';
  editor.style.width = '1000px';
  editor.style.maxWidth = '100%';
  const prose = createElement('div');
  const layer = createElement('aside');
  layer.style.position = 'absolute';
  layer.style.inset = '0';
  layer.style.pointerEvents = 'none';
  const cardLayer = createElement('div');
  layer.append(cardLayer);
  editor.append(prose, layer);
  fixtureRoot.append(editor);

  const sourceLines = 10_000;
  const commentCount = 500;
  const targets: HTMLElement[] = [];
  const cards: HTMLElement[] = [];
  const fragment = document.createDocumentFragment();
  for (let line = 1; line <= sourceLines; line += 1) {
    const lineElement = createElement('div');
    lineElement.style.height = '3px';
    lineElement.dataset.sourceLine = String(line);
    if (line % 20 === 0) {
      lineElement.dataset.stressTarget = feedbackId(targets.length + 1);
      targets.push(lineElement);
    }
    fragment.append(lineElement);
  }
  prose.append(fragment);
  for (let index = 0; index < commentCount; index += 1) {
    const card = createElement('div');
    card.style.position = 'absolute';
    card.style.right = '40px';
    card.style.width = '220px';
    card.style.height = '16px';
    card.dataset.stressCard = feedbackId(index + 1);
    cardLayer.append(card);
    cards.push(card);
  }

  let geometryReads = 0;
  const measuredRect = (element: Element): DOMRect => {
    geometryReads += 1;
    return element.getBoundingClientRect();
  };
  const layoutStart = performance.now();
  const editorBounds = measuredRect(editor);
  const items: FeedbackAnnotationLayoutItem[] = targets.map((target, index) => {
    const targetBounds = measuredRect(target);
    measuredRect(cards[index]!);
    const targetStart = targetBounds.top - editorBounds.top;
    const targetEnd = Math.max(targetStart + 1, targetBounds.bottom - editorBounds.top);
    return {
      id: feedbackId(index + 1),
      sourceOrder: index,
      targetX: targetBounds.right - editorBounds.left,
      targetY: targetStart + (targetEnd - targetStart) / 2,
      targetStart,
      targetEnd,
      compactHeight: 16,
      expandedHeight: 32,
    };
  });
  const layout = layoutFeedbackAnnotations({
    items,
    activeId: 'F250',
    topBound: 0,
    documentBottom: prose.offsetHeight,
    minimumGap: MINIMUM_CARD_GAP,
    markerDiameter: MARKER_DIAMETER,
    connectorThreshold: CONNECTOR_THRESHOLD,
    cardLeft: Math.max(0, editorBounds.width - 260),
    cardWidth: 220,
  });
  for (const placement of layout.placements) {
    cards[placement.sourceOrder]!.style.top = `${placement.top}px`;
  }
  const layoutMs = performance.now() - layoutStart;

  const finalTarget = targets.at(-1)!;
  finalTarget.scrollIntoView({ block: 'center' });
  await settleLayout(2);
  const finalBounds = finalTarget.getBoundingClientRect();
  const finalTargetReachable = finalBounds.bottom > 0 && finalBounds.top < window.innerHeight;

  const metrics = {
    sourceLines,
    comments: commentCount,
    measuredTargets: targets.length,
    measuredCards: cards.length,
    geometryReads,
    finalTargetReachable,
    layoutMs,
  };
  const verification = evaluateAnnotationStress(metrics);
  if (verification.passed) fixtureRoot.replaceChildren();
  return { metrics, ...verification };
}

function realControllerTargetCenter(target: HTMLElement): number {
  const bounds = target.getBoundingClientRect();
  return bounds.top + bounds.height / 2;
}

function realControllerMarkerCenter(marker: HTMLElement): number {
  const bounds = marker.getBoundingClientRect();
  return bounds.top + bounds.height / 2;
}

async function runRealControllerScenario(): Promise<RealControllerResult> {
  const config: AnnotationScenarioConfig = {
    id: 'real-controller-narrow-high-contrast',
    theme: 'high-contrast',
    viewport: 'narrow',
    zoom: 1,
    reducedMotion: false,
  };
  configureTheme(config);
  const fixtureRoot = document.querySelector<HTMLElement>('#fixture-root');
  if (!fixtureRoot) throw new Error('Fixture root is missing.');
  fixtureRoot.replaceChildren();
  window.scrollTo(0, 0);

  const shell = createElement('main');
  shell.id = 'fixture-shell';
  const toolbar = createElement('div');
  toolbar.id = 'fixture-toolbar';
  toolbar.classList.add('formatting-toolbar');
  toolbar.textContent = 'Actual Feedback controller · narrow high contrast';
  const editorContainer = createElement('section');
  editorContainer.id = 'editor';
  const editorMount = createElement('article', 'markdown-editor');
  editorContainer.append(editorMount);
  shell.append(toolbar, editorContainer);
  fixtureRoot.append(shell);

  const paragraphs = Array.from({ length: 120 }, (_, index) => {
    const words = paragraphWords(index, 18).join(' ');
    return `<p>Controller paragraph ${index + 1}: ${words}.</p>`;
  }).join('');
  const editor = new Editor({
    element: editorMount,
    extensions: [StarterKit],
    content: `<h1>Actual controller integration</h1>${paragraphs}`,
  });
  const items = [
    {
      id: 'F1',
      kind: 'text' as const,
      startOrdinal: 0,
      endOrdinal: 0,
      startLine: 1,
      endLine: 1,
      focus: 'Actual controller integration',
      feedback: 'Clarify the opening.',
    },
    {
      id: 'F2',
      kind: 'text' as const,
      startOrdinal: 55,
      endOrdinal: 55,
      startLine: 57,
      endLine: 57,
      focus: 'Controller paragraph 55',
      feedback: 'Tighten the middle.',
    },
    {
      id: 'F3',
      kind: 'text' as const,
      startOrdinal: 120,
      endOrdinal: 120,
      startLine: 122,
      endLine: 122,
      focus: 'Controller paragraph 120',
      feedback: 'Strengthen the ending.',
    },
  ];
  const controller = createFeedbackReviewController({
    editor,
    host: { postMessage: () => undefined },
  });
  controller.activate({
    sessionId: 'fixture-real-controller',
    source: 'docs/controller-fixture.md',
    sourceSha256: 'a'.repeat(64),
    round: 'fixture-real-controller',
    items,
  });
  controller.navigateFeedback('next');
  await settleLayout(5);

  const markers = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-feedback-marker]')
  );
  if (markers.length < 3) {
    controller.deactivate();
    editor.destroy();
    throw new Error(`Actual Feedback controller rendered ${markers.length} markers; expected 3.`);
  }
  markers[0]!.focus({ preventScroll: true });
  markers[0]!.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
  );
  const markerFocusMoved = document.activeElement === markers[1];

  const middleTarget =
    Array.from(editor.view.dom.querySelectorAll<HTMLElement>('.md4h-feedback-annotation')).find(
      target => target.dataset.feedbackIds?.split(',').includes('F2')
    ) ?? (editor.view.dom.children.item(55) as HTMLElement | null);
  const middleMarker = markers.find(marker =>
    marker.dataset.feedbackIds?.split(',').includes('F2')
  );
  if (!middleTarget || !middleMarker) {
    controller.deactivate();
    editor.destroy();
    throw new Error('Actual Feedback controller middle target or marker is missing.');
  }
  const beforeScrollDrift = Math.abs(
    realControllerMarkerCenter(middleMarker) - realControllerTargetCenter(middleTarget)
  );
  const maximumScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  for (const proportion of [0.8, 0.25, 0.68]) window.scrollTo(0, maximumScroll * proportion);
  await settleLayout(3);
  const afterScrollDrift = Math.abs(
    realControllerMarkerCenter(middleMarker) - realControllerTargetCenter(middleTarget)
  );

  const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-feedback-card]'));
  const visibleCards = cards.filter(card => getComputedStyle(card).display !== 'none');
  const visibleCardCount = visibleCards.length;
  const activeCardCount = visibleCards.filter(
    card => card.dataset.feedbackCardState === 'active'
  ).length;
  const connectorCount = Array.from(
    document.querySelectorAll<SVGPathElement>('[data-feedback-connector]')
  ).filter(path => path.dataset.feedbackConnector !== 'F1').length;
  const spacer = document.querySelector<HTMLElement>('[data-feedback-annotation-spacer]');
  const eofSpacerCssPx = Number.parseFloat(spacer?.style.height || '0') || 0;

  controller.toggleComments(false);
  await settleLayout(2);
  const decoratedTargets = Array.from(
    editor.view.dom.querySelectorAll<HTMLElement>('.md4h-feedback-annotation-node')
  );
  const hiddenHighContrastTargetSuppressed =
    decoratedTargets.length > 0 &&
    decoratedTargets.every(target => getComputedStyle(target).boxShadow === 'none');

  const beforeTeardownHtml = shell.outerHTML;
  controller.deactivate();
  await settleLayout(2);
  const teardownArtifactCount =
    fixtureRoot.querySelectorAll(
      [
        '.feedback-annotation-layer',
        '.feedback-annotation-spacer',
        '.feedback-frame-label',
        '.feedback-live-region',
        '.md4h-feedback-annotation',
      ].join(',')
    ).length + (document.body.classList.contains('feedback-review-active') ? 1 : 0);
  editor.destroy();

  const metrics = {
    maxScrollDriftCssPx: Math.max(beforeScrollDrift, afterScrollDrift),
    beforeScrollDriftCssPx: beforeScrollDrift,
    afterScrollDriftCssPx: afterScrollDrift,
    visibleCardCount,
    activeCardCount,
    connectorCount,
    eofSpacerCssPx,
    markerFocusMoved,
    hiddenHighContrastTargetSuppressed,
    teardownArtifactCount,
  };
  const verification = evaluateRealControllerScenario(metrics);
  if (!verification.passed) {
    shell.outerHTML = beforeTeardownHtml;
    document.body.dataset.fixtureFailure = config.id;
  } else {
    fixtureRoot.replaceChildren();
    delete document.body.dataset.fixtureFailure;
  }
  return { metrics, ...verification };
}

window.runAnnotationScenario = runAnnotationScenario;
window.runAnnotationStress = runAnnotationStress;
window.runRealControllerScenario = runRealControllerScenario;
window.fixtureReady = true;

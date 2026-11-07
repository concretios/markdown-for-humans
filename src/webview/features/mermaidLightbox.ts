/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import * as l10n from '../l10n';

const MIN_SCALE = 0.1;
const MAX_SCALE = 10;
const ZOOM_STEP = 1.2;
/** Wheel delta, in pixels, that zooms by one full step. One mouse wheel notch is about 100. */
const WHEEL_DELTA_PER_STEP = 100;
const OVERLAY_CLASS = 'mermaid-lightbox-overlay';

/** Zoom level for the controls, in the display language ("120%", "120 %"). */
function formatPercent(scale: number): string {
  const language = document.documentElement.lang || 'en-US';
  try {
    return new Intl.NumberFormat(language, {
      style: 'percent',
      maximumFractionDigits: 0,
      useGrouping: false,
    }).format(scale);
  } catch {
    // The host passes VS Code's language id through; an id the runtime rejects must not break the UI.
    return `${Math.round(scale * 100)}%`;
  }
}

/**
 * Give the diagram its authored size, so 100% means the size Mermaid laid it out at.
 *
 * Mermaid emits `width="100%"` with a viewBox and an inline max-width. In the
 * viewer's shrink-to-fit canvas a percentage width resolves to the 300px SVG
 * fallback, which made the fitted view read as "347%" and 100% unreadable.
 */
function sizeToViewBox(diagram: SVGElement | null): void {
  const parts =
    diagram
      ?.getAttribute('viewBox')
      ?.trim()
      .split(/[\s,]+/)
      .map(Number) ?? [];
  const [, , width, height] = parts;
  if (!diagram || parts.length !== 4 || !(width > 0) || !(height > 0)) return;
  diagram.style.width = `${width}px`;
  diagram.style.height = `${height}px`;
  diagram.style.maxWidth = 'none';
}

/**
 * Viewer for a rendered mermaid diagram that fills the editor pane.
 * View-only: zoom and pan state lives here and is never written back to the document.
 * A second call while a viewer is open does nothing (a held Enter key repeats clicks).
 */
export function showMermaidLightbox(svg: string): void {
  if (document.querySelector(`.${OVERLAY_CLASS}`)) return;
  const opener = document.activeElement as HTMLElement | null;

  const overlay = document.createElement('div');
  overlay.className = OVERLAY_CLASS;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', l10n.t('Diagram viewer'));
  // Focusable container so the dialog itself can hold focus on open.
  overlay.tabIndex = -1;

  const viewport = document.createElement('div');
  viewport.className = 'mermaid-lightbox-viewport';

  const canvas = document.createElement('div');
  canvas.className = 'mermaid-lightbox-canvas';
  canvas.innerHTML = svg;
  sizeToViewBox(canvas.querySelector('svg'));

  const controls = document.createElement('div');
  controls.className = 'mermaid-lightbox-controls';
  const zoomOut = l10n.html('Zoom out');
  const zoomIn = l10n.html('Zoom in');
  const fitToView = l10n.html('Fit to view');
  controls.innerHTML = `
    <button id="mlb-zoom-out" class="mermaid-lightbox-btn" title="${zoomOut}" aria-label="${zoomOut}">
      <span class="codicon codicon-zoom-out"></span>
    </button>
    <span class="mermaid-lightbox-zoom-level" aria-live="polite"></span>
    <button id="mlb-zoom-in" class="mermaid-lightbox-btn" title="${zoomIn}" aria-label="${zoomIn}">
      <span class="codicon codicon-zoom-in"></span>
    </button>
    <button id="mlb-fit" class="mermaid-lightbox-btn" title="${fitToView}" aria-label="${fitToView}">
      <span class="codicon codicon-screen-normal"></span>
    </button>
    <button id="mlb-close" class="mermaid-lightbox-btn" title="${l10n.html('Close (Esc)')}" aria-label="${l10n.html('Close')}">
      <span class="codicon codicon-close"></span>
    </button>
  `;

  viewport.appendChild(canvas);
  overlay.appendChild(viewport);
  overlay.appendChild(controls);
  document.body.appendChild(overlay);

  const zoomLabel = controls.querySelector('.mermaid-lightbox-zoom-level') as HTMLElement;

  let scale = 1;
  let tx = 0;
  let ty = 0;

  const applyTransform = () => {
    canvas.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    zoomLabel.textContent = formatPercent(scale);
  };

  /** Zoom about a point given in pixels from the viewport centre, keeping that point stationary. */
  const zoomBy = (factor: number, originX = 0, originY = 0) => {
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
    const ratio = next / scale;
    tx = originX - (originX - tx) * ratio;
    ty = originY - (originY - ty) * ratio;
    scale = next;
    applyTransform();
  };

  const fit = () => {
    const view = viewport.getBoundingClientRect();
    const diagram = canvas.firstElementChild?.getBoundingClientRect();
    tx = 0;
    ty = 0;
    // Diagram or viewport not laid out yet (also the case under jsdom): 1:1 is the honest default.
    if (!diagram?.width || !diagram.height || !view.width || !view.height) {
      scale = 1;
    } else {
      // The measured rect already includes the current scale, so scale through it.
      const raw = scale * Math.min(view.width / diagram.width, view.height / diagram.height);
      scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, raw));
    }
    applyTransform();
  };

  let dragOrigin: { x: number; y: number; tx: number; ty: number } | null = null;
  let dragMoved = false;

  const handleMouseMove = (event: MouseEvent) => {
    if (!dragOrigin) return;
    tx = dragOrigin.tx + (event.clientX - dragOrigin.x);
    ty = dragOrigin.ty + (event.clientY - dragOrigin.y);
    dragMoved = true;
    applyTransform();
  };

  const endDrag = () => {
    dragOrigin = null;
    viewport.classList.remove('grabbing');
  };

  const close = () => {
    document.removeEventListener('keydown', handleKeydown);
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', endDrag);
    overlay.remove();
    opener?.focus();
  };

  // aria-modal claims the rest of the page is inert, so Tab must not escape the dialog.
  const trapTab = (event: KeyboardEvent) => {
    const controlsList = Array.from(overlay.querySelectorAll('button'));
    if (!controlsList.length) return;
    const first = controlsList[0];
    const last = controlsList[controlsList.length - 1];
    const active = document.activeElement as HTMLButtonElement | null;
    const index = active ? controlsList.indexOf(active) : -1;

    if (event.shiftKey) {
      if (index !== 0 && index !== -1) return;
      last.focus();
    } else {
      if (index !== controlsList.length - 1 && index !== -1) return;
      first.focus();
    }
    event.preventDefault();
  };

  function handleKeydown(event: KeyboardEvent) {
    switch (event.key) {
      case 'Tab':
        trapTab(event);
        return;
      case 'Escape':
        close();
        break;
      case '+':
      case '=':
        zoomBy(ZOOM_STEP);
        break;
      case '-':
        zoomBy(1 / ZOOM_STEP);
        break;
      case '0':
        fit();
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  // Only bare space dismisses: not the diagram, not the controls, and not the
  // click that terminates a pan gesture.
  overlay.addEventListener('click', event => {
    if (dragMoved) {
      dragMoved = false;
      return;
    }
    if (event.target === viewport || event.target === overlay) close();
  });

  viewport.addEventListener('mousedown', event => {
    event.preventDefault();
    dragOrigin = { x: event.clientX, y: event.clientY, tx, ty };
    viewport.classList.add('grabbing');
  });

  viewport.addEventListener(
    'wheel',
    event => {
      event.preventDefault();
      const view = viewport.getBoundingClientRect();
      const originX = event.clientX - view.left - view.width / 2;
      const originY = event.clientY - view.top - view.height / 2;
      // Scale by the delta: a mouse notch is one step, a trackpad sends many
      // small deltas per second and each must move a little, not a full step.
      // Clamped so one oversized event cannot jump further than a step.
      const notches = Math.max(-1, Math.min(1, -event.deltaY / WHEEL_DELTA_PER_STEP));
      zoomBy(Math.pow(ZOOM_STEP, notches), originX, originY);
    },
    { passive: false }
  );

  const button = (id: string) => controls.querySelector(`#${id}`) as HTMLButtonElement;
  button('mlb-zoom-in').addEventListener('click', () => zoomBy(ZOOM_STEP));
  button('mlb-zoom-out').addEventListener('click', () => zoomBy(1 / ZOOM_STEP));
  button('mlb-fit').addEventListener('click', fit);
  button('mlb-close').addEventListener('click', close);

  document.addEventListener('keydown', handleKeydown);
  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseup', endDrag);

  fit();
  overlay.focus();
}

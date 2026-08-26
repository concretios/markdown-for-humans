/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

const MIN_SCALE = 0.1;
const MAX_SCALE = 10;
const ZOOM_STEP = 1.2;

/**
 * Full-screen viewer for a rendered mermaid diagram.
 * View-only: zoom and pan state lives here and is never written back to the document.
 */
export function showMermaidLightbox(svg: string): void {
  const opener = document.activeElement as HTMLElement | null;

  const overlay = document.createElement('div');
  overlay.className = 'mermaid-lightbox-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Diagram viewer');
  // Focusable container so the dialog itself can hold focus on open.
  overlay.tabIndex = -1;

  const viewport = document.createElement('div');
  viewport.className = 'mermaid-lightbox-viewport';

  const canvas = document.createElement('div');
  canvas.className = 'mermaid-lightbox-canvas';
  canvas.innerHTML = svg;

  const controls = document.createElement('div');
  controls.className = 'mermaid-lightbox-controls';
  controls.innerHTML = `
    <button id="mlb-zoom-out" class="mermaid-lightbox-btn" title="Zoom out" aria-label="Zoom out">
      <span class="codicon codicon-zoom-out"></span>
    </button>
    <span class="mermaid-lightbox-zoom-level" aria-live="polite">100%</span>
    <button id="mlb-zoom-in" class="mermaid-lightbox-btn" title="Zoom in" aria-label="Zoom in">
      <span class="codicon codicon-zoom-in"></span>
    </button>
    <button id="mlb-fit" class="mermaid-lightbox-btn" title="Fit to screen" aria-label="Fit to screen">
      <span class="codicon codicon-screen-normal"></span>
    </button>
    <button id="mlb-close" class="mermaid-lightbox-btn" title="Close (Esc)" aria-label="Close">
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
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
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
    // Diagram or viewport not laid out yet (also the case under jsdom) — 1:1 is the honest default.
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
      zoomBy(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, originX, originY);
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

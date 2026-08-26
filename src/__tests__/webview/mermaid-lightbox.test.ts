/**
 * Tests for the mermaid lightbox: full-screen zoom/pan viewer
 * @jest-environment jsdom
 */

import { showMermaidLightbox } from '../../webview/features/mermaidLightbox';

const SVG = '<svg id="diagram"><g><text>A</text></g></svg>';

const overlay = () => document.querySelector('.mermaid-lightbox-overlay');
const canvas = () => document.querySelector('.mermaid-lightbox-canvas') as HTMLElement;
const zoomLevel = () => document.querySelector('.mermaid-lightbox-zoom-level')?.textContent;
const click = (selector: string) => (document.querySelector(selector) as HTMLButtonElement).click();
const scaleOf = () => Number(/scale\(([\d.]+)\)/.exec(canvas().style.transform)?.[1]);

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Mermaid lightbox: open and close', () => {
  it('should render the provided svg inside the overlay', () => {
    showMermaidLightbox(SVG);

    expect(overlay()).not.toBeNull();
    expect(canvas().querySelector('#diagram')).not.toBeNull();
  });

  it('should close on Escape key', () => {
    showMermaidLightbox(SVG);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(overlay()).toBeNull();
  });

  it('should close when the close button is clicked', () => {
    showMermaidLightbox(SVG);

    (document.querySelector('#mlb-close') as HTMLButtonElement).click();

    expect(overlay()).toBeNull();
  });

  it('should close when the backdrop is clicked', () => {
    showMermaidLightbox(SVG);

    (overlay() as HTMLElement).click();

    expect(overlay()).toBeNull();
  });

  it('should stay open when the diagram itself is clicked', () => {
    showMermaidLightbox(SVG);

    canvas().click();

    expect(overlay()).not.toBeNull();
  });

  it('should stop responding to Escape once closed', () => {
    showMermaidLightbox(SVG);
    (document.querySelector('#mlb-close') as HTMLButtonElement).click();

    showMermaidLightbox(SVG);
    const second = overlay();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(second).not.toBeNull();
    expect(overlay()).toBeNull();
    expect(document.querySelectorAll('.mermaid-lightbox-overlay')).toHaveLength(0);
  });
});

describe('Mermaid lightbox: zoom', () => {
  it('should open at 100% when the viewport has no measurable layout', () => {
    showMermaidLightbox(SVG);

    expect(zoomLevel()).toBe('100%');
    expect(scaleOf()).toBe(1);
  });

  it('should zoom in by one step when the zoom-in button is clicked', () => {
    showMermaidLightbox(SVG);

    click('#mlb-zoom-in');

    expect(scaleOf()).toBeCloseTo(1.2);
    expect(zoomLevel()).toBe('120%');
  });

  it('should zoom out by one step when the zoom-out button is clicked', () => {
    showMermaidLightbox(SVG);

    click('#mlb-zoom-out');

    expect(scaleOf()).toBeCloseTo(1 / 1.2);
    expect(zoomLevel()).toBe('83%');
  });

  it('should clamp zoom in at 1000%', () => {
    showMermaidLightbox(SVG);

    for (let i = 0; i < 40; i++) click('#mlb-zoom-in');

    expect(scaleOf()).toBe(10);
    expect(zoomLevel()).toBe('1000%');
  });

  it('should clamp zoom out at 10%', () => {
    showMermaidLightbox(SVG);

    for (let i = 0; i < 40; i++) click('#mlb-zoom-out');

    expect(scaleOf()).toBe(0.1);
    expect(zoomLevel()).toBe('10%');
  });

  it('should restore the fitted view when the fit button is clicked', () => {
    showMermaidLightbox(SVG);
    click('#mlb-zoom-in');
    click('#mlb-zoom-in');

    click('#mlb-fit');

    expect(scaleOf()).toBe(1);
    expect(canvas().style.transform).toBe('translate(0px, 0px) scale(1)');
  });

  it('should zoom in on a wheel scroll up', () => {
    showMermaidLightbox(SVG);

    canvas().dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));

    expect(scaleOf()).toBeGreaterThan(1);
  });

  it('should zoom out on a wheel scroll down', () => {
    showMermaidLightbox(SVG);

    canvas().dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true }));

    expect(scaleOf()).toBeLessThan(1);
  });
});

describe('Mermaid lightbox: pan', () => {
  const viewport = () => document.querySelector('.mermaid-lightbox-viewport') as HTMLElement;

  const drag = (from: [number, number], to: [number, number]) => {
    viewport().dispatchEvent(
      new MouseEvent('mousedown', { clientX: from[0], clientY: from[1], bubbles: true })
    );
    document.dispatchEvent(
      new MouseEvent('mousemove', { clientX: to[0], clientY: to[1], bubbles: true })
    );
  };

  it('should move the diagram by the drag distance', () => {
    showMermaidLightbox(SVG);

    drag([100, 100], [150, 130]);

    expect(canvas().style.transform).toContain('translate(50px, 30px)');
  });

  it('should keep the diagram still after the drag is released', () => {
    showMermaidLightbox(SVG);
    drag([100, 100], [150, 130]);

    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 400, clientY: 400 }));

    expect(canvas().style.transform).toContain('translate(50px, 30px)');
  });

  it('should accumulate across successive drags', () => {
    showMermaidLightbox(SVG);

    drag([0, 0], [10, 10]);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    drag([0, 0], [5, 5]);

    expect(canvas().style.transform).toContain('translate(15px, 15px)');
  });

  it('should mark the viewport as grabbing only while dragging', () => {
    showMermaidLightbox(SVG);

    drag([0, 0], [10, 10]);
    expect(viewport().classList.contains('grabbing')).toBe(true);

    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(viewport().classList.contains('grabbing')).toBe(false);
  });

  it('should stop panning after the lightbox is closed', () => {
    showMermaidLightbox(SVG);
    drag([0, 0], [10, 10]);
    const closed = canvas();

    click('#mlb-close');
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 900, clientY: 900 }));

    expect(closed.style.transform).toContain('translate(10px, 10px)');
  });
});

describe('Mermaid lightbox: keyboard', () => {
  const press = (key: string) =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

  it('should zoom in on "+"', () => {
    showMermaidLightbox(SVG);

    press('+');

    expect(scaleOf()).toBeCloseTo(1.2);
  });

  it('should zoom in on "=" so the unshifted key works', () => {
    showMermaidLightbox(SVG);

    press('=');

    expect(scaleOf()).toBeCloseTo(1.2);
  });

  it('should zoom out on "-"', () => {
    showMermaidLightbox(SVG);

    press('-');

    expect(scaleOf()).toBeCloseTo(1 / 1.2);
  });

  it('should refit on "0"', () => {
    showMermaidLightbox(SVG);
    click('#mlb-zoom-in');
    click('#mlb-zoom-in');

    press('0');

    expect(canvas().style.transform).toBe('translate(0px, 0px) scale(1)');
  });
});

describe('Mermaid lightbox: click to dismiss vs pan', () => {
  const viewport = () => document.querySelector('.mermaid-lightbox-viewport') as HTMLElement;

  it('should close when empty space beside the diagram is clicked', () => {
    showMermaidLightbox(SVG);

    viewport().click();

    expect(overlay()).toBeNull();
  });

  it('should stay open when a pan gesture ends over empty space', () => {
    showMermaidLightbox(SVG);
    const view = viewport();

    view.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: 10, bubbles: true }));
    document.dispatchEvent(
      new MouseEvent('mousemove', { clientX: 200, clientY: 90, bubbles: true })
    );
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    view.click();

    expect(overlay()).not.toBeNull();
  });

  it('should close on a click that follows a press without movement', () => {
    showMermaidLightbox(SVG);
    const view = viewport();

    view.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: 10, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    view.click();

    expect(overlay()).toBeNull();
  });
});

describe('Mermaid lightbox: focus management', () => {
  const focusables = () =>
    Array.from((overlay() as HTMLElement).querySelectorAll('button')) as HTMLButtonElement[];

  const tab = (shiftKey = false) =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true }));

  it('should move focus into the dialog on open', () => {
    showMermaidLightbox(SVG);

    expect((overlay() as HTMLElement).contains(document.activeElement)).toBe(true);
  });

  it('should return focus to the element that opened it', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    showMermaidLightbox(SVG);
    click('#mlb-close');

    expect(document.activeElement).toBe(trigger);
  });

  it('should wrap focus from the last control back to the first', () => {
    showMermaidLightbox(SVG);
    const buttons = focusables();
    buttons[buttons.length - 1].focus();

    tab();

    expect(document.activeElement).toBe(buttons[0]);
  });

  it('should wrap focus backwards from the first control to the last', () => {
    showMermaidLightbox(SVG);
    const buttons = focusables();
    buttons[0].focus();

    tab(true);

    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
  });

  it('should move focus to the first control when tabbing from the container', () => {
    showMermaidLightbox(SVG);

    tab();

    expect(document.activeElement).toBe(focusables()[0]);
  });
});

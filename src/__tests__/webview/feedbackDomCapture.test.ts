/**
 * @jest-environment jsdom
 */

import {
  createModernScreenshotRasterizer,
  validateCaptureResources,
} from '../../webview/features/feedbackDomCapture';

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('modern-screenshot feedback rasterizer', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    jest.restoreAllMocks();
  });

  it('clones only intersecting top-level blocks at the original editor width', async () => {
    document.body.innerHTML = '<div id="root"><p>one</p><p>two</p><p>three</p></div>';
    const root = document.getElementById('root') as HTMLElement;
    Object.defineProperty(root, 'getBoundingClientRect', { value: () => rect(20, 10, 600, 300) });
    Array.from(root.children).forEach((child, index) => {
      Object.defineProperty(child, 'getBoundingClientRect', {
        value: () => rect(40, 20 + index * 100, 560, 80),
      });
    });

    const screenshot = jest.fn(async (node: Node) => {
      const stage = node as HTMLElement;
      expect(stage.style.width).toBe('200px');
      expect(stage.style.height).toBe('120px');
      const content = stage.querySelector<HTMLElement>('[data-feedback-capture-content]');
      expect(content?.style.boxSizing).toBe('border-box');
      expect(stage.querySelectorAll('[data-feedback-captured-block]')).toHaveLength(2);
      stage.querySelectorAll<HTMLElement>('[data-feedback-captured-block]').forEach(block => {
        expect(block.style.boxSizing).toBe('border-box');
      });
      expect(stage.textContent).toContain('two');
      expect(stage.textContent).toContain('three');
      expect(stage.textContent).not.toContain('one');
      return 'data:image/png;base64,AAAA';
    });
    const rasterize = createModernScreenshotRasterizer(screenshot);

    const result = await rasterize({
      root,
      rectangle: { left: 30, top: 130, width: 200, height: 120 },
      scale: 1.25,
    });

    expect(result).toEqual({
      dataUrl: 'data:image/png;base64,AAAA',
      width: 250,
      height: 150,
    });
    expect(document.querySelector('[data-feedback-capture-stage]')).toBeNull();
  });

  it('bounds layout reads when staging a tiny crop from 10,000 ordered blocks', async () => {
    const root = document.createElement('div');
    root.id = 'root';
    const fragment = document.createDocumentFragment();
    const geometryReads = { count: 0 };
    const blockHeight = 24;
    const targetIndex = 7_654;

    for (let index = 0; index < 10_000; index += 1) {
      const block = document.createElement('p');
      block.textContent = `block ${index}`;
      Object.defineProperty(block, 'getBoundingClientRect', {
        value: jest.fn(() => {
          geometryReads.count += 1;
          return rect(40, index * blockHeight, 560, blockHeight);
        }),
      });
      fragment.append(block);
    }
    root.append(fragment);
    document.body.append(root);
    Object.defineProperty(root, 'getBoundingClientRect', {
      value: () => rect(20, 0, 600, 10_000 * blockHeight),
    });

    const screenshot = jest.fn(async (node: Node) => {
      const stage = node as HTMLElement;
      const captured = stage.querySelectorAll<HTMLElement>('[data-feedback-captured-block]');
      expect(captured).toHaveLength(1);
      expect(captured[0].textContent).toBe(`block ${targetIndex}`);
      return 'data:image/png;base64,AAAA';
    });

    await createModernScreenshotRasterizer(screenshot)({
      root,
      rectangle: {
        left: 40,
        top: targetIndex * blockHeight + 4,
        width: 200,
        height: 12,
      },
      scale: 1,
    });

    expect(geometryReads.count).toBeLessThanOrEqual(32);
    expect(screenshot).toHaveBeenCalledTimes(1);
  });

  it('prunes a very large table to intersecting rows and cells before clone and resource work', async () => {
    const rowCount = 2_000;
    const columnCount = 4;
    const rowHeight = 24;
    const columnWidth = 150;
    const targetRow = 1_600;
    const targetColumn = 2;
    const root = document.createElement('div');
    const table = document.createElement('table');
    const body = document.createElement('tbody');
    const fragment = document.createDocumentFragment();
    const geometryReads = { count: 0 };

    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      const row = document.createElement('tr');
      row.dataset.row = String(rowIndex);
      Object.defineProperty(row, 'getBoundingClientRect', {
        value: () => {
          geometryReads.count += 1;
          return rect(0, rowIndex * rowHeight, columnCount * columnWidth, rowHeight);
        },
      });
      for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
        const cell = document.createElement('td');
        cell.dataset.row = String(rowIndex);
        cell.dataset.column = String(columnIndex);
        cell.textContent = `row ${rowIndex} cell ${columnIndex}`;
        if (rowIndex < 1_100 && columnIndex === 0) {
          const image = document.createElement('img');
          image.src = `data:image/png;base64,${rowIndex}`;
          cell.append(image);
        }
        Object.defineProperty(cell, 'getBoundingClientRect', {
          value: () => {
            geometryReads.count += 1;
            return rect(columnIndex * columnWidth, rowIndex * rowHeight, columnWidth, rowHeight);
          },
        });
        row.append(cell);
      }
      fragment.append(row);
    }
    body.append(fragment);
    table.append(body);
    root.append(table);
    document.body.append(root);
    const tableHeight = rowCount * rowHeight;
    Object.defineProperty(root, 'getBoundingClientRect', {
      value: () => rect(0, 0, columnCount * columnWidth, tableHeight),
    });
    Object.defineProperty(table, 'getBoundingClientRect', {
      value: () => rect(0, 0, columnCount * columnWidth, tableHeight),
    });
    Object.defineProperty(body, 'getBoundingClientRect', {
      value: () => rect(0, 0, columnCount * columnWidth, tableHeight),
    });
    const cloneNode = jest.spyOn(Node.prototype, 'cloneNode');

    const screenshot = jest.fn(async (node: Node) => {
      const stage = node as HTMLElement;
      const stagedTable = stage.querySelector('table');
      const capturedRows = stagedTable?.querySelectorAll<HTMLTableRowElement>('tr[data-row]');
      const capturedCells = stagedTable?.querySelectorAll<HTMLTableCellElement>(
        'td[data-row][data-column]'
      );
      expect(capturedRows).toHaveLength(1);
      expect(capturedRows?.[0].dataset.row).toBe(String(targetRow));
      expect(capturedRows?.[0].style.height).toBe(`${rowHeight}px`);
      expect(capturedCells).toHaveLength(1);
      expect(capturedCells?.[0].dataset).toMatchObject({
        row: String(targetRow),
        column: String(targetColumn),
      });
      expect(capturedCells?.[0].style.width).toBe(`${columnWidth}px`);
      expect(capturedCells?.[0].style.height).toBe(`${rowHeight}px`);
      expect(stagedTable?.textContent).toContain(`row ${targetRow} cell ${targetColumn}`);
      expect(stagedTable?.textContent).not.toContain('row 0 cell 0');
      expect(stagedTable?.querySelectorAll('img')).toHaveLength(0);
      expect(
        stagedTable?.querySelector<HTMLTableRowElement>(
          '[data-feedback-capture-table-row-spacer="before"]'
        )?.style.height
      ).toBe(`${targetRow * rowHeight}px`);
      expect(
        capturedRows?.[0].querySelector<HTMLTableCellElement>(
          '[data-feedback-capture-table-cell-spacer="before"]'
        )?.style.width
      ).toBe(`${targetColumn * columnWidth}px`);
      expect(
        capturedRows?.[0].querySelector<HTMLTableCellElement>(
          '[data-feedback-capture-table-cell-spacer="after"]'
        )?.style.width
      ).toBe(`${columnWidth}px`);
      expect(stage.querySelectorAll('*').length).toBeLessThan(32);
      return 'data:image/png;base64,AAAA';
    });

    await expect(
      createModernScreenshotRasterizer(screenshot)({
        root,
        rectangle: {
          left: targetColumn * columnWidth + 10,
          top: targetRow * rowHeight + 2,
          width: 100,
          height: 20,
        },
        scale: 1,
      })
    ).resolves.toMatchObject({ dataUrl: 'data:image/png;base64,AAAA' });
    expect(cloneNode).not.toHaveBeenCalledWith(true);
    expect(geometryReads.count).toBeLessThanOrEqual(48);
    expect(screenshot).toHaveBeenCalledTimes(1);
  });

  it('prunes non-intersecting nested list subtrees before clone and resource work', async () => {
    const itemCount = 2_000;
    const itemHeight = 24;
    const nestedTop = 30;
    const targetIndex = 1_600;
    const root = document.createElement('div');
    const outerList = document.createElement('ol');
    const outerItem = document.createElement('li');
    const heading = document.createElement('span');
    const nestedList = document.createElement('ol');
    const fragment = document.createDocumentFragment();
    const geometryReads = { count: 0 };
    heading.textContent = 'Nested chapter';
    nestedList.dataset.largeNested = 'true';

    for (let index = 0; index < itemCount; index += 1) {
      const item = document.createElement('li');
      item.dataset.item = String(index);
      item.value = index + 1;
      item.textContent = `nested item ${index}`;
      if (index < 1_100) {
        const image = document.createElement('img');
        image.src = `data:image/png;base64,${index}`;
        item.append(image);
      }
      Object.defineProperty(item, 'getBoundingClientRect', {
        value: () => {
          geometryReads.count += 1;
          return rect(40, nestedTop + index * itemHeight, 360, itemHeight);
        },
      });
      fragment.append(item);
    }
    nestedList.append(fragment);
    outerItem.append(heading, nestedList);
    outerList.append(outerItem);
    root.append(outerList);
    document.body.append(root);
    const listHeight = nestedTop + itemCount * itemHeight;
    [root, outerList, outerItem].forEach(element => {
      Object.defineProperty(element, 'getBoundingClientRect', {
        value: () => rect(0, 0, 400, listHeight),
      });
    });
    Object.defineProperty(nestedList, 'getBoundingClientRect', {
      value: () => rect(40, nestedTop, 360, itemCount * itemHeight),
    });
    const cloneNode = jest.spyOn(Node.prototype, 'cloneNode');

    const screenshot = jest.fn(async (node: Node) => {
      const stage = node as HTMLElement;
      const stagedNestedList = stage.querySelector<HTMLOListElement>('[data-large-nested]');
      const capturedItems =
        stagedNestedList?.querySelectorAll<HTMLLIElement>(':scope > li[data-item]');
      expect(capturedItems).toHaveLength(1);
      expect(capturedItems?.[0].dataset.item).toBe(String(targetIndex));
      expect(capturedItems?.[0].value).toBe(targetIndex + 1);
      expect(capturedItems?.[0].style.height).toBe(`${itemHeight}px`);
      expect(stagedNestedList?.textContent).toContain(`nested item ${targetIndex}`);
      expect(stagedNestedList?.textContent).not.toContain('nested item 0');
      expect(stagedNestedList?.querySelectorAll('img')).toHaveLength(0);
      expect(
        stagedNestedList?.querySelector<HTMLLIElement>(
          '[data-feedback-capture-list-spacer="before"]'
        )?.style.height
      ).toBe(`${targetIndex * itemHeight}px`);
      expect(stage.querySelectorAll('*').length).toBeLessThan(32);
      return 'data:image/png;base64,AAAA';
    });

    await expect(
      createModernScreenshotRasterizer(screenshot)({
        root,
        rectangle: {
          left: 50,
          top: nestedTop + targetIndex * itemHeight + 2,
          width: 200,
          height: 20,
        },
        scale: 1,
      })
    ).resolves.toMatchObject({ dataUrl: 'data:image/png;base64,AAAA' });
    expect(cloneNode).not.toHaveBeenCalledWith(true);
    expect(geometryReads.count).toBeLessThanOrEqual(32);
    expect(screenshot).toHaveBeenCalledTimes(1);
  });

  it('validates and waits only for resources inside intersecting staged blocks', async () => {
    document.body.innerHTML = [
      '<div id="root">',
      '<p>captured prose</p>',
      '<p><img src="https://example.com/unrelated-private.png"></p>',
      '</div>',
    ].join('');
    const root = document.getElementById('root') as HTMLElement;
    Object.defineProperty(root, 'getBoundingClientRect', { value: () => rect(0, 0, 600, 400) });
    Object.defineProperty(root.children[0], 'getBoundingClientRect', {
      value: () => rect(0, 0, 600, 80),
    });
    Object.defineProperty(root.children[1], 'getBoundingClientRect', {
      value: () => rect(0, 200, 600, 80),
    });
    const screenshot = jest.fn(async () => 'data:image/png;base64,AAAA');

    await expect(
      createModernScreenshotRasterizer(screenshot)({
        root,
        rectangle: { left: 0, top: 0, width: 200, height: 60 },
        scale: 1,
      })
    ).resolves.toMatchObject({ dataUrl: 'data:image/png;base64,AAAA' });
    expect(screenshot).toHaveBeenCalledTimes(1);
  });

  it('removes editor chrome and transient decorations without dropping their text', async () => {
    document.body.innerHTML = [
      '<div id="root">',
      '<p class="ProseMirror-selectednode highlighted image-caret-selected feedback-active-target md4h-feedback-block-target md4h-feedback-block-target-active">',
      '<span class="search-match search-match-active">selected words</span>',
      '<span class="validation-error-highlight">reviewed words</span>',
      '<span class="md4h-feedback-annotation md4h-feedback-annotation-inline is-feedback-active md4h-feedback-highlight md4h-feedback-highlight-active" data-feedback-ids="F1,F2" data-feedback-active-ids="F2">annotated words</span>',
      '<button class="code-block-copy-button">Copy</button>',
      '<span class="ProseMirror-gapcursor"></span>',
      '<aside class="feedback-annotation-layer">Comments must not be captured</aside>',
      '<div class="feedback-annotation-spacer">Spacer must not be captured</div>',
      '</p>',
      '</div>',
    ].join('');
    const root = document.getElementById('root') as HTMLElement;
    const block = root.firstElementChild as HTMLElement;
    Object.defineProperty(root, 'getBoundingClientRect', { value: () => rect(0, 0, 600, 100) });
    Object.defineProperty(block, 'getBoundingClientRect', {
      value: () => rect(0, 0, 600, 100),
    });
    const screenshot = jest.fn(async (node: Node) => {
      const stage = node as HTMLElement;
      expect(stage.textContent).toContain('selected words');
      expect(stage.textContent).toContain('reviewed words');
      expect(stage.textContent).toContain('annotated words');
      expect(stage.textContent).not.toContain('Copy');
      expect(stage.textContent).not.toContain('Comments must not be captured');
      expect(stage.textContent).not.toContain('Spacer must not be captured');
      expect(stage.querySelector('.ProseMirror-gapcursor')).toBeNull();
      expect(stage.querySelector('.ProseMirror-selectednode')).toBeNull();
      expect(stage.querySelector('.highlighted')).toBeNull();
      expect(stage.querySelector('.search-match')).toBeNull();
      expect(stage.querySelector('.validation-error-highlight')).toBeNull();
      expect(stage.querySelector('.feedback-active-target')).toBeNull();
      expect(stage.querySelector('.md4h-feedback-annotation')).toBeNull();
      expect(stage.querySelector('.md4h-feedback-highlight')).toBeNull();
      expect(stage.querySelector('[data-feedback-ids]')).toBeNull();
      return 'data:image/png;base64,AAAA';
    });

    await createModernScreenshotRasterizer(screenshot)({
      root,
      rectangle: { left: 0, top: 0, width: 300, height: 80 },
      scale: 1,
    });

    expect(screenshot).toHaveBeenCalledTimes(1);
  });

  it('skips a top-level annotation layer when the capture root is a review surface', async () => {
    document.body.innerHTML = [
      '<div id="root" class="feedback-review-surface">',
      '<p>captured prose</p>',
      '<aside class="feedback-annotation-layer">F1 comment</aside>',
      '<div class="feedback-annotation-spacer"></div>',
      '</div>',
    ].join('');
    const root = document.getElementById('root') as HTMLElement;
    Object.defineProperty(root, 'getBoundingClientRect', {
      value: () => rect(0, 0, 600, 200),
    });
    Array.from(root.children).forEach(child => {
      Object.defineProperty(child, 'getBoundingClientRect', {
        value: () => rect(0, 0, 600, 100),
      });
    });
    const screenshot = jest.fn(async (node: Node) => {
      const stage = node as HTMLElement;
      expect(stage.textContent).toContain('captured prose');
      expect(stage.textContent).not.toContain('F1 comment');
      expect(stage.querySelector('.feedback-annotation-layer')).toBeNull();
      expect(stage.querySelector('.feedback-annotation-spacer')).toBeNull();
      expect(stage.querySelector('.feedback-review-surface')).toBeNull();
      return 'data:image/png;base64,AAAA';
    });

    await createModernScreenshotRasterizer(screenshot)({
      root,
      rectangle: { left: 0, top: 0, width: 300, height: 80 },
      scale: 1,
    });

    expect(screenshot).toHaveBeenCalledTimes(1);
  });

  it('waits for an intersecting pending Mermaid diagram and clones its ready SVG', async () => {
    document.body.innerHTML = [
      '<div id="root">',
      '<section><div class="mermaid-wrapper" data-md4h-mermaid-state="pending">',
      '<div class="mermaid-render"></div>',
      '</div></section>',
      '</div>',
    ].join('');
    const root = document.getElementById('root') as HTMLElement;
    const block = root.firstElementChild as HTMLElement;
    const wrapper = block.querySelector<HTMLElement>('.mermaid-wrapper')!;
    Object.defineProperty(root, 'getBoundingClientRect', {
      value: () => rect(0, 0, 600, 200),
    });
    Object.defineProperty(block, 'getBoundingClientRect', {
      value: () => rect(0, 0, 600, 100),
    });
    Object.defineProperty(wrapper, 'getBoundingClientRect', {
      value: () => rect(20, 10, 300, 70),
    });
    const screenshot = jest.fn(async (node: Node) => {
      const stagedWrapper = (node as HTMLElement).querySelector<HTMLElement>('.mermaid-wrapper');
      expect(stagedWrapper?.getAttribute('data-md4h-mermaid-state')).toBe('ready');
      expect(stagedWrapper?.querySelector('svg')).not.toBeNull();
      return 'data:image/png;base64,AAAA';
    });
    const capture = createModernScreenshotRasterizer(screenshot)({
      root,
      rectangle: { left: 0, top: 0, width: 400, height: 90 },
      scale: 1,
    });

    await Promise.resolve();
    expect(screenshot).not.toHaveBeenCalled();
    wrapper.querySelector('.mermaid-render')!.innerHTML = '<svg aria-label="ready"></svg>';
    wrapper.setAttribute('data-md4h-mermaid-state', 'ready');

    await expect(capture).resolves.toMatchObject({ dataUrl: 'data:image/png;base64,AAAA' });
    expect(screenshot).toHaveBeenCalledTimes(1);
  });

  it('fails explicitly when an intersecting Mermaid diagram reports a render error', async () => {
    document.body.innerHTML = [
      '<div id="root">',
      '<section><div class="mermaid-wrapper" data-md4h-mermaid-state="pending"></div></section>',
      '</div>',
    ].join('');
    const root = document.getElementById('root') as HTMLElement;
    const block = root.firstElementChild as HTMLElement;
    const wrapper = block.querySelector<HTMLElement>('.mermaid-wrapper')!;
    Object.defineProperty(root, 'getBoundingClientRect', {
      value: () => rect(0, 0, 600, 200),
    });
    Object.defineProperty(block, 'getBoundingClientRect', {
      value: () => rect(0, 0, 600, 100),
    });
    Object.defineProperty(wrapper, 'getBoundingClientRect', {
      value: () => rect(20, 10, 300, 70),
    });
    const screenshot = jest.fn(async () => 'data:image/png;base64,AAAA');
    const capture = createModernScreenshotRasterizer(screenshot)({
      root,
      rectangle: { left: 0, top: 0, width: 400, height: 90 },
      scale: 1,
    });

    await Promise.resolve();
    expect(screenshot).not.toHaveBeenCalled();
    wrapper.setAttribute('data-md4h-mermaid-state', 'error');

    await expect(capture).rejects.toMatchObject({
      code: 'MD4H-FB-CAPTURE-001',
      message: expect.stringMatching(/Mermaid.*failed to render/i),
    });
    expect(screenshot).not.toHaveBeenCalled();
  });

  it('times out pending Mermaid readiness without a long real wait', async () => {
    jest.useFakeTimers();
    try {
      document.body.innerHTML = [
        '<div id="root">',
        '<section><div class="mermaid-wrapper" data-md4h-mermaid-state="pending"></div></section>',
        '</div>',
      ].join('');
      const root = document.getElementById('root') as HTMLElement;
      const block = root.firstElementChild as HTMLElement;
      const wrapper = block.querySelector<HTMLElement>('.mermaid-wrapper')!;
      Object.defineProperty(root, 'getBoundingClientRect', {
        value: () => rect(0, 0, 600, 200),
      });
      Object.defineProperty(block, 'getBoundingClientRect', {
        value: () => rect(0, 0, 600, 100),
      });
      Object.defineProperty(wrapper, 'getBoundingClientRect', {
        value: () => rect(20, 10, 300, 70),
      });
      const screenshot = jest.fn(async () => 'data:image/png;base64,AAAA');
      const capture = createModernScreenshotRasterizer(screenshot)({
        root,
        rectangle: { left: 0, top: 0, width: 400, height: 90 },
        scale: 1,
      });

      await Promise.resolve();
      jest.advanceTimersByTime(5_000);

      await expect(capture).rejects.toMatchObject({
        code: 'MD4H-FB-CAPTURE-001',
        message: expect.stringMatching(/Mermaid.*timeout/i),
      });
      expect(screenshot).not.toHaveBeenCalled();
      expect(document.querySelector('[data-feedback-capture-stage]')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('aborts a pending Mermaid wait and disconnects its observer without staging', async () => {
    document.body.innerHTML = [
      '<div id="root">',
      '<section><div class="mermaid-wrapper" data-md4h-mermaid-state="pending"></div></section>',
      '</div>',
    ].join('');
    const root = document.getElementById('root') as HTMLElement;
    const block = root.firstElementChild as HTMLElement;
    const wrapper = block.querySelector<HTMLElement>('.mermaid-wrapper')!;
    Object.defineProperty(root, 'getBoundingClientRect', {
      value: () => rect(0, 0, 600, 200),
    });
    Object.defineProperty(block, 'getBoundingClientRect', {
      value: () => rect(0, 0, 600, 100),
    });
    Object.defineProperty(wrapper, 'getBoundingClientRect', {
      value: () => rect(20, 10, 300, 70),
    });
    const disconnect = jest.spyOn(MutationObserver.prototype, 'disconnect');
    const screenshot = jest.fn(async () => 'data:image/png;base64,AAAA');
    const controller = new AbortController();
    const capture = createModernScreenshotRasterizer(screenshot)({
      root,
      rectangle: { left: 0, top: 0, width: 400, height: 90 },
      scale: 1,
      signal: controller.signal,
    });

    await Promise.resolve();
    controller.abort('session ended');

    await expect(capture).rejects.toMatchObject({
      code: 'MD4H-FB-CAPTURE-002',
      message: expect.stringMatching(/cancelled/i),
    });
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(screenshot).not.toHaveBeenCalled();
    expect(document.querySelector('[data-feedback-capture-stage]')).toBeNull();
  });

  it('aborts an in-flight screenshot and removes its stage immediately', async () => {
    document.body.innerHTML = '<div id="root"><p>one</p></div>';
    const root = document.getElementById('root') as HTMLElement;
    const block = root.firstElementChild as HTMLElement;
    Object.defineProperty(root, 'getBoundingClientRect', {
      value: () => rect(0, 0, 600, 100),
    });
    Object.defineProperty(block, 'getBoundingClientRect', {
      value: () => rect(0, 0, 600, 100),
    });
    let finishScreenshot: ((value: string) => void) | undefined;
    const screenshot = jest.fn(
      () =>
        new Promise<string>(resolve => {
          finishScreenshot = resolve;
        })
    );
    const controller = new AbortController();
    const capture = createModernScreenshotRasterizer(screenshot)({
      root,
      rectangle: { left: 0, top: 0, width: 300, height: 80 },
      scale: 1,
      signal: controller.signal,
    });

    await new Promise<void>(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    await Promise.resolve();
    expect(document.querySelector('[data-feedback-capture-stage]')).not.toBeNull();
    controller.abort('session ended');

    await expect(capture).rejects.toMatchObject({
      code: 'MD4H-FB-CAPTURE-002',
      message: expect.stringMatching(/cancelled/i),
    });
    expect(document.querySelector('[data-feedback-capture-stage]')).toBeNull();
    finishScreenshot?.('data:image/png;base64,AAAA');
    await Promise.resolve();
  });

  it('aborts resource decoding, clears its timeout, and removes the stage', async () => {
    jest.useFakeTimers();
    const originalDecode = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'decode');
    let markDecodeStarted: (() => void) | undefined;
    const decodeStarted = new Promise<void>(resolve => {
      markDecodeStarted = resolve;
    });
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {
      configurable: true,
      value: jest.fn(() => {
        markDecodeStarted?.();
        return new Promise<void>(() => undefined);
      }),
    });
    try {
      document.body.innerHTML =
        '<div id="root"><p><img src="data:image/png;base64,AAAA"></p></div>';
      const root = document.getElementById('root') as HTMLElement;
      const block = root.firstElementChild as HTMLElement;
      Object.defineProperty(root, 'getBoundingClientRect', {
        value: () => rect(0, 0, 600, 100),
      });
      Object.defineProperty(block, 'getBoundingClientRect', {
        value: () => rect(0, 0, 600, 100),
      });
      const screenshot = jest.fn(async () => 'data:image/png;base64,AAAA');
      const controller = new AbortController();
      const capture = createModernScreenshotRasterizer(screenshot)({
        root,
        rectangle: { left: 0, top: 0, width: 300, height: 80 },
        scale: 1,
        signal: controller.signal,
      });

      await decodeStarted;
      expect(jest.getTimerCount()).toBeGreaterThan(0);
      expect(document.querySelector('[data-feedback-capture-stage]')).not.toBeNull();
      controller.abort('session ended');

      await expect(capture).rejects.toMatchObject({
        code: 'MD4H-FB-CAPTURE-002',
        message: expect.stringMatching(/cancelled/i),
      });
      expect(jest.getTimerCount()).toBe(0);
      expect(screenshot).not.toHaveBeenCalled();
      expect(document.querySelector('[data-feedback-capture-stage]')).toBeNull();
    } finally {
      if (originalDecode) {
        Object.defineProperty(HTMLImageElement.prototype, 'decode', originalDecode);
      } else {
        delete (HTMLImageElement.prototype as Partial<HTMLImageElement>).decode;
      }
      jest.useRealTimers();
    }
  });

  it('fails before cloning when intersecting rendered content exceeds the node ceiling', async () => {
    const root = document.createElement('div');
    const block = document.createElement('section');
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 5_000; index += 1) {
      fragment.append(document.createElement('span'));
    }
    block.append(fragment);
    root.append(block);
    document.body.append(root);
    Object.defineProperty(root, 'getBoundingClientRect', {
      value: () => rect(0, 0, 600, 100),
    });
    Object.defineProperty(block, 'getBoundingClientRect', {
      value: () => rect(0, 0, 600, 100),
    });
    const screenshot = jest.fn(async () => 'data:image/png;base64,AAAA');

    await expect(
      createModernScreenshotRasterizer(screenshot)({
        root,
        rectangle: { left: 0, top: 0, width: 300, height: 80 },
        scale: 1,
      })
    ).rejects.toMatchObject({
      code: 'MD4H-FB-CAPTURE-002',
      message: expect.stringMatching(/rendered-node.*limit/i),
    });
    expect(screenshot).not.toHaveBeenCalled();
    expect(document.querySelector('[data-feedback-capture-stage]')).toBeNull();
  });

  it('bounds resource inspection inside an otherwise cloneable staged block', async () => {
    const root = document.createElement('div');
    const block = document.createElement('section');
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 1_025; index += 1) {
      const image = document.createElement('img');
      image.src = `data:image/png;base64,${index}`;
      fragment.append(image);
    }
    block.append(fragment);
    root.append(block);
    document.body.append(root);
    Object.defineProperty(root, 'getBoundingClientRect', {
      value: () => rect(0, 0, 600, 100),
    });
    Object.defineProperty(block, 'getBoundingClientRect', {
      value: () => rect(0, 0, 600, 100),
    });
    const screenshot = jest.fn(async () => 'data:image/png;base64,AAAA');

    await expect(
      createModernScreenshotRasterizer(screenshot)({
        root,
        rectangle: { left: 0, top: 0, width: 300, height: 80 },
        scale: 1,
      })
    ).rejects.toMatchObject({
      code: 'MD4H-FB-CAPTURE-002',
      message: expect.stringMatching(/resource-reference.*limit/i),
    });
    expect(screenshot).not.toHaveBeenCalled();
    expect(document.querySelector('[data-feedback-capture-stage]')).toBeNull();
  });

  it.each(['canvas', 'shadow root'])(
    'fails explicitly for an intersecting opaque %s',
    async kind => {
      document.body.innerHTML = '<div id="root"><section>visible</section></div>';
      const root = document.getElementById('root') as HTMLElement;
      const block = root.firstElementChild as HTMLElement;
      Object.defineProperty(root, 'getBoundingClientRect', { value: () => rect(0, 0, 600, 200) });
      Object.defineProperty(block, 'getBoundingClientRect', { value: () => rect(0, 0, 600, 100) });
      if (kind === 'canvas') {
        const canvas = document.createElement('canvas');
        Object.defineProperty(canvas, 'getBoundingClientRect', {
          value: () => rect(0, 0, 200, 60),
        });
        block.append(canvas);
      } else {
        block.attachShadow({ mode: 'open' }).append(document.createElement('span'));
      }
      const screenshot = jest.fn(async () => 'data:image/png;base64,AAAA');

      await expect(
        createModernScreenshotRasterizer(screenshot)({
          root,
          rectangle: { left: 0, top: 0, width: 200, height: 60 },
          scale: 1,
        })
      ).rejects.toMatchObject({ code: 'MD4H-FB-CAPTURE-001' });
      expect(screenshot).not.toHaveBeenCalled();
      expect(document.querySelector('[data-feedback-capture-stage]')).toBeNull();
    }
  );

  it('rejects non-local rendered resources explicitly', () => {
    const root = document.createElement('div');
    root.innerHTML = '<img src="https://example.com/private.png">';

    expect(() => validateCaptureResources(root)).toThrow(
      expect.objectContaining({ code: 'MD4H-FB-CAPTURE-001' })
    );
  });

  it('accepts data, blob, and VS Code webview resource images', () => {
    const root = document.createElement('div');
    root.innerHTML = [
      '<img src="data:image/png;base64,AAAA">',
      '<img src="blob:https://webview.invalid/id">',
      '<img src="https://file+.vscode-resource.vscode-cdn.net/path/image.png">',
    ].join('');

    expect(() => validateCaptureResources(root)).not.toThrow();
  });
});

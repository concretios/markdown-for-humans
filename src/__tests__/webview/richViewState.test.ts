import {
  MAX_RICH_VIEW_POSITION,
  MAX_RICH_VIEW_SCROLL_TOP,
  RichViewStateController,
  parseRichViewState,
} from '../../webview/utils/richViewState';

type FrameCallback = () => void;

function createFrameHarness() {
  let nextId = 1;
  const callbacks = new Map<number, FrameCallback>();
  return {
    request: jest.fn((callback: FrameCallback) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    }),
    cancel: jest.fn((id: number) => {
      callbacks.delete(id);
    }),
    run(id: number) {
      const callback = callbacks.get(id);
      callbacks.delete(id);
      callback?.();
    },
    runAll() {
      for (const id of [...callbacks.keys()]) this.run(id);
    },
    get ids() {
      return [...callbacks.keys()];
    },
  };
}

describe('rich-view webview state', () => {
  it('accepts only the bounded versioned UI fields and drops document or Feedback payloads', () => {
    const parsed = parseRichViewState({
      version: 1,
      documentVersion: 14,
      selection: { from: 12, to: 18 },
      scrollTop: 987.4,
      content: '# must not survive',
      feedbackSession: { sessionId: 'must-not-survive' },
      editingLocked: true,
    });

    expect(parsed).toEqual({
      version: 1,
      documentVersion: 14,
      selection: { from: 12, to: 18 },
      scrollTop: 987.4,
    });
    expect(JSON.stringify(parsed)).not.toContain('content');
    expect(JSON.stringify(parsed)).not.toContain('feedback');
    expect(JSON.stringify(parsed)).not.toContain('Locked');
  });

  it.each([
    null,
    {},
    { version: 2, documentVersion: 1, selection: { from: 1, to: 1 }, scrollTop: 0 },
    { version: 1, documentVersion: -1, selection: { from: 1, to: 1 }, scrollTop: 0 },
    {
      version: 1,
      documentVersion: 1,
      selection: { from: 3, to: 2 },
      scrollTop: 0,
    },
    {
      version: 1,
      documentVersion: 1,
      selection: { from: MAX_RICH_VIEW_POSITION + 1, to: MAX_RICH_VIEW_POSITION + 1 },
      scrollTop: 0,
    },
    {
      version: 1,
      documentVersion: 1,
      selection: { from: 1, to: 1 },
      scrollTop: MAX_RICH_VIEW_SCROLL_TOP + 1,
    },
    {
      version: 1,
      documentVersion: 1,
      selection: { from: 1, to: 1 },
      scrollTop: Number.NaN,
    },
  ])('rejects malformed or unbounded state %#', value => {
    expect(parseRichViewState(value)).toBeNull();
  });

  it('restores a same-version selection and scroll, clamping positions to the host document', () => {
    const frames = createFrameHarness();
    const applySelection = jest.fn(() => true);
    const applyScroll = jest.fn();
    const controller = new RichViewStateController({
      initialState: {
        version: 1,
        documentVersion: 9,
        selection: { from: 30, to: 60 },
        scrollTop: 420,
      },
      readCurrentState: () => null,
      writeState: jest.fn(),
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
    });

    expect(
      controller.restore({
        documentVersion: 9,
        maximumPosition: 40,
        applySelection,
        applyScroll,
      })
    ).toBe(true);
    expect(applySelection).toHaveBeenCalledWith({ from: 30, to: 40 });
    expect(applyScroll).toHaveBeenCalledWith(420);

    frames.runAll();
    expect(applyScroll).toHaveBeenCalledTimes(2);
  });

  it('does not restore stale UI coordinates into a different document version', () => {
    const frames = createFrameHarness();
    const applySelection = jest.fn(() => true);
    const applyScroll = jest.fn();
    const controller = new RichViewStateController({
      initialState: {
        version: 1,
        documentVersion: 4,
        selection: { from: 8, to: 8 },
        scrollTop: 100,
      },
      readCurrentState: () => null,
      writeState: jest.fn(),
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
    });

    expect(
      controller.restore({
        documentVersion: 6,
        maximumPosition: 20,
        applySelection,
        applyScroll,
      })
    ).toBe(false);
    expect(applySelection).not.toHaveBeenCalled();
    expect(applyScroll).not.toHaveBeenCalled();
    expect(frames.ids).toEqual([]);
  });

  it('restores across the single host version increment caused by a teardown flush', () => {
    const frames = createFrameHarness();
    const applySelection = jest.fn(() => true);
    const controller = new RichViewStateController({
      initialState: {
        version: 1,
        documentVersion: 11,
        selection: { from: 17, to: 17 },
        scrollTop: 240,
      },
      readCurrentState: () => null,
      writeState: jest.fn(),
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
    });

    expect(
      controller.restore({
        documentVersion: 12,
        maximumPosition: 30,
        applySelection,
        applyScroll: jest.fn(),
      })
    ).toBe(true);
    expect(applySelection).toHaveBeenCalledWith({ from: 17, to: 17 });
  });

  it('cancels the delayed scroll correction when host recovery takes control', () => {
    const frames = createFrameHarness();
    const applyScroll = jest.fn();
    const controller = new RichViewStateController({
      initialState: {
        version: 1,
        documentVersion: 2,
        selection: { from: 3, to: 3 },
        scrollTop: 250,
      },
      readCurrentState: () => null,
      writeState: jest.fn(),
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
    });

    controller.restore({
      documentVersion: 2,
      maximumPosition: 10,
      applySelection: () => true,
      applyScroll,
    });
    controller.cancelPendingRestore();
    frames.runAll();

    expect(applyScroll).toHaveBeenCalledTimes(1);
    expect(frames.cancel).toHaveBeenCalledTimes(1);
  });

  it('coalesces hot selection and scroll events into one exact bounded state write', () => {
    const frames = createFrameHarness();
    const writeState = jest.fn();
    let current = {
      documentVersion: 22,
      selection: { from: 4, to: 7 },
      scrollTop: 321.75,
    };
    const controller = new RichViewStateController({
      initialState: null,
      readCurrentState: () => current,
      writeState,
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
    });

    controller.schedulePersist();
    controller.schedulePersist();
    current = {
      documentVersion: 23,
      selection: { from: 9, to: 9 },
      scrollTop: 654.25,
    };

    expect(frames.request).toHaveBeenCalledTimes(1);
    frames.runAll();
    expect(writeState).toHaveBeenCalledTimes(1);
    expect(writeState).toHaveBeenCalledWith({
      version: 1,
      documentVersion: 23,
      selection: { from: 9, to: 9 },
      scrollTop: 654.25,
    });
  });

  it('flushes the last frame synchronously for page teardown and cancels queued work', () => {
    const frames = createFrameHarness();
    const writeState = jest.fn();
    const controller = new RichViewStateController({
      initialState: null,
      readCurrentState: () => ({
        documentVersion: 3,
        selection: { from: 5, to: 5 },
        scrollTop: 88,
      }),
      writeState,
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
    });

    controller.schedulePersist();
    expect(controller.flushPersist()).toBe(true);
    frames.runAll();

    expect(frames.cancel).toHaveBeenCalledTimes(1);
    expect(writeState).toHaveBeenCalledTimes(1);
  });
});

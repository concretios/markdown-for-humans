/**
 * @jest-environment node
 *
 * Exercises the yielder against Node's real MessageChannel, so port start,
 * asynchronous delivery and closing are not only modelled by a fake.
 */
import { createTaskYield } from '../../../webview/highlighting/client';

const macrotask = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn++) await macrotask();
};

describe('message-task yielder', () => {
  it('runs a posted task asynchronously, after the current task', async () => {
    const yielder = createTaskYield();
    const task = jest.fn();
    yielder.post(task);
    expect(task).not.toHaveBeenCalled();
    await settle();
    expect(task).toHaveBeenCalledTimes(1);
    yielder.dispose();
  });

  it('does not run a cancelled task, and accepts a re-post from inside a task', async () => {
    const yielder = createTaskYield();
    const cancelled = jest.fn();
    yielder.post(cancelled)();
    let runs = 0;
    const repeating = (): void => {
      if (++runs < 3) yielder.post(repeating);
    };
    yielder.post(repeating);
    await settle();
    expect(cancelled).not.toHaveBeenCalled();
    expect(runs).toBe(3);
    yielder.dispose();
  });

  it('drops pending and later tasks after disposal', async () => {
    const yielder = createTaskYield();
    const pending = jest.fn();
    yielder.post(pending);
    yielder.dispose();
    const later = jest.fn();
    yielder.post(later);
    await settle();
    expect(pending).not.toHaveBeenCalled();
    expect(later).not.toHaveBeenCalled();
  });
});

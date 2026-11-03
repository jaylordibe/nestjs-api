import { createConcurrencyLimit } from './concurrency-limit.util';

// A task the test finishes by hand, so "in flight" is exact, not timed.
function controllableTask(): {
  run: () => Promise<string>;
  finish: () => void;
  fail: () => void;
} {
  let finish!: () => void;
  let fail!: () => void;
  const done = new Promise<string>((resolve, reject) => {
    finish = () => resolve('done');
    fail = () => reject(new Error('task failed'));
  });
  return { run: () => done, finish, fail };
}

const tick = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

describe('createConcurrencyLimit', () => {
  it('never runs more than the limit at once, and starts waiters in order', async () => {
    const limited = createConcurrencyLimit(2);
    const [first, second, third, fourth] = [0, 1, 2, 3].map(() =>
      controllableTask(),
    ) as [
      ReturnType<typeof controllableTask>,
      ReturnType<typeof controllableTask>,
      ReturnType<typeof controllableTask>,
      ReturnType<typeof controllableTask>,
    ];
    const tasks = [first, second, third, fourth];
    const started: number[] = [];
    const results = tasks.map((task, index) =>
      limited(() => {
        started.push(index);
        return task.run();
      }),
    );

    await tick();
    expect(started).toEqual([0, 1]);

    second.finish();
    await tick();
    expect(started).toEqual([0, 1, 2]);

    first.finish();
    third.finish();
    await tick();
    expect(started).toEqual([0, 1, 2, 3]);
    fourth.finish();
    await expect(Promise.all(results)).resolves.toEqual([
      'done',
      'done',
      'done',
      'done',
    ]);
  });

  it('frees the slot when a task fails', async () => {
    const limited = createConcurrencyLimit(1);
    const failing = controllableTask();
    const next = controllableTask();
    const first = limited(failing.run);
    let isNextStarted = false;
    const second = limited(() => {
      isNextStarted = true;
      return next.run();
    });

    failing.fail();
    await expect(first).rejects.toThrow('task failed');
    await tick();
    expect(isNextStarted).toBe(true);
    next.finish();
    await expect(second).resolves.toBe('done');
  });
});

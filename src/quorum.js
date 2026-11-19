import { isNewer } from './store.js';

// Start every task at once and wait until `needed` of them have SUCCEEDED
// (a task succeeds if its promise resolves). We do not wait for the slow ones:
// as soon as enough answers are in, we resolve. If too few succeed, we resolve
// when every task has finished. This function never rejects.
//   tasks:  functions that return a promise
//   result: { successes: [...values], failures: [...errors] } at the moment we stopped waiting
export function firstSuccesses(tasks, needed) {
  return new Promise((resolve) => {
    const successes = [];
    const failures = [];
    let pending = tasks.length;
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      resolve({ successes: [...successes], failures: [...failures] });
    };

    if (tasks.length === 0 || needed <= 0) return finish();

    for (const task of tasks) {
      Promise.resolve()
        .then(task)
        .then(
          (value) => void successes.push(value),
          (error) => void failures.push(error),
        )
        .then(() => {
          pending--;
          if (successes.length >= needed || pending === 0) finish();
        });
    }
  });
}

// Out of several records (live value or tombstone, or undefined for "I have
// nothing"), pick the newest one by version. Same rule as everywhere else:
// higher version wins, the writer's name breaks a tie.
export function newestRecord(records) {
  let best;
  for (const record of records) {
    if (record !== undefined && isNewer(record, best)) best = record;
  }
  return best;
}
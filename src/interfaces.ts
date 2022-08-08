import { ForbiddenFlagsFn, Task } from 'graphile-worker';

export type WrapTaskFn = (t: Task) => Task;

export interface RateLimiter {
  getForbiddenFlags: ForbiddenFlagsFn;
  wrapTask: WrapTaskFn;
}

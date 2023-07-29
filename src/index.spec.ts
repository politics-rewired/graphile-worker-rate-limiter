import { quickAddJob, runTaskListOnce, Task } from 'graphile-worker';
import * as Redis from 'ioredis';
import { Pool, PoolClient } from 'pg';

import { getLeakyBucketRateLimiter } from './LeakyBucket';

describe('integration test', () => {
  let redis: Redis.Redis;
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    redis = new Redis(process.env.REDIS_URL);
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    client = await pool.connect();

    await redis.flushall();
    await pool.query('delete from graphile_worker.jobs');
  });

  afterAll(async () => {
    client.release();
    await pool.end();
    await redis.quit();
  });

  test('a whole bunch of things', async () => {
    const rateLimiter = getLeakyBucketRateLimiter({
      redis,
      bucketTypes: {
        // Drain at 3 invocations per 1.5 seconds
        bucket: {
          capacity: 6,
          drainCount: 3,
          drainInterval: 1500,
        },
      },
    });

    let highestN = 0;

    const callback = jest.fn();

    const task: Task = rateLimiter.wrapTask(async (payload: any) => {
      callback();
      if (payload.n > highestN) {
        highestN = payload.n;
      }
    });

    const runWorker = () =>
      runTaskListOnce(
        { pgPool: pool, forbiddenFlags: rateLimiter.getForbiddenFlags },
        { task },
        client,
      );

    // if i add 7 jobs, 6 should be run after 100ms, but the 7th shouldnt be run until after 1.1 seconds
    for (const n of [...Array(7)].map((_, idx) => idx)) {
      await quickAddJob(
        { pgPool: pool },
        'task',
        { n: n + 1 },
        { flags: ['bucket:a'] },
      );
    }

    for (const _ of [...Array(7)]) {
      await runWorker();
    }

    expect(callback).toHaveBeenCalledTimes(6);
    expect(highestN).toBe(6);

    await rateLimiter.drainAllBucketsOnce();
    await runWorker();

    expect(callback).toHaveBeenCalledTimes(7);
    expect(highestN).toBe(7);

    await rateLimiter.stop();
  });
});

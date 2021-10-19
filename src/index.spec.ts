import { run, Task } from 'graphile-worker';
import * as Redis from 'ioredis';
import { Pool } from 'pg';

import { getLeakyBucketRateLimiter } from './LeakyBucket';

const sleep = (n: number) => new Promise((resolve) => setTimeout(resolve, n));

describe('integration test', () => {
  let redis: Redis.Redis;
  let pool: Pool;

  beforeAll(async () => {
    redis = new Redis(process.env.REDIS_URL);
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

    await redis.flushall();
    await pool.query('delete from graphile_worker.jobs');
  });

  afterAll(async () => {
    await pool.end();
    await redis.quit();
  });

  test('a whole bunch of things', async () => {
    const rateLimiter = getLeakyBucketRateLimiter({
      redis,
      bucketTypes: {
        // 6 invocations a second
        bucket: {
          capacity: 6,
          drainCount: 3,
          drainInterval: 1000,
        },
      },
    });

    const task: Task = async (payload: any) => {
      if (payload.n > highestN) {
        highestN = payload.n;
      }
    };

    const runningWorker = await run({
      taskList: {
        task: rateLimiter.wrapTask(task),
      },
      pgPool: pool,
      forbiddenFlags: rateLimiter.getForbiddenFlags,
      pollInterval: 20, // need a smaller poll interval
    });

    let highestN = 0;

    // if i add 7 jobs, 6 should be run after 100ms, but the 7th shouldnt be run until after 1.1 seconds
    await Promise.all(
      [...Array(7)].map((_, n) => {
        runningWorker.addJob('task', { n: n + 1 }, { flags: ['bucket:a'] });
      }),
    );

    await sleep(250);

    expect(highestN).toBe(6);

    await sleep(1500);
    expect(highestN).toBe(7);

    await rateLimiter.stop();
    await runningWorker.stop();
  });
});

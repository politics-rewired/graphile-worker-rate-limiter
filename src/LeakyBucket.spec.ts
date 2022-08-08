import * as Redis from 'ioredis';

import {
  getLeakyBucketRateLimiter,
  handleBucketUse,
  LeakyBucketSpec,
  LeakyBucketSpecialKeys,
  makeDrainBucket,
} from './LeakyBucket';

const sleep = (n: number) => new Promise((resolve) => setTimeout(resolve, n));

const redis = new Redis();

describe('make drain bucket', () => {
  beforeAll(async () => {
    await redis.flushall();
  });

  test('no double drain on simultaneous fire', async () => {
    // drain 1 every 5 seconds, allow up to 100
    const bucketSpec: LeakyBucketSpec = {
      capacity: 100,
      drainInterval: 5000, // 5 seconds
      drainCount: 1,
    };

    // simulate 10 runs
    await Promise.all(
      new Array(10)
        .fill(true)
        .map(() =>
          handleBucketUse(
            redis,
            'double-drain-test',
            'instance-one',
            bucketSpec,
          ),
        ),
    );

    // Expect bucket count to be 10
    const beforeDrain = await redis.get(
      `double-drain-test:instance-one:${LeakyBucketSpecialKeys.BucketCurrentCapacity}`,
    );
    expect(parseInt(beforeDrain!)).toBe(10);

    // Run the drain fn twice
    const drainFn = makeDrainBucket(redis, 'double-drain-test', bucketSpec);
    await drainFn();
    await drainFn();

    // Expect bucket count to be 9 because of lock
    const afterDrain = await redis.get(
      `double-drain-test:instance-one:${LeakyBucketSpecialKeys.BucketCurrentCapacity}`,
    );
    expect(parseInt(afterDrain!)).toBe(9);
  });

  test('drain lock released for drain interval', async () => {
    // drain 1 every 5 seconds, allow up to 100
    const bucketSpec: LeakyBucketSpec = {
      capacity: 100,
      drainInterval: 2000, // 5 seconds
      drainCount: 1,
    };

    // simulate 10 runs
    await Promise.all(
      new Array(10)
        .fill(true)
        .map(() =>
          handleBucketUse(
            redis,
            'after-interval-drain-test',
            'instance-one',
            bucketSpec,
          ),
        ),
    );

    // Expect bucket count to be 10
    const beforeDrain = await redis.get(
      `after-interval-drain-test:instance-one:${LeakyBucketSpecialKeys.BucketCurrentCapacity}`,
    );
    expect(parseInt(beforeDrain!)).toBe(10);

    // Run the drain fn twice
    const drainFn = makeDrainBucket(
      redis,
      'after-interval-drain-test',
      bucketSpec,
    );
    await drainFn();

    await sleep(2000);
    await drainFn();

    // Expect bucket count to be 8 because drain interval passed
    const afterDrain = await redis.get(
      `after-interval-drain-test:instance-one:${LeakyBucketSpecialKeys.BucketCurrentCapacity}`,
    );
    expect(parseInt(afterDrain!)).toBe(8);
  });
});

describe('handle bucket use', () => {
  test('can overload bucket', async () => {
    const BUCKET_TYPE = 'simple-overload';
    const BUCKET_NAME = 'one';

    // one per second
    const bucketSpec: LeakyBucketSpec = {
      capacity: 1,
      drainInterval: 1000,
      drainCount: 1,
    };

    await handleBucketUse(redis, BUCKET_TYPE, BUCKET_NAME, bucketSpec);
    const forbiddenFlags = await redis.smembers(
      LeakyBucketSpecialKeys.OverloadedBuckets,
    );

    expect(
      forbiddenFlags.includes(`${BUCKET_TYPE}:${BUCKET_NAME}`),
    ).toBeTruthy();
  });
});

describe('integration', () => {
  test('can only run one per second', async () => {
    const BUCKET_TYPE = 'integration';
    const BUCKET_NAMES = ['one', 'two', 'three'];

    const BUCKET_SPEC: LeakyBucketSpec = {
      capacity: 1,
      drainInterval: 1000,
      drainCount: 1,
    };

    const rateLimiter = getLeakyBucketRateLimiter({
      redis,
      bucketTypes: {
        [BUCKET_TYPE]: BUCKET_SPEC,
      },
    });

    await Promise.all([
      handleBucketUse(redis, BUCKET_TYPE, 'one', BUCKET_SPEC),
      handleBucketUse(redis, BUCKET_TYPE, 'two', BUCKET_SPEC),
      handleBucketUse(redis, BUCKET_TYPE, 'three', BUCKET_SPEC),
    ]);

    // First, check they are all forbidden
    const initialForbidden = (await rateLimiter.getForbiddenFlags()) ?? [];
    expect(
      BUCKET_NAMES.every((name) =>
        initialForbidden.includes(`${BUCKET_TYPE}:${name}`),
      ),
    ).toBe(true);

    // And then we wait a bit more than one sec
    await sleep(1100);

    // Now, none should be
    const forbiddenAfterASecond = (await rateLimiter.getForbiddenFlags()) ?? [];
    expect(
      BUCKET_NAMES.every(
        (name) => !forbiddenAfterASecond.includes(`${BUCKET_TYPE}:${name}`),
      ),
    ).toBe(true);
  });
});

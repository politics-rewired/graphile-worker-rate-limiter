import { ForbiddenFlagsFn, JobHelpers, Task } from 'graphile-worker';
import * as Redis from 'ioredis';

import { RateLimiter, WrapTaskFn } from './interfaces';

export enum LeakyBucketSpecialKeys {
  OverloadedBuckets = 'overloaded-buckets',
  BucketExpiryCheck = 'ttl',
  BucketCurrentCapacity = 'count',
  BucketDrainLock = 'drain-lock',
}

export interface LeakyBucketSpec {
  capacity: number;
  drainInterval: number;
  drainCount: number;
}

interface LeakyBucketRateLimiterOptions {
  redis: Redis.Redis;
  bucketTypes: {
    [name: string]: LeakyBucketSpec;
  };
}

interface LeakyBucketRateLimiter extends RateLimiter {
  stop: () => void;
}

/**
 * makeDrainBucket returns a drain function that drains all buckets of bucketTypeName if it acquires the lock
 * @param bucketTypeName the name of the type of bucket to create the drain function for
 * @param bucketSpec the details of the bucket's drainCount and capacity
 */
export const makeDrainBucket = (
  redis: Redis.Redis,
  bucketTypeName: string,
  bucketSpec: LeakyBucketSpec,
): (() => Promise<void>) => {
  return async () => {
    const bucketsToDrain = await redis.smembers(bucketTypeName);

    await Promise.all(
      bucketsToDrain.map(async (bucketName) => {
        // for each, try to acquire the lock (skipping for first test fail)
        const key = `${bucketTypeName}:${bucketName}:${LeakyBucketSpecialKeys.BucketDrainLock}`;
        const randomValue = Math.random().toString();

        await redis
          .multi()
          .setnx(key, randomValue)
          .pexpire(key, bucketSpec.drainInterval - 10)
          .exec();

        const lockVal = await redis.get(key);
        console.log('lockVal', lockVal);
        console.log('randomValue', randomValue);

        if (lockVal !== null && lockVal === randomValue) {
          const newVal = await redis.decrby(
            `${bucketTypeName}:${bucketName}:${LeakyBucketSpecialKeys.BucketCurrentCapacity}`,
            bucketSpec.drainCount,
          );

          console.log('newVal', newVal);

          // remove from overloaded buckets if now below capacity
          if (newVal < bucketSpec.capacity) {
            await redis.srem(
              LeakyBucketSpecialKeys.OverloadedBuckets,
              `${bucketTypeName}:${bucketName}`,
            );
          }

          // delete entirely if totally empty
          if (newVal < 0) {
            await redis
              .multi()
              .del(
                `${bucketTypeName}:${bucketName}:${LeakyBucketSpecialKeys.BucketCurrentCapacity}`,
              )
              .srem(bucketTypeName, bucketName)
              .exec();
          }
        }
      }),
    );
  };
};

export const getLeakyBucketRateLimiter = (
  opts: LeakyBucketRateLimiterOptions,
): LeakyBucketRateLimiter => {
  const { redis, bucketTypes } = opts;

  /**
   * For each task invocation, we want to record the fact that the tasks queues were used
   * We then want to check if the task is overloaded and if so, record that fact
   */
  const wrapTask: WrapTaskFn = (t: Task): Task => {
    return async (payload: unknown, helpers: JobHelpers) => {
      const flags = Object.keys(helpers.job.flags ?? {});
      if (flags.length > 0) {
        await Promise.all(
          flags
            .map((flag) => flag.split(':'))
            .filter((flag) => flag.length === 2)
            .filter((flag) => bucketTypes[flag[0]])
            .map((flag) =>
              handleBucketUse(redis, flag[0], flag[1], bucketTypes[flag[0]]),
            ),
        );
      }

      return await t(payload, helpers);
    };
  };

  /**
   * The overloaded queues are just the set of queues currently recorded as overloaded
   */
  const getForbiddenFlags: ForbiddenFlagsFn = async () => {
    return await redis.smembers(LeakyBucketSpecialKeys.OverloadedBuckets);
  };

  const intervals = Object.keys(bucketTypes).map((bucketName) =>
    setInterval(
      makeDrainBucket(redis, bucketName, bucketTypes[bucketName]),
      bucketTypes[bucketName].drainInterval,
    ),
  );

  const stop = () => {
    for (const interval of intervals) {
      clearInterval(interval);
    }
  };

  return { wrapTask, getForbiddenFlags, stop };
};

export const handleBucketUse = async (
  redis: Redis.Redis,
  bucketType: string,
  bucketName: string,
  bucketSpec: LeakyBucketSpec,
) => {
  const [, incResult] = await redis
    .multi()
    // add the bucket to the array of buckets for this type
    .sadd(bucketType, bucketName)
    // increment the count
    .incr(
      `${bucketType}:${bucketName}:${LeakyBucketSpecialKeys.BucketCurrentCapacity}`,
    )
    .exec();

  const [, bucketCount] = incResult as [null, number];

  if (bucketCount >= bucketSpec.capacity) {
    await redis.sadd(
      LeakyBucketSpecialKeys.OverloadedBuckets,
      `${bucketType}:${bucketName}`,
    );
  }
};

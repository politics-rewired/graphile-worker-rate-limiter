# Graphile Worker Rate Limiter

A set of utilities to add rate limiting to (graphile-worker)[https://github.com/graphile/worker/]. For context, see (this issue)[https://github.com/graphile/worker/issues/118].

## Usage

Although the interfaces exist to support other rate limiters, right now a Redis based implementation of the Leaky Bucket algorithm is provided.

```typescript
import { run } from 'graphile-worker';
import * as Redis from 'ioredis';
import { getLeakyBucketRateLimiter } from 'graphile-worker-rate-limiter';

const redis = new Redis();
const rateLimiter = getLeakyBucketRateLimiter({
  redis,
  bucketTypes: {
    'send-message-global': {
      capacity: 3000,
      drainInterval: 30 * 1000,
      drainCount: 1500
    },
    'send-message-client': {
      capacity: 1000,
      drainInterval: 15 * 1000,
      drainCount: 500
    },
    'send-message-phone': {
      capacity: 6,
      drainInterval: 500,
      drainCount: 3
    }
  }
});

const worker = await run({
  // graphile worker options as normal, except...
  forbiddenFlags: rateLimiter.getForbiddenFlags,
  taskList: {
    'send-message': wrapTask(sendMessage)
  }
});
```

Now, you can do:
```typescript
await worker.addJob('send-message', payload, { 
  flags: [
    'send-message-global',
    'send-message-client:b412d632-e004-11ea-87d0-0242ac130003',
    'send-message-phone:+12025550320'
   ] 
});
```

Or:

```sql
perform graphile_worker.add_job(
  'send-message',
  payload,
  flags => ARRAY[
    'send-message-global',
    'send-message-client:b412d632-e004-11ea-87d0-0242ac130003',
    'send-message-phone:+12025550320'
  ]
);
```

And `graphile-worker-rate-limiter` will ensure your jobs do not run more often than allowed by your bucket specification.

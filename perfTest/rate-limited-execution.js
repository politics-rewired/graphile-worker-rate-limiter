const worker = require('graphile-worker');
const Redis = require('ioredis');
const GraphileWorkerRateLimiter = require('../dist/index');

const redis = new Redis();

const STANDARD = {
  capacity: 4000,
  drainInterval: 100,
  drainCount: 100,
};

const _SLOW = {
  capacity: 4000,
  drainInterval: 5000,
  drainCount: 2,
};

const rateLimiter = GraphileWorkerRateLimiter.getLeakyBucketRateLimiter({
  redis,
  bucketTypes: {
    bucket: STANDARD,
  },
});

const logIf999 = ({ id }) => {
  if (id === 999) {
    console.log('Found 999!');
  }
};

const SHOULD_LOG_FORBIDDEN_FLAGS = false;
const getAndLogForbiddenFlags = async () => {
  const forbiddenFlags = await rateLimiter.getForbiddenFlags();
  if (SHOULD_LOG_FORBIDDEN_FLAGS && forbiddenFlags.length > 0) {
    console.log(forbiddenFlags);
  }
  return forbiddenFlags;
};

worker
  .runOnce({
    connectionString: process.env.PERF_DATABASE_URL,
    taskList: {
      log_if_999: rateLimiter.wrapTask(logIf999),
    },
    forbiddenFlags: getAndLogForbiddenFlags,
    concurrency: 10,
  })
  .then(process.exit);

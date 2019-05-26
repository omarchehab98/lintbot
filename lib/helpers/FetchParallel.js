const AbortController = require('abort-controller');
const TimeoutError = require('../errors/TimeoutError');
const invariant = require('./invariant');

/**
 * @param {object} options
 * @param {number} options.limit max number of requests in parallel
 * @param {number} options.retry max number of retries
 * @param {(Error) => boolean} options.shouldRetry function that decides whether or not a request
 * should be retried based on the error
 * @param {number} options.timeoutMs max time a request can be pending before it should timeout
 * @example
 * const dispatcher = new FetchParallel({
 *   limit: 4,
 *   retry: 3,
 *   timeoutMs: 2000,
 *   shouldRetry: (err) => err instanceof TimeoutError,
 * });
 *
 * const resolveJob = (msg, time) => (signal) => new Promise((resolve) => setTimeout(() => {
 *   log(msg);
 *   if (!signal.aborted) {
 *     resolve();
 *   }
 * }, time));
 *
 * const rejectJob = (msg, time) => (signal) => {
 *   return new Promise((resolve, reject) => setTimeout(() => {
 *     if (!signal.aborted) {
 *       reject(new Error('Boo hoo'));
 *     }
 *   }, time))
 * };
 *
 * dispatcher.add(resolveJob('1', 1000));
 * dispatcher.add(resolveJob('2', 1500));
 * dispatcher.add(resolveJob('3', 500));
 * dispatcher.add(rejectJob('4', 3000));
 * dispatcher.add(resolveJob('5', 600));
 * dispatcher.add(resolveJob('6', 1200));
 * dispatcher.add(resolveJob('7', 1300));
 * dispatcher.add(resolveJob('8', 300));
 */
class FetchParallel {
  constructor({
    limit,
    retry = 3,
    shouldRetry = err => err instanceof TimeoutError,
    timeoutMs = 15000,
  } = {}) {
    this.limit = limit;
    this.timeoutMs = timeoutMs;
    this.retryLimit = retry;
    this.shouldRetry = shouldRetry;
    this.waitingJobs = [];
    this.pendingJobs = {};
    this.jobIdCounter = 0;
    this.yieldPromise = null;
    this.yieldResolve = null;
    this.yieldReject = null;
    this.yieldErrors = [];
  }

  /**
   * Adds the job to the queue and executes it if the parallel limit has not been reached.
   *
   * @param {(AbortSignal) => Promise} job
   * @example
   * dispatcher.add((signal) => fetch('https://...', { signal }))
   */
  add(job) {
    if (this.waitingJobsCount === 0 && this.pendingJobsCount === 0) {
      this.yieldPromise = new Promise((resolve, reject) => {
        this.yieldResolve = resolve;
        this.yieldReject = reject;
      });
      this.yieldErrors = [];
    }
    this.waitingJobs.unshift(job);
    this.tryDispatch();
  }

  /**
   * Resolves when all pending jobs resolve.
   *
   * @returns {Promise}
   * @example
   * dispatcher.add((signal) => fetch('https://...', { signal }))
   * dispatcher.add((signal) => fetch('https://...', { signal }))
   * dispatcher.add((signal) => fetch('https://...', { signal }))
   * dispatcher.pendingJobsCount // => 3
   * await dispatcher.yield()
   * dispatcher.pendingJobsCount // => 0
   */
  yield() {
    return this.yieldPromise;
  }

  get pendingJobsCount() {
    const pending = Object.keys(this.pendingJobs).length;
    return pending;
  }

  get waitingJobsCount() {
    return this.waitingJobs.length;
  }

  tryDispatch() {
    if (this.waitingJobsCount > 0 && this.pendingJobsCount < this.limit) {
      this.dispatch(this.newJobId());
    } else if (this.pendingJobsCount === 0) {
      if (this.yieldPromise) {
        if (this.yieldErrors.length === 0) {
          this.yieldResolve();
        } else {
          this.yieldReject(this.yieldErrors);
        }
        this.yieldPromise = null;
        this.yieldResolve = null;
        this.yieldReject = null;
        this.yieldErrors = [];
      }
    }
  }

  dispatch(jobId) {
    if (this.pendingJobs[jobId] === undefined) {
      this.pendingJobs[jobId] = {
        id: jobId,
        fn: this.waitingJobs.pop(),
        retry: 0,
        timeoutId: null,
        abortController: null,
      };
    }

    const job = this.pendingJobs[jobId];
    job.retry += 1;
    job.timeoutId = setTimeout(
      () => this.timeout(jobId, job.retry),
      this.timeoutMs,
    );
    job.abortController = new AbortController();
    job
      .fn(job.abortController.signal)
      .then((...args) => this.resolve(jobId, args))
      .catch(err => this.reject(jobId, err));
  }

  resolve(jobId) {
    const job = this.pendingJobs[jobId];
    invariant(
      typeof job === 'object',
      `Job ${jobId} is not an object, it is ${typeof job}`,
    );

    clearTimeout(job.timeoutId);
    delete this.pendingJobs[jobId];
    this.tryDispatch();
  }

  reject(jobId, err) {
    const job = this.pendingJobs[jobId];
    invariant(
      typeof job === 'object',
      `Job ${jobId} is not an object, it is ${typeof job}`,
    );

    clearTimeout(job.timeoutId);
    if (this.shouldRetry(err) && job.retry < this.retryLimit) {
      this.dispatch(jobId);
    } else {
      this.yieldErrors.push(err);
    }
  }

  timeout(jobId) {
    const job = this.pendingJobs[jobId];
    const err = new TimeoutError(job);

    job.abortController.abort(err);
    if (this.shouldRetry(err) && job.retry < this.retryLimit) {
      this.dispatch(jobId);
    } else {
      this.yieldErrors.push(err);
    }
  }

  newJobId() {
    const jobId = this.jobIdCounter;
    this.jobIdCounter += 1;
    return jobId;
  }
}

module.exports = FetchParallel;

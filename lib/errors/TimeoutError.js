class TimeoutError extends Error {
  constructor(job) {
    super(`Job ${job.id} timed out after ${job.retry} attempts`);
  }
}

module.exports = TimeoutError;

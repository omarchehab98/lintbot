class FetchError extends Error {
  constructor(res) {
    super(`HTTP request response ${res.status} ${res.statusText}`);
    this.response = res;
  }
}

module.exports = FetchError;

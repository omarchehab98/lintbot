function invariant(condition, message) {
  if (!condition) {
    const error = new Error(message || invariant.defaultMessage);
    error.name = 'Invariant Violation';
    throw error;
  }
}

invariant.defaultMessage = 'Invariant error thrown, application is in an unexpected state.';

module.exports = invariant;

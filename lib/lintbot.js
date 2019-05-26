#!/usr/bin/env node

const adapters = require('./adapters');
const FetchParallel = require('./helpers/FetchParallel');
const invariant = require('./helpers/invariant');
const TimeoutError = require('./errors/TimeoutError');
const FetchError = require('./errors/FetchError');
async function lintbot({
  CLIEngine,
  limit = 5,
  retry = 3,
  timeoutMs = 15000,
  extensions = ['.js'],
  logger = console,
} = {}) {
  global.Logger = logger;

  const usage = 'usage: lintbot [-d] gitlab [<config>]';

  invariant(
    typeof CLIEngine === 'function',
    'CLIEngine is not defined, you can import it from eslint `require("eslint").CLIEngine`',
  );

  try {
    // pop path to `node`
    process.argv.shift();
    // pop path to `lintbot`
    process.argv.shift();

    // Move switches to the end of the array while preserving the order of arguments
    process.argv.sort((a, b) => a.startsWith('-') - b.startsWith('-'));

    if (process.argv.includes('-h') || process.argv.includes('--help')) {
      Logger.log(usage);
      return 0;
    }

    const dryRun = process.argv.includes('-d');

    // Remove switches from argv
    process.argv = process.argv.filter(a => !a.startsWith('-'));

    if (process.argv.length < 1) {
  Logger.error(usage);
  return 1;
    }

    const vcpName = process.argv[0];
    invariant(
      Object.keys(adapters).includes(vcpName),
      `Unsupported version control provider "${vcpName}"`,
    );
    const VCPAPI = adapters[vcpName];

    // Eslint configuration file
    const configFile = process.argv[1];

    const vcpAPI = new VCPAPI({
      dryRun,
    });

    const linter = new CLIEngine({
      configFile,
    });

    const dispatcher = new FetchParallel({
      limit,
      timeoutMs,
      retry,
      shouldRetry: err => err instanceof TimeoutError
        || (err instanceof FetchError && err.status >= 500 && err.status < 600),
    })

    dispatcher.add(async (getSuggestIdsSignal) => {
      vcpAPI.attachSignal(getSuggestIdsSignal);
      const oldSuggestionIds = await vcpAPI.fetchSuggestionIds();

      oldSuggestionIds.forEach((suggestionId) => {
        dispatcher.add(async (deleteSuggestionSignal) => {
          vcpAPI.attachSignal(deleteSuggestionSignal);
          await vcpAPI.deleteSuggestion(suggestionId);
        });
      });
    });

    await dispatcher.yield();

    dispatcher.add(async (fetchFilePathsSignal) => {
      vcpAPI.attachSignal(fetchFilePathsSignal);
      const filePaths = await vcpAPI.fetchFilePaths()
        .then(files => files.filter(file => extensions.some(ext => file.endsWith(ext))));

      filePaths.forEach((path) => {
        dispatcher.add(async (fetchFileSignal) => {
          vcpAPI.attachSignal(fetchFileSignal);
          const file = await vcpAPI.fetchFile(path);

          const lintReport = linter.executeOnText(file, path);

          const suggestions = lintReport.results
            .filter(
              fileResult => fileResult.errorCount > 0 || fileResult.warningCount > 0,
            )
            .map(fileResult => fileResult.messages)
            .reduce(
              (messages, fileMessages) => messages.concat(fileMessages),
              [],
            )
            .map(message => ({
              line: message.line,
              message: vcpAPI.constructor.suggestionMessage(file, message),
            }));

          suggestions.forEach(async (suggestion) => {
            dispatcher.add(async (suggestChangeSignal) => {
              vcpAPI.attachSignal(suggestChangeSignal);
              await vcpAPI.suggestChange(path, suggestion);
            });
          });
        });
      });
    });

    await dispatcher.yield();

    return 0;
  } catch (err) {
    throw err;
  }
}

module.exports = lintbot;

if (require.main === module) {
  lintbot()
    .then(code => process.exit(code))
    .catch((err) => {
      Logger.error(err, err.stackTrace);
      process.exit(1);
    });
}

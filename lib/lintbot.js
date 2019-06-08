#!/usr/bin/env node

const vcpByName = require('./vcp');
const FetchParallel = require('./helpers/FetchParallel');
const invariant = require('./helpers/invariant');
const TimeoutError = require('./errors/TimeoutError');
const FetchError = require('./errors/FetchError');
const eslintMessage = require('./lint/eslint');

async function lintbot({
  CLIEngine,
  limit = 5,
  retry = 3,
  timeoutMs = 15000,
  extensions = ['.js'],
  logger = console,
} = {}) {
  global.Logger = logger;

  const usage = 'usage: lintbot [-d] (github | gitlab) [<config>]';

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
      Object.keys(vcpByName).includes(vcpName),
      `Unsupported version control provider "${vcpName}"`,
    );
    const VCP = vcpByName[vcpName];

    // Eslint configuration file
    const configFile = process.argv[1];

    const vcp = new VCP({
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
    });

    dispatcher.add(async (getSuggestIdsSignal) => {
      vcp.attachSignal(getSuggestIdsSignal);
      const oldSuggestionIds = await vcp.fetchSuggestionIds();

      oldSuggestionIds.forEach((suggestionId) => {
        dispatcher.add(async (deleteSuggestionSignal) => {
          vcp.attachSignal(deleteSuggestionSignal);
          await vcp.deleteSuggestion(suggestionId);
        });
      });
    });

    await dispatcher.yield();

    dispatcher.add(async (fetchFilePathsSignal) => {
      vcp.attachSignal(fetchFilePathsSignal);

      const filePaths = (await vcp.fetchFilePaths())
        .filter(file => extensions.some(ext => file.endsWith(ext)));

      if (vcp.beforeSuggestionsStart) {
        await vcp.beforeSuggestionsStart();
      }

      filePaths.forEach((path) => {
        dispatcher.add(async (fetchFileSignal) => {
          vcp.attachSignal(fetchFileSignal);
          const file = await vcp.fetchFile(path);

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
              message: eslintMessage(VCP.suggestions, file, message),
            }));

          suggestions.forEach(async (suggestion) => {
            dispatcher.add(async (suggestChangeSignal) => {
              vcp.attachSignal(suggestChangeSignal);
              await vcp.suggestChange(path, suggestion);
            });
          });
        });
      });
    });

    await dispatcher.yield();

    if (vcp.afterSuggestionsEnd) {
      await vcp.afterSuggestionsEnd();
    }

    return 0;
  } catch (err) {
    throw err;
  }
}

module.exports = lintbot;

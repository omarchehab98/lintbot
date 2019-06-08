const defaultIndex = (i, d) => (i >= 0 ? i : d);
const countNewLines = s => (s.match(/\n/g) || []).length;

function suggestionMessage({
  suggestionSnippet,
  suggestionSnippetMultiLine,
}, file, result) {
  const {
    message,
    severity,
    ruleId,
    fix,
  } = result;

  let suggestionSnippetText = '';

  if (fix) {
    const [start, end] = fix.range;
    const fileBeforeStart = file.substring(0, start);
    const fileAfterEnd = file.substring(end);
    const fixedFile = fileBeforeStart + fix.text + fileAfterEnd;

    const suggestFrom = defaultIndex(fileBeforeStart.lastIndexOf('\n'), -1) + 1;
    const suggestTo = defaultIndex(
      fileAfterEnd.indexOf('\n'),
      fileAfterEnd.length,
    );
    const suggestion = fixedFile.substr(
      suggestFrom,
      fileBeforeStart.length - suggestFrom + fix.text.length + suggestTo,
    );

    const newLinesPreFix = countNewLines(file.substring(start, end));

    if (suggestionSnippet) {
      if (suggestionSnippetMultiLine && newLinesPreFix > 0) {
        suggestionSnippetText = `\`\`\`suggestion:-0+${newLinesPreFix}
  ${suggestion.replace(/```/g, '\\`\\`\\`')}
  \`\`\``;
      } else if (newLinesPreFix === 0) {
        suggestionSnippetText = `\`\`\`suggestion
  ${suggestion.replace(/```/g, '\\`\\`\\`')}
  \`\`\``;
      }
    }
  }

  let ruleMd = '';

  if (ruleId) {
    const ruleUrl = `https://www.google.com/search?btnI&q=${encodeURIComponent(
      `eslint rule ${ruleId}`,
    )}`;
    ruleMd = `[${ruleId}](${ruleUrl})`;
  }

  const severityEmoji = suggestionMessage.SEVERITY_EMOJI[severity];
  const severityMessage = suggestionMessage.SEVERITY_TEXT[severity];

  return `${severityEmoji} **Lint ${severityMessage}** ${message}

${suggestionSnippetText}

${ruleMd}`;
}

suggestionMessage.SEVERITY_TEXT = [null, 'Warning', 'Error'];
suggestionMessage.SEVERITY_EMOJI = [null, ':warning:', ':stop_sign:'];

module.exports = suggestionMessage;

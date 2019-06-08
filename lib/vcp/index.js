/**
 * VCP stands for Version Control Provider, all VCPs must implement the interface defined below.
 *
 * fetchFilePaths(): string[]
 *
 * fetchFile(path: string): string
 *
 * suggestChange(path: string, suggestion: {
 *   line: number,
 *   message: string,
 * })
 *
 * fetchSuggestionIds(): any[]
 *
 * deleteSuggestion(suggestionId: any)
 *
 * attachSignal(signal: AbortSignal)
 */
const GitHubAPI = require('./GitHubAPI');
const GitLabAPI = require('./GitLabAPI');

module.exports = {
  github: GitHubAPI,
  gitlab: GitLabAPI,
};

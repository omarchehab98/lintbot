const fetch = require('node-fetch');
const FetchError = require('../errors/FetchError');
const invariant = require('../helpers/invariant');
const pkg = require('../../package.json');

class GitLabAPI {
  /**
   * Requires `CI_PROJECT_ID`, `CI_COMMIT_REF_NAME`, `CI_MERGE_REQUEST_IID` to be set by GitLab CI
   * Requires `LINTBOT_GITLAB_TOKEN`, `LINTBOT_GITLAB_USER_ID` to be set
   * Optionally takes `LINTBOT_GITLAB_BASEURL`
   *
   * `CI_MERGE_REQUEST_IID` is only available if `only: [merge_requests]` is used in `gitlab-ci.yml`
   * and the merge request is created.
   *
   * @param {object} options
   * @param {string} dryRun Only performs GET requests
   */
  constructor({ dryRun = false } = {}) {
    invariant(
      typeof process.env.CI_PROJECT_ID === 'string',
      'Environment variable CI_PROJECT_ID is not defined',
    );
    invariant(
      typeof process.env.CI_COMMIT_REF_NAME === 'string',
      'Environment variable CI_COMMIT_REF_NAME is not defined',
    );
    invariant(
      typeof process.env.CI_MERGE_REQUEST_IID === 'string',
      'Environment variable CI_MERGE_REQUEST_IID is not defined',
    );
    invariant(
      typeof process.env.LINTBOT_GITLAB_TOKEN === 'string',
      'Environment variable LINTBOT_GITLAB_TOKEN is not defined',
    );
    invariant(
      typeof process.env.LINTBOT_GITLAB_USER_ID === 'string',
      'Environment variable LINTBOT_GITLAB_USER_ID is not defined',
    );

    this.projectId = process.env.CI_PROJECT_ID;
    this.branch = process.env.CI_COMMIT_REF_NAME;
    this.mergeRequestId = process.env.CI_MERGE_REQUEST_IID;
    this.token = process.env.LINTBOT_GITLAB_TOKEN;
    this.userId = process.env.LINTBOT_GITLAB_USER_ID;
    this.baseUrl = `${process.env.LINTBOT_GITLAB_BASEURL || 'https://gitlab.com'}/api/v4`;

    this.dryRun = dryRun;
  }

  /**
   * @returns {Promise<string[]>}
   * @example
   * await gitLabAPI.fetchFilePaths();
   * // => ['client/app.js']
   */
  async fetchFilePaths() {
    const res = await this.request(
      'GET',
      `/projects/${encodeURIComponent(
        this.projectId,
      )}/merge_requests/${encodeURIComponent(this.mergeRequestId)}/changes`,
    );

    const {
      changes,
      diff_refs: { base_sha: baseSha, head_sha: headSha, start_sha: startSha },
    } = await res.json();

    this.baseSha = baseSha;
    this.headSha = headSha;
    this.startSha = startSha;

    return changes.map(change => change.new_path);
  }

  /**
   * @param {string} path Path without the leading slash
   * @returns {Promise<string>}
   * @example
   * await gitLabAPI.fetchFile('client/app.js');
   * // => 'const file = "app.js"'
   */
  async fetchFile(path) {
    const res = await this.request(
      'GET',
      `/projects/${encodeURIComponent(
        this.projectId,
      )}/repository/files/${encodeURIComponent(
        path,
      )}/raw?ref=${encodeURIComponent(this.branch)}`,
    );
    const file = await res.text();
    return file;
  }

  /**
   * @param {string} path
   * @param {object} suggestion
   * @param {number} suggestion.line
   * @param {string} suggestion.message
   * @returns {Promise}
   * @example
   * await vcapi.suggestChange('client/app.js', {
   *  line: 1,
   *  message: '```suggestion\nconst file = "new apps.s")\n```',
   * });
   */
  async suggestChange(path, suggestion) {
    await this.request(
      'POST',
      `/projects/${encodeURIComponent(
        this.projectId,
      )}/merge_requests/${encodeURIComponent(
        this.mergeRequestId,
      )}/discussions?body=${encodeURIComponent(
        suggestion.message,
      )}&position[position_type]=text&position[base_sha]=${encodeURIComponent(
        this.baseSha,
      )}&position[start_sha]=${encodeURIComponent(
        this.startSha,
      )}&position[head_sha]=${encodeURIComponent(
        this.headSha,
      )}&position[new_path]=${encodeURIComponent(
        path,
      )}&position[new_line]=${encodeURIComponent(suggestion.line)}`,
    );
  }

  /**
   * @returns {Promise<SuggestionId[]>}
   * @example
   * await vcapi.fetchSuggestionIds();
   * // [["dad2cfbc644ef641fecf0c52c5b8e7e1c4460f34", 549], ...]
   */
  async fetchSuggestionIds() {
    const suggestionIds = await this.requestPaginated(
      'GET',
      `/projects/${encodeURIComponent(
        this.projectId,
      )}/merge_requests/${encodeURIComponent(this.mergeRequestId)}/discussions`,
      {
        itemTransform: d => d.notes
          .filter(n => String(n.author.id) === String(this.userId))
          .map(n => [d.id, n.id]),
        bodyTransform: b => b.reduce((r, a) => r.concat(a), []),
      },
    );
    return suggestionIds;
  }

  /**
   * @param {SuggestionId} suggestionId
   * @example
   * await vcapi.deleteSuggestion(["dad2cfbc644ef641fecf0c52c5b8e7e1c4460f34", 549]);
   */
  async deleteSuggestion(suggestionId) {
    const [discussionId, noteId] = suggestionId;
    await this.request(
      'DELETE',
      `/projects/${encodeURIComponent(
        this.projectId,
      )}/merge_requests/${encodeURIComponent(
        this.mergeRequestId,
      )}/discussions/${encodeURIComponent(
        discussionId,
      )}/notes/${encodeURIComponent(noteId)}`,
    );
  }

  /**
   * @param {AbortSignal} signal
   */
  attachSignal(signal) {
    this.signal = signal;
  }

  async request(method, url) {
    const { signal } = this;
    delete this.signal;

    const fullUrl = (url.startsWith('http') ? '' : this.baseUrl) + url;
    Logger.debug(method, fullUrl);

    let res = { ok: true };
    if (!this.dryRun || method === 'GET') {
      res = await fetch(fullUrl, {
        method,
        signal,
        headers: {
          'User-Agent': `https://github.com/omarchehab98/lintbot/releases/tag/${pkg.version}`,
          'Private-Token': this.token,
        },
      });
    }

    if (!res.ok) {
      throw new FetchError(res);
    }

    return res;
  }

  async requestPaginated(
    method,
    url,
    {
      itemTransform = x => x,
      bodyTransform = x => x,
    } = {},
  ) {
    const result = [];
    let nextLink = ['rel="first"', url];
    while (nextLink) {
      const res = await this.request(method, nextLink[1]);
      const linkHeader = res.headers.get('link');
      invariant(
        typeof linkHeader === 'string',
        `Response header is not a string, it is ${typeof linkHeader}`,
      );
      nextLink = linkHeader
        .split(', ')
        .map(link => link.split('; '))
        .map(([linkUrl, name]) => [name, linkUrl.slice(1, -1)])
        .find(([name]) => name === 'rel="next"');
      const body = await res.json();
      result.push(...bodyTransform(body.map(itemTransform)));
    }
    return result;
  }
}

GitLabAPI.suggestions = {
  suggestionSnippet: true,
  suggestionSnippetMultiLine: true,
};

module.exports = GitLabAPI;

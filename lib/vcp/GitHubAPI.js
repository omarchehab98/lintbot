const fetch = require('node-fetch');
const parseDiff = require('parse-diff');
const FetchError = require('../errors/FetchError');
const invariant = require('../helpers/invariant');
const pkg = require('../../package.json');

class GitHubAPI {
  /**
   * Requires `LINTBOT_GITHUB_USERNAME`, `LINTBOT_GITHUB_TOKEN`, `LINTBOT_GITHUB_REPO`,
   * `LINTBOT_GITHUB_PRID` to be set
   * Optionally takes `LINTBOT_GITHUB_BASEURL`
   *
   * @param {object} options
   * @param {string} dryRun Only performs GET requests
   */
  constructor({ dryRun = false } = {}) {
    invariant(
      typeof process.env.LINTBOT_GITHUB_USERNAME === 'string',
      'Environment variable LINTBOT_GITHUB_USERNAME is not defined',
    );
    invariant(
      typeof process.env.LINTBOT_GITHUB_TOKEN === 'string',
      'Environment variable LINTBOT_GITHUB_TOKEN is not defined',
    );
    invariant(
      typeof process.env.LINTBOT_GITHUB_REPO === 'string',
      'Environment variable LINTBOT_GITHUB_REPO is not defined',
    );

    this.username = process.env.LINTBOT_GITHUB_USERNAME;
    const password = process.env.LINTBOT_GITHUB_TOKEN;
    this.repo = process.env.LINTBOT_GITHUB_REPO;
    this.prId = process.env.LINTBOT_GITHUB_PRID;
    this.credentials = Buffer.from(`${this.username}:${password}`).toString('base64');
    this.apiBaseUrl = process.env.LINTBOT_GITHUB_BASEURL || 'https://api.github.com';
    this.baseUrl = this.apiBaseUrl.replace(/api\./, '');

    this.dryRun = dryRun;
  }

  /**
   * @returns {Promise<string[]>}
   * @example
   * await GitHubAPI.fetchFilePaths();
   * // => ['client/app.js']
   */
  async fetchFilePaths() {
    {
      const res = await this.request('GET', `/repos/${this.repo}/pulls/${this.prId}`);
      const pr = await res.json();
      this.prHeadSha = pr.head.sha;
    }

    {
      const res = await this.request('GET', `/repos/${this.repo}/pulls/${this.prId}`, null, {
        Accept: 'application/vnd.github.v3.diff',
      });
      const diffRaw = await res.text();
      this.diff = parseDiff(diffRaw);
    }
    const filePaths = await this.requestPaginated(
      'GET',
      `/repos/${this.repo}/pulls/${this.prId}/files`,
      {
        itemTransform: file => (file.status !== 'removed' ? file.filename : null),
      },
    );
    return filePaths;
  }

  /**
   * @param {string} path Path without the leading slash
   * @returns {Promise<string>}
   * @example
   * await GitHubAPI.fetchFile('client/app.js');
   * // => 'const file = "app.js"'
   */
  async fetchFile(path) {
    const res = await this.request('GET', `${this.baseUrl}/${this.repo}/raw/${this.prHeadSha}/${path}`);
    const file = await res.text();
    return file;
  }

  async beforeSuggestionsStart() {
    this.comments = [];
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
    const file = this.diff.find(f => f.to === path);
    invariant(
      file,
      'Could not find file in hunk in order to suggest a change.',
    );
    const position = file.chunks.reduce((result, chunk, i) => {
      if (result !== null) {
        return result;
      }
      const j = chunk.changes
        .findIndex(change => change.type !== 'del' && (change.ln2 || change.ln) === suggestion.line);
      return j >= 0
        ? file.chunks
          .slice(0, i)
          .map(c => c.changes.length + 1)
          .reduce((n, x) => n + x, 0) + j + 1
        : null;
    }, null);
    // Position is null if file line cannot be mapped to hunk position
    if (position !== null) {
      this.comments.push({
        position,
        path,
        body: suggestion.message,
      });
    }
  }

  async afterSuggestionsEnd() {
    await this.request(
      'POST',
      `/repos/${this.repo}/pulls/${this.prId}/reviews`,
      {
        commit_id: this.prHeadSha,
        body: '',
        event: 'COMMENT',
        comments: this.comments,
      },
    );
  }

  /**
   * @returns {Promise<SuggestionId[]>}
   * @example
   * await vcapi.fetchSuggestionIds();
   * // [549, ...]
   */
  async fetchSuggestionIds() {
    const reviews = await this.requestPaginated(
      'GET',
      `/repos/${this.repo}/pulls/${this.prId}/comments`,
    );
    return reviews
      .filter(review => review.user.login === this.username)
      .map(review => review.id);
  }

  /**
   * @param {SuggestionId} suggestionId
   * @example
   * await vcapi.deleteSuggestion(549);
   */
  async deleteSuggestion(suggestionId) {
    await this.request(
      'DELETE',
      `/repos/${this.repo}/pulls/comments/${suggestionId}`,
    );
  }

  /**
   * @param {AbortSignal} signal
   */
  attachSignal(signal) {
    this.signal = signal;
  }

  async request(method, url, body = null, headers = {}) {
    const { signal } = this;
    delete this.signal;

    const fullUrl = (url.startsWith('http') ? '' : this.apiBaseUrl) + url;
    Logger.debug(method, fullUrl);

    let res = { ok: true };
    if (!this.dryRun || method === 'GET') {
      res = await fetch(fullUrl, {
        method,
        signal,
        headers: {
          'User-Agent': `https://github.com/omarchehab98/lintbot/releases/tag/${pkg.version}`,
          Authorization: `Basic ${this.credentials}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
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
      const linkHeader = res.headers.get('link') || '';
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
      result.push(
        ...bodyTransform(
          body
            .map(itemTransform)
            .filter(x => x !== null),
        ),
      );
    }
    return result;
  }
}

GitHubAPI.suggestions = {
  suggestionSnippet: true,
  suggestionSnippetMultiLine: false,
};

module.exports = GitHubAPI;

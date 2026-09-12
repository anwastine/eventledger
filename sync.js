// GitHub Contents API sync for a single JSON file in a private repo.
const GitSync = (() => {
  const API = 'https://api.github.com';
  let cfg = { repo: null, path: 'data.json', token: null, branch: null };
  let sha = null;

  const utf8ToB64 = (s) => btoa(unescape(encodeURIComponent(s)));
  const b64ToUtf8 = (s) => decodeURIComponent(escape(atob(s.replace(/\n/g, ''))));

  function configure(c) { cfg = { ...cfg, ...c }; }
  function ready() { return !!(cfg.repo && cfg.token); }

  function headers() {
    return { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  }
  function url() {
    return `${API}/repos/${cfg.repo}/contents/${cfg.path}${cfg.branch ? `?ref=${cfg.branch}` : ''}`;
  }

  // Returns {data, sha} or {data:null} if file does not exist yet.
  async function pull() {
    const r = await fetch(url(), { headers: headers(), cache: 'no-store' });
    if (r.status === 404) {
      // Distinguish "repo missing / no access" from "file missing".
      const rr = await fetch(`${API}/repos/${cfg.repo}`, { headers: headers(), cache: 'no-store' });
      if (rr.status === 404) throw new Error(`Repo ${cfg.repo} not found or token has no access`);
      if (rr.status === 401) throw new Error('Token rejected by GitHub');
      sha = null; return { data: null, sha: null };
    }
    if (r.status === 401) throw new Error('Token rejected by GitHub');
    if (!r.ok) throw new Error(`GitHub ${r.status}`);
    const j = await r.json();
    sha = j.sha;
    return { data: JSON.parse(b64ToUtf8(j.content)), sha };
  }

  // Pushes data; on conflict, calls merge(remote, local) and retries.
  async function push(data, merge) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const body = { message: `ledger update ${new Date().toISOString()}`, content: utf8ToB64(JSON.stringify(data, null, 1)) };
      if (sha) body.sha = sha;
      if (cfg.branch) body.branch = cfg.branch;
      const r = await fetch(`${API}/repos/${cfg.repo}/contents/${cfg.path}`, { method: 'PUT', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (r.ok) { const j = await r.json(); sha = j.content.sha; return data; }
      if (r.status === 409 || r.status === 422) {
        const remote = await pull();
        if (remote.data && merge) data = merge(remote.data, data);
        continue;
      }
      if (r.status === 401 || r.status === 403) throw new Error('Token rejected or lacks Contents write permission');
      throw new Error(`GitHub ${r.status}`);
    }
    throw new Error('Could not sync after retries');
  }

  return { configure, ready, pull, push, get repo() { return cfg.repo; } };
})();

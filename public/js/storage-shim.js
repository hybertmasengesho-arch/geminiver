// storage-shim.js
// Each tracker (matrix.html / reasoning.html / prep30.html) was written against
// window.storage.get/set/delete/list(key, shared) — the same shape used by
// Claude artifacts. This file replaces that object with one backed by the
// real API, so none of the trackers' own logic had to change.
//
// Load this AFTER setting window.APP_NAME, and BEFORE the tracker's own script.
(function () {
  const APP = window.APP_NAME || 'app';

  function getToken() { return localStorage.getItem('rh_token'); }

  async function authFetch(path, opts) {
    opts = opts || {};
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    const token = getToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch(path, Object.assign({}, opts, { headers }));
    if (res.status === 401) {
      localStorage.removeItem('rh_token');
      const next = encodeURIComponent(location.pathname + location.search);
      location.href = '/login.html?next=' + next;
      throw new Error('Not authenticated');
    }
    return res;
  }

  window.storage = {
    async get(key, shared) {
      const q = new URLSearchParams({ app: APP, key: key, shared: !!shared });
      try {
        const res = await authFetch('/api/kv?' + q.toString());
        if (!res.ok) return null;
        const data = await res.json();
        if (data.value === null || data.value === undefined) return null;
        return { key: key, value: data.value, shared: !!shared };
      } catch (e) { return null; }
    },
    async set(key, value, shared) {
      try {
        const res = await authFetch('/api/kv', {
          method: 'POST',
          body: JSON.stringify({ app: APP, key: key, value: value, shared: !!shared })
        });
        if (!res.ok) return null;
        return { key: key, value: value, shared: !!shared };
      } catch (e) { return null; }
    },
    async delete(key, shared) {
      try {
        const res = await authFetch('/api/kv', {
          method: 'DELETE',
          body: JSON.stringify({ app: APP, key: key, shared: !!shared })
        });
        if (!res.ok) return null;
        return { key: key, deleted: true, shared: !!shared };
      } catch (e) { return null; }
    },
    async list(prefix, shared) {
      const q = new URLSearchParams({ app: APP, prefix: prefix || '', shared: !!shared });
      try {
        const res = await authFetch('/api/kv/list?' + q.toString());
        if (!res.ok) return null;
        const data = await res.json();
        return { keys: data.keys || [], prefix: prefix, shared: !!shared };
      } catch (e) { return null; }
    }
  };
})();

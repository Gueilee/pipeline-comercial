/**
 * supabase-shim.js
 * Substituto local do Supabase SDK — conecta ao servidor Node.js (servidor.js)
 * API 100% compatível com @supabase/supabase-js v2
 */
window.supabase = {
  createClient(url, key) {
    const SESSION_KEY = '_pipeline_session';

    const getToken = () => {
      try { return JSON.parse(localStorage.getItem(SESSION_KEY) || '{}').access_token || null; }
      catch { return null; }
    };
    const setSession = d => localStorage.setItem(SESSION_KEY, JSON.stringify(d));
    const clearSession = () => localStorage.removeItem(SESSION_KEY);

    const _authListeners = [];
    const _notify = (ev, s) => _authListeners.forEach(cb => { try { cb(ev, s); } catch {} });

    // ── from(table) ──────────────────────────────────────────────────────────
    function from(table) {
      let _method = 'GET', _body = null, _filters = {}, _select = '*';
      let _order = null, _limit = null, _offset = null;
      let _single = false, _count = null, _head = false;

      const c = {
        select(cols = '*', opts = {}) {
          _select = cols;
          if (opts.count) _count = opts.count;
          if (opts.head)  _head  = true;
          return c;
        },
        eq(k, v)    { _filters[k] = `eq.${v}`;    return c; },
        neq(k, v)   { _filters[k] = `neq.${v}`;   return c; },
        gt(k, v)    { _filters[k] = `gt.${v}`;     return c; },
        gte(k, v)   { _filters[k] = `gte.${v}`;    return c; },
        lt(k, v)    { _filters[k] = `lt.${v}`;     return c; },
        lte(k, v)   { _filters[k] = `lte.${v}`;    return c; },
        like(k, v)  { _filters[k] = `like.${v}`;   return c; },
        ilike(k, v) { _filters[k] = `ilike.${v}`;  return c; },
        is(k, v)    { _filters[k] = `is.${v}`;     return c; },
        in(k, arr)  { _filters[k] = `in.(${arr.join(',')})`;  return c; },
        order(col, opts = {}) { _order = `${col}.${opts.ascending === false ? 'desc' : 'asc'}`; return c; },
        limit(n)        { _limit = n;  return c; },
        range(f, t)     { _offset = f; _limit = t - f + 1; return c; },
        single()        { _single = true; return c; },
        insert(data)    { _method = 'POST';   _body = data; return c; },
        update(data)    { _method = 'PATCH';  _body = data; return c; },
        upsert(data)    { _method = 'POST';   _body = data; return c; },
        delete()        { _method = 'DELETE';  return c; },
        then(res, rej)  { return _exec().then(res, rej); },
      };

      async function _exec() {
        const p = new URLSearchParams();
        p.set('select', _select);
        for (const [k, v] of Object.entries(_filters)) p.set(k, v);
        if (_order)        p.set('order',  _order);
        if (_limit !== null)  p.set('limit',  _limit);
        if (_offset !== null) p.set('offset', _offset);

        const tok = getToken() || 'local-dev-key';
        const hdrs = {
          'Content-Type':  'application/json',
          'apikey':        tok,
          'Authorization': `Bearer ${tok}`,
        };
        if (_single) hdrs['Accept'] = 'application/vnd.pgrst.object+json';
        if (_count || _head) hdrs['Prefer'] = `count=${_count || 'exact'}`;
        if (_method === 'POST' || _method === 'PATCH') hdrs['Prefer'] = 'return=representation';

        const opts = { method: _head ? 'HEAD' : _method, headers: hdrs };
        if (_body) opts.body = JSON.stringify(
          _method === 'PATCH' ? _body : (Array.isArray(_body) ? _body : [_body])
        );

        try {
          const r   = await fetch(`${url}/rest/v1/${table}?${p}`, opts);
          const cr  = r.headers.get('content-range');
          const cnt = cr?.split('/')?.[1] ? parseInt(cr.split('/')[1]) : null;
          if (!r.ok) {
            let e; try { e = await r.json(); } catch { e = { message: r.statusText }; }
            return { data: null, error: e, count: cnt };
          }
          if (_head) return { data: null, error: null, count: cnt };
          let d; try { d = await r.json(); } catch { d = null; }
          return { data: d, error: null, count: cnt };
        } catch (e) {
          return { data: null, error: { message: e.message }, count: null };
        }
      }
      return c;
    }

    // ── auth ─────────────────────────────────────────────────────────────────
    const auth = {
      async signInWithPassword({ email, password }) {
        try {
          const r = await fetch(`${url}/auth/v1/token?grant_type=password`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', apikey: key },
            body: JSON.stringify({ email, password }),
          });
          const d = await r.json();
          if (!r.ok) return { data: null, error: { message: d.error_description || 'Login falhou' } };
          setSession(d);
          _notify('SIGNED_IN', d);
          return { data: { session: d, user: d.user }, error: null };
        } catch (e) { return { data: null, error: { message: e.message } }; }
      },

      async signUp({ email, password }) {
        try {
          const r = await fetch(`${url}/auth/v1/signup`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', apikey: key },
            body: JSON.stringify({ email, password }),
          });
          const d = await r.json();
          if (!r.ok) return { data: null, error: { message: d.error_description || 'Cadastro falhou' } };
          setSession(d);
          _notify('SIGNED_IN', d);
          return { data: { user: d.user }, error: null };
        } catch (e) { return { data: null, error: { message: e.message } }; }
      },

      async signOut() {
        clearSession();
        _notify('SIGNED_OUT', null);
        return { error: null };
      },

      async getSession() {
        const raw = localStorage.getItem(SESSION_KEY);
        if (!raw) return { data: { session: null }, error: null };
        try { return { data: { session: JSON.parse(raw) }, error: null }; }
        catch { return { data: { session: null }, error: null }; }
      },

      async resetPasswordForEmail(email) {
        try { await fetch(`${url}/auth/v1/recover`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) }); }
        catch {}
        return { data: {}, error: null };
      },

      async updateUser({ password }) {
        const tok = getToken();
        if (!tok) return { data: null, error: { message: 'Não autenticado' } };
        try {
          const r = await fetch(`${url}/auth/v1/user`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tok}` },
            body: JSON.stringify({ password }),
          });
          const d = await r.json();
          if (!r.ok) return { data: null, error: { message: d.message } };
          return { data: { user: d.user }, error: null };
        } catch (e) { return { data: null, error: { message: e.message } }; }
      },

      onAuthStateChange(cb) {
        _authListeners.push(cb);
        const raw = localStorage.getItem(SESSION_KEY);
        if (raw) { try { cb('SIGNED_IN', JSON.parse(raw)); } catch {} }
        else { setTimeout(() => cb('SIGNED_OUT', null), 0); }
        return { data: { subscription: { unsubscribe() {
          const i = _authListeners.indexOf(cb);
          if (i >= 0) _authListeners.splice(i, 1);
        }}}};
      },
    };

    // ── storage ───────────────────────────────────────────────────────────────
    const storage = {
      from(bucket) {
        return {
          async upload(filePath, file) {
            const tok = getToken() || key;
            const fd  = new FormData();
            fd.append('', file, filePath.split('/').pop());
            try {
              const r = await fetch(`${url}/storage/v1/object/${bucket}/${filePath}`, {
                method: 'POST', headers: { Authorization: `Bearer ${tok}` }, body: fd,
              });
              const d = await r.json();
              if (!r.ok) return { data: null, error: { message: d.error || 'Erro upload' } };
              return { data: { path: filePath }, error: null };
            } catch (e) { return { data: null, error: { message: e.message } }; }
          },
          async remove(paths) {
            const tok = getToken() || key;
            try {
              await fetch(`${url}/storage/v1/object/${bucket}`, {
                method: 'DELETE', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
                body: JSON.stringify(paths),
              });
              return { data: {}, error: null };
            } catch (e) { return { data: null, error: { message: e.message } }; }
          },
          getPublicUrl(filePath) {
            return { data: { publicUrl: `${url}/storage/v1/object/public/${bucket}/${filePath}` } };
          },
        };
      },
    };

    return { from, auth, storage };
  },
};

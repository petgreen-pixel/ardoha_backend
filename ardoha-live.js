/* Ardoha live mode. Connects the website to the real backend (accounts, Google sign-in, dashboard, payments).
   To switch it on, add two things to the live site's pages, just before the closing body tag:
     1) a small script that sets: window.ARD_CONFIG = { api: "https://api.your-domain.com" }
     2) a script tag that loads this file (ardoha-live.js)
   With no api address set, the site stays in demo mode. */
(function () {
  var C = window.ARD_CONFIG || {};
  if (!C.api) return;
  var API = String(C.api).replace(/\/$/, ''), A = window.ARD, d = document;
  function call(method, url, body) {
    return fetch(API + url, { method: method, credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.error || 'Something went wrong'); e.status = r.status; throw e; } return j; }); });
  }
  function when(iso) { try { return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return ''; } }
  function toLocal(x) {
    return {
      svcs: x.services.map(function (s) {
        var o = { s: s.slug, p: s.status === 'completed' ? 100 : s.progress, tier: s.tier, note: s.note };
        if (s.status === 'pending') o.paid = false;
        return o;
      }),
      ups: x.updates.map(function (u) { return [when(u.created_at), u.text]; }),
      sample: false,
    };
  }
  function rerender() { var h = location.hash; if (h === '#dashboard' || h === '#checkout') dispatchEvent(new HashChangeEvent('hashchange')); }
  function refresh() {
    return call('GET', '/api/me/dashboard').then(function (x) { A.hydrate(x.user, toLocal(x)); rerender(); return x; })
      .catch(function (e) { if (e.status === 401) { A.clear(); } return null; });
  }
  function go(h) { if (location.hash === '#' + h) dispatchEvent(new HashChangeEvent('hashchange')); else location.hash = h; }
  function say(t, title, msg) { if (window.notify) window.notify(t, title, msg || ''); }
  function fail(e) { say(e.status === 401 ? 'warning' : 'error', e.status === 401 ? 'Please log in first' : 'Something went wrong', e.status === 401 ? '' : e.message); if (e.status === 401) { A.clear(); go('account'); } }
  function welcome(j) {
    return refresh().then(function () {
      say('success', j.isNew ? 'Welcome to Ardoha!' : 'Welcome back, ' + j.user.name.split(' ')[0] + '!', j.isNew ? 'Your account is ready. Your dashboard tracks every service as it progresses.' : 'Good to see you again. Here is where your launch stands.');
      go('dashboard');
    });
  }

  // Actions that change data go to the server
  A.add = function (slug, tier) {
    if (!A.user()) { say('warning', 'Please log in first', 'Log in or sign up to add services to your plan.'); go('account'); return; }
    call('POST', '/api/me/plan', { slug: slug, tier: tier || 'starter' }).then(function () { return refresh(); })
      .then(function () { say('success', 'Added to your plan', 'It is pending payment. Pay from your dashboard to start.'); go('dashboard'); }).catch(fail);
  };

  // Intercept the prototype's local handlers (capture phase) and send them to the server instead
  d.addEventListener('submit', function (e) {
    if (!e.target || e.target.id !== 'af') return;
    e.preventDefault(); e.stopPropagation();
    var f = e.target, m = d.getElementById('am'), up = (d.querySelector('.seg button[aria-selected=true]') || {}).dataset.m === 'up';
    var body = { email: f.email.value.trim(), password: f.password.value };
    if (up) { body.name = f.name.value.trim(); body.title = f.title.value.trim(); body.goal = f.goal.value; }
    call('POST', up ? '/api/auth/signup' : '/api/auth/login', body).then(function (j) { f.password.value = ''; if (m) m.textContent = ''; return welcome(j); })
      .catch(function (er) { if (m) m.textContent = er.message; });
  }, true);
  d.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('#lo,[data-rm],.tb,#pay');
    if (!t) return;
    if (t.id === 'lo') {
      e.preventDefault(); e.stopPropagation();
      call('POST', '/api/auth/logout').finally(function () { A.clear(); say('info', "You're logged out", 'See you soon.'); go('home'); });
    } else if (t.dataset && t.dataset.rm) {
      e.preventDefault(); e.stopPropagation();
      call('DELETE', '/api/me/plan/' + encodeURIComponent(t.dataset.rm)).then(refresh).then(function () { say('info', 'Removed from your plan', ''); }).catch(fail);
    } else if (t.classList.contains('tb')) {
      e.preventDefault(); e.stopPropagation();
      call('PATCH', '/api/me/plan/' + encodeURIComponent(t.dataset.s), { tier: t.dataset.t }).then(refresh).catch(fail);
    } else if (t.id === 'pay') {
      e.preventDefault(); e.stopPropagation();
      var msg = d.getElementById('pm3'), tc = d.getElementById('tc');
      if (!tc || !tc.checked) { if (msg) msg.textContent = 'Please agree to the terms to continue.'; return; }
      var ds = d.querySelector('.sum .ln2.ds span'), promo = ds ? ds.textContent.replace('Promo ', '').trim() : null;
      t.disabled = true; t.textContent = 'Redirecting to secure payment…';
      call('POST', '/api/checkout/initialize', { promo: promo }).then(function (r) { location.href = r.authorization_url; })
        .catch(function (er) { t.disabled = false; t.textContent = 'Try again'; if (msg) msg.textContent = er.message; });
    }
  }, true);

  // Google sign-in: the real button, verified by the server
  function setupGoogle() {
    var demo = d.getElementById('gbtn'); if (!demo) return;
    call('GET', '/api/config').then(function (cfg) {
      if (!cfg.googleClientId) return;
      var host = d.createElement('div'); host.id = 'gsi'; host.style.cssText = 'display:flex;justify-content:center;min-height:44px';
      demo.parentNode.insertBefore(host, demo); demo.style.display = 'none'; var gd = d.getElementById('gdemo'); if (gd) gd.remove();
      function init() {
        window.google.accounts.id.initialize({ client_id: cfg.googleClientId, callback: function (resp) {
          call('POST', '/api/auth/google', { credential: resp.credential }).then(welcome).catch(function (er) { say('error', 'Google sign-in failed', er.message); });
        } });
        window.google.accounts.id.renderButton(host, { theme: 'outline', size: 'large', text: 'continue_with', shape: 'rectangular', width: 320 });
      }
      if (window.google && window.google.accounts) init();
      else { var s = d.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.onload = init; d.head.appendChild(s); }
    }).catch(function () {});
  }

  // Returning from Paystack: confirm the payment with the server
  function handleReturn() {
    var ref = new URLSearchParams(location.search).get('reference');
    if (!ref) return Promise.resolve();
    history.replaceState(null, '', location.pathname + '#dashboard');
    return call('GET', '/api/checkout/verify/' + encodeURIComponent(ref)).then(function (r) {
      return refresh().then(function () {
        if (r.status === 'paid') say('success', 'Payment received. Thank you!', 'Your services are now active.');
        else if (r.status === 'pending') say('info', 'Payment is processing', 'We will update your dashboard as soon as it clears.');
        else say('error', 'Payment not completed', 'No money was taken. You can try again from your cart.');
        go('dashboard');
      });
    }).catch(function () { say('warning', 'We could not check your payment', 'Please refresh in a minute or contact us.'); });
  }

  setupGoogle();
  refresh().then(handleReturn);
})();

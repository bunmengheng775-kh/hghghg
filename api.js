// Small API client used by app.js (all calls to the server live here)
const API_BASE = (() => {
  const page = new URL(window.location.href);
  if (page.protocol === 'file:') return 'http://localhost:3000/';
  if (page.protocol === 'http:' && page.port && page.port !== '3000')
    return `http://${page.hostname}:3000/`;
  return `${page.origin}/`;
})();
const currentPage = new URL(window.location.href);
const isPrivateIPv4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(currentPage.hostname);
const isLocalHost = ['localhost', '127.0.0.1', '::1'].includes(currentPage.hostname);
const localDemoAllowed = currentPage.protocol === 'file:' ||
  (currentPage.protocol === 'http:' && (isLocalHost || isPrivateIPv4 || currentPage.hostname.endsWith('.local')));
const DEMO_TOKEN = 'local-demo';
const DEMO_USER_KEY = 'sh_demo_user';
const DEMO_USERS_KEY = 'sh_demo_users';
const DEMO_FILES_KEY = 'sh_demo_files';

function demoRead(key, fallback) {
  const value = localStorage.getItem(key);
  return value === null ? fallback : JSON.parse(value);
}

function demoRequest(method, pathname, body) {
  const route = pathname.replace(/^.*\/api\//, '');
  if (route === 'me' && method === 'GET') {
    const user = demoRead(DEMO_USER_KEY, null);
    if (!user) throw new Error('Demo session ended. Log in again.');
    return user;
  }
  if (route === 'files' && method === 'GET') return demoRead(DEMO_FILES_KEY, []);
  if (route === 'exercises' && method === 'GET') return [];
  if (route === 'users' && method === 'GET') return demoRead(DEMO_USERS_KEY, []);
  if (route === 'users' && method === 'POST') {
    const users = demoRead(DEMO_USERS_KEY, []);
    if (users.some(user => user.username === body.username))
      throw new Error('Username already exists in this browser demo');
    const user = { username: body.username, name: body.name, role: body.role };
    users.push(user);
    localStorage.setItem(DEMO_USERS_KEY, JSON.stringify(users));
    return user;
  }
  const userRoute = route.match(/^users\/([^/]+)$/);
  if (userRoute) {
    const username = decodeURIComponent(userRoute[1]);
    const users = demoRead(DEMO_USERS_KEY, []);
    const index = users.findIndex(user => user.username === username);
    if (index < 0) throw new Error('User not found in this browser demo');
    if (method === 'PATCH') {
      users[index] = { ...users[index], ...body };
      localStorage.setItem(DEMO_USERS_KEY, JSON.stringify(users));
      return users[index];
    }
    if (method === 'DELETE') {
      if (users[index].role === 'owner') throw new Error('Owner accounts cannot be deleted');
      users.splice(index, 1);
      localStorage.setItem(DEMO_USERS_KEY, JSON.stringify(users));
      return { ok: true };
    }
  }
  if (route.startsWith('files') && method !== 'GET')
    throw new Error('File uploads and changes require the Study Hub server.');
  throw new Error('This action is not available in the browser-only demo.');
}

const API = {
  token: localStorage.getItem('sh_token') === DEMO_TOKEN && !localDemoAllowed
    ? '' : localStorage.getItem('sh_token') || '',
  demoMode: localDemoAllowed && localStorage.getItem('sh_token') === DEMO_TOKEN,
  async req(method, url, body, isForm) {
    if (this.demoMode) return demoRequest(method, new URL(url, API_BASE).pathname, body);
    const opt = { method, headers: {} };
    if (this.token) opt.headers.Authorization = 'Bearer ' + this.token;
    if (body && !isForm) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    if (isForm) opt.body = body;
    let r;
    try { r = await fetch(new URL(url, API_BASE), opt); }
    catch (e) {
      if (localDemoAllowed && method === 'POST' && new URL(url, API_BASE).pathname.endsWith('/api/login')) {
        const username = String(body && body.username || '').trim().toLowerCase();
        const role = body && body.role;
        if (!username || !String(body && body.password || '') ||
            !['student', 'teacher', 'owner'].includes(role))
          throw new Error('Enter a username and password, then choose a valid role.');
        const user = { username, name: username, role };
        const users = demoRead(DEMO_USERS_KEY, []);
        if (!users.some(account => account.username === username))
          users.push(user);
        localStorage.setItem(DEMO_USERS_KEY, JSON.stringify(users));
        localStorage.setItem(DEMO_USER_KEY, JSON.stringify(user));
        this.demoMode = true;
        return { token: DEMO_TOKEN, user };
      }
      const recovery = currentPage.protocol === 'https:'
        ? 'Check your internet connection and Vercel deployment.'
        : 'Check that the Study Hub server is running.';
      throw new Error(`Cannot reach Study Hub at ${new URL(API_BASE).origin}. ${recovery}`);
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || (r.status === 404
      ? 'The Study Hub API is not deployed on this site yet. Deploy the app backend to enable login and shared data.'
      : r.status + ' - the Study Hub server is not available at this address.'));
    return data;
  },
  async login(username, password, role) {
    const d = await this.req('POST', 'api/login', { username, password, role });
    this.token = d.token;
    this.demoMode = d.token === DEMO_TOKEN;
    localStorage.setItem('sh_token', d.token);
    return d.user;
  },
  async logout() {
    if (!this.demoMode) try { await this.req('POST', 'api/logout'); } catch (e) {}
    this.token = '';
    this.demoMode = false;
    localStorage.removeItem('sh_token');
    localStorage.removeItem(DEMO_USER_KEY);
  },
  me: () => API.req('GET', 'api/me'),
  files: () => API.req('GET', 'api/files'),
  exercises: () => API.req('GET', 'api/exercises'),
  createExercise: exercise => API.req('POST', 'api/exercises', exercise),
  deleteExercise: id => API.req('DELETE', 'api/exercises/' + encodeURIComponent(id)),
  submitExercise: (id, answers) => API.req('POST', 'api/exercises/' + encodeURIComponent(id) + '/submissions', { answers }),
  users: () => API.req('GET', 'api/users'),
  createUser: user => API.req('POST', 'api/users', user),
  updateUser: (username, patch) => API.req('PATCH', 'api/users/' + encodeURIComponent(username), patch),
  deleteUser: username => API.req('DELETE', 'api/users/' + encodeURIComponent(username)),
  async upload(fileList) {
    const uploaded = [];
    for (const file of [...fileList]) {
      const fd = new FormData();
      fd.append('files', file);
      const result = await API.req('POST', 'api/files', fd, true);
      uploaded.push(...result);
    }
    return uploaded;
  },
  update: (id, patch) => API.req('PATCH', 'api/files/' + id, patch),
  remove: id => API.req('DELETE', 'api/files/' + id),
  rawUrl: id => new URL(`api/files/${id}/raw?token=${encodeURIComponent(API.token)}`, API_BASE).toString()
};

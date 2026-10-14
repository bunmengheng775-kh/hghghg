const SESSION_DAYS = 30;
const MAX_FILE_SIZE = 20 * 1024 * 1024;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
});

const fail = (message, status = 400) => json({ error: message }, status);
const hex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
const safeEqual = (left, right) => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
};

async function digest(value) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

async function hashPassword(password, salt = hex(crypto.getRandomValues(new Uint8Array(16)))) {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const result = await crypto.subtle.deriveBits({
    name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 210000
  }, material, 256);
  return { salt, hash: hex(result) };
}

async function verifyPassword(password, salt, expected) {
  const actual = await hashPassword(password, salt);
  return safeEqual(actual.hash, expected);
}

async function bodyJson(request) {
  try { return await request.json(); }
  catch { return null; }
}

async function ensureInitialOwner(env) {
  const existing = await env.DB.prepare('SELECT username FROM users LIMIT 1').first();
  if (existing) return;
  const username = (env.INITIAL_OWNER_USERNAME || 'heng').trim().toLowerCase();
  const name = (env.INITIAL_OWNER_NAME || 'Heng').trim();
  const password = env.INITIAL_OWNER_PASSWORD;
  if (!/^[a-z0-9._-]{3,32}$/.test(username) || !name || name.length > 80 ||
      typeof password !== 'string' || password.length < 8 || password.length > 128)
    throw new Error('Configure INITIAL_OWNER_PASSWORD (8–128 characters) before the first login');
  const { salt, hash } = await hashPassword(password);
  await env.DB.prepare(
    'INSERT OR IGNORE INTO users (username, name, role, salt, password_hash) VALUES (?, ?, ?, ?, ?)'
  ).bind(username, name, 'owner', salt, hash).run();
}

async function authenticated(request, env) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '') ||
    new URL(request.url).searchParams.get('token');
  if (!token) return null;
  const tokenHash = await digest(token);
  const session = await env.DB.prepare(
    `SELECT u.username, u.name, u.role
     FROM sessions s JOIN users u ON u.username = s.username
     WHERE s.token_hash = ? AND s.expires_at > ?`
  ).bind(tokenHash, Date.now()).first();
  return session || null;
}

const publicUser = user => ({ username: user.username, name: user.name, role: user.role });
const canTeach = user => ['teacher', 'owner'].includes(user.role);

function fileRecord(row, origin, apiKey) {
  return {
    id: row.id, name: row.name, caption: row.caption, kind: row.kind, size: row.size,
    mime: row.mime, uploadedBy: row.uploaded_by, createdAt: row.created_at,
    url: `${origin}/api/public/files/${encodeURIComponent(row.id)}/raw?key=${encodeURIComponent(apiKey)}`
  };
}

async function sendRaw(id, env, headers = {}) {
  const file = await env.DB.prepare('SELECT stored, kind FROM files WHERE id = ?').bind(id).first();
  if (!file) return new Response(null, { status: 404 });
  const object = await env.UPLOADS.get(file.stored);
  if (!object) return new Response('Uploaded file is missing from storage', { status: 404 });
  const responseHeaders = new Headers(headers);
  object.writeHttpMetadata(responseHeaders);
  if (file.kind === 'html')
    responseHeaders.set('Content-Security-Policy', 'sandbox allow-scripts allow-forms allow-modals');
  responseHeaders.set('Cache-Control', 'private, no-store');
  return new Response(object.body, { headers: responseHeaders });
}

async function notify(env, event, file, origin) {
  if (!env.WEBHOOK_URL) return;
  const apiKey = env.API_KEY || '';
  try {
    await fetch(env.WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, file: fileRecord(file, origin, apiKey), at: new Date().toISOString() })
    });
  } catch (error) {
    console.error('Webhook notification failed:', error);
  }
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;

  if (path === '/api/health' && method === 'GET') {
    await env.DB.prepare('SELECT 1 AS ok').first();
    return json({ ok: true });
  }

  if (path === '/api/login' && method === 'POST') {
    const body = await bodyJson(request);
    if (!body || typeof body.username !== 'string' || typeof body.password !== 'string' ||
        !['student', 'teacher', 'owner'].includes(body.role))
      return fail('Enter a username, password, and valid role');
    await ensureInitialOwner(env);
    const username = body.username.trim().toLowerCase();
    const user = await env.DB.prepare(
      'SELECT username, name, role, salt, password_hash FROM users WHERE username = ?'
    ).bind(username).first();
    if (!user || body.role !== user.role || !await verifyPassword(body.password, user.salt, user.password_hash))
      return fail('Wrong username, password, or role', 401);
    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
    await env.DB.prepare('INSERT INTO sessions (token_hash, username, expires_at) VALUES (?, ?, ?)')
      .bind(await digest(token), user.username, expiresAt).run();
    return json({ token, user: publicUser(user) });
  }

  if (path === '/api/logout' && method === 'POST') {
    const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await digest(token)).run();
    return json({ ok: true });
  }

  if (path.startsWith('/api/public/files')) {
    if (!env.API_KEY || (request.headers.get('x-api-key') || url.searchParams.get('key')) !== env.API_KEY)
      return fail('Bad API key', 401);
    if (path === '/api/public/files' && method === 'GET') {
      const rows = await env.DB.prepare('SELECT * FROM files ORDER BY created_at DESC').all();
      return json(rows.results.map(file => fileRecord(file, url.origin, env.API_KEY)));
    }
    const publicRaw = path.match(/^\/api\/public\/files\/([^/]+)\/raw$/);
    if (publicRaw && method === 'GET') return sendRaw(decodeURIComponent(publicRaw[1]), env);
    const publicFile = path.match(/^\/api\/public\/files\/([^/]+)$/);
    if (publicFile && method === 'GET') {
      const file = await env.DB.prepare('SELECT * FROM files WHERE id = ?').bind(decodeURIComponent(publicFile[1])).first();
      return file ? json(fileRecord(file, url.origin, env.API_KEY)) : fail('Not found', 404);
    }
    return fail('Not found', 404);
  }

  const user = await authenticated(request, env);
  if (!user) return fail('Not logged in', 401);

  if (path === '/api/me' && method === 'GET') return json(publicUser(user));

  if (path === '/api/users' && method === 'GET') {
    if (user.role !== 'owner') return fail('Owner only', 403);
    const result = await env.DB.prepare('SELECT username, name, role FROM users ORDER BY username').all();
    return json(result.results);
  }
  if (path === '/api/users' && method === 'POST') {
    if (user.role !== 'owner') return fail('Owner only', 403);
    const body = await bodyJson(request);
    const username = typeof body?.username === 'string' ? body.username.trim().toLowerCase() : '';
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const password = body?.password;
    const role = body?.role;
    if (!/^[a-z0-9._-]{3,32}$/.test(username)) return fail('Username must be 3–32 characters using letters, numbers, dots, underscores, or hyphens');
    if (!name || name.length > 80) return fail('Name must be between 1 and 80 characters');
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) return fail('Password must be between 8 and 128 characters');
    if (!['student', 'teacher'].includes(role)) return fail('Role must be student or teacher');
    const { salt, hash } = await hashPassword(password);
    try {
      await env.DB.prepare('INSERT INTO users (username, name, role, salt, password_hash) VALUES (?, ?, ?, ?, ?)')
        .bind(username, name, role, salt, hash).run();
    } catch (error) {
      if (String(error).includes('UNIQUE')) return fail('Username already exists', 409);
      throw error;
    }
    return json({ username, name, role }, 201);
  }

  const userPath = path.match(/^\/api\/users\/([^/]+)$/);
  if (userPath && (method === 'PATCH' || method === 'DELETE')) {
    if (user.role !== 'owner') return fail('Owner only', 403);
    const username = decodeURIComponent(userPath[1]).toLowerCase();
    const target = await env.DB.prepare('SELECT username, name, role FROM users WHERE username = ?').bind(username).first();
    if (!target) return fail('User not found', 404);
    if (method === 'DELETE') {
      if (target.role === 'owner') return fail('Owner accounts cannot be deleted here', 403);
      await env.DB.prepare('DELETE FROM users WHERE username = ?').bind(username).run();
      return json({ ok: true });
    }
    const body = await bodyJson(request);
    if (!body || (body.name === undefined && body.role === undefined)) return fail('Provide a name or role to update');
    const name = body.name === undefined ? target.name : body.name;
    const role = body.role === undefined ? target.role : body.role;
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) return fail('Name must be between 1 and 80 characters');
    if (target.role === 'owner' && role !== target.role) return fail('Owner permissions cannot be changed here', 403);
    if (target.role !== 'owner' && !['student', 'teacher'].includes(role)) return fail('Role must be student or teacher');
    await env.DB.prepare('UPDATE users SET name = ?, role = ? WHERE username = ?')
      .bind(name.trim(), role, username).run();
    if (role !== target.role) await env.DB.prepare('DELETE FROM sessions WHERE username = ?').bind(username).run();
    return json({ username, name: name.trim(), role });
  }

  if (path === '/api/files' && method === 'GET') {
    const result = await env.DB.prepare('SELECT * FROM files ORDER BY created_at DESC').all();
    return json(result.results);
  }
  const rawFile = path.match(/^\/api\/files\/([^/]+)\/raw$/);
  if (rawFile && method === 'GET') return sendRaw(decodeURIComponent(rawFile[1]), env);
  if (path === '/api/files' && method === 'POST') {
    if (!canTeach(user)) return fail('Teacher only', 403);
    const form = await request.formData();
    const uploads = form.getAll('files').filter(value => value instanceof File && value.size > 0);
    if (!uploads.length) return fail('Choose at least one file to upload');
    if (uploads.some(file => file.size > MAX_FILE_SIZE) ||
        uploads.reduce((total, file) => total + file.size, 0) > 30 * 1024 * 1024)
      return fail('Each file must be 20 MB or smaller and the total upload must be under 30 MB', 413);
    const added = [];
    for (const file of uploads) {
      const id = crypto.randomUUID();
      const stored = id;
      const name = file.name.slice(0, 255);
      const type = file.type || 'application/octet-stream';
      const lower = name.toLowerCase();
      const kind = /\.html?$/.test(lower) ? 'html'
        : type.startsWith('image/') ? 'image'
          : type.startsWith('video/') ? 'video'
            : lower.endsWith('.pdf') ? 'pdf' : 'other';
      await env.UPLOADS.put(stored, file.stream(), {
        httpMetadata: {
          contentType: type,
          contentDisposition: `inline; filename*=UTF-8''${encodeURIComponent(name)}`
        },
        customMetadata: { originalName: name }
      });
      const record = {
        id, name, caption: '', kind, mime: type, size: file.size,
        stored, uploaded_by: user.name, created_at: Date.now()
      };
      try {
        await env.DB.prepare(
          'INSERT INTO files (id, name, caption, kind, mime, size, stored, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(id, name, '', kind, type, file.size, stored, user.name, record.created_at).run();
      } catch (error) {
        await env.UPLOADS.delete(stored);
        throw error;
      }
      added.push(record);
      await notify(env, 'uploaded', record, url.origin);
    }
    return json(added);
  }
  const filePath = path.match(/^\/api\/files\/([^/]+)$/);
  if (filePath && (method === 'PATCH' || method === 'DELETE')) {
    if (!canTeach(user)) return fail('Teacher only', 403);
    const id = decodeURIComponent(filePath[1]);
    const file = await env.DB.prepare('SELECT * FROM files WHERE id = ?').bind(id).first();
    if (!file) return fail('Not found', 404);
    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM files WHERE id = ?').bind(id).run();
      await env.UPLOADS.delete(file.stored);
      await notify(env, 'deleted', file, url.origin);
      return json({ ok: true });
    }
    const body = await bodyJson(request);
    const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 255) : file.name;
    const caption = typeof body?.caption === 'string' ? body.caption.trim().slice(0, 2000) : file.caption;
    await env.DB.prepare('UPDATE files SET name = ?, caption = ? WHERE id = ?').bind(name, caption, id).run();
    const updated = { ...file, name, caption };
    await notify(env, 'updated', updated, url.origin);
    return json({ id, name, caption, kind: file.kind, mime: file.mime, size: file.size, stored: file.stored, by: file.uploaded_by, at: file.created_at });
  }

  if (path === '/api/exercises' && method === 'GET') {
    const result = await env.DB.prepare('SELECT * FROM exercises ORDER BY created_at DESC').all();
    const submissions = await env.DB.prepare('SELECT * FROM submissions ORDER BY updated_at DESC').all();
    return json(result.results.map(exercise => {
      const item = { ...exercise, questions: JSON.parse(exercise.questions_json) };
      delete item.questions_json;
      if (user.role === 'student') {
        const mine = submissions.results.find(s => s.exercise_id === exercise.id && s.username === user.username);
        item.mySubmission = mine ? { answers: JSON.parse(mine.answers_json), at: mine.created_at, updatedAt: mine.updated_at } : null;
      } else {
        item.submissions = submissions.results.filter(s => s.exercise_id === exercise.id).map(s => ({
          username: s.username, name: s.name, answers: JSON.parse(s.answers_json), at: s.created_at, updatedAt: s.updated_at
        }));
      }
      return item;
    }));
  }
  if (path === '/api/exercises' && method === 'POST') {
    if (!canTeach(user)) return fail('Teacher only', 403);
    const body = await bodyJson(request);
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    const instructions = typeof body?.instructions === 'string' ? body.instructions.trim() : '';
    const questions = Array.isArray(body?.questions)
      ? body.questions.map(question => typeof question === 'string' ? question.trim() : '') : [];
    if (!title || title.length > 120) return fail('Exercise title must be between 1 and 120 characters');
    if (instructions.length > 2000) return fail('Instructions cannot exceed 2000 characters');
    if (questions.length < 1 || questions.length > 30 || questions.some(q => !q || q.length > 500))
      return fail('Add 1–30 non-empty questions, each up to 500 characters');
    const exercise = { id: crypto.randomUUID(), title, instructions, questions, by: user.name, at: Date.now() };
    await env.DB.prepare(
      'INSERT INTO exercises (id, title, instructions, questions_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(exercise.id, title, instructions, JSON.stringify(questions), user.username, exercise.at).run();
    return json(exercise, 201);
  }
  const exercisePath = path.match(/^\/api\/exercises\/([^/]+)$/);
  if (exercisePath && method === 'DELETE') {
    if (!canTeach(user)) return fail('Teacher only', 403);
    const result = await env.DB.prepare('DELETE FROM exercises WHERE id = ?').bind(decodeURIComponent(exercisePath[1])).run();
    return result.meta.changes ? json({ ok: true }) : fail('Exercise not found', 404);
  }
  const submissionPath = path.match(/^\/api\/exercises\/([^/]+)\/submissions$/);
  if (submissionPath && method === 'POST') {
    if (user.role !== 'student') return fail('Only students can submit exercise answers', 403);
    const exercise = await env.DB.prepare('SELECT id, questions_json FROM exercises WHERE id = ?')
      .bind(decodeURIComponent(submissionPath[1])).first();
    if (!exercise) return fail('Exercise not found', 404);
    const questions = JSON.parse(exercise.questions_json);
    const body = await bodyJson(request);
    const answers = body?.answers;
    if (!Array.isArray(answers) || answers.length !== questions.length ||
        answers.some(answer => typeof answer !== 'string' || answer.length > 5000))
      return fail('Provide an answer (up to 5000 characters) for every question');
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO submissions (id, exercise_id, username, name, answers_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (exercise_id, username)
       DO UPDATE SET name = excluded.name, answers_json = excluded.answers_json, updated_at = excluded.updated_at`
    ).bind(crypto.randomUUID(), exercise.id, user.username, user.name, JSON.stringify(answers), now, now).run();
    return json({ ok: true, updatedAt: now });
  }

  return fail('Not found', 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env);
    } catch (error) {
      console.error('Study Hub API error:', error);
      return fail(error instanceof Error ? error.message : 'Internal server error', 500);
    }
  }
};

const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const cors = require('cors');
const express = require('express');
const multer = require('multer');
const { neon } = require('@neondatabase/serverless');
const { del, get, put } = require('@vercel/blob');

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 1 }
});
const SESSION_DAYS = 30;
const sql = () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured');
  return neon(process.env.DATABASE_URL);
};
const hash = (password, salt = crypto.randomBytes(16).toString('hex')) =>
  crypto.scryptSync(password, salt, 32).toString('hex');
const check = (password, salt, expected) => {
  const actual = Buffer.from(hash(password, salt), 'hex');
  const stored = Buffer.from(expected, 'hex');
  return actual.length === stored.length && crypto.timingSafeEqual(actual, stored);
};
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const publicUser = user => ({ username: user.username, name: user.name, role: user.role });
const kindOf = (name, mime) => {
  if (/\.html?$/i.test(name)) return 'html';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (/\.pdf$/i.test(name)) return 'pdf';
  return 'other';
};
const asyncRoute = handler => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);
const fileRecord = row => ({
  id: row.id,
  name: row.name,
  caption: row.caption,
  kind: row.kind,
  mime: row.mime,
  size: Number(row.size),
  by: row.uploaded_by,
  at: Number(row.created_at),
  pathname: row.blob_path
});
const publicFile = (file, origin) => ({
  id: file.id,
  name: file.name,
  caption: file.caption,
  kind: file.kind,
  size: file.size,
  mime: file.mime,
  uploadedBy: file.by,
  createdAt: file.at,
  url: `${origin}/api/public/files/${encodeURIComponent(file.id)}/raw?key=${encodeURIComponent(process.env.API_KEY || '')}`
});

app.use(cors());
app.use(express.json({ limit: '1mb' }));

async function ensureInitialOwner() {
  const db = sql();
  const existing = await db`SELECT username FROM users LIMIT 1`;
  if (existing.length) return;
  const username = (process.env.INITIAL_OWNER_USERNAME || 'heng').trim().toLowerCase();
  const name = (process.env.INITIAL_OWNER_NAME || 'Heng').trim();
  const password = process.env.INITIAL_OWNER_PASSWORD;
  if (!/^[a-z0-9._-]{3,32}$/.test(username) || !name || name.length > 80 ||
      typeof password !== 'string' || password.length < 8 || password.length > 128) {
    throw new Error('Configure INITIAL_OWNER_PASSWORD (8–128 characters) before first login');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  await db`
    INSERT INTO users (username, name, role, salt, password_hash)
    VALUES (${username}, ${name}, 'owner', ${salt}, ${hash(password, salt)})
    ON CONFLICT (username) DO NOTHING
  `;
}

const auth = asyncRoute(async (req, res, next) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.query.token;
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  const db = sql();
  const rows = await db`
    SELECT u.username, u.name, u.role
    FROM sessions s JOIN users u ON u.username = s.username
    WHERE s.token_hash = ${digest(token)} AND s.expires_at > ${Date.now()}
  `;
  if (!rows.length) return res.status(401).json({ error: 'Not logged in' });
  req.user = rows[0];
  next();
});
const teacher = (req, res, next) => ['teacher', 'owner'].includes(req.user.role)
  ? next() : res.status(403).json({ error: 'Teacher only' });
const owner = (req, res, next) => req.user.role === 'owner'
  ? next() : res.status(403).json({ error: 'Owner only' });
const apiKey = (req, res, next) => {
  if (!process.env.API_KEY) return res.status(503).json({ error: 'Public file API is not configured' });
  const supplied = req.headers['x-api-key'] || req.query.key || '';
  const a = Buffer.from(String(supplied));
  const b = Buffer.from(process.env.API_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b)
    ? next() : res.status(401).json({ error: 'Bad API key' });
};

async function notify(event, file, origin) {
  if (!process.env.WEBHOOK_URL) return;
  try {
    const response = await fetch(process.env.WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event,
        file: publicFile(file, origin),
        at: new Date().toISOString()
      })
    });
    if (!response.ok) console.error(`Webhook notification failed with status ${response.status}`);
  } catch (error) {
    console.error('Webhook notification failed:', error);
  }
}

async function getFile(id) {
  const db = sql();
  const rows = await db`SELECT * FROM files WHERE id = ${id}`;
  return rows.length ? fileRecord(rows[0]) : null;
}

async function sendRaw(id, res) {
  const db = sql();
  const rows = await db`SELECT * FROM files WHERE id = ${id}`;
  if (!rows.length) return res.status(404).end();
  const row = rows[0];
  const blob = await get(row.blob_path, { access: 'private' });
  if (!blob || blob.statusCode !== 200 || !blob.stream)
    return res.status(404).json({ error: 'Uploaded file is missing from storage' });
  res.setHeader('Content-Type', row.kind === 'html'
    ? 'text/html; charset=utf-8' : row.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(row.name)}`);
  res.setHeader('Cache-Control', 'private, no-store');
  if (row.kind === 'html')
    res.setHeader('Content-Security-Policy', 'sandbox allow-scripts allow-forms allow-modals');
  Readable.fromWeb(blob.stream).pipe(res);
}

app.get('/api/health', asyncRoute(async (req, res) => {
  await sql()`SELECT 1 AS ok`;
  res.json({ ok: true });
}));

app.post('/api/login', asyncRoute(async (req, res) => {
  const { username, password, role } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' ||
      !['student', 'teacher', 'owner'].includes(role))
    return res.status(400).json({ error: 'Enter a username, password, and valid role' });
  await ensureInitialOwner();
  const db = sql();
  const rows = await db`
    SELECT username, name, role, salt, password_hash
    FROM users WHERE username = ${username.trim().toLowerCase()}
  `;
  const user = rows[0];
  if (!user || user.role !== role || !check(password, user.salt, user.password_hash))
    return res.status(401).json({ error: 'Wrong username, password, or role' });
  const token = crypto.randomBytes(32).toString('hex');
  await db`
    INSERT INTO sessions (token_hash, username, expires_at)
    VALUES (${digest(token)}, ${user.username}, ${Date.now() + SESSION_DAYS * 86400000})
  `;
  res.json({ token, user: publicUser(user) });
}));

app.post('/api/logout', auth, asyncRoute(async (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (token) await sql()`DELETE FROM sessions WHERE token_hash = ${digest(token)}`;
  res.json({ ok: true });
}));
app.get('/api/me', auth, (req, res) => res.json(publicUser(req.user)));

app.get('/api/users', auth, owner, asyncRoute(async (req, res) => {
  const users = await sql()`SELECT username, name, role FROM users ORDER BY username`;
  res.json(users);
}));
app.post('/api/users', auth, owner, asyncRoute(async (req, res) => {
  const { username, name, password, role } = req.body || {};
  const normalizedUsername = typeof username === 'string' ? username.trim().toLowerCase() : '';
  const normalizedName = typeof name === 'string' ? name.trim() : '';
  if (!/^[a-z0-9._-]{3,32}$/.test(normalizedUsername))
    return res.status(400).json({ error: 'Username must be 3–32 characters using letters, numbers, dots, underscores, or hyphens' });
  if (!normalizedName || normalizedName.length > 80)
    return res.status(400).json({ error: 'Name must be between 1 and 80 characters' });
  if (typeof password !== 'string' || password.length < 8 || password.length > 128)
    return res.status(400).json({ error: 'Password must be between 8 and 128 characters' });
  if (!['student', 'teacher'].includes(role))
    return res.status(400).json({ error: 'Role must be student or teacher' });
  const db = sql();
  const salt = crypto.randomBytes(16).toString('hex');
  const inserted = await db`
    INSERT INTO users (username, name, role, salt, password_hash)
    VALUES (${normalizedUsername}, ${normalizedName}, ${role}, ${salt}, ${hash(password, salt)})
    ON CONFLICT (username) DO NOTHING
    RETURNING username, name, role
  `;
  if (!inserted.length) return res.status(409).json({ error: 'Username already exists' });
  res.status(201).json(inserted[0]);
}));
app.patch('/api/users/:username', auth, owner, asyncRoute(async (req, res) => {
  const { name, role } = req.body || {};
  if (name === undefined && role === undefined)
    return res.status(400).json({ error: 'Provide a name or role to update' });
  if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.trim().length > 80))
    return res.status(400).json({ error: 'Name must be between 1 and 80 characters' });
  if (role !== undefined && !['student', 'teacher'].includes(role))
    return res.status(400).json({ error: 'Role must be student or teacher' });
  const db = sql();
  const rows = await db`SELECT username, name, role FROM users WHERE username = ${req.params.username.toLowerCase()}`;
  const user = rows[0];
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.role === 'owner' && role !== undefined)
    return res.status(403).json({ error: 'Owner permissions cannot be changed here' });
  const updated = await db`
    UPDATE users
    SET name = ${name === undefined ? user.name : name.trim()},
        role = ${role === undefined ? user.role : role}
    WHERE username = ${user.username}
    RETURNING username, name, role
  `;
  if (role !== undefined && role !== user.role)
    await db`DELETE FROM sessions WHERE username = ${user.username}`;
  res.json(updated[0]);
}));
app.delete('/api/users/:username', auth, owner, asyncRoute(async (req, res) => {
  const db = sql();
  const rows = await db`SELECT role FROM users WHERE username = ${req.params.username.toLowerCase()}`;
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  if (rows[0].role === 'owner')
    return res.status(403).json({ error: 'Owner accounts cannot be deleted here' });
  await db`DELETE FROM users WHERE username = ${req.params.username.toLowerCase()}`;
  res.json({ ok: true });
}));

app.get('/api/files', auth, asyncRoute(async (req, res) => {
  const rows = await sql()`SELECT * FROM files ORDER BY created_at DESC`;
  res.json(rows.map(fileRecord));
}));
app.get('/api/files/:id/raw', auth, asyncRoute(async (req, res) => sendRaw(req.params.id, res)));

app.get('/api/exercises', auth, asyncRoute(async (req, res) => {
  const db = sql();
  const rows = await db`SELECT * FROM exercises ORDER BY created_at DESC`;
  const exercises = rows.map(row => ({
    id: row.id,
    title: row.title,
    instructions: row.instructions,
    questions: row.questions,
    by: row.created_by,
    at: Number(row.created_at)
  }));
  const submissions = req.user.role === 'student'
    ? await db`
        SELECT * FROM submissions
        WHERE username = ${req.user.username}
        ORDER BY created_at
      `
    : await db`SELECT * FROM submissions ORDER BY created_at`;
  const shapedSubmissions = submissions.map(row => ({
    id: row.id,
    exerciseId: row.exercise_id,
    username: row.username,
    name: row.name,
    answers: row.answers,
    at: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  }));
  res.json(exercises.map(exercise => ({
    ...exercise,
    ...(req.user.role === 'student'
      ? { mySubmission: shapedSubmissions.find(item => item.exerciseId === exercise.id) || null }
      : { submissions: shapedSubmissions.filter(item => item.exerciseId === exercise.id) })
  })));
}));
app.post('/api/exercises', auth, teacher, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const instructions = typeof body.instructions === 'string' ? body.instructions.trim() : '';
  const questions = Array.isArray(body.questions)
    ? body.questions.map(question => typeof question === 'string' ? question.trim() : '')
    : [];
  if (!title || title.length > 120)
    return res.status(400).json({ error: 'Exercise title must be between 1 and 120 characters' });
  if (instructions.length > 2000)
    return res.status(400).json({ error: 'Instructions cannot exceed 2000 characters' });
  if (questions.length < 1 || questions.length > 30 || questions.some(q => !q || q.length > 500))
    return res.status(400).json({ error: 'Add 1–30 non-empty questions, each up to 500 characters' });
  const exercise = {
    id: crypto.randomUUID(), title, instructions, questions,
    by: req.user.name, at: Date.now()
  };
  await sql()`
    INSERT INTO exercises (id, title, instructions, questions, created_by, created_at)
    VALUES (${exercise.id}, ${title}, ${instructions}, ${JSON.stringify(questions)}, ${exercise.by}, ${exercise.at})
  `;
  res.status(201).json(exercise);
}));
app.delete('/api/exercises/:id', auth, teacher, asyncRoute(async (req, res) => {
  const deleted = await sql()`DELETE FROM exercises WHERE id = ${req.params.id} RETURNING id`;
  if (!deleted.length) return res.status(404).json({ error: 'Exercise not found' });
  res.json({ ok: true });
}));
app.post('/api/exercises/:id/submissions', auth, asyncRoute(async (req, res) => {
  if (req.user.role !== 'student')
    return res.status(403).json({ error: 'Only students can submit exercise answers' });
  const db = sql();
  const exercises = await db`SELECT questions FROM exercises WHERE id = ${req.params.id}`;
  if (!exercises.length) return res.status(404).json({ error: 'Exercise not found' });
  const answers = req.body && req.body.answers;
  if (!Array.isArray(answers) || answers.length !== exercises[0].questions.length ||
      answers.some(answer => typeof answer !== 'string' || answer.length > 5000))
    return res.status(400).json({ error: 'Provide an answer (up to 5000 characters) for every question' });
  const now = Date.now();
  const rows = await db`
    INSERT INTO submissions (id, exercise_id, username, name, answers, created_at, updated_at)
    VALUES (${crypto.randomUUID()}, ${req.params.id}, ${req.user.username}, ${req.user.name},
      ${JSON.stringify(answers)}, ${now}, ${now})
    ON CONFLICT (exercise_id, username) DO UPDATE
    SET answers = EXCLUDED.answers, updated_at = EXCLUDED.updated_at
    RETURNING *
  `;
  const row = rows[0];
  res.json({
    id: row.id,
    exerciseId: row.exercise_id,
    username: row.username,
    name: row.name,
    answers: row.answers,
    at: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  });
}));

app.post('/api/files', auth, teacher, upload.single('files'), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a file to upload' });
  const id = crypto.randomUUID();
  const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  const blob = await put(`study-hub/${id}/${originalName}`, req.file.buffer, {
    access: 'private',
    addRandomSuffix: true,
    contentType: req.file.mimetype || 'application/octet-stream'
  });
  const file = {
    id,
    name: originalName,
    caption: '',
    kind: kindOf(originalName, req.file.mimetype || ''),
    mime: req.file.mimetype || 'application/octet-stream',
    size: req.file.size,
    by: req.user.name,
    at: Date.now(),
    pathname: blob.pathname
  };
  try {
    await sql()`
      INSERT INTO files (id, name, caption, kind, mime, size, blob_path, uploaded_by, created_at)
      VALUES (${file.id}, ${file.name}, '', ${file.kind}, ${file.mime}, ${file.size},
        ${file.pathname}, ${file.by}, ${file.at})
    `;
  } catch (error) {
    await del(blob.url);
    throw error;
  }
  await notify('uploaded', file, `${req.protocol}://${req.get('host')}`);
  res.status(201).json([file]);
}));
app.patch('/api/files/:id', auth, teacher, asyncRoute(async (req, res) => {
  const db = sql();
  const rows = await db`SELECT * FROM files WHERE id = ${req.params.id}`;
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const previous = fileRecord(rows[0]);
  const name = typeof req.body.name === 'string' && req.body.name.trim()
    ? req.body.name.trim() : previous.name;
  const caption = typeof req.body.caption === 'string' ? req.body.caption.trim() : previous.caption;
  const updated = await db`
    UPDATE files SET name = ${name}, caption = ${caption}
    WHERE id = ${req.params.id} RETURNING *
  `;
  const file = fileRecord(updated[0]);
  await notify('updated', file, `${req.protocol}://${req.get('host')}`);
  res.json(file);
}));
app.delete('/api/files/:id', auth, teacher, asyncRoute(async (req, res) => {
  const db = sql();
  const rows = await db`SELECT * FROM files WHERE id = ${req.params.id}`;
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const file = fileRecord(rows[0]);
  await del(file.pathname);
  await db`DELETE FROM files WHERE id = ${req.params.id}`;
  await notify('deleted', file, `${req.protocol}://${req.get('host')}`);
  res.json({ ok: true });
}));

app.get('/api/public/files', apiKey, asyncRoute(async (req, res) => {
  const rows = await sql()`SELECT * FROM files ORDER BY created_at DESC`;
  const origin = `${req.protocol}://${req.get('host')}`;
  res.json(rows.map(row => publicFile(fileRecord(row), origin)));
}));
app.get('/api/public/files/:id', apiKey, asyncRoute(async (req, res) => {
  const file = await getFile(req.params.id);
  if (!file) return res.status(404).json({ error: 'Not found' });
  res.json(publicFile(file, `${req.protocol}://${req.get('host')}`));
}));
app.get('/api/public/files/:id/raw', apiKey, asyncRoute(async (req, res) => sendRaw(req.params.id, res)));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof multer.MulterError) {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? 'Files must be 4 MB or smaller on Vercel'
      : 'Upload one file per request';
    return res.status(status).json({ error: message });
  }
  console.error('Study Hub API error:', error);
  res.status(500).json({ error: error.message || 'Study Hub API error' });
});

module.exports = app;
module.exports.config = { api: { bodyParser: false } };

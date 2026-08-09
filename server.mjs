import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const port = Number(process.env.PORT || 3110);
const dataDir = process.env.DATA_DIR || join(process.cwd(), 'data');
const staticDir = process.env.STATIC_DIR || process.cwd();
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, 'news.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sources (id INTEGER PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, feed_url TEXT NOT NULL UNIQUE, accent TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS articles (id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL REFERENCES sources(id), external_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, url TEXT NOT NULL, summary TEXT, category TEXT NOT NULL, published_at TEXT NOT NULL, fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE INDEX IF NOT EXISTS articles_published_idx ON articles(published_at DESC);
  CREATE TABLE IF NOT EXISTS user_topics (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, topic TEXT NOT NULL, PRIMARY KEY (user_id, topic));
  CREATE TABLE IF NOT EXISTS user_sources (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE, enabled INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (user_id, source_id));
`);

const SOURCE_SEED = [
  ['OpenAI', 'https://openai.com/news/', 'https://openai.com/news/rss.xml', '#cefa62'],
  ['Hugging Face', 'https://huggingface.co/blog', 'https://huggingface.co/blog/feed.xml', '#ffd35c'],
  ['GitHub Blog', 'https://github.blog/', 'https://github.blog/feed/', '#cbbaff'],
  ['Cloudflare', 'https://blog.cloudflare.com/', 'https://blog.cloudflare.com/rss/', '#ffaf79'],
];
const insertSource = db.prepare('INSERT OR IGNORE INTO sources (name, url, feed_url, accent) VALUES (?, ?, ?, ?)');
SOURCE_SEED.forEach((source) => insertSource.run(...source));
const TOPICS = ['models', 'dev', 'research', 'tools'];
let lastRefresh = 0;
let refreshPromise = null;

function clean(value = '') {
  return decodeEntities(value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}
function decodeEntities(value) {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#39);/g, (entity) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'" })[entity] || entity);
}
function tag(block, name) {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return match ? clean(match[1]) : '';
}
function linkFrom(block) {
  const atom = block.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i);
  return atom ? decodeEntities(atom[1]) : tag(block, 'link');
}
function categoryFor(sourceName, title, summary) {
  const text = `${title} ${summary}`.toLowerCase();
  if (/research|paper|benchmark|eval|dataset|science|reasoning|safety/.test(text)) return 'research';
  if (/model|gpt|llm|transformer|inference|embedding|multimodal/.test(text)) return 'models';
  if (/api|developer|code|github|cli|sdk|worker|build|deploy|javascript|python/.test(text)) return 'dev';
  return sourceName === 'GitHub Blog' || sourceName === 'Cloudflare' ? 'dev' : 'tools';
}
function parseFeed(xml, source) {
  const blocks = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || xml.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi) || [];
  return blocks.slice(0, 50).map((block) => {
    const title = tag(block, 'title');
    const url = linkFrom(block);
    const summary = tag(block, 'description') || tag(block, 'summary') || tag(block, 'content');
    const externalId = tag(block, 'guid') || tag(block, 'id') || url;
    const rawDate = tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated');
    const date = new Date(rawDate);
    if (!title || !url || !externalId) return null;
    return { externalId: `${source.id}:${externalId}`, title: title.slice(0, 500), url, summary: summary.slice(0, 900), category: categoryFor(source.name, title, summary), publishedAt: Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString() };
  }).filter(Boolean);
}
async function refreshFeeds(force = false) {
  if (refreshPromise) return refreshPromise;
  if (!force && Date.now() - lastRefresh < 10 * 60 * 1000) return { updated: 0, cached: true };
  refreshPromise = (async () => {
    const sources = db.prepare('SELECT * FROM sources WHERE enabled = 1').all();
    const addArticle = db.prepare('INSERT OR IGNORE INTO articles (source_id, external_id, title, url, summary, category, published_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    let updated = 0;
    await Promise.all(sources.map(async (source) => {
      try {
        const response = await fetch(source.feed_url, { headers: { 'User-Agent': 'signal-ai-news/1.0 (+https://supadrupapp.xedoc.ru)' }, signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const articles = parseFeed(await response.text(), source);
        for (const article of articles) updated += addArticle.run(source.id, article.externalId, article.title, article.url, article.summary, article.category, article.publishedAt).changes;
      } catch (error) { console.error(`Could not refresh ${source.name}: ${error.message}`); }
    }));
    lastRefresh = Date.now();
    return { updated, cached: false };
  })();
  try { return await refreshPromise; } finally { refreshPromise = null; }
}

function userFromRequest(request) {
  const match = (request.headers.cookie || '').match(/(?:^|;\s*)signal_session=([^;]+)/);
  const token = match?.[1];
  if (!token) return null;
  const hash = createHash('sha256').update(token).digest('hex');
  const session = db.prepare('SELECT users.id, users.email, sessions.expires_at AS expiresAt FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ?').get(hash);
  if (!session || new Date(`${session.expiresAt.replace(' ', 'T')}Z`) <= new Date()) return null;
  return { id: session.id, email: session.email };
}
function json(response, status, body, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  response.end(JSON.stringify(body));
}
function badRequest(response, message) { json(response, 400, { error: message }); }
async function body(request) {
  let raw = '';
  for await (const chunk of request) { raw += chunk; if (raw.length > 100000) throw new Error('Request too large'); }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new Error('Invalid JSON'); }
}
function sessionCookie(token, maxAge = 60 * 60 * 24 * 30) {
  return `signal_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
async function createUserSession(response, user) {
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))").run(hash, user.id);
  json(response, 201, { user }, { 'Set-Cookie': sessionCookie(token) });
}
async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const value = await scrypt(password, salt, 64);
  return `${salt}:${value.toString('hex')}`;
}
async function passwordMatches(password, stored) {
  const [salt, hash] = stored.split(':');
  const actual = await scrypt(password, salt, 64);
  return timingSafeEqual(Buffer.from(hash, 'hex'), actual);
}
function preferences(userId) {
  return {
    topics: db.prepare('SELECT topic FROM user_topics WHERE user_id = ?').all(userId).map((row) => row.topic),
    sources: db.prepare('SELECT source_id AS sourceId, enabled FROM user_sources WHERE user_id = ?').all(userId),
  };
}
function feed(user, topic) {
  const selected = user ? preferences(user.id) : { topics: [], sources: [] };
  const topics = topic && TOPICS.includes(topic) ? [topic] : selected.topics;
  const disabledSources = selected.sources.filter((row) => !row.enabled).map((row) => row.sourceId);
  let query = `SELECT articles.id, articles.title, articles.url, articles.summary, articles.category, articles.published_at AS publishedAt, sources.id AS sourceId, sources.name AS sourceName, sources.accent FROM articles JOIN sources ON sources.id = articles.source_id WHERE 1=1`;
  const params = [];
  if (topics.length) { query += ` AND articles.category IN (${topics.map(() => '?').join(',')})`; params.push(...topics); }
  if (disabledSources.length) { query += ` AND articles.source_id NOT IN (${disabledSources.map(() => '?').join(',')})`; params.push(...disabledSources); }
  query += ' ORDER BY datetime(articles.published_at) DESC LIMIT 60';
  return db.prepare(query).all(...params);
}
async function api(request, response, url) {
  const user = userFromRequest(request);
  if (request.method === 'GET' && url.pathname === '/api/health') return json(response, 200, { ok: true });
  if (request.method === 'GET' && url.pathname === '/api/me') return json(response, 200, { user, preferences: user ? preferences(user.id) : null });
  if (request.method === 'GET' && url.pathname === '/api/sources') return json(response, 200, { sources: db.prepare('SELECT id, name, url, accent FROM sources WHERE enabled = 1 ORDER BY id').all() });
  if (request.method === 'GET' && url.pathname === '/api/feed') return json(response, 200, { articles: feed(user, url.searchParams.get('topic')), personalized: Boolean(user) });
  if (request.method === 'POST' && url.pathname === '/api/refresh') {
    const result = await refreshFeeds();
    return json(response, 200, result);
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/register') {
    const { email = '', password = '' } = await body(request);
    const normalized = email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(normalized)) return badRequest(response, 'Введите корректный email.');
    if (password.length < 8) return badRequest(response, 'Пароль должен содержать не менее 8 символов.');
    try {
      const result = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(normalized, await hashPassword(password));
      return createUserSession(response, { id: Number(result.lastInsertRowid), email: normalized });
    } catch { return badRequest(response, 'Пользователь с таким email уже существует.'); }
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/login') {
    const { email = '', password = '' } = await body(request);
    const userRecord = db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?').get(email.trim().toLowerCase());
    if (!userRecord || !(await passwordMatches(password, userRecord.password_hash))) return json(response, 401, { error: 'Неверный email или пароль.' });
    return createUserSession(response, { id: userRecord.id, email: userRecord.email });
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
    const token = (request.headers.cookie || '').match(/(?:^|;\s*)signal_session=([^;]+)/)?.[1];
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(createHash('sha256').update(token).digest('hex'));
    return json(response, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }
  if (request.method === 'PUT' && url.pathname === '/api/preferences') {
    if (!user) return json(response, 401, { error: 'Войдите, чтобы сохранить настройки.' });
    const { topics = [], sources = [] } = await body(request);
    const validTopics = [...new Set(topics)].filter((item) => TOPICS.includes(item));
    const validSources = sources.filter((item) => Number.isInteger(item.sourceId) && typeof item.enabled === 'boolean');
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM user_topics WHERE user_id = ?').run(user.id);
      const addTopic = db.prepare('INSERT INTO user_topics (user_id, topic) VALUES (?, ?)');
      validTopics.forEach((item) => addTopic.run(user.id, item));
      const updateSource = db.prepare('INSERT INTO user_sources (user_id, source_id, enabled) VALUES (?, ?, ?) ON CONFLICT(user_id, source_id) DO UPDATE SET enabled = excluded.enabled');
      validSources.forEach((item) => updateSource.run(user.id, item.sourceId, Number(item.enabled)));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return json(response, 200, { preferences: preferences(user.id) });
  }
  return json(response, 404, { error: 'Не найдено.' });
}
async function staticFile(request, response, path) {
  const requested = path === '/' ? 'index.html' : path.slice(1);
  if (!['index.html', 'styles.css', 'app.js'].includes(requested)) { response.writeHead(404); return response.end('Not found'); }
  try {
    const file = await readFile(join(staticDir, requested));
    const type = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8' }[extname(requested)];
    response.writeHead(200, { 'Content-Type': type }); response.end(file);
  } catch { response.writeHead(404); response.end('Not found'); }
}
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await api(request, response, url);
    return await staticFile(request, response, url.pathname);
  } catch (error) { console.error(error); return json(response, 500, { error: 'Внутренняя ошибка сервера.' }); }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`signal/ai listening on http://127.0.0.1:${port}`);
  refreshFeeds().then((result) => console.log(`Initial refresh: ${result.updated} new articles`));
});
setInterval(() => refreshFeeds(), 15 * 60 * 1000).unref();

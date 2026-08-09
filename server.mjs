import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const port = Number(process.env.PORT || 3110);
const dataDir = process.env.DATA_DIR || join(process.cwd(), 'data');
const staticDir = process.env.STATIC_DIR || process.cwd();
mkdirSync(dataDir, { recursive: true });
const uploadsDir = join(dataDir, 'uploads');
mkdirSync(uploadsDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, 'news.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, is_admin INTEGER NOT NULL DEFAULT 0, is_moderator INTEGER NOT NULL DEFAULT 0, is_banned INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sources (id INTEGER PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, feed_url TEXT NOT NULL UNIQUE, accent TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS articles (id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL REFERENCES sources(id), external_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, url TEXT NOT NULL, summary TEXT, category TEXT NOT NULL, published_at TEXT NOT NULL, fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, view_count INTEGER NOT NULL DEFAULT 0, source_popularity_label TEXT NOT NULL DEFAULT '', is_hidden INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX IF NOT EXISTS articles_published_idx ON articles(published_at DESC);
  CREATE TABLE IF NOT EXISTS user_topics (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, topic TEXT NOT NULL, PRIMARY KEY (user_id, topic));
  CREATE TABLE IF NOT EXISTS user_sources (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE, enabled INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (user_id, source_id));
  CREATE TABLE IF NOT EXISTS user_settings (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, language TEXT NOT NULL DEFAULT 'ru' CHECK(language IN ('ru', 'en')));
  CREATE TABLE IF NOT EXISTS translations (article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE, language TEXT NOT NULL CHECK(language IN ('ru', 'en')), title TEXT NOT NULL, summary TEXT, PRIMARY KEY (article_id, language));
  CREATE TABLE IF NOT EXISTS article_pages (article_id INTEGER PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE, original_title TEXT NOT NULL, original_content TEXT NOT NULL, original_markup TEXT NOT NULL DEFAULT '', original_markup_version INTEGER NOT NULL DEFAULT 1, fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS article_page_translations (article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE, language TEXT NOT NULL CHECK(language IN ('ru', 'en')), title TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY (article_id, language));
  CREATE TABLE IF NOT EXISTS user_profiles (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, display_name TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '', avatar_url TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY, article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, parent_id INTEGER, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE INDEX IF NOT EXISTS comments_article_idx ON comments(article_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS user_posts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, blocks_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, published_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, view_count INTEGER NOT NULL DEFAULT 0, is_hidden INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS post_votes (post_id INTEGER NOT NULL REFERENCES user_posts(id) ON DELETE CASCADE, poll_id TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, option_index INTEGER NOT NULL, PRIMARY KEY (post_id, poll_id, user_id));
  CREATE INDEX IF NOT EXISTS user_posts_published_idx ON user_posts(published_at DESC);
  CREATE TABLE IF NOT EXISTS post_comments (id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL REFERENCES user_posts(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, parent_id INTEGER, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE INDEX IF NOT EXISTS post_comments_post_idx ON post_comments(post_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS analytics_events (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, content_type TEXT, content_id INTEGER, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE INDEX IF NOT EXISTS analytics_events_kind_created_idx ON analytics_events(kind, created_at DESC);
`);
if (!db.prepare("SELECT name FROM pragma_table_info('comments') WHERE name = 'parent_id'").get()) db.exec('ALTER TABLE comments ADD COLUMN parent_id INTEGER');
if (!db.prepare("SELECT name FROM pragma_table_info('user_profiles') WHERE name = 'bio'").get()) db.exec("ALTER TABLE user_profiles ADD COLUMN bio TEXT NOT NULL DEFAULT ''");
if (!db.prepare("SELECT name FROM pragma_table_info('user_profiles') WHERE name = 'avatar_url'").get()) db.exec("ALTER TABLE user_profiles ADD COLUMN avatar_url TEXT NOT NULL DEFAULT ''");
if (!db.prepare("SELECT name FROM pragma_table_info('articles') WHERE name = 'view_count'").get()) db.exec('ALTER TABLE articles ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0');
if (!db.prepare("SELECT name FROM pragma_table_info('articles') WHERE name = 'source_popularity_label'").get()) db.exec("ALTER TABLE articles ADD COLUMN source_popularity_label TEXT NOT NULL DEFAULT ''");
if (!db.prepare("SELECT name FROM pragma_table_info('user_posts') WHERE name = 'view_count'").get()) db.exec('ALTER TABLE user_posts ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0');
if (!db.prepare("SELECT name FROM pragma_table_info('article_pages') WHERE name = 'original_markup'").get()) db.exec("ALTER TABLE article_pages ADD COLUMN original_markup TEXT NOT NULL DEFAULT ''");
if (!db.prepare("SELECT name FROM pragma_table_info('article_pages') WHERE name = 'original_markup_version'").get()) db.exec('ALTER TABLE article_pages ADD COLUMN original_markup_version INTEGER NOT NULL DEFAULT 1');
if (!db.prepare("SELECT name FROM pragma_table_info('article_page_translations') WHERE name = 'markup'").get()) db.exec("ALTER TABLE article_page_translations ADD COLUMN markup TEXT NOT NULL DEFAULT ''");
if (!db.prepare("SELECT name FROM pragma_table_info('users') WHERE name = 'is_admin'").get()) db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
if (!db.prepare("SELECT name FROM pragma_table_info('users') WHERE name = 'is_moderator'").get()) db.exec('ALTER TABLE users ADD COLUMN is_moderator INTEGER NOT NULL DEFAULT 0');
if (!db.prepare("SELECT name FROM pragma_table_info('users') WHERE name = 'is_banned'").get()) db.exec('ALTER TABLE users ADD COLUMN is_banned INTEGER NOT NULL DEFAULT 0');
if (!db.prepare("SELECT name FROM pragma_table_info('articles') WHERE name = 'is_hidden'").get()) db.exec('ALTER TABLE articles ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0');
if (!db.prepare("SELECT name FROM pragma_table_info('user_posts') WHERE name = 'is_hidden'").get()) db.exec('ALTER TABLE user_posts ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0');
if (!db.prepare("SELECT name FROM pragma_table_info('comments') WHERE name = 'deleted_at'").get()) db.exec('ALTER TABLE comments ADD COLUMN deleted_at TEXT');
if (!db.prepare("SELECT name FROM pragma_table_info('comments') WHERE name = 'deleted_by'").get()) db.exec('ALTER TABLE comments ADD COLUMN deleted_by INTEGER');
if (!db.prepare("SELECT name FROM pragma_table_info('post_comments') WHERE name = 'deleted_at'").get()) db.exec('ALTER TABLE post_comments ADD COLUMN deleted_at TEXT');
if (!db.prepare("SELECT name FROM pragma_table_info('post_comments') WHERE name = 'deleted_by'").get()) db.exec('ALTER TABLE post_comments ADD COLUMN deleted_by INTEGER');
db.prepare('UPDATE users SET is_admin = 1 WHERE id = 2').run();

const SOURCE_SEED = [
  ['OpenAI', 'https://openai.com/news/', 'https://openai.com/news/rss.xml', '#cefa62'],
  ['Hugging Face', 'https://huggingface.co/blog', 'https://huggingface.co/blog/feed.xml', '#ffd35c'],
  ['GitHub Blog', 'https://github.blog/', 'https://github.blog/feed/', '#cbbaff'],
  ['Cloudflare', 'https://blog.cloudflare.com/', 'https://blog.cloudflare.com/rss/', '#ffaf79'],
  ['vc.ru', 'https://vc.ru/', 'https://vc.ru/rss', '#ff7692'],
  ['DTF', 'https://dtf.ru/', 'https://dtf.ru/rss/all', '#78c9f0'],
  ['Habr', 'https://habr.com/ru/', 'https://habr.com/ru/rss/articles/top/daily/?fl=ru', '#5ac9e8'],
  ['Hacker News', 'https://news.ycombinator.com/', 'https://hacker-news.firebaseio.com/v0/topstories.json', '#ff9c48'],
];
const insertSource = db.prepare('INSERT OR IGNORE INTO sources (name, url, feed_url, accent) VALUES (?, ?, ?, ?)');
SOURCE_SEED.forEach((source) => insertSource.run(...source));
const TOPICS = ['models', 'dev', 'research', 'tools', 'games', 'business', 'media'];
const RICH_MARKUP_VERSION = 9;
let lastRefresh = 0;
let refreshPromise = null;

function clean(value = '') {
  return decodeEntities(value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}
function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
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
  if (/research|paper|benchmark|eval|dataset|science|reasoning|safety|исследован|научн|бенчмарк|датасет|безопасност/.test(text)) return 'research';
  if (/model|gpt|llm|transformer|inference|embedding|multimodal|искусственн.*интеллект|нейросет|(?:^|[^а-яё])ии(?:$|[^а-яё])|модел[ьяи]/.test(text)) return 'models';
  if (/api|developer|code|github|cli|sdk|worker|build|deploy|javascript|python|разработк|программир|код[ауе]?|инженер/.test(text)) return 'dev';
  if (/game|gaming|steam|playstation|xbox|nintendo|blizzard|rpg|adventure|игр[аыое]|гейм|адвенчур|консол|трейлер/.test(text)) return 'games';
  if (/business|market|company|startup|finance|econom|revenue|sales|stock|бизнес|компан|рынок|маркетплейс|wildberries|яндекс|акци[яи]|инвест|деньг|финанс|эконом|продаж|выруч|сделк|реклам/.test(text)) return 'business';
  if (/movie|film|series|music|streaming|netflix|hbo|disney|anime|cinema|кино|фильм|сериал|музык|стриминг|аниме|комикс|режисс/.test(text)) return 'media';
  if (sourceName === 'DTF') return 'games';
  if (sourceName === 'vc.ru') return 'business';
  return sourceName === 'GitHub Blog' || sourceName === 'Cloudflare' || sourceName === 'Hacker News' ? 'dev' : 'tools';
}
function reclassifyArticles() {
  const articles = db.prepare('SELECT articles.id, articles.title, articles.summary, articles.category, sources.name AS sourceName FROM articles JOIN sources ON sources.id = articles.source_id').all();
  const updateCategory = db.prepare('UPDATE articles SET category = ? WHERE id = ?');
  for (const article of articles) {
    const category = categoryFor(article.sourceName, article.title, article.summary || '');
    if (category !== article.category) updateCategory.run(category, article.id);
  }
}
reclassifyArticles();
function parseFeed(xml, source) {
  const blocks = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || xml.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi) || [];
  return blocks.slice(0, 50).map((block, index) => {
    const title = tag(block, 'title');
    const url = linkFrom(block);
    const summary = tag(block, 'description') || tag(block, 'summary') || tag(block, 'content');
    const externalId = tag(block, 'guid') || tag(block, 'id') || url;
    const rawDate = tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated');
    const date = new Date(rawDate);
    if (!title || !url || !externalId) return null;
    const sourcePopularityLabel = source.name === 'Habr' ? `Топ Habr · #${index + 1}` : '';
    return { externalId: `${source.id}:${externalId}`, title: title.slice(0, 500), url, summary: summary.slice(0, 900), category: categoryFor(source.name, title, summary), publishedAt: Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(), sourcePopularityLabel };
  }).filter(Boolean);
}
async function hackerNewsFeed(source) {
  const response = await fetch(source.feed_url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const ids = (await response.json()).slice(0, 40);
  const items = await Promise.all(ids.map(async (id, index) => {
    const itemResponse = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { signal: AbortSignal.timeout(15000) });
    if (!itemResponse.ok) return null;
    const item = await itemResponse.json();
    const publishedAt = new Date((item?.time || 0) * 1000);
    if (!item || item.type !== 'story' || item.dead || item.deleted || !item.title || Number.isNaN(publishedAt.getTime()) || Date.now() - publishedAt.getTime() > 72 * 60 * 60 * 1000) return null;
    const score = Number(item.score) || 0;
    const comments = Number(item.descendants) || 0;
    const url = item.url || `https://news.ycombinator.com/item?id=${item.id}`;
    const summary = clean(item.text || `Обсуждение в Hacker News: ${comments} комментариев.`);
    return { externalId: `${source.id}:hn:${item.id}`, title: item.title.slice(0, 500), url, summary: summary.slice(0, 900), category: categoryFor(source.name, item.title, summary), publishedAt: publishedAt.toISOString(), sourcePopularityLabel: `Топ HN · #${index + 1} · ${score} pts · ${comments} комм.` };
  }));
  return items.filter(Boolean);
}
async function refreshFeeds(force = false) {
  if (refreshPromise) return refreshPromise;
  if (!force && Date.now() - lastRefresh < 10 * 60 * 1000) return { updated: 0, cached: true };
  refreshPromise = (async () => {
    const sources = db.prepare('SELECT * FROM sources WHERE enabled = 1').all();
    const addArticle = db.prepare(`INSERT INTO articles (source_id, external_id, title, url, summary, category, published_at, source_popularity_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(external_id) DO UPDATE SET source_popularity_label = excluded.source_popularity_label`);
    let updated = 0;
    await Promise.all(sources.map(async (source) => {
      try {
        if (source.name === 'Hacker News') {
          const articles = await hackerNewsFeed(source);
          for (const article of articles) updated += addArticle.run(source.id, article.externalId, article.title, article.url, article.summary, article.category, article.publishedAt, article.sourcePopularityLabel).changes;
          return;
        }
        const response = await fetch(source.feed_url, { headers: { 'User-Agent': 'supa-news/1.0 (+https://supadrupapp.xedoc.ru)' }, signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const articles = parseFeed(await response.text(), source);
        for (const article of articles) updated += addArticle.run(source.id, article.externalId, article.title, article.url, article.summary, article.category, article.publishedAt, article.sourcePopularityLabel).changes;
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
  const session = db.prepare('SELECT users.id, users.email, users.is_admin AS isAdmin, users.is_moderator AS isModerator, users.is_banned AS isBanned, user_profiles.display_name AS displayName, sessions.expires_at AS expiresAt FROM sessions JOIN users ON users.id = sessions.user_id LEFT JOIN user_profiles ON user_profiles.user_id = users.id WHERE sessions.token_hash = ?').get(hash);
  if (!session || session.isBanned || new Date(`${session.expiresAt.replace(' ', 'T')}Z`) <= new Date()) return null;
  return { id: session.id, email: session.email, displayName: session.displayName || session.email.split('@')[0], isAdmin: Boolean(session.isAdmin), isModerator: Boolean(session.isModerator) };
}
function json(response, status, body, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  response.end(JSON.stringify(body));
}
function badRequest(response, message) { json(response, 400, { error: message }); }
async function body(request) {
  let raw = '';
  for await (const chunk of request) { raw += chunk; if (raw.length > 7000000) throw new Error('Request too large'); }
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
  const setting = db.prepare('SELECT language FROM user_settings WHERE user_id = ?').get(userId);
  return {
    topics: db.prepare('SELECT topic FROM user_topics WHERE user_id = ?').all(userId).map((row) => row.topic),
    sources: db.prepare('SELECT source_id AS sourceId, enabled FROM user_sources WHERE user_id = ?').all(userId),
    language: setting?.language || 'ru',
  };
}
const recordAnalyticsEvent = db.prepare('INSERT INTO analytics_events (kind, content_type, content_id, user_id) VALUES (?, ?, ?, ?)');
function requireAdmin(user, response) {
  if (user?.isAdmin) return true;
  json(response, 403, { error: 'Доступ только для администратора.' });
  return false;
}
function canModerate(user) { return Boolean(user?.isAdmin || user?.isModerator); }
function isoDate(value, fallback) {
  const text = String(value || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(new Date(`${text}T00:00:00Z`).getTime()) ? text : fallback;
}
function dateDaysAgo(days) { return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10); }
function adminStats(fromParam, toParam) {
  const to = isoDate(toParam, new Date().toISOString().slice(0, 10));
  const from = isoDate(fromParam, dateDaysAgo(29));
  if (from > to) throw new Error('Дата начала должна быть раньше даты окончания.');
  const byDate = (sql) => new Map(db.prepare(sql).all(from, to).map((row) => [row.day, Number(row.count)]));
  const views = byDate("SELECT date(created_at) AS day, COUNT(*) AS count FROM analytics_events WHERE kind = 'view' AND date(created_at) BETWEEN ? AND ? GROUP BY day");
  const articles = byDate(`SELECT day, SUM(count) AS count FROM (
    SELECT date(published_at) AS day, COUNT(*) AS count FROM articles WHERE is_hidden = 0 AND date(published_at) BETWEEN ?1 AND ?2 GROUP BY day
    UNION ALL SELECT date(published_at) AS day, COUNT(*) AS count FROM user_posts WHERE is_hidden = 0 AND date(published_at) BETWEEN ?1 AND ?2 GROUP BY day
  ) GROUP BY day`);
  const comments = byDate(`SELECT day, SUM(count) AS count FROM (
    SELECT date(created_at) AS day, COUNT(*) AS count FROM comments WHERE date(created_at) BETWEEN ?1 AND ?2 GROUP BY day
    UNION ALL SELECT date(created_at) AS day, COUNT(*) AS count FROM post_comments WHERE date(created_at) BETWEEN ?1 AND ?2 GROUP BY day
  ) GROUP BY day`);
  const registrations = byDate('SELECT date(created_at) AS day, COUNT(*) AS count FROM users WHERE date(created_at) BETWEEN ? AND ? GROUP BY day');
  const series = [];
  for (let date = new Date(`${from}T00:00:00Z`); date <= new Date(`${to}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 1)) {
    const day = date.toISOString().slice(0, 10);
    series.push({ date: day, views: views.get(day) || 0, articles: articles.get(day) || 0, comments: comments.get(day) || 0, registrations: registrations.get(day) || 0 });
  }
  const scalar = (sql) => Number(db.prepare(sql).get().count || 0);
  return {
    from, to, series,
    totals: {
      users: scalar('SELECT COUNT(*) AS count FROM users'),
      articles: scalar('SELECT COUNT(*) AS count FROM articles WHERE is_hidden = 0') + scalar('SELECT COUNT(*) AS count FROM user_posts WHERE is_hidden = 0'),
      comments: scalar('SELECT COUNT(*) AS count FROM comments') + scalar('SELECT COUNT(*) AS count FROM post_comments'),
      views: scalar('SELECT COALESCE(SUM(view_count), 0) AS count FROM articles') + scalar('SELECT COALESCE(SUM(view_count), 0) AS count FROM user_posts'),
    },
  };
}
function adminUsers() {
  return db.prepare(`SELECT users.id, users.email, users.is_admin AS isAdmin, users.is_moderator AS isModerator, users.is_banned AS isBanned, users.created_at AS createdAt,
    COALESCE(NULLIF(user_profiles.display_name, ''), substr(users.email, 1, instr(users.email, '@') - 1)) AS displayName,
    (SELECT COUNT(*) FROM user_posts WHERE user_id = users.id) AS postCount,
    (SELECT COUNT(*) FROM comments WHERE user_id = users.id) + (SELECT COUNT(*) FROM post_comments WHERE user_id = users.id) AS commentCount
    FROM users LEFT JOIN user_profiles ON user_profiles.user_id = users.id ORDER BY datetime(users.created_at) DESC LIMIT 300`).all().map((row) => ({ ...row, isAdmin: Boolean(row.isAdmin), isModerator: Boolean(row.isModerator), isBanned: Boolean(row.isBanned) }));
}
function adminDeletedComments() {
  return db.prepare(`SELECT * FROM (
    SELECT 'article' AS kind, comments.id, comments.article_id AS contentId, articles.title AS contentTitle, comments.body, comments.created_at AS createdAt, comments.deleted_at AS deletedAt,
      COALESCE(NULLIF(author_profile.display_name, ''), substr(author.email, 1, instr(author.email, '@') - 1)) AS author,
      COALESCE(NULLIF(deleter_profile.display_name, ''), substr(deleter.email, 1, instr(deleter.email, '@') - 1)) AS deletedBy
      FROM comments JOIN articles ON articles.id = comments.article_id JOIN users AS author ON author.id = comments.user_id
      LEFT JOIN users AS deleter ON deleter.id = comments.deleted_by LEFT JOIN user_profiles AS author_profile ON author_profile.user_id = author.id LEFT JOIN user_profiles AS deleter_profile ON deleter_profile.user_id = deleter.id
      WHERE comments.deleted_at IS NOT NULL
    UNION ALL
    SELECT 'post' AS kind, post_comments.id, post_comments.post_id AS contentId, user_posts.title AS contentTitle, post_comments.body, post_comments.created_at AS createdAt, post_comments.deleted_at AS deletedAt,
      COALESCE(NULLIF(author_profile.display_name, ''), substr(author.email, 1, instr(author.email, '@') - 1)) AS author,
      COALESCE(NULLIF(deleter_profile.display_name, ''), substr(deleter.email, 1, instr(deleter.email, '@') - 1)) AS deletedBy
      FROM post_comments JOIN user_posts ON user_posts.id = post_comments.post_id JOIN users AS author ON author.id = post_comments.user_id
      LEFT JOIN users AS deleter ON deleter.id = post_comments.deleted_by LEFT JOIN user_profiles AS author_profile ON author_profile.user_id = author.id LEFT JOIN user_profiles AS deleter_profile ON deleter_profile.user_id = deleter.id
      WHERE post_comments.deleted_at IS NOT NULL
  ) ORDER BY datetime(deletedAt) DESC LIMIT 300`).all();
}
function adminContent() {
  return db.prepare(`SELECT * FROM (
    SELECT 'article' AS kind, articles.id, articles.title, sources.name AS sourceName, articles.published_at AS publishedAt, articles.view_count AS viewCount,
      (SELECT COUNT(*) FROM comments WHERE article_id = articles.id) AS commentCount, articles.is_hidden AS isHidden
      FROM articles JOIN sources ON sources.id = articles.source_id
    UNION ALL
    SELECT 'post' AS kind, user_posts.id, user_posts.title, COALESCE(NULLIF(user_profiles.display_name, ''), substr(users.email, 1, instr(users.email, '@') - 1)) AS sourceName, user_posts.published_at AS publishedAt, user_posts.view_count AS viewCount,
      (SELECT COUNT(*) FROM post_comments WHERE post_id = user_posts.id) AS commentCount, user_posts.is_hidden AS isHidden
      FROM user_posts JOIN users ON users.id = user_posts.user_id LEFT JOIN user_profiles ON user_profiles.user_id = users.id
  ) ORDER BY datetime(publishedAt) DESC LIMIT 300`).all().map((row) => ({ ...row, isHidden: Boolean(row.isHidden) }));
}
async function translateArticle(article, language) {
  if (language === 'en') return article;
  const cached = db.prepare('SELECT title, summary FROM translations WHERE article_id = ? AND language = ?').get(article.id, language);
  if (cached) return { ...article, title: cached.title, summary: cached.summary || article.summary };
  const divider = '\n\n=====|=====\n\n';
  try {
    const url = new URL('https://translate.googleapis.com/translate_a/single');
    url.searchParams.set('client', 'gtx');
    url.searchParams.set('sl', 'auto');
    url.searchParams.set('tl', language);
    url.searchParams.set('dt', 't');
    url.searchParams.set('q', `${article.title}${divider}${article.summary || ''}`);
    const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`Translation HTTP ${response.status}`);
    const data = await response.json();
    const translated = (data[0] || []).map((part) => part[0]).join('');
    const [title, summary] = translated.split('=====|=====');
    if (!title || summary === undefined) throw new Error('Translation response is incomplete');
    const translatedArticle = { ...article, title: title.trim(), summary: summary.trim() };
    db.prepare('INSERT OR REPLACE INTO translations (article_id, language, title, summary) VALUES (?, ?, ?, ?)').run(article.id, language, translatedArticle.title, translatedArticle.summary);
    return translatedArticle;
  } catch (error) {
    console.error(`Could not translate article ${article.id}: ${error.message}`);
    return article;
  }
}
async function translateArticles(articles, language) {
  const result = [];
  const queue = [...articles];
  const worker = async () => { while (queue.length) result.push(await translateArticle(queue.shift(), language)); };
  await Promise.all(Array.from({ length: Math.min(6, articles.length) }, worker));
  return articles.map((article) => result.find((translated) => translated.id === article.id) || article);
}
function extractPageContent(html, preferFragment = false) {
  let codeIndex = 0;
  const codeProtected = String(html || '').replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, () => `\n\n[[CODE_BLOCK_${codeIndex++}]]\n\n`);
  const candidates = (preferFragment ? [codeProtected] : [codeProtected.match(/<article(?:\s[^>]*)?>([\s\S]*?)<\/article>/i)?.[1], codeProtected.match(/<main(?:\s[^>]*)?>([\s\S]*?)<\/main>/i)?.[1], codeProtected.match(/<body(?:\s[^>]*)?>([\s\S]*?)<\/body>/i)?.[1], codeProtected]).filter(Boolean);
  return candidates.map((candidate) => {
    const withoutChrome = candidate.replace(/<(script|style|svg|nav|header|footer|aside|form|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
    const withBreaks = withoutChrome.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|h1|h2|h3|h4|li|blockquote|pre|div|section)>/gi, '\n\n');
    return decodeEntities(withBreaks.replace(/<[^>]+>/g, ' ')).split(/\n\s*\n/).map((part) => part.replace(/\s+/g, ' ').trim()).filter((part) => part.length > 35 || /^\[\[CODE_BLOCK_\d+\]\]$/.test(part)).slice(0, 220).join('\n\n').slice(0, 100000);
  }).sort((left, right) => right.length - left.length)[0] || '';
}
function safeExternalUrl(value, base) {
  try {
    const url = new URL(decodeEntities(String(value || '').trim()), base);
    if (url.protocol !== 'https:') return '';
    if (url.hostname === 'api.dtf.ru' && /^\/v2\.8\/redirect$/.test(url.pathname)) {
      const target = url.searchParams.get('to');
      if (target?.startsWith('https://')) return target;
    }
    return url.href;
  } catch { return ''; }
}
function safeRichMarkup(html, base) {
  const allowed = new Set(['p', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'strong', 'b', 'em', 'i', 'br', 'a', 'pre', 'code', 'figure', 'figcaption', 'img', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col']);
  return String(html || '').replace(/<[^>]*>/g, (rawTag) => {
    const match = rawTag.match(/^<\s*(\/?)\s*([a-z0-9]+)/i);
    if (!match) return '';
    const closing = Boolean(match[1]);
    const name = match[2].toLowerCase();
    if (!allowed.has(name)) return '';
    if (name === 'pre') return closing ? '</pre>' : '<pre class="reader-code-block">';
    if (name === 'code') return closing ? '</code>' : '<code>';
    if (name === 'table') return closing ? '</table></div>' : '<div class="reader-table-wrap"><table>';
    if (name === 'col') return closing ? '' : '<col>';
    if (name === 'img') {
      if (closing) return '';
      const src = rawTag.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const url = safeExternalUrl(src?.[1] || src?.[2] || src?.[3], base);
      return url ? `<img src="${escapeHtml(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '';
    }
    if (name === 'br') return closing ? '' : '<br />';
    if (name !== 'a') return `<${closing ? '/' : ''}${name}>`;
    if (closing) return '</a>';
    const href = rawTag.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const url = safeExternalUrl(href?.[1] || href?.[2] || href?.[3], base);
    return url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">` : '';
  }).replace(/<p>\s*<\/p>/gi, '').trim();
}
function elementInnerHtml(html, openingPattern) {
  const opening = openingPattern.exec(html);
  if (!opening) return '';
  const start = opening.index;
  const openingTagEnd = html.indexOf('>', start);
  const tagName = opening[0].match(/^<\s*([a-z0-9]+)/i)?.[1];
  if (openingTagEnd < 0 || !tagName) return '';
  const tags = new RegExp(`<\\/?${tagName}\\b[^>]*>`, 'gi');
  tags.lastIndex = start;
  let depth = 0;
  let tag;
  while ((tag = tags.exec(html))) {
    if (tag[0].startsWith('</')) depth -= 1;
    else if (!tag[0].endsWith('/>')) depth += 1;
    if (depth === 0) return html.slice(openingTagEnd + 1, tag.index);
  }
  return '';
}
function genericRichPage(html, article) {
  const fragment = article.sourceName === 'Habr'
    ? elementInnerHtml(html, /<div\b[^>]*\bid=["']post-content-body["'][^>]*>/i)
    : elementInnerHtml(html, /<div\b[^>]*\bclass=["'][^"']*\bpost-content\b[^"']*["'][^>]*>/i) || elementInnerHtml(html, /<article\b[^>]*>/i);
  if (!fragment) return null;
  const withoutHeader = fragment.replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, '');
  const markup = safeRichMarkup(withoutHeader, article.url).replace(/(?:<br>\s*){3,}/g, '<br><br>').trim();
  const content = extractPageContent(withoutHeader, true);
  return /<(p|h2|h3|h4|ul|ol|blockquote|pre|figure|a)\b/i.test(markup) && content.length >= 80 ? { title: pageTitleFromHtml(html, article.title), content, markup } : null;
}
function contentMarkupWithCode(content, originalMarkup) {
  const codeBlocks = [...String(originalMarkup || '').matchAll(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi)].map((match) => match[0]);
  if (!codeBlocks.length) return '';
  const paragraphMarkup = (text) => text.split(/\n\n+/).map((paragraph) => paragraph.trim()).filter(Boolean).map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`).join('');
  return String(content || '').split(/\[\[CODE_BLOCK_(\d+)\]\]/g).map((part, index) => index % 2 ? codeBlocks[Number(part)] || '' : paragraphMarkup(part)).join('');
}
function jsonObjectAt(source, from) {
  const start = source.indexOf('{', from);
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) {
      try { return JSON.parse(source.slice(start, index + 1)); } catch { return null; }
    }
  }
  return null;
}
function dtfRichPage(html, article) {
  const articleId = new URL(article.url).pathname.match(/\/(\d+)(?:-|$)/)?.[1];
  const markerIndex = articleId ? html.indexOf(`"entry@${articleId}":`) : -1;
  const entry = markerIndex >= 0 ? jsonObjectAt(html, markerIndex) : null;
  if (!entry?.blocks) return null;
  const markup = [];
  for (const block of entry.blocks) {
    if (block.hidden) continue;
    if (block.type === 'text' && block.data?.text) markup.push(safeRichMarkup(block.data.text, article.url));
    if (block.type === 'header' && block.data?.text) markup.push(`<h2>${escapeHtml(clean(block.data.text))}</h2>`);
    if (block.type === 'list' && Array.isArray(block.data?.items)) {
      const listTag = block.data.type === 'OL' ? 'ol' : 'ul';
      const items = block.data.items.map((item) => `<li>${safeRichMarkup(item, article.url)}</li>`).join('');
      if (items) markup.push(`<${listTag}>${items}</${listTag}>`);
    }
    if (block.type === 'media' && Array.isArray(block.data?.items)) {
      for (const item of block.data.items.slice(0, 12)) {
        const image = item.image?.data;
        if (!image?.uuid) continue;
        const baseUrl = `https://leonardo.osnova.io/${image.uuid}/-/`;
        const src = `${baseUrl}format/webp/`;
        const caption = clean(item.title || '');
        if (image.type === 'gif' && image.duration) {
          markup.push(`<figure class="reader-native-video"><div class="reader-video"><video controls preload="metadata" playsinline poster="${src}" referrerpolicy="no-referrer"><source src="${baseUrl}format/mp4/#t=0.1" type="video/mp4" /></video></div>${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ''}</figure>`);
        } else {
          markup.push(`<figure><img src="${src}" alt="" loading="lazy" referrerpolicy="no-referrer" />${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ''}</figure>`);
        }
      }
    }
    if (block.type === 'video') {
      const video = block.data?.video?.data;
      const service = video?.external_service;
      const id = String(service?.id || '');
      if (service?.name === 'youtube' && /^[A-Za-z0-9_-]{6,}$/.test(id)) {
        const title = clean(block.data?.title || 'Видео из статьи');
        markup.push(`<figure class="reader-video"><iframe src="https://www.youtube-nocookie.com/embed/${id}?rel=0" title="${escapeHtml(title)}" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe></figure>`);
      }
    }
    if (block.type === 'quote' && block.data?.text) markup.push(`<blockquote>${safeRichMarkup(block.data.text, article.url)}</blockquote>`);
  }
  const content = clean(markup.join('\n'));
  return markup.length && content.length >= 80 ? { title: clean(entry.title || article.title).slice(0, 500), content, markup: markup.join('\n') } : null;
}
function pageTitleFromHtml(html, fallback) {
  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1];
  return clean(ogTitle || tag(html, 'title') || fallback).slice(0, 500);
}
async function loadOriginalPage(article) {
  const cached = db.prepare('SELECT original_title AS title, original_content AS content, original_markup AS markup, original_markup_version AS markupVersion FROM article_pages WHERE article_id = ?').get(article.id);
  if (cached?.content.length >= 200 && cached.markupVersion === RICH_MARKUP_VERSION) return cached;
  let page;
  try {
    const destination = new URL(article.url);
    if (destination.protocol !== 'https:') throw new Error('Статья доступна только по HTTPS.');
    const response = await fetch(destination, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Источник вернул HTTP ${response.status}`);
    const html = await response.text();
    page = (article.sourceName === 'DTF' ? dtfRichPage(html, article) : null) || genericRichPage(html, article) || { title: pageTitleFromHtml(html, article.title), content: extractPageContent(html), markup: '' };
  } catch (error) {
    console.error(`Could not copy article ${article.id}: ${error.message}`);
    page = { title: article.title, content: article.summary || 'Источник временно не разрешил загрузку полного текста. Откройте оригинал по ссылке выше.', markup: '' };
  }
  if (page.content.length < 80) page.content = article.summary || 'Источник временно не разрешил загрузку полного текста. Откройте оригинал по ссылке выше.';
  db.prepare('INSERT OR REPLACE INTO article_pages (article_id, original_title, original_content, original_markup, original_markup_version) VALUES (?, ?, ?, ?, ?)').run(article.id, page.title, page.content, page.markup || '', RICH_MARKUP_VERSION);
  return page;
}
async function translateText(text, language) {
  if (language === 'en' || !text) return text;
  const url = new URL('https://translate.googleapis.com/translate_a/single');
  url.searchParams.set('client', 'gtx');
  url.searchParams.set('sl', 'auto');
  url.searchParams.set('tl', language);
  url.searchParams.set('dt', 't');
  url.searchParams.set('q', text);
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Translation HTTP ${response.status}`);
  const data = await response.json();
  return (data[0] || []).map((part) => part[0]).join('');
}
async function translateLongText(content, language) {
  const paragraphs = content.split(/\n\n+/);
  const chunks = [];
  let chunk = '';
  for (const paragraph of paragraphs) {
    if (chunk && chunk.length + paragraph.length > 4200) { chunks.push(chunk); chunk = ''; }
    chunk += `${chunk ? '\n\n' : ''}${paragraph}`;
  }
  if (chunk) chunks.push(chunk);
  const translated = [];
  const queue = [...chunks];
  const worker = async () => { while (queue.length) translated.push(await translateText(queue.shift(), language)); };
  await Promise.all(Array.from({ length: Math.min(4, chunks.length) }, worker));
  return translated.join('\n\n');
}
async function translateMarkup(markup, language, base) {
  const protectedParts = [];
  const protect = (value, type) => {
    const token = `[[SUPA_${type}_${protectedParts.length}]]`;
    protectedParts.push({ token, value });
    return token;
  };
  const marked = String(markup || '')
    .replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, (value) => protect(value, 'CODE'))
    .replace(/<figure\b[^>]*>[\s\S]*?<\/figure>/gi, (value) => protect(value, 'MEDIA'))
    .replace(/<a\b[^>]*>/gi, (value) => protect(value, 'LINK_START'))
    .replace(/<\/a>/gi, (value) => protect(value, 'LINK_END'));
  const pieces = marked.split(/(?=<(?:p|h2|h3|h4|li|blockquote)\b)/i).filter(Boolean);
  const chunks = [];
  let chunk = '';
  for (const piece of pieces) {
    if (chunk && chunk.length + piece.length > 3800) { chunks.push(chunk); chunk = ''; }
    chunk += piece;
  }
  if (chunk) chunks.push(chunk);
  const translated = [];
  for (const current of chunks.length ? chunks : [marked]) translated.push(await translateText(current, language));
  let result = translated.join('');
  for (const part of protectedParts) result = result.split(part.token).join(part.value);
  return safeRichMarkup(result, base);
}
async function articlePage(user, articleId) {
  const article = db.prepare('SELECT articles.id, articles.title, articles.url, articles.summary, articles.category, articles.published_at AS publishedAt, articles.view_count AS viewCount, sources.name AS sourceName, sources.accent FROM articles JOIN sources ON sources.id = articles.source_id WHERE articles.id = ? AND articles.is_hidden = 0').get(articleId);
  if (!article) return null;
  const language = user ? preferences(user.id).language : 'ru';
  const original = await loadOriginalPage(article);
  if (language === 'en') return { ...article, ...original, language, originalUrl: article.url, markup: original.markup || '' };
  if ((article.sourceName === 'DTF' || article.sourceName === 'Habr') && original.markup) return { ...article, ...original, language: 'ru', originalUrl: article.url, markup: original.markup };
  const cached = db.prepare('SELECT title, content, markup FROM article_page_translations WHERE article_id = ? AND language = ?').get(article.id, language);
  if (original.markup && cached?.markup) return { ...article, title: cached.title, content: cached.content, language, originalUrl: article.url, markup: cached.markup };
  if (original.markup) {
    try {
      const [title, content, markup] = await Promise.all([translateText(original.title, language), translateLongText(original.content, language), translateMarkup(original.markup, language, article.url)]);
      db.prepare('INSERT OR REPLACE INTO article_page_translations (article_id, language, title, content, markup) VALUES (?, ?, ?, ?, ?)').run(article.id, language, title, content, markup);
      return { ...article, title, content, language, originalUrl: article.url, markup };
    } catch (error) {
      console.error(`Could not translate article markup ${article.id}: ${error.message}`);
      return { ...article, ...original, language: 'en', originalUrl: article.url, markup: original.markup };
    }
  }
  if (cached?.content.length >= 200) return { ...article, title: cached.title, content: cached.content, language, originalUrl: article.url };
  try {
    const [title, content] = await Promise.all([translateText(original.title, language), translateLongText(original.content, language)]);
    db.prepare('INSERT OR REPLACE INTO article_page_translations (article_id, language, title, content, markup) VALUES (?, ?, ?, ?, ?)').run(article.id, language, title, content, '');
    return { ...article, title, content, language, originalUrl: article.url, markup: contentMarkupWithCode(content, original.markup) };
  } catch (error) {
    console.error(`Could not translate article page ${article.id}: ${error.message}`);
    return { ...article, ...original, language: 'en', originalUrl: article.url };
  }
}
function commentsFor(articleId, includeDeleted = false) {
  const comments = db.prepare(`SELECT comments.id, comments.parent_id AS parentId, comments.body, comments.created_at AS createdAt, comments.deleted_at AS deletedAt, comments.deleted_by AS deletedBy, comments.deleted_at IS NOT NULL AS isDeleted, users.id AS authorId, COALESCE(user_profiles.avatar_url, '') AS avatarUrl,
    COALESCE(NULLIF(user_profiles.display_name, ''), substr(users.email, 1, instr(users.email, '@') - 1)) AS author
    FROM comments JOIN users ON users.id = comments.user_id LEFT JOIN user_profiles ON user_profiles.user_id = users.id
    WHERE comments.article_id = ? ${includeDeleted ? '' : 'AND comments.deleted_at IS NULL'} ORDER BY datetime(comments.created_at) ASC`).all(articleId).map((comment) => ({ ...comment, isDeleted: Boolean(comment.isDeleted), replies: [] }));
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const roots = [];
  comments.forEach((comment) => { const parent = comment.parentId ? byId.get(comment.parentId) : null; (parent ? parent.replies : roots).push(comment); });
  return roots;
}
function postCommentsFor(postId, includeDeleted = false) {
  const comments = db.prepare(`SELECT post_comments.id, post_comments.parent_id AS parentId, post_comments.body, post_comments.created_at AS createdAt, post_comments.deleted_at AS deletedAt, post_comments.deleted_by AS deletedBy, post_comments.deleted_at IS NOT NULL AS isDeleted, users.id AS authorId, COALESCE(user_profiles.avatar_url, '') AS avatarUrl,
    COALESCE(NULLIF(user_profiles.display_name, ''), substr(users.email, 1, instr(users.email, '@') - 1)) AS author
    FROM post_comments JOIN users ON users.id = post_comments.user_id LEFT JOIN user_profiles ON user_profiles.user_id = users.id
    WHERE post_comments.post_id = ? ${includeDeleted ? '' : 'AND post_comments.deleted_at IS NULL'} ORDER BY datetime(post_comments.created_at) ASC`).all(postId).map((comment) => ({ ...comment, isDeleted: Boolean(comment.isDeleted), replies: [] }));
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const roots = [];
  comments.forEach((comment) => { const parent = comment.parentId ? byId.get(comment.parentId) : null; (parent ? parent.replies : roots).push(comment); });
  return roots;
}
function deleteComment(user, table, scopeColumn, scopeId, commentId) {
  const target = db.prepare(`SELECT id, user_id AS userId, deleted_at AS deletedAt FROM ${table} WHERE id = ? AND ${scopeColumn} = ?`).get(commentId, scopeId);
  if (!target) return { error: 'Комментарий не найден.', status: 404 };
  if (target.deletedAt) return { error: 'Комментарий уже удалён.', status: 409 };
  if (target.userId !== user.id && !canModerate(user)) return { error: 'Можно удалить только свой комментарий.', status: 403 };
  db.prepare(`UPDATE ${table} SET deleted_at = CURRENT_TIMESTAMP, deleted_by = ? WHERE id = ? AND ${scopeColumn} = ?`).run(user.id, commentId, scopeId);
  return { ok: true };
}
function safeBlocks(rawBlocks) {
  if (!Array.isArray(rawBlocks) || rawBlocks.length < 1 || rawBlocks.length > 60) throw new Error('Добавьте от 1 до 60 блоков.');
  return rawBlocks.map((block) => {
    const type = String(block?.type || '');
    if (['paragraph', 'heading', 'quote'].includes(type)) {
      const text = String(block.text || '').trim();
      if (!text || text.length > 5000) throw new Error('Текстовый блок должен содержать до 5000 символов.');
      return { type, text };
    }
    if (type === 'divider') return { type };
    if (type === 'image') {
      const url = String(block.url || '');
      if (!/^https:\/\//.test(url) && !/^\/api\/uploads\/[a-z0-9-]+\.(png|jpg|webp)$/i.test(url)) throw new Error('Для картинки укажите корректный URL или загрузите файл.');
      return { type, url, caption: String(block.caption || '').trim().slice(0, 500) };
    }
    if (type === 'poll') {
      const question = String(block.question || '').trim().slice(0, 400);
      const options = Array.isArray(block.options) ? block.options.map((option) => String(option || '').trim().slice(0, 160)).filter(Boolean).slice(0, 6) : [];
      if (!question || options.length < 2) throw new Error('В опросе нужны вопрос и минимум два варианта.');
      return { type, id: String(block.id || randomBytes(8).toString('hex')).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40), question, options };
    }
    throw new Error('Неизвестный тип блока.');
  });
}
function postRow(post) { return { ...post, blocks: JSON.parse(post.blocksJson), kind: 'post' }; }
function postsForFeed() {
  return db.prepare(`SELECT user_posts.id, user_posts.user_id AS authorId, user_posts.title, user_posts.blocks_json AS blocksJson, user_posts.published_at AS publishedAt, user_posts.view_count AS viewCount,
    (SELECT COUNT(*) FROM post_comments WHERE post_comments.post_id = user_posts.id) AS commentCount,
    COALESCE(NULLIF(user_profiles.display_name, ''), substr(users.email, 1, instr(users.email, '@') - 1)) AS author
    FROM user_posts JOIN users ON users.id = user_posts.user_id LEFT JOIN user_profiles ON user_profiles.user_id = users.id WHERE user_posts.is_hidden = 0 ORDER BY datetime(user_posts.published_at) DESC LIMIT 20`).all().map(postRow);
}
function pollResults(postId, blocks, userId) {
  const votes = db.prepare('SELECT poll_id AS pollId, option_index AS optionIndex, COUNT(*) AS count FROM post_votes WHERE post_id = ? GROUP BY poll_id, option_index').all(postId);
  const ownVotes = userId ? db.prepare('SELECT poll_id AS pollId, option_index AS optionIndex FROM post_votes WHERE post_id = ? AND user_id = ?').all(postId, userId) : [];
  return blocks.filter((block) => block.type === 'poll').reduce((result, poll) => {
    result[poll.id] = { counts: poll.options.map((_, index) => votes.find((vote) => vote.pollId === poll.id && vote.optionIndex === index)?.count || 0), selected: ownVotes.find((vote) => vote.pollId === poll.id)?.optionIndex ?? null };
    return result;
  }, {});
}
function postById(postId, user) {
  const post = db.prepare(`SELECT user_posts.id, user_posts.user_id AS authorId, user_posts.title, user_posts.blocks_json AS blocksJson, user_posts.published_at AS publishedAt, user_posts.view_count AS viewCount,
    COALESCE(NULLIF(user_profiles.display_name, ''), substr(users.email, 1, instr(users.email, '@') - 1)) AS author
    FROM user_posts JOIN users ON users.id = user_posts.user_id LEFT JOIN user_profiles ON user_profiles.user_id = users.id WHERE user_posts.id = ? AND user_posts.is_hidden = 0`).get(postId);
  if (!post) return null;
  const result = postRow(post);
  return { ...result, polls: pollResults(result.id, result.blocks, user?.id) };
}
function profileById(userId) {
  const profile = db.prepare(`SELECT users.id, COALESCE(NULLIF(user_profiles.display_name, ''), substr(users.email, 1, instr(users.email, '@') - 1)) AS displayName,
    COALESCE(user_profiles.bio, '') AS bio, COALESCE(user_profiles.avatar_url, '') AS avatarUrl, users.created_at AS createdAt
    FROM users LEFT JOIN user_profiles ON user_profiles.user_id = users.id WHERE users.id = ?`).get(userId);
  if (!profile) return null;
  const posts = db.prepare(`SELECT id, title, blocks_json AS blocksJson, published_at AS publishedAt FROM user_posts WHERE user_id = ? AND is_hidden = 0 ORDER BY datetime(published_at) DESC`).all(userId).map(postRow);
  const comments = db.prepare(`SELECT * FROM (
    SELECT comments.id, comments.body, comments.created_at AS createdAt, articles.id AS targetId, articles.title AS targetTitle, 'article' AS targetKind
    FROM comments JOIN articles ON articles.id = comments.article_id WHERE comments.user_id = ?
    UNION ALL
    SELECT post_comments.id, post_comments.body, post_comments.created_at AS createdAt, user_posts.id AS targetId, user_posts.title AS targetTitle, 'post' AS targetKind
    FROM post_comments JOIN user_posts ON user_posts.id = post_comments.post_id WHERE post_comments.user_id = ?
  ) ORDER BY datetime(createdAt) DESC LIMIT 100`).all(userId, userId);
  return { profile, posts, comments };
}
function articleOrder(sort) {
  if (sort === 'views') return 'viewCount DESC, commentCount DESC, datetime(articles.published_at) DESC';
  if (sort === 'comments') return 'commentCount DESC, viewCount DESC, datetime(articles.published_at) DESC';
  return 'datetime(articles.published_at) DESC';
}
function sourceIdsFrom(value) {
  return [...new Set(String(value || '').split(',').map(Number).filter((id) => Number.isInteger(id) && id > 0))].slice(0, 20);
}
async function feed(user, topic, sourceId, sort) {
  const selected = user ? preferences(user.id) : { topics: [], sources: [], language: 'ru' };
  const topics = topic && TOPICS.includes(topic) ? [topic] : selected.topics;
  const requestedSourceIds = sourceIdsFrom(sourceId);
  const hasSourceFilter = requestedSourceIds.length > 0;
  const disabledSources = selected.sources.filter((row) => !row.enabled).map((row) => row.sourceId);
  let query = `SELECT articles.id, articles.title, articles.url, articles.summary, articles.category, articles.published_at AS publishedAt, articles.view_count AS viewCount, articles.source_popularity_label AS sourcePopularityLabel,
    (SELECT COUNT(*) FROM comments WHERE comments.article_id = articles.id AND comments.deleted_at IS NULL) AS commentCount,
    sources.id AS sourceId, sources.name AS sourceName, sources.accent FROM articles JOIN sources ON sources.id = articles.source_id WHERE articles.is_hidden = 0`;
  const params = [];
  if (hasSourceFilter) { query += ` AND articles.source_id IN (${requestedSourceIds.map(() => '?').join(',')})`; params.push(...requestedSourceIds); }
  else if (topics.length) { query += ` AND articles.category IN (${topics.map(() => '?').join(',')})`; params.push(...topics); }
  if (!hasSourceFilter && disabledSources.length) { query += ` AND articles.source_id NOT IN (${disabledSources.map(() => '?').join(',')})`; params.push(...disabledSources); }
  query += ` ORDER BY ${articleOrder(sort)} LIMIT 30`;
  const articles = db.prepare(query).all(...params);
  return { articles: await translateArticles(articles, selected.language), language: selected.language };
}
async function highlights(user, period, sourceId, sort) {
  const days = { day: 1, week: 7, month: 31 }[period] || 1;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const language = user ? preferences(user.id).language : 'ru';
  const selectedSourceIds = sourceIdsFrom(sourceId);
  let query = `SELECT articles.id, articles.title, articles.url, articles.summary, articles.category, articles.published_at AS publishedAt, articles.view_count AS viewCount, articles.source_popularity_label AS sourcePopularityLabel,
    (SELECT COUNT(*) FROM comments WHERE comments.article_id = articles.id AND comments.deleted_at IS NULL) AS commentCount,
    sources.id AS sourceId, sources.name AS sourceName, sources.accent FROM articles JOIN sources ON sources.id = articles.source_id WHERE sources.enabled = 1 AND articles.is_hidden = 0`;
  const params = [];
  if (selectedSourceIds.length) { query += ` AND articles.source_id IN (${selectedSourceIds.map(() => '?').join(',')})`; params.push(...selectedSourceIds); }
  query += ` ORDER BY ${articleOrder(sort)} LIMIT 400`;
  const rows = db.prepare(query).all(...params)
    .filter((article) => new Date(article.publishedAt).getTime() >= cutoff)
    .map((article) => {
      const popularity = String(article.sourcePopularityLabel || '');
      const rank = Number(popularity.match(/#(\d+)/)?.[1]) || 0;
      const points = Number(popularity.match(/·\s*(\d+)\s*pts/)?.[1]) || 0;
      const sourceComments = Number(popularity.match(/·\s*(\d+)\s*комм/)?.[1]) || 0;
      const ageHours = Math.max(0, (Date.now() - new Date(article.publishedAt).getTime()) / 36e5);
      const freshness = Math.max(0, 30 * (1 - ageHours / (days * 24)));
      const sourceScore = rank ? Math.max(0, 100 - rank) * 1.25 + Math.min(points, 400) * .15 + Math.min(sourceComments, 400) * .07 : 0;
      const localScore = Math.min(article.viewCount, 100) * .5 + Math.min(article.commentCount, 100) * 3;
      return { ...article, hotScore: Math.round(sourceScore + localScore + freshness) };
    });
  rows.sort((left, right) => {
    if (sort === 'views') return Number(right.viewCount || 0) - Number(left.viewCount || 0) || Number(right.commentCount || 0) - Number(left.commentCount || 0) || new Date(right.publishedAt) - new Date(left.publishedAt);
    if (sort === 'comments') return Number(right.commentCount || 0) - Number(left.commentCount || 0) || Number(right.viewCount || 0) - Number(left.viewCount || 0) || new Date(right.publishedAt) - new Date(left.publishedAt);
    return right.hotScore - left.hotScore || new Date(right.publishedAt) - new Date(left.publishedAt);
  });
  const perSource = new Map();
  const sourceLimit = selectedSourceIds.length > 1 ? Math.ceil(18 / selectedSourceIds.length) : selectedSourceIds.length ? Infinity : 3;
  const articles = [];
  for (const article of rows) {
    if ((perSource.get(article.sourceId) || 0) >= sourceLimit) continue;
    perSource.set(article.sourceId, (perSource.get(article.sourceId) || 0) + 1);
    articles.push(article);
    if (articles.length === 18) break;
  }
  return { articles: await translateArticles(articles, language), language, sourceIds: selectedSourceIds, period: days === 1 ? 'day' : days === 7 ? 'week' : 'month' };
}
async function searchContent(user, query, sourceId) {
  const text = String(query || '').trim().replace(/\s+/g, ' ').slice(0, 100);
  if (text.length < 2) return { items: [], language: user ? preferences(user.id).language : 'ru' };
  const like = `%${text}%`;
  const selectedSourceId = Number(sourceId) || null;
  let articleSql = `SELECT articles.id, articles.title, articles.url, articles.summary, articles.category, articles.published_at AS publishedAt, articles.view_count AS viewCount,
    (SELECT COUNT(*) FROM comments WHERE comments.article_id = articles.id) AS commentCount, sources.id AS sourceId, sources.name AS sourceName, sources.accent
    FROM articles JOIN sources ON sources.id = articles.source_id
    WHERE articles.is_hidden = 0 AND sources.enabled = 1 AND (articles.title LIKE ? OR COALESCE(articles.summary, '') LIKE ? OR articles.url LIKE ?)`;
  const articleParams = [like, like, like];
  if (selectedSourceId) { articleSql += ' AND articles.source_id = ?'; articleParams.push(selectedSourceId); }
  articleSql += ' ORDER BY CASE WHEN articles.title LIKE ? THEN 0 ELSE 1 END, datetime(articles.published_at) DESC LIMIT 30';
  articleParams.push(like);
  const articleRows = db.prepare(articleSql).all(...articleParams);
  const postRows = selectedSourceId ? [] : db.prepare(`SELECT user_posts.id, user_posts.user_id AS authorId, user_posts.title, user_posts.blocks_json AS blocksJson, user_posts.published_at AS publishedAt, user_posts.view_count AS viewCount,
    (SELECT COUNT(*) FROM post_comments WHERE post_comments.post_id = user_posts.id) AS commentCount,
    COALESCE(NULLIF(user_profiles.display_name, ''), substr(users.email, 1, instr(users.email, '@') - 1)) AS author
    FROM user_posts JOIN users ON users.id = user_posts.user_id LEFT JOIN user_profiles ON user_profiles.user_id = users.id
    WHERE user_posts.is_hidden = 0 AND (user_posts.title LIKE ? OR user_posts.blocks_json LIKE ?)
    ORDER BY CASE WHEN user_posts.title LIKE ? THEN 0 ELSE 1 END, datetime(user_posts.published_at) DESC LIMIT 20`).all(like, like, like);
  const posts = postRows.map(postRow).map((post) => ({ ...post, kind: 'post', sourceName: post.author, summary: post.blocks.find((block) => block.type === 'paragraph' || block.type === 'quote')?.text || 'Авторская публикация.' }));
  const language = user ? preferences(user.id).language : 'ru';
  const articles = await translateArticles(articleRows, language);
  return { items: [...articles.map((article) => ({ ...article, kind: 'article' })), ...posts].sort((left, right) => new Date(right.publishedAt) - new Date(left.publishedAt)).slice(0, 36), language };
}
async function api(request, response, url) {
  const user = userFromRequest(request);
  if (request.method === 'GET' && url.pathname === '/api/health') return json(response, 200, { ok: true });
  if (request.method === 'GET' && url.pathname === '/api/me') return json(response, 200, { user, preferences: user ? preferences(user.id) : null });
  if (url.pathname.startsWith('/api/admin/')) {
    if (!requireAdmin(user, response)) return;
    if (request.method === 'GET' && url.pathname === '/api/admin/stats') {
      try { return json(response, 200, adminStats(url.searchParams.get('from'), url.searchParams.get('to'))); }
      catch (error) { return badRequest(response, error.message); }
    }
    if (request.method === 'GET' && url.pathname === '/api/admin/users') return json(response, 200, { users: adminUsers() });
    if (request.method === 'GET' && url.pathname === '/api/admin/content') return json(response, 200, { content: adminContent() });
    if (request.method === 'GET' && url.pathname === '/api/admin/comments') return json(response, 200, { comments: adminDeletedComments() });
    const adminUserMatch = url.pathname.match(/^\/api\/admin\/users\/(\d+)$/);
    if (request.method === 'PUT' && adminUserMatch) {
      const userId = Number(adminUserMatch[1]);
      const target = db.prepare('SELECT id, is_admin AS isAdmin, is_moderator AS isModerator, is_banned AS isBanned FROM users WHERE id = ?').get(userId);
      if (!target) return json(response, 404, { error: 'Пользователь не найден.' });
      const changes = await body(request);
      const isAdmin = typeof changes.isAdmin === 'boolean' ? changes.isAdmin : Boolean(target.isAdmin);
      const isModerator = typeof changes.isModerator === 'boolean' ? changes.isModerator : Boolean(target.isModerator);
      const isBanned = typeof changes.isBanned === 'boolean' ? changes.isBanned : Boolean(target.isBanned);
      if (userId === user.id && !isAdmin) return badRequest(response, 'Нельзя снять с себя права администратора.');
      db.prepare('UPDATE users SET is_admin = ?, is_moderator = ?, is_banned = ? WHERE id = ?').run(Number(isAdmin), Number(isModerator), Number(isBanned), userId);
      return json(response, 200, { users: adminUsers() });
    }
    const adminCommentMatch = url.pathname.match(/^\/api\/admin\/comments\/(articles|posts)\/(\d+)$/);
    if (request.method === 'PUT' && adminCommentMatch) {
      const { deleted } = await body(request);
      if (typeof deleted !== 'boolean') return badRequest(response, 'Передайте статус комментария.');
      const table = adminCommentMatch[1] === 'articles' ? 'comments' : 'post_comments';
      const result = deleted
        ? db.prepare(`UPDATE ${table} SET deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP), deleted_by = COALESCE(deleted_by, ?) WHERE id = ?`).run(user.id, Number(adminCommentMatch[2]))
        : db.prepare(`UPDATE ${table} SET deleted_at = NULL, deleted_by = NULL WHERE id = ?`).run(Number(adminCommentMatch[2]));
      return result.changes ? json(response, 200, { ok: true }) : json(response, 404, { error: 'Комментарий не найден.' });
    }
    const adminContentMatch = url.pathname.match(/^\/api\/admin\/content\/(articles|posts)\/(\d+)$/);
    if (request.method === 'PUT' && adminContentMatch) {
      const { isHidden } = await body(request);
      if (typeof isHidden !== 'boolean') return badRequest(response, 'Передайте статус видимости.');
      const table = adminContentMatch[1] === 'articles' ? 'articles' : 'user_posts';
      const result = db.prepare(`UPDATE ${table} SET is_hidden = ? WHERE id = ?`).run(Number(isHidden), Number(adminContentMatch[2]));
      return result.changes ? json(response, 200, { ok: true }) : json(response, 404, { error: 'Материал не найден.' });
    }
    return json(response, 404, { error: 'Раздел админки не найден.' });
  }
  if (request.method === 'PUT' && url.pathname === '/api/profile') {
    if (!user) return json(response, 401, { error: 'Войдите, чтобы изменить профиль.' });
    const { displayName = '', bio = '', avatarUrl } = await body(request);
    const name = String(displayName).trim().replace(/\s+/g, ' ').slice(0, 60);
    const about = String(bio).trim().replace(/\s+/g, ' ').slice(0, 600);
    const existing = profileById(user.id)?.profile;
    const avatar = avatarUrl === undefined ? existing?.avatarUrl || '' : String(avatarUrl).trim();
    if (name.length < 2) return badRequest(response, 'Имя профиля должно содержать минимум 2 символа.');
    if (avatar && !/^\/api\/uploads\/[a-z0-9-]+\.(png|jpg|webp)$/i.test(avatar)) return badRequest(response, 'Загрузите изображение через форму профиля.');
    db.prepare(`INSERT INTO user_profiles (user_id, display_name, bio, avatar_url) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET display_name = excluded.display_name, bio = excluded.bio, avatar_url = excluded.avatar_url`).run(user.id, name, about, avatar);
    return json(response, 200, { user: { ...user, displayName: name }, profile: profileById(user.id)?.profile });
  }
  const profileMatch = url.pathname.match(/^\/api\/profiles\/(\d+)$/);
  if (request.method === 'GET' && profileMatch) {
    const result = profileById(Number(profileMatch[1]));
    return result ? json(response, 200, result) : json(response, 404, { error: 'Профиль не найден.' });
  }
  if (request.method === 'GET' && url.pathname === '/api/sources') return json(response, 200, { sources: db.prepare('SELECT id, name, url, accent FROM sources WHERE enabled = 1 ORDER BY id').all() });
  if (request.method === 'GET' && url.pathname === '/api/search') return json(response, 200, await searchContent(user, url.searchParams.get('q'), url.searchParams.get('source')));
  const uploadMatch = url.pathname.match(/^\/api\/uploads\/([a-z0-9-]+\.(?:png|jpg|webp))$/i);
  if (request.method === 'GET' && uploadMatch) {
    try {
      const file = await readFile(join(uploadsDir, uploadMatch[1]));
      const extension = extname(uploadMatch[1]);
      response.writeHead(200, { 'Content-Type': { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' }[extension], 'Cache-Control': 'public, max-age=31536000, immutable' });
      return response.end(file);
    } catch { response.writeHead(404); return response.end('Not found'); }
  }
  if (request.method === 'POST' && url.pathname === '/api/uploads') {
    if (!user) return json(response, 401, { error: 'Войдите, чтобы загружать изображения.' });
    const { dataUrl = '' } = await body(request);
    const match = String(dataUrl).match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!match) return badRequest(response, 'Поддерживаются PNG, JPEG и WebP.');
    const file = Buffer.from(match[2], 'base64');
    if (!file.length || file.length > 5000000) return badRequest(response, 'Размер изображения должен быть до 5 МБ.');
    const extension = match[1] === 'jpeg' ? 'jpg' : match[1];
    const filename = `${randomBytes(12).toString('hex')}.${extension}`;
    await writeFile(join(uploadsDir, filename), file);
    return json(response, 201, { url: `/api/uploads/${filename}` });
  }
  if (request.method === 'GET' && url.pathname === '/api/posts') return json(response, 200, { posts: postsForFeed() });
  if (request.method === 'POST' && url.pathname === '/api/posts') {
    if (!user) return json(response, 401, { error: 'Войдите, чтобы опубликовать статью.' });
    const { title = '', blocks = [] } = await body(request);
    const normalizedTitle = String(title).trim().slice(0, 240);
    if (normalizedTitle.length < 5) return badRequest(response, 'Заголовок должен содержать не менее 5 символов.');
    let safe;
    try { safe = safeBlocks(blocks); } catch (error) { return badRequest(response, error.message); }
    const result = db.prepare('INSERT INTO user_posts (user_id, title, blocks_json) VALUES (?, ?, ?)').run(user.id, normalizedTitle, JSON.stringify(safe));
    return json(response, 201, { post: postById(Number(result.lastInsertRowid), user) });
  }
  const postMatch = url.pathname.match(/^\/api\/posts\/(\d+)$/);
  if (request.method === 'GET' && postMatch) {
    const postId = Number(postMatch[1]);
    db.prepare('UPDATE user_posts SET view_count = view_count + 1 WHERE id = ? AND is_hidden = 0').run(postId);
    const post = postById(postId, user);
    if (post) recordAnalyticsEvent.run('view', 'post', postId, user?.id || null);
    return post ? json(response, 200, { post }) : json(response, 404, { error: 'Публикация не найдена.' });
  }
  const voteMatch = url.pathname.match(/^\/api\/posts\/(\d+)\/polls\/([a-zA-Z0-9-]+)\/vote$/);
  if (request.method === 'POST' && voteMatch) {
    if (!user) return json(response, 401, { error: 'Войдите, чтобы голосовать.' });
    const post = postById(Number(voteMatch[1]), user);
    if (!post) return json(response, 404, { error: 'Публикация не найдена.' });
    const poll = post.blocks.find((block) => block.type === 'poll' && block.id === voteMatch[2]);
    const { optionIndex } = await body(request);
    if (!poll || !Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= poll.options.length) return badRequest(response, 'Вариант ответа не найден.');
    db.prepare('INSERT INTO post_votes (post_id, poll_id, user_id, option_index) VALUES (?, ?, ?, ?) ON CONFLICT(post_id, poll_id, user_id) DO UPDATE SET option_index = excluded.option_index').run(post.id, poll.id, user.id, optionIndex);
    return json(response, 200, { post: postById(post.id, user) });
  }
  if (request.method === 'GET' && url.pathname === '/api/feed') {
    const result = await feed(user, url.searchParams.get('topic'), url.searchParams.get('source'), url.searchParams.get('sort'));
    return json(response, 200, { ...result, personalized: Boolean(user) });
  }
  if (request.method === 'GET' && url.pathname === '/api/highlights') return json(response, 200, await highlights(user, url.searchParams.get('period'), url.searchParams.get('source'), url.searchParams.get('sort')));
  const commentsMatch = url.pathname.match(/^\/api\/articles\/(\d+)\/comments$/);
  if (request.method === 'GET' && commentsMatch) return json(response, 200, { comments: commentsFor(Number(commentsMatch[1]), canModerate(user)) });
  if (request.method === 'POST' && commentsMatch) {
    if (!user) return json(response, 401, { error: 'Войдите, чтобы оставить комментарий.' });
    const { body: commentBody = '', parentId = null } = await body(request);
    const text = commentBody.trim().replace(/\s+/g, ' ');
    if (text.length < 2 || text.length > 1500) return badRequest(response, 'Комментарий должен содержать от 2 до 1500 символов.');
    const exists = db.prepare('SELECT id FROM articles WHERE id = ?').get(Number(commentsMatch[1]));
    if (!exists) return json(response, 404, { error: 'Статья не найдена.' });
    const parent = parentId === null || parentId === undefined || parentId === '' ? null : Number(parentId);
    if (parent !== null && (!Number.isInteger(parent) || !db.prepare('SELECT id FROM comments WHERE id = ? AND article_id = ?').get(parent, Number(commentsMatch[1])))) return badRequest(response, 'Комментарий, на который вы отвечаете, не найден.');
    db.prepare('INSERT INTO comments (article_id, user_id, parent_id, body) VALUES (?, ?, ?, ?)').run(Number(commentsMatch[1]), user.id, parent, text);
    return json(response, 201, { comments: commentsFor(Number(commentsMatch[1]), canModerate(user)) });
  }
  const articleCommentDeleteMatch = url.pathname.match(/^\/api\/articles\/(\d+)\/comments\/(\d+)$/);
  if (request.method === 'DELETE' && articleCommentDeleteMatch) {
    if (!user) return json(response, 401, { error: 'Войдите, чтобы удалить комментарий.' });
    const result = deleteComment(user, 'comments', 'article_id', Number(articleCommentDeleteMatch[1]), Number(articleCommentDeleteMatch[2]));
    return result.ok ? json(response, 200, { comments: commentsFor(Number(articleCommentDeleteMatch[1]), canModerate(user)) }) : json(response, result.status, { error: result.error });
  }
  const postCommentsMatch = url.pathname.match(/^\/api\/posts\/(\d+)\/comments$/);
  if (request.method === 'GET' && postCommentsMatch) return json(response, 200, { comments: postCommentsFor(Number(postCommentsMatch[1]), canModerate(user)) });
  if (request.method === 'POST' && postCommentsMatch) {
    if (!user) return json(response, 401, { error: 'Войдите, чтобы оставить комментарий.' });
    const { body: commentBody = '', parentId = null } = await body(request);
    const text = commentBody.trim().replace(/\s+/g, ' ');
    if (text.length < 2 || text.length > 1500) return badRequest(response, 'Комментарий должен содержать от 2 до 1500 символов.');
    const postId = Number(postCommentsMatch[1]);
    if (!db.prepare('SELECT id FROM user_posts WHERE id = ?').get(postId)) return json(response, 404, { error: 'Публикация не найдена.' });
    const parent = parentId === null || parentId === undefined || parentId === '' ? null : Number(parentId);
    if (parent !== null && (!Number.isInteger(parent) || !db.prepare('SELECT id FROM post_comments WHERE id = ? AND post_id = ?').get(parent, postId))) return badRequest(response, 'Комментарий, на который вы отвечаете, не найден.');
    db.prepare('INSERT INTO post_comments (post_id, user_id, parent_id, body) VALUES (?, ?, ?, ?)').run(postId, user.id, parent, text);
    return json(response, 201, { comments: postCommentsFor(postId, canModerate(user)) });
  }
  const postCommentDeleteMatch = url.pathname.match(/^\/api\/posts\/(\d+)\/comments\/(\d+)$/);
  if (request.method === 'DELETE' && postCommentDeleteMatch) {
    if (!user) return json(response, 401, { error: 'Войдите, чтобы удалить комментарий.' });
    const result = deleteComment(user, 'post_comments', 'post_id', Number(postCommentDeleteMatch[1]), Number(postCommentDeleteMatch[2]));
    return result.ok ? json(response, 200, { comments: postCommentsFor(Number(postCommentDeleteMatch[1]), canModerate(user)) }) : json(response, result.status, { error: result.error });
  }
  const articleMatch = url.pathname.match(/^\/api\/articles\/(\d+)$/);
  if (request.method === 'GET' && articleMatch) {
    const articleId = Number(articleMatch[1]);
    db.prepare('UPDATE articles SET view_count = view_count + 1 WHERE id = ? AND is_hidden = 0').run(articleId);
    const article = await articlePage(user, articleId);
    if (article) recordAnalyticsEvent.run('view', 'article', articleId, user?.id || null);
    return article ? json(response, 200, { article }) : json(response, 404, { error: 'Статья не найдена.' });
  }
  if (request.method === 'POST' && url.pathname === '/api/refresh') {
    const result = await refreshFeeds();
    return json(response, 200, result);
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/register') {
    const { email = '', password = '', displayName = '' } = await body(request);
    const normalized = email.trim().toLowerCase();
    const name = displayName.trim().replace(/\s+/g, ' ').slice(0, 60) || normalized.split('@')[0];
    if (!/^\S+@\S+\.\S+$/.test(normalized)) return badRequest(response, 'Введите корректный email.');
    if (password.length < 8) return badRequest(response, 'Пароль должен содержать не менее 8 символов.');
    try {
      const result = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(normalized, await hashPassword(password));
      const user = { id: Number(result.lastInsertRowid), email: normalized, displayName: name, isAdmin: false, isModerator: false };
      db.prepare('INSERT INTO user_profiles (user_id, display_name) VALUES (?, ?)').run(user.id, name);
      return createUserSession(response, user);
    } catch { return badRequest(response, 'Пользователь с таким email уже существует.'); }
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/login') {
    const { email = '', password = '' } = await body(request);
    const userRecord = db.prepare('SELECT users.id, users.email, users.password_hash, users.is_admin AS isAdmin, users.is_moderator AS isModerator, user_profiles.display_name AS displayName FROM users LEFT JOIN user_profiles ON user_profiles.user_id = users.id WHERE users.email = ?').get(email.trim().toLowerCase());
    if (!userRecord || !(await passwordMatches(password, userRecord.password_hash))) return json(response, 401, { error: 'Неверный email или пароль.' });
    return createUserSession(response, { id: userRecord.id, email: userRecord.email, displayName: userRecord.displayName || userRecord.email.split('@')[0], isAdmin: Boolean(userRecord.isAdmin), isModerator: Boolean(userRecord.isModerator) });
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
    const token = (request.headers.cookie || '').match(/(?:^|;\s*)signal_session=([^;]+)/)?.[1];
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(createHash('sha256').update(token).digest('hex'));
    return json(response, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }
  if (request.method === 'PUT' && url.pathname === '/api/preferences') {
    if (!user) return json(response, 401, { error: 'Войдите, чтобы сохранить настройки.' });
    const { topics = [], sources = [], language = 'ru' } = await body(request);
    const validTopics = [...new Set(topics)].filter((item) => TOPICS.includes(item));
    const validSources = sources.filter((item) => Number.isInteger(item.sourceId) && typeof item.enabled === 'boolean');
    if (!['ru', 'en'].includes(language)) return badRequest(response, 'Поддерживаются только русский и английский языки.');
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM user_topics WHERE user_id = ?').run(user.id);
      const addTopic = db.prepare('INSERT INTO user_topics (user_id, topic) VALUES (?, ?)');
      validTopics.forEach((item) => addTopic.run(user.id, item));
      const updateSource = db.prepare('INSERT INTO user_sources (user_id, source_id, enabled) VALUES (?, ?, ?) ON CONFLICT(user_id, source_id) DO UPDATE SET enabled = excluded.enabled');
      validSources.forEach((item) => updateSource.run(user.id, item.sourceId, Number(item.enabled)));
      db.prepare('INSERT INTO user_settings (user_id, language) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET language = excluded.language').run(user.id, language);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return json(response, 200, { preferences: preferences(user.id) });
  }
  return json(response, 404, { error: 'Не найдено.' });
}
async function staticFile(request, response, path) {
  const requested = path === '/' || path === '/write' || path === '/about' || path === '/admin' || /^(\/article|\/post|\/profile)\/\d+$/.test(path) ? 'index.html' : path.slice(1);
  if (!['index.html', 'styles.css', 'reader.css', 'layout.css', 'community.css', 'replies.css', 'publisher.css', 'branding.css', 'sidebar.css', 'favicon.svg', 'app.js'].includes(requested)) { response.writeHead(404); return response.end('Not found'); }
  try {
    const file = await readFile(join(staticDir, requested));
    const type = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml' }[extname(requested)];
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
  console.log(`supa listening on http://127.0.0.1:${port}`);
  refreshFeeds().then((result) => console.log(`Initial refresh: ${result.updated} new articles`));
});
setInterval(() => refreshFeeds(), 15 * 60 * 1000).unref();

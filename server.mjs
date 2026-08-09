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
  CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sources (id INTEGER PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, feed_url TEXT NOT NULL UNIQUE, accent TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS articles (id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL REFERENCES sources(id), external_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, url TEXT NOT NULL, summary TEXT, category TEXT NOT NULL, published_at TEXT NOT NULL, fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE INDEX IF NOT EXISTS articles_published_idx ON articles(published_at DESC);
  CREATE TABLE IF NOT EXISTS user_topics (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, topic TEXT NOT NULL, PRIMARY KEY (user_id, topic));
  CREATE TABLE IF NOT EXISTS user_sources (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE, enabled INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (user_id, source_id));
  CREATE TABLE IF NOT EXISTS user_settings (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, language TEXT NOT NULL DEFAULT 'ru' CHECK(language IN ('ru', 'en')));
  CREATE TABLE IF NOT EXISTS translations (article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE, language TEXT NOT NULL CHECK(language IN ('ru', 'en')), title TEXT NOT NULL, summary TEXT, PRIMARY KEY (article_id, language));
  CREATE TABLE IF NOT EXISTS article_pages (article_id INTEGER PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE, original_title TEXT NOT NULL, original_content TEXT NOT NULL, fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS article_page_translations (article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE, language TEXT NOT NULL CHECK(language IN ('ru', 'en')), title TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY (article_id, language));
  CREATE TABLE IF NOT EXISTS user_profiles (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, display_name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY, article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, parent_id INTEGER, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE INDEX IF NOT EXISTS comments_article_idx ON comments(article_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS user_posts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, blocks_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, published_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS post_votes (post_id INTEGER NOT NULL REFERENCES user_posts(id) ON DELETE CASCADE, poll_id TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, option_index INTEGER NOT NULL, PRIMARY KEY (post_id, poll_id, user_id));
  CREATE INDEX IF NOT EXISTS user_posts_published_idx ON user_posts(published_at DESC);
  CREATE TABLE IF NOT EXISTS post_comments (id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL REFERENCES user_posts(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, parent_id INTEGER, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE INDEX IF NOT EXISTS post_comments_post_idx ON post_comments(post_id, created_at DESC);
`);
if (!db.prepare("SELECT name FROM pragma_table_info('comments') WHERE name = 'parent_id'").get()) db.exec('ALTER TABLE comments ADD COLUMN parent_id INTEGER');

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
  const session = db.prepare('SELECT users.id, users.email, user_profiles.display_name AS displayName, sessions.expires_at AS expiresAt FROM sessions JOIN users ON users.id = sessions.user_id LEFT JOIN user_profiles ON user_profiles.user_id = users.id WHERE sessions.token_hash = ?').get(hash);
  if (!session || new Date(`${session.expiresAt.replace(' ', 'T')}Z`) <= new Date()) return null;
  return { id: session.id, email: session.email, displayName: session.displayName || session.email.split('@')[0] };
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
function extractPageContent(html) {
  const candidates = [html.match(/<article(?:\s[^>]*)?>([\s\S]*?)<\/article>/i)?.[1], html.match(/<main(?:\s[^>]*)?>([\s\S]*?)<\/main>/i)?.[1], html.match(/<body(?:\s[^>]*)?>([\s\S]*?)<\/body>/i)?.[1], html].filter(Boolean);
  return candidates.map((candidate) => {
    const withoutChrome = candidate.replace(/<(script|style|svg|nav|header|footer|aside|form|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
    const withBreaks = withoutChrome.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|h1|h2|h3|h4|li|blockquote|pre|div|section)>/gi, '\n\n');
    return decodeEntities(withBreaks.replace(/<[^>]+>/g, ' ')).split(/\n\s*\n/).map((part) => part.replace(/\s+/g, ' ').trim()).filter((part) => part.length > 35).slice(0, 220).join('\n\n').slice(0, 100000);
  }).sort((left, right) => right.length - left.length)[0] || '';
}
function pageTitleFromHtml(html, fallback) {
  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1];
  return clean(ogTitle || tag(html, 'title') || fallback).slice(0, 500);
}
async function loadOriginalPage(article) {
  const cached = db.prepare('SELECT original_title AS title, original_content AS content FROM article_pages WHERE article_id = ?').get(article.id);
  if (cached?.content.length >= 200) return cached;
  let page;
  try {
    const destination = new URL(article.url);
    if (destination.protocol !== 'https:') throw new Error('Статья доступна только по HTTPS.');
    const response = await fetch(destination, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Источник вернул HTTP ${response.status}`);
    const html = await response.text();
    page = { title: pageTitleFromHtml(html, article.title), content: extractPageContent(html) };
  } catch (error) {
    console.error(`Could not copy article ${article.id}: ${error.message}`);
    page = { title: article.title, content: article.summary || 'Источник временно не разрешил загрузку полного текста. Откройте оригинал по ссылке выше.' };
  }
  if (page.content.length < 80) page.content = article.summary || 'Источник временно не разрешил загрузку полного текста. Откройте оригинал по ссылке выше.';
  db.prepare('INSERT OR REPLACE INTO article_pages (article_id, original_title, original_content) VALUES (?, ?, ?)').run(article.id, page.title, page.content);
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
async function articlePage(user, articleId) {
  const article = db.prepare('SELECT articles.id, articles.title, articles.url, articles.summary, articles.category, articles.published_at AS publishedAt, sources.name AS sourceName, sources.accent FROM articles JOIN sources ON sources.id = articles.source_id WHERE articles.id = ?').get(articleId);
  if (!article) return null;
  const language = user ? preferences(user.id).language : 'ru';
  const original = await loadOriginalPage(article);
  if (language === 'en') return { ...article, ...original, language, originalUrl: article.url };
  const cached = db.prepare('SELECT title, content FROM article_page_translations WHERE article_id = ? AND language = ?').get(article.id, language);
  if (cached?.content.length >= 200) return { ...article, title: cached.title, content: cached.content, language, originalUrl: article.url };
  try {
    const [title, content] = await Promise.all([translateText(original.title, language), translateLongText(original.content, language)]);
    db.prepare('INSERT OR REPLACE INTO article_page_translations (article_id, language, title, content) VALUES (?, ?, ?, ?)').run(article.id, language, title, content);
    return { ...article, title, content, language, originalUrl: article.url };
  } catch (error) {
    console.error(`Could not translate article page ${article.id}: ${error.message}`);
    return { ...article, ...original, language: 'en', originalUrl: article.url };
  }
}
function commentsFor(articleId) {
  const comments = db.prepare(`SELECT comments.id, comments.parent_id AS parentId, comments.body, comments.created_at AS createdAt,
    COALESCE(NULLIF(user_profiles.display_name, ''), substr(users.email, 1, instr(users.email, '@') - 1)) AS author
    FROM comments JOIN users ON users.id = comments.user_id LEFT JOIN user_profiles ON user_profiles.user_id = users.id
    WHERE comments.article_id = ? ORDER BY datetime(comments.created_at) ASC`).all(articleId).map((comment) => ({ ...comment, replies: [] }));
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const roots = [];
  comments.forEach((comment) => { const parent = comment.parentId ? byId.get(comment.parentId) : null; (parent ? parent.replies : roots).push(comment); });
  return roots;
}
function postCommentsFor(postId) {
  const comments = db.prepare(`SELECT post_comments.id, post_comments.parent_id AS parentId, post_comments.body, post_comments.created_at AS createdAt,
    COALESCE(NULLIF(user_profiles.display_name, ''), substr(users.email, 1, instr(users.email, '@') - 1)) AS author
    FROM post_comments JOIN users ON users.id = post_comments.user_id LEFT JOIN user_profiles ON user_profiles.user_id = users.id
    WHERE post_comments.post_id = ? ORDER BY datetime(post_comments.created_at) ASC`).all(postId).map((comment) => ({ ...comment, replies: [] }));
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const roots = [];
  comments.forEach((comment) => { const parent = comment.parentId ? byId.get(comment.parentId) : null; (parent ? parent.replies : roots).push(comment); });
  return roots;
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
  return db.prepare(`SELECT user_posts.id, user_posts.title, user_posts.blocks_json AS blocksJson, user_posts.published_at AS publishedAt,
    COALESCE(NULLIF(user_profiles.display_name, ''), substr(users.email, 1, instr(users.email, '@') - 1)) AS author
    FROM user_posts JOIN users ON users.id = user_posts.user_id LEFT JOIN user_profiles ON user_profiles.user_id = users.id ORDER BY datetime(user_posts.published_at) DESC LIMIT 20`).all().map(postRow);
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
  const post = db.prepare(`SELECT user_posts.id, user_posts.title, user_posts.blocks_json AS blocksJson, user_posts.published_at AS publishedAt,
    COALESCE(NULLIF(user_profiles.display_name, ''), substr(users.email, 1, instr(users.email, '@') - 1)) AS author
    FROM user_posts JOIN users ON users.id = user_posts.user_id LEFT JOIN user_profiles ON user_profiles.user_id = users.id WHERE user_posts.id = ?`).get(postId);
  if (!post) return null;
  const result = postRow(post);
  return { ...result, polls: pollResults(result.id, result.blocks, user?.id) };
}
async function feed(user, topic) {
  const selected = user ? preferences(user.id) : { topics: [], sources: [], language: 'ru' };
  const topics = topic && TOPICS.includes(topic) ? [topic] : selected.topics;
  const disabledSources = selected.sources.filter((row) => !row.enabled).map((row) => row.sourceId);
  let query = `SELECT articles.id, articles.title, articles.url, articles.summary, articles.category, articles.published_at AS publishedAt, sources.id AS sourceId, sources.name AS sourceName, sources.accent FROM articles JOIN sources ON sources.id = articles.source_id WHERE 1=1`;
  const params = [];
  if (topics.length) { query += ` AND articles.category IN (${topics.map(() => '?').join(',')})`; params.push(...topics); }
  if (disabledSources.length) { query += ` AND articles.source_id NOT IN (${disabledSources.map(() => '?').join(',')})`; params.push(...disabledSources); }
  query += ' ORDER BY datetime(articles.published_at) DESC LIMIT 30';
  const articles = db.prepare(query).all(...params);
  return { articles: await translateArticles(articles, selected.language), language: selected.language };
}
async function api(request, response, url) {
  const user = userFromRequest(request);
  if (request.method === 'GET' && url.pathname === '/api/health') return json(response, 200, { ok: true });
  if (request.method === 'GET' && url.pathname === '/api/me') return json(response, 200, { user, preferences: user ? preferences(user.id) : null });
  if (request.method === 'GET' && url.pathname === '/api/sources') return json(response, 200, { sources: db.prepare('SELECT id, name, url, accent FROM sources WHERE enabled = 1 ORDER BY id').all() });
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
    const post = postById(Number(postMatch[1]), user);
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
    const result = await feed(user, url.searchParams.get('topic'));
    return json(response, 200, { ...result, personalized: Boolean(user) });
  }
  const commentsMatch = url.pathname.match(/^\/api\/articles\/(\d+)\/comments$/);
  if (request.method === 'GET' && commentsMatch) return json(response, 200, { comments: commentsFor(Number(commentsMatch[1])) });
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
    return json(response, 201, { comments: commentsFor(Number(commentsMatch[1])) });
  }
  const postCommentsMatch = url.pathname.match(/^\/api\/posts\/(\d+)\/comments$/);
  if (request.method === 'GET' && postCommentsMatch) return json(response, 200, { comments: postCommentsFor(Number(postCommentsMatch[1])) });
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
    return json(response, 201, { comments: postCommentsFor(postId) });
  }
  const articleMatch = url.pathname.match(/^\/api\/articles\/(\d+)$/);
  if (request.method === 'GET' && articleMatch) {
    const article = await articlePage(user, Number(articleMatch[1]));
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
      const user = { id: Number(result.lastInsertRowid), email: normalized, displayName: name };
      db.prepare('INSERT INTO user_profiles (user_id, display_name) VALUES (?, ?)').run(user.id, name);
      return createUserSession(response, user);
    } catch { return badRequest(response, 'Пользователь с таким email уже существует.'); }
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/login') {
    const { email = '', password = '' } = await body(request);
    const userRecord = db.prepare('SELECT users.id, users.email, users.password_hash, user_profiles.display_name AS displayName FROM users LEFT JOIN user_profiles ON user_profiles.user_id = users.id WHERE users.email = ?').get(email.trim().toLowerCase());
    if (!userRecord || !(await passwordMatches(password, userRecord.password_hash))) return json(response, 401, { error: 'Неверный email или пароль.' });
    return createUserSession(response, { id: userRecord.id, email: userRecord.email, displayName: userRecord.displayName || userRecord.email.split('@')[0] });
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
  const requested = path === '/' ? 'index.html' : path.slice(1);
  if (!['index.html', 'styles.css', 'reader.css', 'layout.css', 'community.css', 'replies.css', 'publisher.css', 'branding.css', 'favicon.svg', 'app.js'].includes(requested)) { response.writeHead(404); return response.end('Not found'); }
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
  console.log(`signal/ai listening on http://127.0.0.1:${port}`);
  refreshFeeds().then((result) => console.log(`Initial refresh: ${result.updated} new articles`));
});
setInterval(() => refreshFeeds(), 15 * 60 * 1000).unref();

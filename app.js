const state = { user: null, preferences: { topics: [], sources: [], language: 'ru' }, sources: [], topic: 'all', isLogin: true };
const labels = { models: 'Модели', dev: 'Dev', research: 'Research', tools: 'Tools' };
const topicChoices = [['models', 'Модели и LLM'], ['dev', 'Разработка'], ['research', 'Исследования'], ['tools', 'Инструменты']];
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (text = '') => text.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);

async function request(path, options = {}) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'Не удалось выполнить запрос.');
  return payload;
}
function relativeDate(value) {
  const diff = Date.now() - new Date(value).getTime();
  const hours = Math.max(0, Math.round(diff / 36e5));
  if (hours < 1) return 'только что';
  if (hours < 24) return `${hours} ч назад`;
  return `${Math.round(hours / 24)} дн назад`;
}
function articleMarkup(article) {
  return `<article class="article-card"><a href="/article/${article.id}"><div class="article-top"><span class="tag ${article.category}">${labels[article.category] || 'News'}</span><span class="source-dot" style="--accent:${escapeHtml(article.accent)}"></span><span>${escapeHtml(article.sourceName)}</span></div><h3>${escapeHtml(article.title)}</h3><p>${escapeHtml(article.summary || 'Открыть публикацию в источнике.')}</p><div class="article-footer"><span>${relativeDate(article.publishedAt)}</span><span>Читать здесь →</span></div></a></article>`;
}
async function loadFeed() {
  const query = state.topic === 'all' ? '' : `?topic=${state.topic}`;
  const { articles, personalized } = await request(`/api/feed${query}`);
  $('#feedHeading').textContent = personalized ? 'Ваша персональная лента' : 'Свежие публикации';
  $('#articleList').innerHTML = articles.length ? articles.map(articleMarkup).join('') : '<div class="empty-state"><strong>Пока нет публикаций по этим условиям.</strong><span>Попробуйте включить больше тем или обновить ленту.</span></div>';
  $('#refreshLabel').textContent = `Лента обновлена · ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
}
function renderSources() {
  $('#sourceList').innerHTML = state.sources.map((source) => `<a class="source" href="${escapeHtml(source.url)}" target="_blank" rel="noopener"><span class="source-logo" style="background:${escapeHtml(source.accent)}">${escapeHtml(source.name.slice(0, 2).toUpperCase())}</span><span><strong>${escapeHtml(source.name)}</strong><small>Открыть источник</small></span><b>↗</b></a>`).join('');
}
function renderProfile() {
  $('#accountButton').textContent = state.user ? 'Настройки' : 'Войти';
  $('#profileContent').innerHTML = state.user ? `<div class="profile-email">${escapeHtml(state.user.email)}</div><p>Язык: ${state.preferences.language === 'en' ? 'English' : 'Русский'}<br />Темы: ${state.preferences.topics.length ? state.preferences.topics.map((topic) => labels[topic]).join(', ') : 'все'}</p><button class="subscribe-button" id="profileSettings">Изменить поток <span>→</span></button><button class="logout-button" id="logoutButton">Выйти</button>` : '<p>Войдите, чтобы выбирать темы, источники и язык своей ленты.</p><button class="subscribe-button" id="profileLogin">Создать аккаунт <span>↗</span></button>';
  $('#profileLogin')?.addEventListener('click', () => openAuth(false));
  $('#profileSettings')?.addEventListener('click', openSettings);
  $('#logoutButton')?.addEventListener('click', logout);
}
function openAuth(login = true) {
  state.isLogin = login;
  $('#authTitle').textContent = login ? 'Войти в поток' : 'Создать аккаунт';
  $('#authText').textContent = login ? 'Сохраните темы и источники, чтобы лента подстраивалась под вас.' : 'Аккаунт нужен только для вашей персональной ленты.';
  $('#authForm button').textContent = login ? 'Войти' : 'Создать аккаунт';
  $('#authSwitch').textContent = login ? 'Нет аккаунта? Создать' : 'Уже есть аккаунт? Войти';
  $('#authMessage').textContent = '';
  $('#authDialog').showModal();
}
function openSettings() {
  if (!state.user) return openAuth(false);
  const topicSet = new Set(state.preferences.topics);
  const sourceMap = new Map(state.preferences.sources.map((item) => [item.sourceId, Boolean(item.enabled)]));
  $(`input[name="language"][value="${state.preferences.language || 'ru'}"]`).checked = true;
  $('#topicSettings').innerHTML = topicChoices.map(([key, name]) => `<label class="check"><input type="checkbox" name="topic" value="${key}" ${topicSet.has(key) ? 'checked' : ''}/><span>${name}</span></label>`).join('');
  $('#sourceSettings').innerHTML = state.sources.map((source) => `<label class="check"><input type="checkbox" name="source" value="${source.id}" ${sourceMap.get(source.id) !== false ? 'checked' : ''}/><span>${escapeHtml(source.name)}</span></label>`).join('');
  $('#settingsMessage').textContent = '';
  $('#settingsDialog').showModal();
}
async function logout() { await request('/api/auth/logout', { method: 'POST' }); state.user = null; state.preferences = { topics: [], sources: [], language: 'ru' }; renderProfile(); loadFeed(); }

document.querySelectorAll('.topic').forEach((button) => button.addEventListener('click', () => { document.querySelectorAll('.topic').forEach((item) => item.classList.remove('active')); button.classList.add('active'); state.topic = button.dataset.topic; loadFeed(); }));
$('#themeToggle').addEventListener('click', () => document.body.classList.toggle('dark'));
$('#accountButton').addEventListener('click', () => state.user ? openSettings() : openAuth(true));
$('#setupButton').addEventListener('click', openSettings); $('#sourcesSetup').addEventListener('click', openSettings);
$('#profileLogin')?.addEventListener('click', () => openAuth(false));
$('#authSwitch').addEventListener('click', () => openAuth(!state.isLogin));
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => $(`#${button.dataset.close}`).close()));
document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => {
  const bounds = dialog.getBoundingClientRect();
  const outsideDialog = event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
  if (outsideDialog) dialog.close();
}));
$('#authForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { const result = await request(state.isLogin ? '/api/auth/login' : '/api/auth/register', { method: 'POST', body: JSON.stringify({ email: form.get('email'), password: form.get('password') }) }); state.user = result.user; const me = await request('/api/me'); state.preferences = me.preferences; $('#authDialog').close(); renderProfile(); openSettings(); loadFeed(); } catch (error) { $('#authMessage').textContent = error.message; } });
$('#settingsForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const topics = form.getAll('topic'); const enabled = new Set(form.getAll('source').map(Number)); const sources = state.sources.map((source) => ({ sourceId: source.id, enabled: enabled.has(source.id) })); const language = form.get('language'); try { const result = await request('/api/preferences', { method: 'PUT', body: JSON.stringify({ topics, sources, language }) }); state.preferences = result.preferences; $('#settingsMessage').textContent = 'Настройки сохранены.'; renderProfile(); loadFeed(); setTimeout(() => $('#settingsDialog').close(), 500); } catch (error) { $('#settingsMessage').textContent = error.message; } });
$('#refreshButton').addEventListener('click', async (event) => { event.currentTarget.disabled = true; event.currentTarget.innerHTML = 'Обновляем…'; try { await request('/api/refresh', { method: 'POST' }); await loadFeed(); } finally { event.currentTarget.disabled = false; event.currentTarget.innerHTML = 'Обновить <span>↻</span>'; } });

async function renderArticlePage(articleId) {
  const { article } = await request(`/api/articles/${articleId}`);
  const paragraphs = article.content.split(/\n\n+/).filter(Boolean).map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('');
  $('main').innerHTML = `<article class="reader"><a class="reader-back" href="/">← Вернуться к ленте</a><div class="reader-meta"><span class="tag ${article.category}">${labels[article.category] || 'News'}</span><span>${escapeHtml(article.sourceName)}</span><span>${relativeDate(article.publishedAt)}</span></div><h1>${escapeHtml(article.title)}</h1><div class="reader-source">Сохранённая копия · язык: ${article.language === 'ru' ? 'русский' : 'English'} <a href="${escapeHtml(article.originalUrl)}" target="_blank" rel="noopener">Оригинал ↗</a></div><div class="reader-content">${paragraphs}</div></article>`;
}
async function init() { try { const [me, sources] = await Promise.all([request('/api/me'), request('/api/sources')]); state.user = me.user; state.preferences = me.preferences || state.preferences; state.sources = sources.sources; if (location.pathname.startsWith('/article/')) return renderArticlePage(location.pathname.split('/')[2]); renderSources(); renderProfile(); await loadFeed(); } catch (error) { const target = $('#articleList') || $('main'); target.innerHTML = `<div class="empty-state"><strong>Не удалось загрузить материал.</strong><span>${escapeHtml(error.message)}</span></div>`; } }
init();

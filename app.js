const initialBestPeriod = new URLSearchParams(location.search).get('best');
const initialFeedSort = new URLSearchParams(location.search).get('sort');
const state = { user: null, preferences: { topics: [], sources: [], language: 'ru' }, sources: [], topic: new URLSearchParams(location.search).get('topic') || 'all', sourceId: Number(new URLSearchParams(location.search).get('source')) || null, bestPeriod: ['day', 'week', 'month'].includes(initialBestPeriod) ? initialBestPeriod : null, feedSort: ['recent', 'views', 'comments'].includes(initialFeedSort) ? initialFeedSort : 'recent', isLogin: true };
const labels = { models: 'Модели', dev: 'Dev', research: 'Research', tools: 'Tools', games: 'Игры', business: 'Бизнес', media: 'Медиа' };
const topicChoices = [['models', 'Модели и LLM'], ['dev', 'Разработка'], ['research', 'Исследования'], ['tools', 'Инструменты'], ['games', 'Игры'], ['business', 'Бизнес'], ['media', 'Медиа']];
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (text = '') => text.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);

const metrikaId = 111439223;
const trackEvent = (goal, params = {}) => { if (typeof window.ym === 'function') window.ym(metrikaId, 'reachGoal', goal, params); };
let stopContentTracking = () => {};
function trackContentReading(type, content) {
  stopContentTracking();
  const params = { content_type: type, content_id: Number(content.id), category: content.category || 'community', source: content.sourceName || 'community' };
  trackEvent(`${type}_open`, params);
  const depths = [25, 50, 75, 90];
  const sentDepths = new Set();
  let visibleSince = document.hidden ? 0 : Date.now();
  let visibleMs = 0;
  let readSent = false;
  const updateReadTime = () => { if (!visibleSince) return; visibleMs += Date.now() - visibleSince; visibleSince = Date.now(); if (!readSent && visibleMs >= 30000) { readSent = true; trackEvent(`${type}_read_30s`, params); } };
  const onVisibility = () => { if (document.hidden) { updateReadTime(); visibleSince = 0; } else visibleSince = Date.now(); };
  const onScroll = () => { const total = document.documentElement.scrollHeight - window.innerHeight; if (total <= 0) return; const depth = Math.round((window.scrollY / total) * 100); depths.forEach((threshold) => { if (depth >= threshold && !sentDepths.has(threshold)) { sentDepths.add(threshold); trackEvent(`${type}_scroll_${threshold}`, params); } }); };
  const timer = window.setInterval(updateReadTime, 5000);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  stopContentTracking = () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility); window.removeEventListener('scroll', onScroll); updateReadTime(); };
}
function trackMutation(path, method) {
  if (method !== 'POST' && method !== 'PUT') return;
  const commentMatch = path.match(/^\/api\/(articles|posts)\/\d+\/comments$/);
  if (commentMatch) return trackEvent(`${commentMatch[1] === 'articles' ? 'article' : 'post'}_comment_publish`);
  if (path === '/api/auth/login') return trackEvent('auth_login');
  if (path === '/api/auth/register') return trackEvent('auth_register');
  if (path === '/api/preferences') return trackEvent('settings_save');
  if (path === '/api/refresh') return trackEvent('feed_refresh');
  if (path === '/api/posts' && method === 'POST') return trackEvent('post_publish');
  if (/^\/api\/posts\/\d+\/polls\/[^/]+\/vote$/.test(path)) return trackEvent('poll_vote');
  if (path === '/api/profile') return trackEvent('profile_save');
}

async function request(path, options = {}) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'Не удалось выполнить запрос.');
  trackMutation(path, options.method || 'GET');
  return payload;
}
function relativeDate(value) {
  const diff = Date.now() - new Date(value).getTime();
  const hours = Math.max(0, Math.round(diff / 36e5));
  if (hours < 1) return 'только что';
  if (hours < 24) return `${hours} ч назад`;
  return `${Math.round(hours / 24)} дн назад`;
}
function preciseDate(value) {
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(value));
}
function metricCount(value) {
  return new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 }).format(Math.max(0, Number(value) || 0));
}
function readerViewsMarkup(value) {
  const views = metricCount(value);
  return `<span class="reader-views" title="Просмотров на supa"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/></svg>${views}</span>`;
}
function feedReturnHref() {
  const query = new URLSearchParams(location.search).toString();
  return `/${query ? `?${query}` : ''}`;
}
function articleMarkup(article) {
  const ownPost = article.kind === 'post';
  const date = preciseDate(article.publishedAt);
  const views = metricCount(article.viewCount);
  const comments = metricCount(article.commentCount);
  const popularity = article.sourcePopularityLabel ? `<span class="source-popularity" title="Популярность в источнике">↗ ${escapeHtml(article.sourcePopularityLabel)}</span>` : '';
  return `<article class="article-card ${ownPost ? 'author-post-card' : ''}"><a href="${ownPost ? `/post/${article.id}` : `/article/${article.id}`}"><div class="article-top"><span class="tag ${ownPost ? 'tools' : article.category}">${ownPost ? 'Автор' : (labels[article.category] || 'News')}</span><span class="source-dot" style="--accent:${ownPost ? '#8463ef' : escapeHtml(article.accent)}"></span><span>${escapeHtml(ownPost ? article.author : article.sourceName)}</span></div><h3>${escapeHtml(article.title)}</h3><p>${escapeHtml(article.summary || 'Открыть публикацию в источнике.')}</p>${popularity ? `<div class="article-source-popularity">${popularity}</div>` : ''}<div class="article-footer"><div class="article-metrics"><time datetime="${escapeHtml(article.publishedAt)}" title="${escapeHtml(date)}">${relativeDate(article.publishedAt)}</time><span class="article-metric" aria-label="Просмотров: ${views}" title="Просмотров"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/></svg>${views}</span><span class="article-metric" aria-label="Комментариев: ${comments}" title="Комментариев"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5h16v10H9l-5 3v-13Z"/></svg>${comments}</span></div><span>Читать здесь →</span></div></a></article>`;
}
function enhanceCodeBlocks() {
  document.querySelectorAll('.reader-code-block').forEach((block) => {
    if (block.dataset.enhanced) return;
    block.dataset.enhanced = 'true';
    const code = block.querySelector('code') || block.appendChild(document.createElement('code'));
    const text = code.textContent.replace(/\r\n/g, '\n').replace(/^\n|\n\s*$/g, '');
    const lines = text.split('\n');
    code.innerHTML = lines.map((line) => `<span class="code-line">${escapeHtml(line) || ' '}</span>`).join('');
    const toolbar = document.createElement('div');
    toolbar.className = 'code-toolbar';
    toolbar.innerHTML = `<span>Код · ${lines.length} строк</span><div><button type="button" data-code-wrap>Перенос</button><button type="button" data-code-lines>Номера</button><button type="button" data-code-copy>Копировать</button></div>`;
    block.prepend(toolbar);
    toolbar.querySelector('[data-code-wrap]').addEventListener('click', (event) => { block.classList.toggle('code-wrap'); event.currentTarget.classList.toggle('active', block.classList.contains('code-wrap')); });
    toolbar.querySelector('[data-code-lines]').addEventListener('click', (event) => { block.classList.toggle('code-lines'); event.currentTarget.classList.toggle('active', block.classList.contains('code-lines')); });
    toolbar.querySelector('[data-code-copy]').addEventListener('click', async (event) => { try { await navigator.clipboard.writeText(text); event.currentTarget.textContent = 'Скопировано'; setTimeout(() => { event.currentTarget.textContent = 'Копировать'; }, 1400); } catch { event.currentTarget.textContent = 'Не скопировано'; } });
  });
}
async function loadFeed() {
  const selectedSource = state.sources.find((source) => source.id === state.sourceId);
  const isHighlights = Boolean(state.bestPeriod);
  let articles = [];
  let personalized = false;
  let ownPosts = [];
  if (isHighlights) {
    const query = new URLSearchParams({ period: state.bestPeriod });
    if (state.sourceId) query.set('source', state.sourceId);
    ({ articles } = await request(`/api/highlights?${query}`));
    personalized = Boolean(state.user);
  } else {
    const query = new URLSearchParams();
    if (state.sourceId) query.set('source', state.sourceId);
    else if (state.topic !== 'all') query.set('topic', state.topic);
    const feedResult = await request(`/api/feed${query.size ? `?${query}` : ''}`);
    articles = feedResult.articles;
    personalized = feedResult.personalized;
    if (state.topic === 'all' && !state.sourceId) {
      const { posts } = await request('/api/posts');
      ownPosts = posts.map((post) => ({ ...post, summary: post.blocks.find((block) => block.type === 'paragraph' || block.type === 'quote')?.text || 'Авторская публикация сообщества.' }));
    }
  }
  const canSortPersonal = personalized && !state.sourceId && state.topic === 'all';
  const items = isHighlights ? articles : [...ownPosts, ...articles];
  const allItems = [...items].sort((left, right) => {
    if (canSortPersonal && state.feedSort === 'views') return Number(right.viewCount || 0) - Number(left.viewCount || 0) || Number(right.commentCount || 0) - Number(left.commentCount || 0) || new Date(right.publishedAt) - new Date(left.publishedAt);
    if (canSortPersonal && state.feedSort === 'comments') return Number(right.commentCount || 0) - Number(left.commentCount || 0) || Number(right.viewCount || 0) - Number(left.viewCount || 0) || new Date(right.publishedAt) - new Date(left.publishedAt);
    return new Date(right.publishedAt) - new Date(left.publishedAt);
  });
  const periodNames = { day: 'день', week: 'неделю', month: 'месяц' };
  $('#feedHeading').textContent = isHighlights ? `Лучшие материалы${selectedSource ? ` · ${selectedSource.name}` : ''} за ${periodNames[state.bestPeriod]}` : (selectedSource ? `${selectedSource.name} — последние материалы` : (personalized ? 'Ваша персональная лента' : 'Свежие публикации'));
  $('#sourceFeedReset').hidden = !selectedSource;
  $('#bestPeriods').hidden = !isHighlights;
  $('#personalSort').hidden = !canSortPersonal;
  document.querySelectorAll('[data-best-period]').forEach((button) => button.classList.toggle('active', button.dataset.bestPeriod === state.bestPeriod));
  document.querySelectorAll('[data-feed-sort]').forEach((button) => button.classList.toggle('active', button.dataset.feedSort === state.feedSort));
  $('#articleList').innerHTML = allItems.length ? allItems.map(articleMarkup).join('') : '<div class="empty-state"><strong>Пока нет публикаций по этим условиям.</strong><span>Попробуйте включить больше тем или обновить ленту.</span></div>';
  document.querySelectorAll('#articleList .article-card a').forEach((link) => { link.search = location.search; });
  $('#refreshLabel').textContent = `Лента обновлена · ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
}
function renderSources() {
  $('#sourceList').innerHTML = state.sources.map((source) => { const query = new URLSearchParams({ source: source.id }); if (state.bestPeriod) query.set('best', state.bestPeriod); return `<a class="source ${state.sourceId === source.id ? 'active' : ''}" href="/?${query}" data-source-filter="${source.id}"><span class="source-logo" style="background:${escapeHtml(source.accent)}">${escapeHtml(source.name.slice(0, 2).toUpperCase())}</span><span><strong>${escapeHtml(source.name)}</strong><small>${state.bestPeriod ? 'Лучшее за период' : 'Последние материалы'}</small></span><b>→</b></a>`; }).join('');
  document.querySelectorAll('[data-source-filter]').forEach((link) => link.addEventListener('click', (event) => { event.preventDefault(); selectSource(Number(event.currentTarget.dataset.sourceFilter)); }));
}
let searchDelay = 0;
function searchResultMarkup(item) {
  const isPost = item.kind === 'post';
  const href = isPost ? `/post/${item.id}` : `/article/${item.id}`;
  const kind = isPost ? 'Статья' : (labels[item.category] || 'Материал');
  const author = isPost ? item.author : item.sourceName;
  return `<a class="search-result" href="${href}"><div class="search-result-top"><span class="tag ${isPost ? 'tools' : item.category}">${kind}</span><span>${escapeHtml(author || '')}</span></div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.summary || 'Открыть материал')}</p><small>${relativeDate(item.publishedAt)} · ◉ ${metricCount(item.viewCount)} · ◌ ${metricCount(item.commentCount)}</small></a>`;
}
async function runSearch() {
  const input = $('#searchInput');
  const results = $('#searchResults');
  const query = input.value.trim();
  if (query.length < 2) { results.innerHTML = '<p>Введите хотя бы два символа.</p>'; return; }
  results.innerHTML = '<p>Ищем материалы…</p>';
  try {
    const params = new URLSearchParams({ q: query });
    if ($('#searchSource').value) params.set('source', $('#searchSource').value);
    const { items } = await request(`/api/search?${params}`);
    if (input.value.trim() !== query) return;
    results.innerHTML = items.length ? items.map(searchResultMarkup).join('') : '<p>Ничего не найдено. Попробуйте другое слово или снимите фильтр источника.</p>';
  } catch (error) { results.innerHTML = `<p>${escapeHtml(error.message)}</p>`; }
}
function openSearch() {
  const dialog = $('#searchDialog');
  if (!dialog.open) dialog.showModal();
  $('#searchSource').innerHTML = `<option value="">Все источники и статьи сообщества</option>${state.sources.map((source) => `<option value="${source.id}">${escapeHtml(source.name)}</option>`).join('')}`;
  setTimeout(() => $('#searchInput').focus(), 0);
}
$('#searchButton').addEventListener('click', openSearch);
$('#sidebarSearch').addEventListener('click', openSearch);
$('#searchInput').addEventListener('input', () => { clearTimeout(searchDelay); searchDelay = setTimeout(runSearch, 180); });
$('#searchSource').addEventListener('change', runSearch);
document.addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openSearch(); } });
function renderProfile() {
  const accountButton = $('#accountButton');
  if (accountButton) accountButton.textContent = state.user ? 'Настройки' : 'Войти';
  const profileButton = $('#profileButton');
  if (profileButton) profileButton.hidden = !state.user;
  const adminLink = $('#sidebarAdmin');
  if (adminLink) { adminLink.hidden = !state.user?.isAdmin; adminLink.classList.toggle('active', location.pathname === '/admin'); }
  const profileContent = $('#profileContent');
  if (!profileContent) return;
  profileContent.innerHTML = state.user ? `<div class="profile-email">${escapeHtml(state.user.email)}</div><p>Язык: ${state.preferences.language === 'en' ? 'English' : 'Русский'}<br />Темы: ${state.preferences.topics.length ? state.preferences.topics.map((topic) => labels[topic]).join(', ') : 'все'}</p><div class="profile-actions"><button class="logout-button" id="profileSettings">Изменить поток</button><button class="logout-button" id="logoutButton">Выйти</button></div>` : '<p>Войдите, чтобы выбирать темы, источники и язык своей ленты.</p><button class="subscribe-button" id="profileLogin">Создать аккаунт <span>↗</span></button>';
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
  $('.name-field').hidden = login;
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
async function logout() { await request('/api/auth/logout', { method: 'POST' }); state.user = null; state.preferences = { topics: [], sources: [], language: 'ru' }; renderProfile(); if (location.pathname !== '/') { location.href = '/'; return; } loadFeed(); }

function syncTopicControls() { const isFeedPage = location.pathname === '/'; document.querySelectorAll('[data-topic]').forEach((item) => item.classList.toggle('active', isFeedPage && item.dataset.topic === state.topic)); }
function selectTopic(topic) { trackEvent('feed_topic_select', { topic }); state.topic = topic; state.sourceId = null; state.bestPeriod = null; state.feedSort = 'recent'; syncTopicControls(); if (!$('#articleList')) { location.href = `/?topic=${encodeURIComponent(topic)}`; return; } history.replaceState(null, '', topic === 'all' ? '/' : `/?topic=${encodeURIComponent(topic)}`); renderSources(); loadFeed(); }
function selectSource(sourceId) { const selectedSourceId = Number(sourceId) || null; trackEvent('feed_source_select', { source_id: selectedSourceId, best_period: state.bestPeriod || 'latest' }); state.sourceId = selectedSourceId; state.topic = 'all'; state.feedSort = 'recent'; syncTopicControls(); const query = new URLSearchParams(); if (state.bestPeriod) query.set('best', state.bestPeriod); if (selectedSourceId) query.set('source', selectedSourceId); history.replaceState(null, '', query.size ? `/?${query}` : '/'); renderSources(); loadFeed(); }
function selectBest(period = 'day') { const selectedPeriod = ['day', 'week', 'month'].includes(period) ? period : 'day'; trackEvent('highlights_period_select', { period: selectedPeriod, source_id: state.sourceId || 'all', sort: state.feedSort }); state.bestPeriod = selectedPeriod; state.topic = 'all'; syncTopicControls(); const query = new URLSearchParams({ best: selectedPeriod }); if (state.sourceId) query.set('source', state.sourceId); if (state.feedSort !== 'recent') query.set('sort', state.feedSort); if (!$('#articleList')) { location.href = `/?${query}`; return; } history.replaceState(null, '', `/?${query}`); renderSources(); loadFeed(); }
function selectFeedSort(sort) { const selectedSort = ['recent', 'views', 'comments'].includes(sort) ? sort : 'recent'; trackEvent('personal_feed_sort', { sort: selectedSort, period: state.bestPeriod || 'all' }); state.feedSort = selectedSort; const query = new URLSearchParams(); if (state.bestPeriod) query.set('best', state.bestPeriod); if (state.sourceId) query.set('source', state.sourceId); if (selectedSort !== 'recent') query.set('sort', selectedSort); history.replaceState(null, '', query.size ? `/?${query}` : '/'); loadFeed(); }
document.querySelectorAll('[data-topic]').forEach((button) => button.addEventListener('click', () => selectTopic(button.dataset.topic)));
$('#themeToggle').addEventListener('click', () => document.body.classList.toggle('dark'));
$('#sidebarTheme').addEventListener('click', () => document.body.classList.toggle('dark'));
$('#sidebarFresh').addEventListener('click', () => selectTopic('all'));
$('#sidebarBest').addEventListener('click', () => selectBest('day'));
$('#sidebarPersonal').addEventListener('click', openSettings);
$('#sidebarProfile').addEventListener('click', () => state.user ? location.href = `/profile/${state.user.id}` : openAuth(true));
$('#sidebarSettings').addEventListener('click', () => state.user ? openSettings() : openAuth(true));
$('#writeButton').addEventListener('click', () => { location.href = '/write'; });
$('#profileButton').addEventListener('click', () => { if (state.user) location.href = `/profile/${state.user.id}`; });
$('#accountButton').addEventListener('click', () => state.user ? openSettings() : openAuth(true));
$('#setupButton').addEventListener('click', openSettings); $('#sourcesSetup').addEventListener('click', openSettings);
$('#sourceFeedReset').addEventListener('click', () => selectSource(null));
document.querySelectorAll('[data-best-period]').forEach((button) => button.addEventListener('click', () => selectBest(button.dataset.bestPeriod)));
document.querySelectorAll('[data-feed-sort]').forEach((button) => button.addEventListener('click', () => selectFeedSort(button.dataset.feedSort)));
function openImageViewer(image) {
  const dialog = $('#imageDialog');
  const target = $('#imageDialogImage');
  const source = image.currentSrc || image.src;
  if (!dialog || !target || !source) return;
  target.src = source;
  target.alt = image.alt || 'Изображение из статьи';
  if (!dialog.open) dialog.showModal();
  trackEvent('article_image_open', { source: location.pathname.startsWith('/post/') ? 'community' : 'article' });
}
document.addEventListener('click', (event) => {
  const image = event.target.closest('.reader-content img');
  if (!image) return;
  event.preventDefault();
  openImageViewer(image);
});
$('#imageDialogClose').addEventListener('click', () => $('#imageDialog').close());
$('#profileLogin')?.addEventListener('click', () => openAuth(false));
$('#authSwitch').addEventListener('click', () => openAuth(!state.isLogin));
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => $(`#${button.dataset.close}`).close()));
document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => {
  const bounds = dialog.getBoundingClientRect();
  const outsideDialog = event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
  if (outsideDialog) dialog.close();
}));
$('#authForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { const result = await request(state.isLogin ? '/api/auth/login' : '/api/auth/register', { method: 'POST', body: JSON.stringify({ email: form.get('email'), password: form.get('password'), displayName: form.get('displayName') }) }); state.user = result.user; const me = await request('/api/me'); state.user = me.user; state.preferences = me.preferences; $('#authDialog').close(); renderProfile(); if (location.pathname.startsWith('/article/')) return renderArticlePage(location.pathname.split('/')[2]); if (location.pathname.startsWith('/post/')) return renderPostPage(location.pathname.split('/')[2]); if (location.pathname.startsWith('/profile/')) return renderProfilePage(location.pathname.split('/')[2]); if (location.pathname === '/write') return renderWritePage(); if (location.pathname === '/admin') return renderAdminPage(); openSettings(); loadFeed(); } catch (error) { $('#authMessage').textContent = error.message; } });
$('#settingsForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const topics = form.getAll('topic'); const enabled = new Set(form.getAll('source').map(Number)); const sources = state.sources.map((source) => ({ sourceId: source.id, enabled: enabled.has(source.id) })); const language = form.get('language'); try { const result = await request('/api/preferences', { method: 'PUT', body: JSON.stringify({ topics, sources, language }) }); state.preferences = result.preferences; $('#settingsMessage').textContent = 'Настройки сохранены.'; renderProfile(); loadFeed(); setTimeout(() => $('#settingsDialog').close(), 500); } catch (error) { $('#settingsMessage').textContent = error.message; } });
$('#refreshButton').addEventListener('click', async (event) => { const button = event.currentTarget; button.disabled = true; button.innerHTML = 'Обновляем…'; try { await request('/api/refresh', { method: 'POST' }); await loadFeed(); } finally { button.disabled = false; button.innerHTML = 'Обновить <span>↻</span>'; } });

function avatarMarkup(name, avatarUrl, className) { return `<div class="${className}">${avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" alt="" />` : escapeHtml(name.slice(0, 1).toUpperCase())}</div>`; }
function commentMarkup(comment, depth = 0) { const canModerate = state.user?.isAdmin || state.user?.isModerator; const canDelete = !comment.isDeleted && state.user && (state.user.id === comment.authorId || canModerate); return `<div class="comment-thread" style="--reply-depth:${Math.min(depth, 4)}"><article class="comment${comment.isDeleted ? ' comment-is-deleted' : ''}">${avatarMarkup(comment.author, comment.avatarUrl, 'comment-avatar')}<div><div class="comment-meta"><strong><a class="profile-link" href="/profile/${comment.authorId}">${escapeHtml(comment.author)}</a></strong><span>${relativeDate(comment.createdAt)}</span></div>${comment.isDeleted ? '<p class="comment-deleted">Комментарий удалён</p>' : `<p>${escapeHtml(comment.body)}</p>`}${!comment.isDeleted ? `<div class="comment-actions"><button class="reply-button" data-reply-id="${comment.id}" data-reply-author="${escapeHtml(comment.author)}">Ответить</button>${canDelete ? `<button class="comment-delete" data-delete-comment="${comment.id}">Удалить</button>` : ''}</div>` : ''}</div></article>${comment.replies.length ? `<div class="comment-children">${comment.replies.map((reply) => commentMarkup(reply, depth + 1)).join('')}</div>` : ''}</div>`; }
async function loadComments(contentType, contentId) { const { comments } = await request(`/api/${contentType}/${contentId}/comments`); $('#commentsList').innerHTML = comments.length ? comments.map((comment) => commentMarkup(comment)).join('') : '<p class="comments-empty">Пока нет комментариев. Начните обсуждение.</p>'; }
function commentsSection() {
  const composer = state.user ? `<form class="comment-form" id="commentForm"><div class="comment-reply-target" id="commentReplyTarget" hidden><span id="commentReplyLabel"></span><button type="button" id="cancelReply">×</button></div><textarea name="body" maxlength="1500" required minlength="2" placeholder="Поделитесь мыслью о материале…"></textarea><div><span>От имени ${escapeHtml(state.user.displayName || state.user.email.split('@')[0])}</span><button>Отправить</button></div></form>` : `<div class="comment-login"><span>Хотите обсудить публикацию?</span><button id="commentLogin">Войти или создать аккаунт</button></div>`;
  return `<section class="comments"><div class="comments-heading"><span>Обсуждение</span><small>Комментарии читателей</small></div>${composer}<div id="commentsList" class="comments-list"><p class="comments-empty">Пока нет комментариев. Начните обсуждение.</p></div></section>`;
}
function bindComments(contentType, contentId) {
  let replyTo = null;
  enhanceCodeBlocks();
  $('#commentLogin')?.addEventListener('click', () => openAuth(true));
  const clearReply = () => { replyTo = null; $('#commentReplyTarget').hidden = true; };
  $('#cancelReply')?.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); clearReply(); });
  $('#commentForm')?.addEventListener('click', (event) => { if (event.target.closest('#cancelReply')) { event.preventDefault(); clearReply(); } });
  $('#commentsList').addEventListener('click', async (event) => { const remove = event.target.closest('[data-delete-comment]'); if (remove) { if (!confirm('Пометить комментарий как удалённый?')) return; remove.disabled = true; try { await request(`/api/${contentType}/${contentId}/comments/${remove.dataset.deleteComment}`, { method: 'DELETE' }); if (replyTo?.id === Number(remove.dataset.deleteComment)) clearReply(); await loadComments(contentType, contentId); } catch (error) { alert(error.message); remove.disabled = false; } return; } const button = event.target.closest('.reply-button'); if (!button) return; if (!state.user) return openAuth(true); replyTo = { id: Number(button.dataset.replyId), author: button.dataset.replyAuthor }; $('#commentReplyLabel').textContent = `Ответ для ${replyTo.author}`; $('#commentReplyTarget').hidden = false; $('#commentForm textarea').focus(); });
  $('#commentForm')?.addEventListener('submit', async (event) => { event.preventDefault(); const textarea = event.currentTarget.elements.body; const button = event.currentTarget.querySelector('button[type="submit"], button:not([type])'); button.disabled = true; try { await request(`/api/${contentType}/${contentId}/comments`, { method: 'POST', body: JSON.stringify({ body: textarea.value, parentId: replyTo?.id || null }) }); textarea.value = ''; clearReply(); await loadComments(contentType, contentId); } catch (error) { textarea.setCustomValidity(error.message); textarea.reportValidity(); textarea.setCustomValidity(''); } finally { button.disabled = false; } });
  $('#commentForm textarea')?.addEventListener('keydown', (event) => { if (event.ctrlKey && event.key === 'Enter') { event.preventDefault(); $('#commentForm').requestSubmit(); } });
}
async function renderArticlePage(articleId) {
  const { article } = await request(`/api/articles/${articleId}`);
  trackContentReading('article', article);
  const paragraphs = article.content.split(/\n\n+/).filter(Boolean).map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('');
  const content = article.markup || paragraphs;
  let replyTo = null;
  const composer = state.user ? `<form class="comment-form" id="commentForm"><div class="comment-reply-target" id="commentReplyTarget" hidden><span id="commentReplyLabel"></span><button type="button" id="cancelReply">×</button></div><textarea name="body" maxlength="1500" required minlength="2" placeholder="Поделитесь мыслью о материале…"></textarea><div><span>От имени ${escapeHtml(state.user.displayName || state.user.email.split('@')[0])}</span><button>Отправить</button></div></form>` : `<div class="comment-login"><span>Хотите обсудить статью?</span><button id="commentLogin">Войти или создать аккаунт</button></div>`;
  $('main').innerHTML = `<article class="reader"><a class="reader-back" href="/">← Вернуться к ленте</a><div class="reader-meta"><span class="tag ${article.category}">${labels[article.category] || 'News'}</span><span>${escapeHtml(article.sourceName)}</span><span>${relativeDate(article.publishedAt)}</span>${readerViewsMarkup(article.viewCount)}</div><h1>${escapeHtml(article.title)}</h1><div class="reader-source">Сохранённая копия · язык: ${article.language === 'ru' ? 'русский' : 'English'} <a href="${escapeHtml(article.originalUrl)}" target="_blank" rel="noopener">Оригинал ↗</a></div><div class="reader-content${article.markup ? ' rich-reader-content' : ''}">${content}</div><section class="comments"><div class="comments-heading"><span>Обсуждение</span><small>Комментарии читателей</small></div>${composer}<div id="commentsList" class="comments-list"><p class="comments-empty">Пока нет комментариев. Начните обсуждение.</p></div></section></article>`;
  $('.reader-back').href = feedReturnHref();
  $('#commentLogin')?.addEventListener('click', () => openAuth(true));
  const clearReply = () => { replyTo = null; $('#commentReplyTarget').hidden = true; };
  $('#cancelReply')?.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); clearReply(); });
  $('#commentForm')?.addEventListener('click', (event) => { if (event.target.closest('#cancelReply')) { event.preventDefault(); clearReply(); } });
  $('#commentsList').addEventListener('click', async (event) => { const remove = event.target.closest('[data-delete-comment]'); if (remove) { if (!confirm('Пометить комментарий как удалённый?')) return; remove.disabled = true; try { await request(`/api/articles/${articleId}/comments/${remove.dataset.deleteComment}`, { method: 'DELETE' }); if (replyTo?.id === Number(remove.dataset.deleteComment)) clearReply(); await loadComments('articles', articleId); } catch (error) { alert(error.message); remove.disabled = false; } return; } const button = event.target.closest('.reply-button'); if (!button) return; if (!state.user) return openAuth(true); replyTo = { id: Number(button.dataset.replyId), author: button.dataset.replyAuthor }; $('#commentReplyLabel').textContent = `Ответ для ${replyTo.author}`; $('#commentReplyTarget').hidden = false; $('#commentForm textarea').focus(); });
  $('#commentForm')?.addEventListener('submit', async (event) => { event.preventDefault(); const textarea = event.currentTarget.elements.body; const button = event.currentTarget.querySelector('button[type="submit"], button:not([type])'); button.disabled = true; try { await request(`/api/articles/${articleId}/comments`, { method: 'POST', body: JSON.stringify({ body: textarea.value, parentId: replyTo?.id || null }) }); textarea.value = ''; clearReply(); await loadComments('articles', articleId); } catch (error) { textarea.setCustomValidity(error.message); textarea.reportValidity(); textarea.setCustomValidity(''); } finally { button.disabled = false; } });
  $('#commentForm textarea')?.addEventListener('keydown', (event) => { if (event.ctrlKey && event.key === 'Enter') { event.preventDefault(); $('#commentForm').requestSubmit(); } });
  enhanceCodeBlocks();
  await loadComments('articles', articleId);
}
function postTextMarkup(text = '') {
  return escapeHtml(String(text)).replace(/https?:\/\/[^\s<]+/g, (value) => {
    const suffix = value.match(/[),.;!?]+$/)?.[0] || '';
    const url = suffix ? value.slice(0, -suffix.length) : value;
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>${suffix}`;
  }).replace(/\n/g, '<br />');
}
function postBlockMarkup(block, post) {
  if (block.type === 'heading') return `<h2>${postTextMarkup(block.text)}</h2>`;
  if (block.type === 'quote') return `<blockquote>${postTextMarkup(block.text)}</blockquote>`;
  if (block.type === 'divider') return '<hr />';
  if (block.type === 'image') return `<figure><img src="${escapeHtml(block.url)}" alt="${escapeHtml(block.caption || '')}" />${block.caption ? `<figcaption>${escapeHtml(block.caption)}</figcaption>` : ''}</figure>`;
  if (block.type === 'poll') { const poll = post.polls[block.id] || { counts: [], selected: null }; const total = poll.counts.reduce((sum, count) => sum + count, 0); return `<section class="post-poll" data-poll-id="${escapeHtml(block.id)}"><h3>${escapeHtml(block.question)}</h3><div>${block.options.map((option, index) => `<button class="poll-option ${poll.selected === index ? 'selected' : ''}" data-option-index="${index}"><span>${escapeHtml(option)}</span><b>${total ? Math.round((poll.counts[index] || 0) / total * 100) : 0}%</b></button>`).join('')}</div><small>${total} голос${total === 1 ? '' : total < 5 ? 'а' : 'ов'}</small></section>`; }
  return `<p>${postTextMarkup(block.text)}</p>`;
}
async function renderPostPage(postId) {
  const { post } = await request(`/api/posts/${postId}`);
  trackContentReading('post', post);
  $('main').innerHTML = `<article class="reader user-post"><a class="reader-back" href="/">← Вернуться к ленте</a><div class="reader-meta"><span class="tag tools">Авторская статья</span><a class="profile-link" href="/profile/${post.authorId}">${escapeHtml(post.author)}</a><span>${relativeDate(post.publishedAt)}</span>${readerViewsMarkup(post.viewCount)}</div><h1>${escapeHtml(post.title)}</h1><div class="reader-content post-content" id="postBlocks">${post.blocks.map((block) => postBlockMarkup(block, post)).join('')}</div>${commentsSection()}</article>`;
  $('.reader-back').href = feedReturnHref();
  enhanceCodeBlocks();
  $('#postBlocks').addEventListener('click', async (event) => { const option = event.target.closest('.poll-option'); if (!option) return; if (!state.user) return openAuth(true); const pollId = option.closest('.post-poll').dataset.pollId; try { await request(`/api/posts/${post.id}/polls/${pollId}/vote`, { method: 'POST', body: JSON.stringify({ optionIndex: Number(option.dataset.optionIndex) }) }); await renderPostPage(post.id); } catch (error) { alert(error.message); } });
  bindComments('posts', post.id);
  await loadComments('posts', post.id);
}
function profilePostsMarkup(posts) {
  if (!posts.length) return '<p class="profile-empty">Пока нет опубликованных статей.</p>';
  return `<div class="profile-posts">${posts.map((post) => `<a class="profile-post" href="/post/${post.id}"><span class="tag tools">Статья</span><h3>${escapeHtml(post.title)}</h3><p>${escapeHtml(post.blocks.find((block) => block.type === 'paragraph' || block.type === 'quote')?.text || 'Авторская публикация.')}</p><small>${relativeDate(post.publishedAt)} · Читать →</small></a>`).join('')}</div>`;
}
function profileCommentsMarkup(comments) {
  if (!comments.length) return '<p class="profile-empty">Пока нет комментариев.</p>';
  return `<div class="profile-comments">${comments.map((comment) => `<article class="profile-comment"><p>${escapeHtml(comment.body)}</p><a href="/${comment.targetKind}/${comment.targetId}">${escapeHtml(comment.targetTitle)}</a><small>${relativeDate(comment.createdAt)}</small></article>`).join('')}</div>`;
}
async function renderProfilePage(profileId, activeTab = 'posts') {
  const result = await request(`/api/profiles/${profileId}`);
  const { profile, posts, comments } = result;
  const ownProfile = state.user?.id === profile.id;
  const avatar = ownProfile
    ? `<button type="button" class="profile-avatar profile-avatar-trigger" id="profileAvatarTrigger" title="Изменить аватар" aria-label="Изменить аватар">${profile.avatarUrl ? `<img src="${escapeHtml(profile.avatarUrl)}" alt="" />` : escapeHtml(profile.displayName.slice(0, 1).toUpperCase())}</button>`
    : avatarMarkup(profile.displayName, profile.avatarUrl, 'profile-avatar');
  const content = activeTab === 'posts' ? profilePostsMarkup(posts) : profileCommentsMarkup(comments);
  const editor = ownProfile ? `<form class="profile-edit" id="profileEditForm"><label>Имя<input name="displayName" maxlength="60" value="${escapeHtml(profile.displayName)}" required /></label><input data-profile-avatar type="file" accept="image/png,image/jpeg,image/webp" hidden /><input name="avatarUrl" type="hidden" value="${escapeHtml(profile.avatarUrl)}" /><label>О себе<textarea name="bio" maxlength="600" placeholder="Расскажите немного о себе">${escapeHtml(profile.bio)}</textarea></label><div class="profile-edit-actions"><button>Сохранить профиль</button><button type="button" class="profile-logout" id="profileLogout">Выйти из аккаунта</button></div><small id="profileEditMessage"></small></form>` : '';
  $('main').innerHTML = `<section class="profile-page"><a class="reader-back" href="/">← Вернуться к ленте</a><header class="profile-hero">${avatar}<div><p class="eyebrow">Профиль автора</p><h1>${escapeHtml(profile.displayName)}</h1><p>${escapeHtml(profile.bio || 'Пока без описания.')}</p><small>На supa с ${new Date(profile.createdAt).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })}</small></div></header>${editor}<nav class="profile-tabs" aria-label="Разделы профиля"><button class="${activeTab === 'posts' ? 'active' : ''}" data-profile-tab="posts">Статьи <span>${posts.length}</span></button><button class="${activeTab === 'comments' ? 'active' : ''}" data-profile-tab="comments">Комментарии <span>${comments.length}</span></button></nav><section class="profile-activity">${content}</section></section>`;
  document.querySelectorAll('[data-profile-tab]').forEach((button) => button.addEventListener('click', () => renderProfilePage(profile.id, button.dataset.profileTab)));
  $('#profileAvatarTrigger')?.addEventListener('click', () => document.querySelector('[data-profile-avatar]')?.click());
  $('#profileEditForm')?.addEventListener('change', async (event) => { const input = event.target; if (!input.matches('[data-profile-avatar]') || !input.files[0]) return; const message = $('#profileEditMessage'); if (input.files[0].size > 5000000) { message.textContent = 'Изображение должно быть не больше 5 МБ.'; return; } const reader = new FileReader(); reader.onload = async () => { try { const { url } = await request('/api/uploads', { method: 'POST', body: JSON.stringify({ dataUrl: reader.result }) }); $('#profileEditForm').elements.avatarUrl.value = url; document.querySelector('.profile-hero .profile-avatar').innerHTML = `<img src="${escapeHtml(url)}" alt="" />`; message.textContent = 'Аватар загружен. Сохраните профиль.'; } catch (error) { message.textContent = error.message; } }; reader.readAsDataURL(input.files[0]); });
  $('#profileLogout')?.addEventListener('click', logout);
  $('#profileEditForm')?.addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const message = $('#profileEditMessage'); try { const updated = await request('/api/profile', { method: 'PUT', body: JSON.stringify({ displayName: form.get('displayName'), bio: form.get('bio'), avatarUrl: form.get('avatarUrl') }) }); state.user = updated.user; renderProfile(); await renderProfilePage(profile.id, activeTab); } catch (error) { message.textContent = error.message; } });
}
function renderAboutPage() {
  const sourceNames = state.sources.map((source) => escapeHtml(source.name)).join(' · ');
  $('main').innerHTML = `<section class="about-page"><a class="reader-back" href="/">← Вернуться к ленте</a><p class="eyebrow">О проекте</p><h1>supa — личная лента<br />того, что интересно.</h1><p class="about-lead">Собираем свежие и популярные материалы о технологиях, ИИ, разработке, играх и медиа в одном спокойном месте.</p><section class="about-grid"><article><span>01</span><h2>Вы выбираете</h2><p>Темы, источники и язык. Персональная лента подстраивается под ваши интересы.</p></article><article><span>02</span><h2>Мы собираем</h2><p>Новые материалы из проверенных источников и показываем их популярность там, где она доступна.</p></article><article><span>03</span><h2>Вы обсуждаете</h2><p>Открывайте сохранённые копии статей, комментируйте и публикуйте собственные материалы.</p></article></section><section class="about-note"><h2>Как устроены материалы</h2><p>Когда вы открываете публикацию, supa создаёт сохранённую копию для удобного чтения, сохраняет ссылки, изображения и форматирование, а также оставляет переход на оригинал. Просмотры и комментарии учитываются отдельно на supa.</p><p>Сейчас в ленте: ${sourceNames || 'источники загружаются'}.</p></section></section>`;
}
function adminRange(days) {
  const to = new Date();
  const from = new Date(to.getTime() - (days - 1) * 86400000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}
function adminChart(title, metric, series, color) {
  const values = series.map((item) => Number(item[metric]) || 0);
  const rawMax = Math.max(1, ...values);
  const max = rawMax <= 4 ? rawMax : Math.ceil(rawMax / (rawMax < 20 ? 5 : rawMax < 100 ? 10 : 50)) * (rawMax < 20 ? 5 : rawMax < 100 ? 10 : 50);
  const width = 620;
  const height = 196;
  const plot = { left: 48, right: 14, top: 16, bottom: 35 };
  const plotWidth = width - plot.left - plot.right;
  const plotHeight = height - plot.top - plot.bottom;
  const point = (value, index) => ({ x: plot.left + plotWidth * (values.length < 2 ? 0 : index / (values.length - 1)), y: plot.top + plotHeight * (1 - value / max) });
  const points = values.map((value, index) => { const valuePoint = point(value, index); return `${valuePoint.x},${valuePoint.y}`; }).join(' ');
  const sum = values.reduce((total, value) => total + value, 0);
  const ticks = [max, max / 2, 0];
  const dateIndexes = [...new Set([0, Math.round((series.length - 1) / 2), Math.max(0, series.length - 1)])];
  const dateLabel = (value) => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(new Date(`${value}T00:00:00`));
  return `<article class="admin-chart" data-admin-chart data-chart-metric="${metric}" data-chart-title="${title}"><header><span>${title}</span><b>${metricCount(sum)}</b></header><div class="admin-chart-canvas"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${title}">${ticks.map((tick) => { const y = plot.top + plotHeight * (1 - tick / max); return `<g class="admin-chart-grid"><line x1="${plot.left}" x2="${width - plot.right}" y1="${y}" y2="${y}"/><text x="${plot.left - 8}" y="${y + 3}" text-anchor="end">${metricCount(tick)}</text></g>`; }).join('')}${dateIndexes.map((index) => { const valuePoint = point(values[index], index); return `<text class="admin-chart-date" x="${valuePoint.x}" y="${height - 10}" text-anchor="middle">${dateLabel(series[index]?.date || '')}</text>`; }).join('')}<polyline points="${points}" style="--chart-color:${color}"/><line class="admin-chart-guide" x1="0" x2="0" y1="${plot.top}" y2="${height - plot.bottom}" hidden/><circle class="admin-chart-dot" cx="0" cy="0" r="4" style="--chart-color:${color}" hidden/><rect class="admin-chart-hit" x="${plot.left}" y="${plot.top}" width="${plotWidth}" height="${plotHeight}"/></svg><div class="admin-chart-tooltip" hidden></div></div></article>`;
}
function bindAdminCharts(series) {
  document.querySelectorAll('[data-admin-chart]').forEach((chart) => {
    const metric = chart.dataset.chartMetric;
    const title = chart.dataset.chartTitle;
    const svg = chart.querySelector('svg');
    const tooltip = chart.querySelector('.admin-chart-tooltip');
    const guide = chart.querySelector('.admin-chart-guide');
    const dot = chart.querySelector('.admin-chart-dot');
    const width = 620;
    const left = 48;
    const right = 14;
    const top = 16;
    const bottom = 35;
    const height = 196;
    const values = series.map((item) => Number(item[metric]) || 0);
    const rawMax = Math.max(1, ...values);
    const max = rawMax <= 4 ? rawMax : Math.ceil(rawMax / (rawMax < 20 ? 5 : rawMax < 100 ? 10 : 50)) * (rawMax < 20 ? 5 : rawMax < 100 ? 10 : 50);
    const setPoint = (index) => {
      const ratio = values.length < 2 ? 0 : index / (values.length - 1);
      const x = left + (width - left - right) * ratio;
      const y = top + (height - top - bottom) * (1 - values[index] / max);
      guide.setAttribute('x1', x); guide.setAttribute('x2', x); guide.hidden = false;
      dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.hidden = false;
      tooltip.textContent = `${new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${series[index].date}T00:00:00`))} · ${title}: ${values[index]}`;
      const svgBox = svg.getBoundingClientRect();
      const chartBox = chart.getBoundingClientRect();
      const tooltipX = svgBox.left - chartBox.left + svgBox.width * x / width;
      const tooltipY = svgBox.top - chartBox.top + svgBox.height * y / height;
      tooltip.style.left = `${Math.max(95, Math.min(chart.clientWidth - 95, tooltipX))}px`;
      tooltip.style.top = `${Math.max(38, Math.min(chart.clientHeight - 28, tooltipY - 12))}px`;
      tooltip.hidden = false;
    };
    svg.addEventListener('pointermove', (event) => {
      const box = svg.getBoundingClientRect();
      const raw = ((event.clientX - box.left) / box.width * width - left) / (width - left - right);
      setPoint(Math.max(0, Math.min(values.length - 1, Math.round(raw * (values.length - 1)))));
    });
    svg.addEventListener('pointerleave', () => { tooltip.hidden = true; guide.hidden = true; dot.hidden = true; });
  });
}
async function renderAdminPage(range = adminRange(30), activeTab = 'stats') {
  if (!state.user?.isAdmin) { $('main').innerHTML = '<section class="admin-page"><a class="reader-back" href="/">← Вернуться к ленте</a><h1>Админка</h1><p class="admin-empty">Доступ к этому разделу есть только у администратора.</p></section>'; return; }
  const query = new URLSearchParams(range);
  const [statsResult, usersResult, contentResult, deletedCommentsResult] = await Promise.all([request(`/api/admin/stats?${query}`), request('/api/admin/users'), request('/api/admin/content'), request('/api/admin/comments')]);
  const { totals, series } = statsResult;
  const tabs = [['stats', 'Статистика'], ['users', `Пользователи · ${usersResult.users.length}`], ['content', `Контент · ${contentResult.content.length}`], ['comments', `Удалённые комментарии · ${deletedCommentsResult.comments.length}`]];
  const userRows = usersResult.users.map((item) => `<tr><td><strong>${escapeHtml(item.displayName)}</strong><small>${escapeHtml(item.email)}</small></td><td>${new Date(item.createdAt).toLocaleDateString('ru-RU')}</td><td>${item.postCount} / ${item.commentCount}</td><td>${item.isAdmin ? '<span class="admin-status admin-status-violet">админ</span>' : ''}${item.isModerator && !item.isAdmin ? '<span class="admin-status admin-status-violet">модератор</span>' : ''}${item.isBanned ? '<span class="admin-status admin-status-red">заблокирован</span>' : ''}</td><td><button class="admin-action" data-admin-user="${item.id}" data-admin-field="isBanned" data-admin-value="${!item.isBanned}">${item.isBanned ? 'Разблокировать' : 'Заблокировать'}</button>${!item.isAdmin ? `<button class="admin-action" data-admin-user="${item.id}" data-admin-field="isModerator" data-admin-value="${!item.isModerator}">${item.isModerator ? 'Снять модератора' : 'Назначить модератором'}</button>` : ''}${item.id !== state.user.id ? `<button class="admin-action" data-admin-user="${item.id}" data-admin-field="isAdmin" data-admin-value="${!item.isAdmin}">${item.isAdmin ? 'Снять админа' : 'Сделать админом'}</button>` : ''}</td></tr>`).join('');
  const contentRows = contentResult.content.map((item) => `<tr><td><a href="/${item.kind === 'post' ? 'post' : 'article'}/${item.id}">${escapeHtml(item.title)}</a><small>${escapeHtml(item.sourceName)}</small></td><td>${item.kind === 'post' ? 'Статья' : 'Источник'}</td><td>${metricCount(item.viewCount)} · ${metricCount(item.commentCount)}</td><td>${item.isHidden ? '<span class="admin-status admin-status-red">скрыт</span>' : '<span class="admin-status">виден</span>'}</td><td><button class="admin-action" data-admin-content="${item.id}" data-admin-kind="${item.kind}" data-admin-hidden="${!item.isHidden}">${item.isHidden ? 'Показать' : 'Скрыть'}</button></td></tr>`).join('');
  const deletedCommentRows = deletedCommentsResult.comments.map((item) => `<tr><td><a href="/${item.kind === 'post' ? 'post' : 'article'}/${item.contentId}">${escapeHtml(item.contentTitle)}</a><small>${escapeHtml(item.author)} · ${new Date(item.createdAt).toLocaleDateString('ru-RU')}</small></td><td class="admin-comment-body">${escapeHtml(item.body)}</td><td>${escapeHtml(item.deletedBy || '—')}<small>${new Date(item.deletedAt).toLocaleString('ru-RU')}</small></td><td><button class="admin-action" data-admin-comment="${item.id}" data-admin-comment-kind="${item.kind}" data-admin-deleted="false">Восстановить</button></td></tr>`).join('') || '<tr><td colspan="4" class="admin-empty">Удалённых комментариев пока нет.</td></tr>';
  const page = `<section class="admin-page"><a class="reader-back" href="/">← Вернуться к ленте</a><p class="eyebrow">Администрирование</p><h1>Управление supa</h1><nav class="admin-tabs">${tabs.map(([key, title]) => `<button class="${activeTab === key ? 'active' : ''}" data-admin-tab="${key}">${title}</button>`).join('')}</nav><section class="admin-panel ${activeTab === 'stats' ? '' : 'admin-panel-hidden'}"><form id="adminRange" class="admin-range"><label>С<input name="from" type="date" value="${statsResult.from}" /></label><label>По<input name="to" type="date" value="${statsResult.to}" /></label><button>Показать</button><span><button type="button" data-admin-range="7">7 дней</button><button type="button" data-admin-range="30">30 дней</button><button type="button" data-admin-range="90">90 дней</button><button type="button" data-admin-range="365">Год</button></span></form><div class="admin-stat-grid"><article><span>Пользователей</span><strong>${metricCount(totals.users)}</strong><small>за всё время</small></article><article><span>Материалов</span><strong>${metricCount(totals.articles)}</strong><small>видимых</small></article><article><span>Комментариев</span><strong>${metricCount(totals.comments)}</strong><small>за всё время</small></article><article><span>Просмотров</span><strong>${metricCount(totals.views)}</strong><small>на supa</small></article></div><div class="admin-charts">${adminChart('Просмотры', 'views', series, '#8463ef')}${adminChart('Новые статьи', 'articles', series, '#ceaa55')}${adminChart('Комментарии', 'comments', series, '#64bde8')}${adminChart('Регистрации', 'registrations', series, '#a4d850')}</div></section><section class="admin-panel ${activeTab === 'users' ? '' : 'admin-panel-hidden'}"><div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Пользователь</th><th>Регистрация</th><th>Статьи / комм.</th><th>Статус</th><th></th></tr></thead><tbody>${userRows}</tbody></table></div></section><section class="admin-panel ${activeTab === 'content' ? '' : 'admin-panel-hidden'}"><div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Материал</th><th>Тип</th><th>Просмотры / комм.</th><th>Статус</th><th></th></tr></thead><tbody>${contentRows}</tbody></table></div></section><section class="admin-panel ${activeTab === 'comments' ? '' : 'admin-panel-hidden'}"><div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Материал и автор</th><th>Комментарий</th><th>Удалил</th><th></th></tr></thead><tbody>${deletedCommentRows}</tbody></table></div></section></section>`;
  $('main').innerHTML = page;
  bindAdminCharts(series);
  $('#adminRange')?.addEventListener('submit', (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); renderAdminPage({ from: form.get('from'), to: form.get('to') }, activeTab); });
  document.querySelectorAll('[data-admin-range]').forEach((button) => button.addEventListener('click', () => renderAdminPage(adminRange(Number(button.dataset.adminRange)), activeTab)));
  document.querySelectorAll('[data-admin-tab]').forEach((button) => button.addEventListener('click', () => renderAdminPage(range, button.dataset.adminTab)));
  document.querySelectorAll('[data-admin-user]').forEach((button) => button.addEventListener('click', async () => { button.disabled = true; try { await request(`/api/admin/users/${button.dataset.adminUser}`, { method: 'PUT', body: JSON.stringify({ [button.dataset.adminField]: button.dataset.adminValue === 'true' }) }); await renderAdminPage(range, 'users'); } catch (error) { alert(error.message); button.disabled = false; } }));
  document.querySelectorAll('[data-admin-content]').forEach((button) => button.addEventListener('click', async () => { button.disabled = true; try { await request(`/api/admin/content/${button.dataset.adminKind === 'post' ? 'posts' : 'articles'}/${button.dataset.adminContent}`, { method: 'PUT', body: JSON.stringify({ isHidden: button.dataset.adminHidden === 'true' }) }); await renderAdminPage(range, 'content'); } catch (error) { alert(error.message); button.disabled = false; } }));
  document.querySelectorAll('[data-admin-comment]').forEach((button) => button.addEventListener('click', async () => { button.disabled = true; try { await request(`/api/admin/comments/${button.dataset.adminCommentKind === 'post' ? 'posts' : 'articles'}/${button.dataset.adminComment}`, { method: 'PUT', body: JSON.stringify({ deleted: button.dataset.adminDeleted === 'true' }) }); await renderAdminPage(range, 'comments'); } catch (error) { alert(error.message); button.disabled = false; } }));
}
function blankBlock(type) { if (type === 'image') return { type, url: '', caption: '' }; if (type === 'poll') return { type, id: crypto.randomUUID().slice(0, 16), question: '', options: ['', ''] }; return { type, text: type === 'divider' ? '' : '' }; }
async function renderWritePage() {
  if (!state.user) { $('main').innerHTML = `<section class="writer-gate"><span class="tag tools">Публикации сообщества</span><h1>Есть мысль?<br />Расскажите её.</h1><p>Создавайте статьи с текстом, изображениями, цитатами и опросами.</p><button id="writerLogin">Войти, чтобы написать</button></section>`; $('#writerLogin').addEventListener('click', () => openAuth(false)); return; }
  const draft = { title: '', blocks: [blankBlock('paragraph')] };
  const editorBlock = (block, index) => { if (block.type === 'divider') return `<div class="editor-divider" data-index="${index}"><span>Разделитель</span><button data-remove="${index}">Удалить</button></div>`; if (block.type === 'image') return `<div class="editor-block image-block" data-index="${index}"><div class="editor-block-top"><span>Картинка</span><button data-remove="${index}">Удалить</button></div><input data-image-url="${index}" value="${escapeHtml(block.url)}" placeholder="https://… или загрузите файл" /><input data-image-file="${index}" type="file" accept="image/png,image/jpeg,image/webp" /><input data-image-caption="${index}" value="${escapeHtml(block.caption)}" placeholder="Подпись к картинке (необязательно)" />${block.url ? `<img src="${escapeHtml(block.url)}" alt="Предпросмотр" />` : ''}</div>`; if (block.type === 'poll') return `<div class="editor-block poll-block" data-index="${index}"><div class="editor-block-top"><span>Опрос</span><button data-remove="${index}">Удалить</button></div><input data-poll-question="${index}" value="${escapeHtml(block.question)}" placeholder="Ваш вопрос" />${block.options.map((option, optionIndex) => `<input data-poll-option="${index}:${optionIndex}" value="${escapeHtml(option)}" placeholder="Вариант ${optionIndex + 1}" />`).join('')}<button class="add-option" data-add-option="${index}">+ Добавить вариант</button></div>`; const names = { paragraph: 'Текст', heading: 'Подзаголовок', quote: 'Цитата' }; return `<div class="editor-block" data-index="${index}"><div class="editor-block-top"><span>${names[block.type]}</span><button data-remove="${index}">Удалить</button></div><textarea data-text="${index}" placeholder="Начните писать…">${escapeHtml(block.text)}</textarea></div>`; };
  const draw = () => { $('main').innerHTML = `<section class="writer"><a class="reader-back" href="/">← К ленте</a><div class="writer-heading"><span class="tag tools">Новая публикация</span><h1>Напишите то, что<br />стоит прочитать.</h1><input id="postTitle" value="${escapeHtml(draft.title)}" placeholder="Заголовок статьи" /></div><div class="editor-toolbar"><button data-add="paragraph">Текст</button><button data-add="heading">Подзаголовок</button><button data-add="quote">Цитата</button><button data-add="image">Картинка</button><button data-add="poll">Опрос</button><button data-add="divider">Разделитель</button></div><div class="editor-blocks" id="editorBlocks">${draft.blocks.map(editorBlock).join('')}</div><div class="publish-bar"><span>Публикация сразу появится в общей ленте.</span><button id="publishPost">Опубликовать →</button></div></section>`; bind(); };
  const bind = () => { $('#postTitle').addEventListener('input', (event) => { draft.title = event.target.value; }); $('#editorBlocks').addEventListener('input', (event) => { const target = event.target; if (target.dataset.text !== undefined) draft.blocks[Number(target.dataset.text)].text = target.value; if (target.dataset.imageUrl !== undefined) draft.blocks[Number(target.dataset.imageUrl)].url = target.value; if (target.dataset.imageCaption !== undefined) draft.blocks[Number(target.dataset.imageCaption)].caption = target.value; if (target.dataset.pollQuestion !== undefined) draft.blocks[Number(target.dataset.pollQuestion)].question = target.value; if (target.dataset.pollOption) { const [blockIndex, optionIndex] = target.dataset.pollOption.split(':').map(Number); draft.blocks[blockIndex].options[optionIndex] = target.value; } }); $('#editorBlocks').addEventListener('click', (event) => { const remove = event.target.closest('[data-remove]'); const addOption = event.target.closest('[data-add-option]'); if (remove) { draft.blocks.splice(Number(remove.dataset.remove), 1); draw(); } if (addOption) { draft.blocks[Number(addOption.dataset.addOption)].options.push(''); draw(); } }); $('#editorBlocks').addEventListener('change', async (event) => { const target = event.target; if (!target.dataset.imageFile || !target.files[0]) return; if (target.files[0].size > 5000000) return alert('Изображение должно быть не больше 5 МБ.'); const reader = new FileReader(); reader.onload = async () => { try { const { url } = await request('/api/uploads', { method: 'POST', body: JSON.stringify({ dataUrl: reader.result }) }); draft.blocks[Number(target.dataset.imageFile)].url = url; draw(); } catch (error) { alert(error.message); } }; reader.readAsDataURL(target.files[0]); }); document.querySelectorAll('[data-add]').forEach((button) => button.addEventListener('click', () => { draft.blocks.push(blankBlock(button.dataset.add)); draw(); })); $('#publishPost').addEventListener('click', async () => { const button = $('#publishPost'); button.disabled = true; try { const { post } = await request('/api/posts', { method: 'POST', body: JSON.stringify({ title: draft.title, blocks: draft.blocks }) }); location.href = `/post/${post.id}`; } catch (error) { alert(error.message); button.disabled = false; } }); };
  draw();
}
async function init() { try { const [me, sources] = await Promise.all([request('/api/me'), request('/api/sources')]); state.user = me.user; state.preferences = me.preferences || state.preferences; state.sources = sources.sources; syncTopicControls(); $('#sidebarAbout').classList.toggle('active', location.pathname === '/about'); $('#sidebarWrite').classList.toggle('active', location.pathname === '/write'); renderProfile(); if (location.pathname.startsWith('/article/')) return renderArticlePage(location.pathname.split('/')[2]); if (location.pathname.startsWith('/post/')) return renderPostPage(location.pathname.split('/')[2]); if (location.pathname.startsWith('/profile/')) return renderProfilePage(location.pathname.split('/')[2]); if (location.pathname === '/write') return renderWritePage(); if (location.pathname === '/about') return renderAboutPage(); if (location.pathname === '/admin') return renderAdminPage(); renderSources(); await loadFeed(); } catch (error) { const target = $('#articleList') || $('main'); target.innerHTML = `<div class="empty-state"><strong>Не удалось загрузить материал.</strong><span>${escapeHtml(error.message)}</span></div>`; } }
init();

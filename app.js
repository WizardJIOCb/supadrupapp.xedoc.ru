const state = { user: null, preferences: { topics: [], sources: [], language: 'ru' }, sources: [], topic: new URLSearchParams(location.search).get('topic') || 'all', sourceId: Number(new URLSearchParams(location.search).get('source')) || null, isLogin: true };
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
  const query = new URLSearchParams();
  if (state.sourceId) query.set('source', state.sourceId);
  else if (state.topic !== 'all') query.set('topic', state.topic);
  const selectedSource = state.sources.find((source) => source.id === state.sourceId);
  const [{ articles, personalized }, { posts }] = await Promise.all([request(`/api/feed${query.size ? `?${query}` : ''}`), request('/api/posts')]);
  const ownPosts = state.topic === 'all' && !state.sourceId ? posts.map((post) => ({ ...post, summary: post.blocks.find((block) => block.type === 'paragraph' || block.type === 'quote')?.text || 'Авторская публикация сообщества.' })) : [];
  const allItems = [...ownPosts, ...articles].sort((left, right) => new Date(right.publishedAt) - new Date(left.publishedAt));
  $('#feedHeading').textContent = selectedSource ? `${selectedSource.name} — последние материалы` : (personalized ? 'Ваша персональная лента' : 'Свежие публикации');
  $('#sourceFeedReset').hidden = !selectedSource;
  $('#articleList').innerHTML = allItems.length ? allItems.map(articleMarkup).join('') : '<div class="empty-state"><strong>Пока нет публикаций по этим условиям.</strong><span>Попробуйте включить больше тем или обновить ленту.</span></div>';
  $('#refreshLabel').textContent = `Лента обновлена · ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
}
function renderSources() {
  $('#sourceList').innerHTML = state.sources.map((source) => `<a class="source ${state.sourceId === source.id ? 'active' : ''}" href="/?source=${source.id}" data-source-filter="${source.id}"><span class="source-logo" style="background:${escapeHtml(source.accent)}">${escapeHtml(source.name.slice(0, 2).toUpperCase())}</span><span><strong>${escapeHtml(source.name)}</strong><small>Последние материалы</small></span><b>→</b></a>`).join('');
  document.querySelectorAll('[data-source-filter]').forEach((link) => link.addEventListener('click', (event) => { event.preventDefault(); selectSource(Number(event.currentTarget.dataset.sourceFilter)); }));
}
function renderProfile() {
  const accountButton = $('#accountButton');
  if (accountButton) accountButton.textContent = state.user ? 'Настройки' : 'Войти';
  const profileButton = $('#profileButton');
  if (profileButton) profileButton.hidden = !state.user;
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

function syncTopicControls() { document.querySelectorAll('[data-topic]').forEach((item) => item.classList.toggle('active', item.dataset.topic === state.topic)); }
function selectTopic(topic) { trackEvent('feed_topic_select', { topic }); state.topic = topic; state.sourceId = null; syncTopicControls(); if (!$('#articleList')) { location.href = `/?topic=${encodeURIComponent(topic)}`; return; } history.replaceState(null, '', topic === 'all' ? '/' : `/?topic=${encodeURIComponent(topic)}`); renderSources(); loadFeed(); }
function selectSource(sourceId) { const selectedSourceId = Number(sourceId) || null; trackEvent('feed_source_select', { source_id: selectedSourceId }); state.sourceId = selectedSourceId; state.topic = 'all'; syncTopicControls(); history.replaceState(null, '', selectedSourceId ? `/?source=${selectedSourceId}` : '/'); renderSources(); loadFeed(); }
document.querySelectorAll('[data-topic]').forEach((button) => button.addEventListener('click', () => selectTopic(button.dataset.topic)));
$('#themeToggle').addEventListener('click', () => document.body.classList.toggle('dark'));
$('#sidebarTheme').addEventListener('click', () => document.body.classList.toggle('dark'));
$('#sidebarFresh').addEventListener('click', () => selectTopic('all'));
$('#sidebarPersonal').addEventListener('click', openSettings);
$('#sidebarProfile').addEventListener('click', () => state.user ? location.href = `/profile/${state.user.id}` : openAuth(true));
$('#sidebarSettings').addEventListener('click', () => state.user ? openSettings() : openAuth(true));
$('#writeButton').addEventListener('click', () => { location.href = '/write'; });
$('#profileButton').addEventListener('click', () => { if (state.user) location.href = `/profile/${state.user.id}`; });
$('#accountButton').addEventListener('click', () => state.user ? openSettings() : openAuth(true));
$('#setupButton').addEventListener('click', openSettings); $('#sourcesSetup').addEventListener('click', openSettings);
$('#sourceFeedReset').addEventListener('click', () => selectSource(null));
$('#profileLogin')?.addEventListener('click', () => openAuth(false));
$('#authSwitch').addEventListener('click', () => openAuth(!state.isLogin));
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => $(`#${button.dataset.close}`).close()));
document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => {
  const bounds = dialog.getBoundingClientRect();
  const outsideDialog = event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
  if (outsideDialog) dialog.close();
}));
$('#authForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { const result = await request(state.isLogin ? '/api/auth/login' : '/api/auth/register', { method: 'POST', body: JSON.stringify({ email: form.get('email'), password: form.get('password'), displayName: form.get('displayName') }) }); state.user = result.user; const me = await request('/api/me'); state.preferences = me.preferences; $('#authDialog').close(); renderProfile(); if (location.pathname.startsWith('/article/')) return renderArticlePage(location.pathname.split('/')[2]); if (location.pathname.startsWith('/post/')) return renderPostPage(location.pathname.split('/')[2]); if (location.pathname.startsWith('/profile/')) return renderProfilePage(location.pathname.split('/')[2]); if (location.pathname === '/write') return renderWritePage(); openSettings(); loadFeed(); } catch (error) { $('#authMessage').textContent = error.message; } });
$('#settingsForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const topics = form.getAll('topic'); const enabled = new Set(form.getAll('source').map(Number)); const sources = state.sources.map((source) => ({ sourceId: source.id, enabled: enabled.has(source.id) })); const language = form.get('language'); try { const result = await request('/api/preferences', { method: 'PUT', body: JSON.stringify({ topics, sources, language }) }); state.preferences = result.preferences; $('#settingsMessage').textContent = 'Настройки сохранены.'; renderProfile(); loadFeed(); setTimeout(() => $('#settingsDialog').close(), 500); } catch (error) { $('#settingsMessage').textContent = error.message; } });
$('#refreshButton').addEventListener('click', async (event) => { const button = event.currentTarget; button.disabled = true; button.innerHTML = 'Обновляем…'; try { await request('/api/refresh', { method: 'POST' }); await loadFeed(); } finally { button.disabled = false; button.innerHTML = 'Обновить <span>↻</span>'; } });

function avatarMarkup(name, avatarUrl, className) { return `<div class="${className}">${avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" alt="" />` : escapeHtml(name.slice(0, 1).toUpperCase())}</div>`; }
function commentMarkup(comment, depth = 0) { return `<div class="comment-thread" style="--reply-depth:${Math.min(depth, 4)}"><article class="comment">${avatarMarkup(comment.author, comment.avatarUrl, 'comment-avatar')}<div><div class="comment-meta"><strong><a class="profile-link" href="/profile/${comment.authorId}">${escapeHtml(comment.author)}</a></strong><span>${relativeDate(comment.createdAt)}</span></div><p>${escapeHtml(comment.body)}</p><button class="reply-button" data-reply-id="${comment.id}" data-reply-author="${escapeHtml(comment.author)}">Ответить</button></div></article>${comment.replies.length ? `<div class="comment-children">${comment.replies.map((reply) => commentMarkup(reply, depth + 1)).join('')}</div>` : ''}</div>`; }
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
  $('#commentsList').addEventListener('click', (event) => { const button = event.target.closest('.reply-button'); if (!button) return; if (!state.user) return openAuth(true); replyTo = { id: Number(button.dataset.replyId), author: button.dataset.replyAuthor }; $('#commentReplyLabel').textContent = `Ответ для ${replyTo.author}`; $('#commentReplyTarget').hidden = false; $('#commentForm textarea').focus(); });
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
  $('main').innerHTML = `<article class="reader"><a class="reader-back" href="/">← Вернуться к ленте</a><div class="reader-meta"><span class="tag ${article.category}">${labels[article.category] || 'News'}</span><span>${escapeHtml(article.sourceName)}</span><span>${relativeDate(article.publishedAt)}</span></div><h1>${escapeHtml(article.title)}</h1><div class="reader-source">Сохранённая копия · язык: ${article.language === 'ru' ? 'русский' : 'English'} <a href="${escapeHtml(article.originalUrl)}" target="_blank" rel="noopener">Оригинал ↗</a></div><div class="reader-content${article.markup ? ' rich-reader-content' : ''}">${content}</div><section class="comments"><div class="comments-heading"><span>Обсуждение</span><small>Комментарии читателей</small></div>${composer}<div id="commentsList" class="comments-list"><p class="comments-empty">Пока нет комментариев. Начните обсуждение.</p></div></section></article>`;
  $('#commentLogin')?.addEventListener('click', () => openAuth(true));
  const clearReply = () => { replyTo = null; $('#commentReplyTarget').hidden = true; };
  $('#cancelReply')?.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); clearReply(); });
  $('#commentForm')?.addEventListener('click', (event) => { if (event.target.closest('#cancelReply')) { event.preventDefault(); clearReply(); } });
  $('#commentsList').addEventListener('click', (event) => { const button = event.target.closest('.reply-button'); if (!button) return; if (!state.user) return openAuth(true); replyTo = { id: Number(button.dataset.replyId), author: button.dataset.replyAuthor }; $('#commentReplyLabel').textContent = `Ответ для ${replyTo.author}`; $('#commentReplyTarget').hidden = false; $('#commentForm textarea').focus(); });
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
  $('main').innerHTML = `<article class="reader user-post"><a class="reader-back" href="/">← Вернуться к ленте</a><div class="reader-meta"><span class="tag tools">Авторская статья</span><a class="profile-link" href="/profile/${post.authorId}">${escapeHtml(post.author)}</a><span>${relativeDate(post.publishedAt)}</span></div><h1>${escapeHtml(post.title)}</h1><div class="reader-content post-content" id="postBlocks">${post.blocks.map((block) => postBlockMarkup(block, post)).join('')}</div>${commentsSection()}</article>`;
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
function blankBlock(type) { if (type === 'image') return { type, url: '', caption: '' }; if (type === 'poll') return { type, id: crypto.randomUUID().slice(0, 16), question: '', options: ['', ''] }; return { type, text: type === 'divider' ? '' : '' }; }
async function renderWritePage() {
  if (!state.user) { $('main').innerHTML = `<section class="writer-gate"><span class="tag tools">Публикации сообщества</span><h1>Есть мысль?<br />Расскажите её.</h1><p>Создавайте статьи с текстом, изображениями, цитатами и опросами.</p><button id="writerLogin">Войти, чтобы написать</button></section>`; $('#writerLogin').addEventListener('click', () => openAuth(false)); return; }
  const draft = { title: '', blocks: [blankBlock('paragraph')] };
  const editorBlock = (block, index) => { if (block.type === 'divider') return `<div class="editor-divider" data-index="${index}"><span>Разделитель</span><button data-remove="${index}">Удалить</button></div>`; if (block.type === 'image') return `<div class="editor-block image-block" data-index="${index}"><div class="editor-block-top"><span>Картинка</span><button data-remove="${index}">Удалить</button></div><input data-image-url="${index}" value="${escapeHtml(block.url)}" placeholder="https://… или загрузите файл" /><input data-image-file="${index}" type="file" accept="image/png,image/jpeg,image/webp" /><input data-image-caption="${index}" value="${escapeHtml(block.caption)}" placeholder="Подпись к картинке (необязательно)" />${block.url ? `<img src="${escapeHtml(block.url)}" alt="Предпросмотр" />` : ''}</div>`; if (block.type === 'poll') return `<div class="editor-block poll-block" data-index="${index}"><div class="editor-block-top"><span>Опрос</span><button data-remove="${index}">Удалить</button></div><input data-poll-question="${index}" value="${escapeHtml(block.question)}" placeholder="Ваш вопрос" />${block.options.map((option, optionIndex) => `<input data-poll-option="${index}:${optionIndex}" value="${escapeHtml(option)}" placeholder="Вариант ${optionIndex + 1}" />`).join('')}<button class="add-option" data-add-option="${index}">+ Добавить вариант</button></div>`; const names = { paragraph: 'Текст', heading: 'Подзаголовок', quote: 'Цитата' }; return `<div class="editor-block" data-index="${index}"><div class="editor-block-top"><span>${names[block.type]}</span><button data-remove="${index}">Удалить</button></div><textarea data-text="${index}" placeholder="Начните писать…">${escapeHtml(block.text)}</textarea></div>`; };
  const draw = () => { $('main').innerHTML = `<section class="writer"><a class="reader-back" href="/">← К ленте</a><div class="writer-heading"><span class="tag tools">Новая публикация</span><h1>Напишите то, что<br />стоит прочитать.</h1><input id="postTitle" value="${escapeHtml(draft.title)}" placeholder="Заголовок статьи" /></div><div class="editor-toolbar"><button data-add="paragraph">Текст</button><button data-add="heading">Подзаголовок</button><button data-add="quote">Цитата</button><button data-add="image">Картинка</button><button data-add="poll">Опрос</button><button data-add="divider">Разделитель</button></div><div class="editor-blocks" id="editorBlocks">${draft.blocks.map(editorBlock).join('')}</div><div class="publish-bar"><span>Публикация сразу появится в общей ленте.</span><button id="publishPost">Опубликовать →</button></div></section>`; bind(); };
  const bind = () => { $('#postTitle').addEventListener('input', (event) => { draft.title = event.target.value; }); $('#editorBlocks').addEventListener('input', (event) => { const target = event.target; if (target.dataset.text !== undefined) draft.blocks[Number(target.dataset.text)].text = target.value; if (target.dataset.imageUrl !== undefined) draft.blocks[Number(target.dataset.imageUrl)].url = target.value; if (target.dataset.imageCaption !== undefined) draft.blocks[Number(target.dataset.imageCaption)].caption = target.value; if (target.dataset.pollQuestion !== undefined) draft.blocks[Number(target.dataset.pollQuestion)].question = target.value; if (target.dataset.pollOption) { const [blockIndex, optionIndex] = target.dataset.pollOption.split(':').map(Number); draft.blocks[blockIndex].options[optionIndex] = target.value; } }); $('#editorBlocks').addEventListener('click', (event) => { const remove = event.target.closest('[data-remove]'); const addOption = event.target.closest('[data-add-option]'); if (remove) { draft.blocks.splice(Number(remove.dataset.remove), 1); draw(); } if (addOption) { draft.blocks[Number(addOption.dataset.addOption)].options.push(''); draw(); } }); $('#editorBlocks').addEventListener('change', async (event) => { const target = event.target; if (!target.dataset.imageFile || !target.files[0]) return; if (target.files[0].size > 5000000) return alert('Изображение должно быть не больше 5 МБ.'); const reader = new FileReader(); reader.onload = async () => { try { const { url } = await request('/api/uploads', { method: 'POST', body: JSON.stringify({ dataUrl: reader.result }) }); draft.blocks[Number(target.dataset.imageFile)].url = url; draw(); } catch (error) { alert(error.message); } }; reader.readAsDataURL(target.files[0]); }); document.querySelectorAll('[data-add]').forEach((button) => button.addEventListener('click', () => { draft.blocks.push(blankBlock(button.dataset.add)); draw(); })); $('#publishPost').addEventListener('click', async () => { const button = $('#publishPost'); button.disabled = true; try { const { post } = await request('/api/posts', { method: 'POST', body: JSON.stringify({ title: draft.title, blocks: draft.blocks }) }); location.href = `/post/${post.id}`; } catch (error) { alert(error.message); button.disabled = false; } }); };
  draw();
}
async function init() { try { const [me, sources] = await Promise.all([request('/api/me'), request('/api/sources')]); state.user = me.user; state.preferences = me.preferences || state.preferences; state.sources = sources.sources; syncTopicControls(); renderProfile(); if (location.pathname.startsWith('/article/')) return renderArticlePage(location.pathname.split('/')[2]); if (location.pathname.startsWith('/post/')) return renderPostPage(location.pathname.split('/')[2]); if (location.pathname.startsWith('/profile/')) return renderProfilePage(location.pathname.split('/')[2]); if (location.pathname === '/write') return renderWritePage(); renderSources(); await loadFeed(); } catch (error) { const target = $('#articleList') || $('main'); target.innerHTML = `<div class="empty-state"><strong>Не удалось загрузить материал.</strong><span>${escapeHtml(error.message)}</span></div>`; } }
init();

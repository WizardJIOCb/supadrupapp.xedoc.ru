const topics = document.querySelectorAll('.topic');
const articles = document.querySelectorAll('.article');
const search = document.querySelector('#searchInput');
const dialog = document.querySelector('#subscribeDialog');

function filterArticles() {
  const activeTopic = document.querySelector('.topic.active').dataset.topic;
  const query = search.value.trim().toLowerCase();
  articles.forEach((article) => {
    const topicMatch = activeTopic === 'all' || article.dataset.topic === activeTopic;
    const textMatch = article.dataset.title.toLowerCase().includes(query);
    article.hidden = !(topicMatch && textMatch);
  });
}

topics.forEach((topic) => topic.addEventListener('click', () => {
  topics.forEach((item) => item.classList.remove('active'));
  topic.classList.add('active');
  filterArticles();
}));
search.addEventListener('input', filterArticles);

document.querySelectorAll('.save-button').forEach((button) => button.addEventListener('click', () => {
  button.classList.toggle('saved');
  button.textContent = button.classList.contains('saved') ? '★' : '☆';
}));

document.querySelector('#themeToggle').addEventListener('click', () => {
  document.body.classList.toggle('dark');
});

document.querySelector('#subscribeButton').addEventListener('click', () => dialog.showModal());
document.querySelector('.dialog-close').addEventListener('click', () => dialog.close());
document.querySelector('#subscribeForm').addEventListener('submit', (event) => {
  event.preventDefault();
  document.querySelector('#formMessage').textContent = 'Готово! Следующий дайджест придёт на эту почту.';
  event.currentTarget.reset();
});

document.querySelector('#moreButton').addEventListener('click', (event) => {
  event.currentTarget.innerHTML = 'Новая подборка скоро здесь <span>✦</span>';
  event.currentTarget.disabled = true;
});

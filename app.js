// Header scroll
const header = document.getElementById('header');
window.addEventListener('scroll', () => {
  header.classList.toggle('header--scrolled', window.scrollY > 40);
}, { passive: true });

// Smooth scroll
document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener('click', e => {
    e.preventDefault();
    const t = document.querySelector(a.getAttribute('href'));
    if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

// Reveal on scroll
const revealObserver = new IntersectionObserver(entries => {
  entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('visible'); });
}, { threshold: 0.1 });
document.querySelectorAll('.section__inner').forEach(el => {
  el.classList.add('reveal');
  revealObserver.observe(el);
});

// Role card flip
document.querySelectorAll('.role-card').forEach(card => {
  card.addEventListener('click', () => card.classList.toggle('flipped'));
});

// ===== QUICK REFERENCE TOGGLE =====
document.getElementById('ref-toggle').addEventListener('click', function() {
  const grid = document.getElementById('ref-grid');
  const isHidden = grid.hidden;
  grid.hidden = !isHidden;
  this.textContent = isHidden ? 'Hide Cheat Sheet' : 'Show Cheat Sheet';
});

// ===== STANDUP SIMULATOR =====
let standupInterval = null;
const standupTimer = document.getElementById('standup-timer');
const standupForm = document.getElementById('standup-form');
const standupResult = document.getElementById('standup-result');

document.getElementById('standup-start').addEventListener('click', function() {
  let secs = 300;
  if (standupInterval) clearInterval(standupInterval);
  standupTimer.classList.add('running');
  this.textContent = 'Running...';
  this.disabled = true;
  standupInterval = setInterval(() => {
    secs--;
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    standupTimer.textContent = m + ':' + String(s).padStart(2, '0');
    if (secs <= 0) {
      clearInterval(standupInterval);
      standupTimer.textContent = "Time's up!";
      standupTimer.classList.remove('running');
    }
  }, 1000);
});

standupForm.addEventListener('submit', e => {
  e.preventDefault();
  const did = document.getElementById('su-did').value || 'Nothing reported';
  const next = document.getElementById('su-next').value || 'Nothing planned';
  const blockers = document.getElementById('su-blockers').value || 'None';

  document.getElementById('standup-summary').innerHTML =
    '<div class="su-item"><div class="su-label">Progress toward Sprint Goal</div><div class="su-text">' + did + '</div></div>' +
    '<div class="su-item"><div class="su-label">Working on next</div><div class="su-text">' + next + '</div></div>' +
    '<div class="su-item"><div class="su-label">Blockers</div><div class="su-text">' + blockers + '</div></div>';

  standupForm.hidden = true;
  standupResult.hidden = false;
  if (standupInterval) clearInterval(standupInterval);
  standupTimer.textContent = 'Done';
  standupTimer.classList.remove('running');
});

document.getElementById('standup-reset').addEventListener('click', () => {
  standupForm.hidden = false;
  standupResult.hidden = true;
  standupForm.reset();
  standupTimer.textContent = '5:00';
  const btn = document.getElementById('standup-start');
  btn.textContent = 'Start Timer';
  btn.disabled = false;
});

// ===== SPRINT TIMER =====
let sprintInterval = null;
let sprintSecsLeft = 0;
let sprintTotalSecs = 0;
const sprintClock = document.getElementById('sprint-clock');
const sprintPhase = document.getElementById('sprint-phase');
const phaseSegs = document.querySelectorAll('.phase-seg');

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m + ':' + String(sec).padStart(2, '0');
}

function getPhase(elapsed, total) {
  const pct = elapsed / total;
  if (pct < 0.0833) return 'plan';
  if (pct < 0.8333) return 'work';
  if (pct < 0.9167) return 'review';
  return 'retro';
}

const phaseNames = { plan: 'Sprint Planning', work: 'Do The Work', review: 'Sprint Review', retro: 'Retrospective' };

document.getElementById('sprint-start-btn').addEventListener('click', function() {
  if (sprintInterval) return;
  sprintTotalSecs = parseInt(document.getElementById('sprint-duration').value);
  sprintSecsLeft = sprintTotalSecs;
  sprintClock.classList.add('running');
  this.disabled = true;

  sprintInterval = setInterval(() => {
    sprintSecsLeft--;
    sprintClock.textContent = formatTime(sprintSecsLeft);
    const elapsed = sprintTotalSecs - sprintSecsLeft;
    const phase = getPhase(elapsed, sprintTotalSecs);
    sprintPhase.textContent = phaseNames[phase];
    phaseSegs.forEach(s => s.classList.toggle('active', s.dataset.phase === phase));

    if (sprintSecsLeft <= 0) {
      clearInterval(sprintInterval);
      sprintInterval = null;
      sprintClock.textContent = 'Sprint Complete!';
      sprintClock.classList.remove('running');
      sprintPhase.textContent = 'Great work!';
      document.getElementById('sprint-start-btn').disabled = false;
    }
  }, 1000);
});

document.getElementById('sprint-reset-btn').addEventListener('click', () => {
  if (sprintInterval) clearInterval(sprintInterval);
  sprintInterval = null;
  const dur = parseInt(document.getElementById('sprint-duration').value);
  sprintClock.textContent = formatTime(dur);
  sprintClock.classList.remove('running');
  sprintPhase.textContent = 'Ready to start';
  phaseSegs.forEach(s => s.classList.remove('active'));
  document.getElementById('sprint-start-btn').disabled = false;
});

document.getElementById('sprint-duration').addEventListener('change', function() {
  if (!sprintInterval) {
    sprintClock.textContent = formatTime(parseInt(this.value));
  }
});

// ===== TASK BOARD =====
const STORAGE_KEY = 'microsprint-board';
const DEFAULT_TASKS = [
  { id: 1, text: 'Write the intro paragraph', status: 'todo' },
  { id: 2, text: 'Design the logo', status: 'todo' },
  { id: 3, text: 'Test the login flow', status: 'todo' }
];

let storedData = localStorage.getItem(STORAGE_KEY);
let tasks = storedData ? JSON.parse(storedData) : DEFAULT_TASKS.map(t => ({...t}));
let taskIdCounter = tasks.length ? Math.max(...tasks.map(t => t.id)) + 1 : 1;

// Save initial default tasks to localStorage if none existed
if (!storedData) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
}

function saveTasks() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
}

function updateEmptyStates() {
  ['todo', 'progress', 'done'].forEach(status => {
    const emptyEl = document.getElementById('empty-' + status);
    if (emptyEl) {
      const count = tasks.filter(t => t.status === status).length;
      emptyEl.style.display = count === 0 ? 'block' : 'none';
    }
  });
}

function renderBoard() {
  ['todo', 'progress', 'done'].forEach(status => {
    const col = document.getElementById('col-' + status);
    col.innerHTML = '';
    const items = tasks.filter(t => t.status === status);
    items.forEach(task => {
      const card = document.createElement('div');
      card.className = 'task-card';
      card.draggable = true;
      card.dataset.id = task.id;
      card.innerHTML = task.text + '<button class="task-card__delete" data-id="' + task.id + '">&times;</button>';

      card.addEventListener('dragstart', e => {
        e.dataTransfer.setData('text/plain', task.id);
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));

      col.appendChild(card);
    });
    document.getElementById('count-' + status).textContent = items.length;
  });
  updateEmptyStates();
}

document.querySelectorAll('.board__cards').forEach(col => {
  col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('drag-over'); });
  col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
  col.addEventListener('drop', e => {
    e.preventDefault();
    col.classList.remove('drag-over');
    const id = parseInt(e.dataTransfer.getData('text/plain'));
    const status = col.id.replace('col-', '');
    const task = tasks.find(t => t.id === id);
    if (task) { task.status = status; saveTasks(); renderBoard(); }
  });
});

document.getElementById('add-todo').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.value.trim()) {
    tasks.push({ id: taskIdCounter++, text: e.target.value.trim(), status: 'todo' });
    e.target.value = '';
    saveTasks();
    renderBoard();
  }
});

document.addEventListener('click', e => {
  if (e.target.classList.contains('task-card__delete')) {
    const id = parseInt(e.target.dataset.id);
    tasks = tasks.filter(t => t.id !== id);
    saveTasks();
    renderBoard();
  }
});

renderBoard();

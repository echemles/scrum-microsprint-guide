// ===== HEADER =====
const header = document.getElementById('header');
window.addEventListener('scroll', () => header.classList.toggle('header--scrolled', window.scrollY > 30), { passive: true });

document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener('click', e => { e.preventDefault(); document.querySelector(a.getAttribute('href'))?.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
});

// ===== REVEAL =====
const ro = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) e.target.classList.add('visible'); }), { threshold: 0.08 });
document.querySelectorAll('.section__inner').forEach(el => { el.classList.add('reveal'); ro.observe(el); });

// ===== MODES & TIMELINE =====
const TIMELINES = {
  spike: [
    { time: '0–3', name: 'Define Question', color: 'var(--indigo)' },
    { time: '3–8', name: 'Prompt + Explore', color: 'var(--cyan)' },
    { time: '8–22', name: 'Prototype', color: 'var(--amber)' },
    { time: '22–27', name: 'Findings', color: 'var(--emerald)' },
    { time: '27–30', name: 'Decision', color: 'var(--rose)' }
  ],
  build: [
    { time: '0–5', name: 'Sprint Contract', color: 'var(--indigo)' },
    { time: '5–10', name: 'Prompt + Plan', color: 'var(--cyan)' },
    { time: '10–40', name: 'Claude Build Loop', color: 'var(--amber)' },
    { time: '40–50', name: 'Human Review', color: 'var(--emerald)' },
    { time: '50–57', name: 'Demo Prep', color: 'var(--white)' },
    { time: '57–60', name: 'Retro', color: 'var(--rose)' }
  ],
  ship: [
    { time: '0–10', name: 'Sprint Contract', color: 'var(--indigo)' },
    { time: '10–20', name: 'Prompt + Plan', color: 'var(--cyan)' },
    { time: '20–80', name: 'Build', color: 'var(--amber)' },
    { time: '80–100', name: 'Review + QA', color: 'var(--emerald)' },
    { time: '100–112', name: 'Polish', color: 'var(--white)' },
    { time: '112–120', name: 'Demo + Retro', color: 'var(--rose)' }
  ]
};
const MODE_DURATIONS = { spike: '30-minute', build: '60-minute', ship: '120-minute' };
const SCOPE_LIMITS = { spike: 1, build: 3, ship: 5 };
let currentMode = 'build';

function renderTimeline() {
  const tl = document.getElementById('tl');
  tl.innerHTML = TIMELINES[currentMode].map(p =>
    `<div class="tl__phase"><div class="tl__phase-time">${p.time} min</div><div class="tl__phase-name">${p.name}</div><div class="tl__phase-bar" style="background:${p.color}"></div></div>`
  ).join('');
}

document.querySelectorAll('.mode-card').forEach(card => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.mode-card').forEach(c => c.classList.remove('mode-card--active'));
    card.classList.add('mode-card--active');
    currentMode = card.dataset.mode;
    renderTimeline();
    updatePrompt();
    checkScope();
  });
});
renderTimeline();

// ===== PROMPT GENERATOR =====
const fields = ['c-goal','c-user','c-context','c-nongoals','c-dod','c-demo','c-risk'];
const labels = { 'c-goal': 'Sprint Goal', 'c-user': 'User / Customer', 'c-context': 'Context', 'c-nongoals': 'Non-goals', 'c-dod': 'Definition of Done', 'c-demo': 'Demo Moment', 'c-risk': 'Main Risk' };

function updatePrompt() {
  const v = {};
  fields.forEach(f => v[f] = document.getElementById(f).value.trim() || '(not specified)');
  const strict = document.getElementById('strict-toggle').checked;

  let txt = `We are running a ${MODE_DURATIONS[currentMode]} Claude Code microsprint.\n\n`;
  fields.forEach(f => txt += `${labels[f]}:\n${v[f]}\n\n`);
  txt += `Working Rules:\n1. First inspect the relevant files and summarize what you found.\n2. Propose a short implementation plan before editing.\n3. Keep the scope tight and aligned to the sprint goal.\n4. Do not modify unrelated files.\n5. Prefer simple, reversible changes.\n6. After implementation, run the most relevant checks available.\n7. End with a concise summary of files changed, validation results, risks, and recommended next steps.\n`;

  if (strict) {
    txt += `\nStrict Mode:\n- Ask before making broad architectural changes.\n- Do not introduce new dependencies unless absolutely necessary.\n- Do not refactor unrelated code.\n- Stop and report if the task appears larger than the selected sprint duration.\n`;
  }

  txt += `\nDeliverables:\n- Working implementation or prototype\n- Validation notes\n- Demo instructions\n- Follow-up tasks`;

  document.getElementById('prompt-output').textContent = txt;
}

fields.forEach(f => document.getElementById(f).addEventListener('input', updatePrompt));
document.getElementById('strict-toggle').addEventListener('change', updatePrompt);
updatePrompt();

document.getElementById('copy-prompt').addEventListener('click', function() {
  navigator.clipboard.writeText(document.getElementById('prompt-output').textContent);
  this.textContent = 'Copied!';
  this.classList.add('copied');
  setTimeout(() => { this.textContent = 'Copy Prompt'; this.classList.remove('copied'); }, 1500);
});

// ===== SPRINT BOARD =====
const COLS = ['backlog','selected','claude','human-review','verified','cut'];
const COL_LABELS = { backlog:'Backlog', selected:'Selected', claude:'Claude Working', 'human-review':'Human Review', verified:'Verified', cut:'Cut' };
const COL_COLORS = { backlog:'var(--text-dim)', selected:'var(--indigo)', claude:'var(--amber)', 'human-review':'var(--cyan)', verified:'var(--emerald)', cut:'var(--rose)' };
let tasks = JSON.parse(localStorage.getItem('ms-board') || '[]');
let tid = tasks.length ? Math.max(...tasks.map(t => t.id)) + 1 : 1;

function saveBoard() { localStorage.setItem('ms-board', JSON.stringify(tasks)); }

function renderBoard() {
  const grid = document.getElementById('board-grid');
  grid.innerHTML = COLS.map(col => {
    const items = tasks.filter(t => t.col === col);
    return `<div class="board__col" data-col="${col}">
      <div class="board__col-header"><span class="board__col-dot" style="background:${COL_COLORS[col]}"></span>${COL_LABELS[col]}<span class="board__col-count">${items.length}</span></div>
      <div class="board__cards">${items.map(t => renderCard(t, col)).join('')}</div>
    </div>`;
  }).join('');
  checkScope();
}

function renderCard(t, col) {
  const ci = COLS.indexOf(col);
  const left = ci > 0 ? `<button data-move="${t.id}" data-dir="left">&larr;</button>` : '';
  const right = ci < COLS.length - 1 ? `<button data-move="${t.id}" data-dir="right">&rarr;</button>` : '';
  return `<div class="task-card"><span class="task-card__type">${t.type}</span>${t.text}<div class="task-card__actions">${left}${right}<button class="del-btn" data-del="${t.id}">&times;</button></div></div>`;
}

document.getElementById('board-grid').addEventListener('click', e => {
  const moveBtn = e.target.closest('[data-move]');
  if (moveBtn) {
    const task = tasks.find(t => t.id === +moveBtn.dataset.move);
    if (!task) return;
    const ci = COLS.indexOf(task.col);
    task.col = moveBtn.dataset.dir === 'left' ? COLS[ci - 1] : COLS[ci + 1];
    saveBoard(); renderBoard();
  }
  const delBtn = e.target.closest('[data-del]');
  if (delBtn) {
    tasks = tasks.filter(t => t.id !== +delBtn.dataset.del);
    saveBoard(); renderBoard();
  }
});

document.getElementById('add-task-btn').addEventListener('click', () => {
  const title = document.getElementById('task-title').value.trim();
  if (!title) return;
  tasks.push({ id: tid++, text: title, type: document.getElementById('task-type').value, col: 'backlog' });
  document.getElementById('task-title').value = '';
  saveBoard(); renderBoard();
});
document.getElementById('task-title').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('add-task-btn').click(); });

function checkScope() {
  const active = tasks.filter(t => t.col !== 'cut' && t.col !== 'backlog').length;
  const warn = document.getElementById('scope-warn');
  warn.hidden = active <= SCOPE_LIMITS[currentMode];
}

renderBoard();

// ===== REVIEW GATE =====
document.getElementById('checklist').addEventListener('change', () => {
  const checked = document.querySelectorAll('#checklist input:checked').length;
  document.getElementById('review-progress').textContent = `${checked} / 6 verified`;
});

// ===== RETRO REPORT =====
const retroFields = ['r-shipped','r-notshipped','r-changed','r-bugs','r-decisions','r-next'];
const retroLabels = { 'r-shipped':'Shipped', 'r-notshipped':'Not Shipped', 'r-changed':'What Changed', 'r-bugs':'Bugs / Risks', 'r-decisions':'Decisions Made', 'r-next':'Next Sprint Candidates' };

function updateRetro() {
  const goal = document.getElementById('c-goal').value.trim() || '(not set)';
  const demo = document.getElementById('c-demo').value.trim() || '(not set)';
  let md = `# Microsprint Report\n\n## Sprint Mode\n${MODE_DURATIONS[currentMode]}\n\n## Sprint Goal\n${goal}\n\n`;
  retroFields.forEach(f => {
    const v = document.getElementById(f).value.trim() || '(none)';
    md += `## ${retroLabels[f]}\n${v}\n\n`;
  });
  md += `## Demo Notes\n${demo}\n`;
  document.getElementById('retro-output').textContent = md;
}

retroFields.forEach(f => document.getElementById(f).addEventListener('input', updateRetro));
['c-goal','c-demo'].forEach(f => document.getElementById(f).addEventListener('input', updateRetro));
updateRetro();

document.getElementById('copy-retro').addEventListener('click', function() {
  navigator.clipboard.writeText(document.getElementById('retro-output').textContent);
  this.textContent = 'Copied!';
  this.classList.add('copied');
  setTimeout(() => { this.textContent = 'Copy Report'; this.classList.remove('copied'); }, 1500);
});

// ===== THEORY DRAWER =====
document.getElementById('theory-toggle').addEventListener('click', function() {
  const body = document.getElementById('theory-body');
  body.hidden = !body.hidden;
  this.textContent = body.hidden ? 'Why this works: Scrum concepts behind the microsprint' : 'Hide Scrum concepts';
});

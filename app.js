// ===== STATE =====
const LS = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const SS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn('localStorage write failed:', e); } };

function escHtml(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }

let sprint = LS('ms-sprint') || null;
let tasks = LS('ms-tasks') || [];
let history = LS('ms-history') || [];
let eventLog = LS('ms-log') || [];
let tid = tasks.length ? Math.max(...tasks.map(t => t.id)) + 1 : 1;
if (!isFinite(tid) || tid < 1) tid = 1;
let currentMode = sprint?.mode || 'build';
let timerInterval = null;

function save() { SS('ms-sprint', sprint); SS('ms-tasks', tasks); SS('ms-history', history); SS('ms-log', eventLog); }

function toggleSprintSections() {
  document.body.classList.toggle('sprint-active', !!sprint);
}

// ===== TIMELINES =====
const TIMELINES = {
  spike: [{ time:'0–3', name:'Define Question', color:'var(--indigo)' },{ time:'3–8', name:'Prompt + Explore', color:'var(--cyan)' },{ time:'8–22', name:'Prototype', color:'var(--amber)' },{ time:'22–27', name:'Findings', color:'var(--emerald)' },{ time:'27–30', name:'Decision', color:'var(--rose)' }],
  build: [{ time:'0–5', name:'Sprint Contract', color:'var(--indigo)' },{ time:'5–10', name:'Prompt + Plan', color:'var(--cyan)' },{ time:'10–40', name:'Claude Build Loop', color:'var(--amber)' },{ time:'40–50', name:'Human Review', color:'var(--emerald)' },{ time:'50–57', name:'Demo Prep', color:'var(--white)' },{ time:'57–60', name:'Retro', color:'var(--rose)' }],
  ship: [{ time:'0–10', name:'Sprint Contract', color:'var(--indigo)' },{ time:'10–20', name:'Prompt + Plan', color:'var(--cyan)' },{ time:'20–80', name:'Build', color:'var(--amber)' },{ time:'80–100', name:'Review + QA', color:'var(--emerald)' },{ time:'100–112', name:'Polish', color:'var(--white)' },{ time:'112–120', name:'Demo + Retro', color:'var(--rose)' }]
};
const DURATIONS = { spike: 30, build: 60, ship: 120 };
const SCOPE_LIMITS = { spike: 1, build: 3, ship: 5 };
const PHASES = ['planning', 'work', 'review', 'retro', 'completed'];
const PHASE_LABELS = { planning: 'Planning', work: 'Build', review: 'Review', retro: 'Retro', completed: 'Done' };
const BOARD_COLS = ['selected','claude','human-review','verified','cut'];
const COL_LABELS = { selected:'Selected', claude:'Claude Working', 'human-review':'Human Review', verified:'Verified', cut:'Cut' };
const COL_COLORS = { selected:'var(--indigo)', claude:'var(--amber)', 'human-review':'var(--cyan)', verified:'var(--emerald)', cut:'var(--rose)' };

// ===== TEMPLATES (item 19) =====
const TEMPLATES = {
  impl: { goal:'Build and ship [feature name]', nongoals:'No unrelated refactoring', dod:'Feature works in browser, tests pass, PR ready', risk:'Claude overbuilds the data model' },
  bugbash: { goal:'Fix the top 3 user-reported bugs', nongoals:'No new features, no refactoring', dod:'Each bug has a fix + test + verification screenshot', risk:'Fixes introduce regressions' },
  design: { goal:'Design and prototype [screen/flow]', nongoals:'No backend work', dod:'Clickable prototype with all states', risk:'Scope creep into implementation' },
  docs: { goal:'Document [feature/API/process]', nongoals:'No code changes', dod:'Docs are clear to a new team member', risk:'Over-documenting edge cases' },
  discovery: { goal:'Validate [hypothesis] with [N] users', nongoals:'No building, only learning', dod:'Clear go/no-go decision with evidence', risk:'Confirmation bias' }
};

// ===== FACILITATOR PROMPTS (item 13) =====
const FAC_PROMPTS = {
  planning: ['Is the sprint goal clear and testable?','Can we cut anything to protect the demo?','Does each person know their top priority?','Are there blockers we should surface now?'],
  work: ['Are we still on track for the sprint goal?','Is anyone blocked?','Should we cut scope to finish on time?','Are we building the simplest version first?'],
  review: ['Does the increment match the sprint goal?','Can we demo this right now?','Are there unrelated file changes to revert?','Did we run the relevant checks?'],
  retro: ['What went well this sprint?','What should we do differently next time?','What one process experiment will we try?','What action items should become tickets?']
};

// ===== HEADER =====
window.addEventListener('scroll', () => document.getElementById('header').classList.toggle('header--scrolled', window.scrollY > 30), { passive: true });
document.querySelectorAll('a[href^="#"]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); document.querySelector(a.getAttribute('href'))?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }));

// Reveal
const ro = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) e.target.classList.add('visible'); }), { threshold: 0.08 });
document.querySelectorAll('.section__inner').forEach(el => { el.classList.add('reveal'); ro.observe(el); });

// ===== MODE SELECT =====
function setMode(mode) {
  currentMode = mode;
  document.querySelectorAll('.mode-card').forEach(c => c.classList.toggle('mode-card--active', c.dataset.mode === mode));
  renderTimeline();
  updatePrompt();
  checkScope();
  // Update timer modal phases to match mode
  tmState.phases = TM_PHASES[mode];
  tmState.phaseIndex = 0;
  tmState.elapsed = 0;
  tmState.running = false;
  if (tmInterval) { clearInterval(tmInterval); tmInterval = null; }
}
document.querySelectorAll('.mode-card').forEach(c => c.addEventListener('click', () => setMode(c.dataset.mode)));

// ===== TEMPLATES =====
document.querySelectorAll('.templates__btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const t = TEMPLATES[btn.dataset.tpl];
    if (!t) return;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set('c-goal-a', t.goal); set('c-dod-a', t.dod); set('c-nongoals-a', t.nongoals); set('c-risk-a', t.risk);
    set('c-goal-b', t.goal); set('c-dod-b', t.dod); set('c-nongoals-b', t.nongoals); set('c-risk-b', t.risk);
    updatePrompt();
  });
});

// DoD preset (item 20)
document.getElementById('dod-preset-btn')?.addEventListener('click', () => {
  const el = document.getElementById('c-dod'); if (el) { el.value = 'Usable by teammate, tested or intentionally waived, proof attached, next step obvious.'; updatePrompt(); }
});

// ===== TIMELINE =====
function renderTimeline() {
  const tl = document.getElementById('tl');
  const phases = TIMELINES[currentMode];
  tl.innerHTML = phases.map((p, i) => `<div class="tl__phase${sprint && getTimelinePhaseIndex() === i ? ' active' : ''}"><div class="tl__phase-time">${p.time} min</div><div class="tl__phase-name">${p.name}</div><div class="tl__phase-bar" style="background:${p.color}"></div></div>`).join('');
}

function getTimelinePhaseIndex() {
  if (!sprint || !sprint.startTime) return -1;
  const elapsed = (Date.now() - sprint.startTime) / 60000;
  const total = DURATIONS[sprint.mode];
  const pct = elapsed / total;
  const phases = TIMELINES[sprint.mode];
  let acc = 0;
  for (let i = 0; i < phases.length; i++) {
    const [s, e] = phases[i].time.split('–').map(Number);
    if (elapsed >= s && elapsed < e) return i;
  }
  return phases.length - 1;
}

renderTimeline();

// ===== OWNER SELECTS (only if board/standup UI exists) =====
function updateOwnerSelects() {
  const a = document.getElementById('person-a')?.value || 'Les';
  const b = document.getElementById('person-b')?.value || 'Mattis';
  [document.getElementById('task-owner'), document.getElementById('su-who')].forEach(sel => {
    if (!sel) return;
    sel.innerHTML = '';
    [['', 'Unassigned'], [a, a], [b, b]].forEach(([v, t]) => {
      const opt = document.createElement('option');
      opt.value = v; opt.textContent = t; sel.appendChild(opt);
    });
  });
}
['person-a', 'person-b'].forEach(id => document.getElementById(id)?.addEventListener('input', updateOwnerSelects));
updateOwnerSelects();

// ===== SPRINT LIFECYCLE (items 1,4,25,26) =====
function logEvent(msg) {
  const entry = { time: new Date().toISOString(), msg };
  eventLog.push(entry);
  save();
  renderEventLog();
}

document.getElementById('start-sprint-btn').addEventListener('click', () => {
  const goalEl = document.getElementById('c-goal');
  const goal = goalEl.value.trim();
  if (!goal) {
    goalEl.style.borderColor = 'var(--rose)';
    let err = document.getElementById('goal-error');
    if (!err) { err = document.createElement('div'); err.id = 'goal-error'; err.style.cssText = 'color:var(--rose);font-size:.75rem;margin-top:4px'; err.textContent = 'Please enter a sprint goal'; goalEl.parentElement.appendChild(err); }
    goalEl.focus();
    goalEl.addEventListener('input', () => { goalEl.style.borderColor = ''; document.getElementById('goal-error')?.remove(); }, { once: true });
    return;
  }
  sprint = {
    id: 'sp-' + Date.now(),
    mode: currentMode,
    goal,
    goalA: document.getElementById('c-goal-a').value.trim(),
    goalB: document.getElementById('c-goal-b').value.trim(),
    personA: document.getElementById('person-a').value.trim() || 'Person A',
    personB: document.getElementById('person-b').value.trim() || 'Person B',
    projectA: document.getElementById('project-a').value.trim(),
    projectB: document.getElementById('project-b').value.trim(),
    duration: DURATIONS[currentMode],
    phase: 'planning',
    startTime: Date.now(),
    pausedAt: null,
    pausedElapsed: 0,
    standups: [],
    reviewNotes: null,
    retroNotes: null,
  };
  eventLog = [];
  save();
  logEvent('Sprint started: ' + goal);
  activateSprint();
});

function activateSprint() {
  document.body.classList.add('sprint-active');
  document.getElementById('topbar').hidden = false;
  updateTopbar();
  startTimer();
  renderAll();
}

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(tickTimer, 1000);
}

function tickTimer() {
  if (!sprint || !sprint.startTime || sprint.pausedAt) return;
  const elapsed = getElapsed();
  const total = sprint.duration * 60;
  const remaining = Math.max(0, total - elapsed);
  const m = Math.floor(remaining / 60), s = remaining % 60;
  const tb = document.getElementById('tb-timer');
  tb.textContent = m + ':' + String(s).padStart(2, '0');
  tb.className = 'topbar__timer' + (remaining < 300 ? ' warn' : '') + (remaining < 60 ? ' critical' : '');
  document.getElementById('tb-progress').style.width = Math.min(100, (elapsed / total) * 100) + '%';
  renderTimeline();
  if (remaining <= 0) { clearInterval(timerInterval); logEvent('Timer reached zero'); }
}

function getElapsed() {
  if (!sprint) return 0;
  const now = sprint.pausedAt || Date.now();
  return Math.floor((now - sprint.startTime - sprint.pausedElapsed) / 1000);
}

function updateTopbar() {
  if (!sprint) return;
  document.getElementById('tb-phase').textContent = PHASE_LABELS[sprint.phase] || sprint.phase;
  document.getElementById('tb-goal').textContent = sprint.goal;
  document.getElementById('tb-roles').textContent = sprint.personA + ' + ' + sprint.personB;
}

// Pause/Resume (item 26)
document.getElementById('tb-pause').addEventListener('click', () => {
  if (!sprint) return;
  if (sprint.pausedAt) {
    sprint.pausedElapsed += Date.now() - sprint.pausedAt;
    sprint.pausedAt = null;
    document.getElementById('tb-pause').innerHTML = '&#10074;&#10074;';
    logEvent('Sprint resumed');
  } else {
    sprint.pausedAt = Date.now();
    document.getElementById('tb-pause').innerHTML = '&#9654;';
    logEvent('Sprint paused');
  }
  save();
});

// Next phase
document.getElementById('tb-next-phase').addEventListener('click', () => {
  if (!sprint) return;
  const i = PHASES.indexOf(sprint.phase);
  if (i < PHASES.length - 1) {
    sprint.phase = PHASES[i + 1];
    save();
    logEvent('Phase → ' + PHASE_LABELS[sprint.phase]);
    updateTopbar();
    renderTimeline();
    renderFacilitator();
  }
});

// End sprint
document.getElementById('tb-end').addEventListener('click', () => {
  if (!sprint) return;
  if (!confirm('End this sprint?')) return;
  sprint.phase = 'completed';
  save();
  logEvent('Sprint ended');
  document.getElementById('tb-phase').textContent = 'Complete — fill in retro below';
  document.getElementById('retro').scrollIntoView({ behavior: 'smooth' });
});

// Close & archive (items 29,39)
document.getElementById('close-sprint-btn').addEventListener('click', () => {
  if (!sprint) return;
  if (!confirm('Archive this sprint and move unfinished tasks to backlog?')) return;
  sprint.endTime = Date.now();
  sprint.retroNotes = {
    experiment: getVal('retro-experiment'),
    les: { well: getVal('retro-well-a'), improve: getVal('retro-improve-a'), actions: getVal('retro-actions-a'), carryover: getVal('retro-carryover-a') },
    mattis: { well: getVal('retro-well-b'), improve: getVal('retro-improve-b'), actions: getVal('retro-actions-b'), carryover: getVal('retro-carryover-b') },
    // Legacy combined fields for backward compat
    well: getVal('retro-well-a') + (getVal('retro-well-b') ? '\n\nMattis: ' + getVal('retro-well-b') : ''),
    improve: getVal('retro-improve-a') + (getVal('retro-improve-b') ? '\n\nMattis: ' + getVal('retro-improve-b') : ''),
    actions: getVal('retro-actions-a') + '\n' + getVal('retro-actions-b'),
    carryover: getVal('retro-carryover-a') + '\n' + getVal('retro-carryover-b'),
  };
  sprint.reviewNotes = {
    shipped: document.getElementById('r-shipped-desc')?.value,
    demoLink: document.getElementById('r-demo-link')?.value,
    feedback: document.getElementById('r-feedback')?.value,
  };
  sprint.tasks = tasks.filter(t => t.sprintId === sprint.id).map(t => ({ ...t }));

  // Retro action items → backlog (item 17)
  const actions = (sprint.retroNotes.actions || '').split('\n').filter(a => a.trim());
  actions.forEach(a => { tasks.push({ id: tid++, text: a.trim(), type: 'Research', owner: '', sprintId: null, col: 'backlog', blockedReason: '', tooBig: false }); });

  // Carry-over → backlog (item 29)
  tasks.filter(t => t.sprintId === sprint.id && t.col !== 'verified' && t.col !== 'cut').forEach(t => { t.sprintId = null; t.col = 'backlog'; });

  history.push({ ...sprint });
  logEvent('Sprint archived');
  sprint = null;
  eventLog = [];
  save();
  document.getElementById('topbar').hidden = true;
  if (timerInterval) clearInterval(timerInterval);
  renderAll();
});

// ===== PROMPT GENERATOR =====
const PROMPT_FIELDS = ['c-goal','c-user','c-context','c-nongoals','c-dod','c-demo','c-risk'];
const PROMPT_LABELS = { 'c-goal':'Sprint Goal','c-user':'User / Customer','c-context':'Context','c-nongoals':'Non-goals','c-dod':'Definition of Done','c-demo':'Demo Moment','c-risk':'Main Risk' };

function getVal(id) { return (document.getElementById(id)?.value || '').trim(); }

function buildPersonMd(name, projectId, goalId, dodId, nongoalsId, riskId, implId) {
  const dur = DURATIONS[currentMode];
  const strict = document.getElementById('strict-toggle')?.checked;
  const project = getVal(projectId) || '(not set)';
  const goal = getVal(goalId) || '(not set)';
  const dod = getVal(dodId) || '(not set)';
  const nongoals = getVal(nongoalsId) || '(none)';
  const risk = getVal(riskId) || '(none)';
  const impl = getVal(implId) || '_(fill in your approach, files to touch, validations)_';

  let md = `# ${name} — Microsprint Plan\n\n**Duration:** ${dur} minutes\n**Project:** ${project}\n\n## Sprint Goal\n${goal}\n\n## Definition of Done\n${dod}\n\n## Non-goals\n${nongoals}\n\n## Main Risk\n${risk}\n\n## Implementation Notes\n${impl}\n\n---\n\n## Claude Code Prompt\n\nWe are running a ${dur}-minute Claude Code microsprint.\n\n**Sprint Goal:** ${goal}\n**Definition of Done:** ${dod}\n**Non-goals:** ${nongoals}\n**Main Risk:** ${risk}\n\n**My implementation plan:**\n${impl}\n\n### Working Rules\n1. First inspect the relevant files and summarize what you found.\n2. Propose a short implementation plan before editing.\n3. Keep the scope tight and aligned to the sprint goal.\n4. Do not modify unrelated files.\n5. Prefer simple, reversible changes.\n6. After implementation, run the most relevant checks available.\n7. End with a concise summary of files changed, validation results, risks, and recommended next steps.\n`;
  if (strict) md += `\n### Strict Mode\n- Ask before making broad architectural changes.\n- Do not introduce new dependencies unless absolutely necessary.\n- Do not refactor unrelated code.\n- Stop and report if the task appears larger than ${dur} minutes.\n`;
  md += `\n### Deliverables\n- Working implementation or prototype\n- Validation notes\n- Demo instructions\n- Follow-up tasks`;
  return md;
}

function updatePrompt() {
  const lesMd = buildPersonMd('Les', 'project-a', 'c-goal-a', 'c-dod-a', 'c-nongoals-a', 'c-risk-a', 'c-impl-a');
  const mattisMd = buildPersonMd('Mattis', 'project-b', 'c-goal-b', 'c-dod-b', 'c-nongoals-b', 'c-risk-b', 'c-impl-b');
  const lesEl = document.getElementById('md-body-les');
  const mattisEl = document.getElementById('md-body-mattis');
  if (lesEl) lesEl.textContent = lesMd;
  if (mattisEl) mattisEl.textContent = mattisMd;
  const legacy = document.getElementById('prompt-output');
  if (legacy) legacy.textContent = lesMd + '\n\n---\n\n' + mattisMd;
}

function copyMd(btnId, srcId, label) {
  const btn = document.getElementById(btnId);
  btn?.addEventListener('click', function() {
    const txt = document.getElementById(srcId)?.textContent || '';
    navigator.clipboard.writeText(txt).then(() => { this.textContent = 'Copied!'; this.classList.add('copied'); setTimeout(() => { this.textContent = label; this.classList.remove('copied'); }, 1200); }).catch(() => { this.textContent = 'Failed'; });
  });
}
copyMd('copy-md-les', 'md-body-les', 'Copy');
copyMd('copy-md-mattis', 'md-body-mattis', 'Copy');
PROMPT_FIELDS.forEach(f => document.getElementById(f).addEventListener('input', updatePrompt));
document.getElementById('strict-toggle').addEventListener('change', updatePrompt);
updatePrompt();

function copyBtn(btnId, textId) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.addEventListener('click', function() {
    const label = btnId.includes('retro') ? 'Copy Report' : 'Copy Prompt';
    navigator.clipboard.writeText(document.getElementById(textId)?.textContent || '')
      .then(() => { btn.textContent = 'Copied!'; btn.classList.add('copied'); })
      .catch(() => { btn.textContent = 'Copy failed'; })
      .finally(() => { setTimeout(() => { btn.textContent = label; btn.classList.remove('copied'); }, 1500); });
  });
}
copyBtn('copy-prompt', 'prompt-output');
copyBtn('copy-retro', 'retro-output');

// ===== TASK MANAGEMENT =====
document.getElementById('add-task-btn')?.addEventListener('click', addTask);
document.getElementById('task-title')?.addEventListener('keydown', e => { if (e.key === 'Enter') addTask(); });

function addTask() {
  const ti = document.getElementById('task-title');
  if (!ti) return;
  const text = ti.value.trim();
  if (!text) return;
  tasks.push({
    id: tid++, text, type: document.getElementById('task-type').value,
    owner: document.getElementById('task-owner').value,
    sprintId: null, col: 'backlog', blockedReason: '', tooBig: false
  });
  ti.value = '';
  save(); renderPlanning(); renderBoard();
}

// ===== PLANNING (items 6,7,9,22,23) =====
function renderPlanning() {
  if (!document.getElementById('plan-backlog')) return; // planning UI removed (informational now)
  const backlog = tasks.filter(t => !t.sprintId && t.col === 'backlog');
  const sprintTasks = tasks.filter(t => sprint && t.sprintId === sprint.id);

  document.getElementById('plan-backlog').innerHTML = backlog.map(t =>
    `<div class="plan-card"><div class="plan-card__info"><span class="plan-card__type">${escHtml(t.type)}</span><span class="plan-card__title">${escHtml(t.text)}</span>${t.owner ? `<span class="plan-card__owner">${escHtml(t.owner)}</span>` : ''}${t.tooBig ? '<span class="plan-card__toobig">TOO BIG</span>' : ''}</div><div>${sprint ? `<button data-pull="${t.id}">Pull →</button>` : ''}${!t.tooBig ? `<button data-toobig="${t.id}">⚠</button>` : ''}</div></div>`
  ).join('') || `<div style="color:var(--text-dim);font-size:.75rem">${sprint ? 'No backlog tasks' : 'Start a sprint to pull tasks'}</div>`;

  document.getElementById('plan-sprint').innerHTML = sprintTasks.map(t =>
    `<div class="plan-card"><div class="plan-card__info"><span class="plan-card__type">${escHtml(t.type)}</span><span class="plan-card__title">${escHtml(t.text)}</span>${t.owner ? `<span class="plan-card__owner">${escHtml(t.owner)}</span>` : ''}</div><button data-unpull="${t.id}">← Back</button></div>`
  ).join('') || '<div style="color:var(--text-dim);font-size:.75rem">Pull tasks from backlog</div>';

  document.getElementById('sprint-count').textContent = sprintTasks.length;
  checkScope();
}

document.getElementById('plan-backlog')?.addEventListener('click', e => {
  const btn = e.target.closest('[data-pull]');
  if (btn && sprint) { const t = tasks.find(x => x.id === +btn.dataset.pull); if (t) { t.sprintId = sprint.id; t.col = 'selected'; save(); renderPlanning(); renderBoard(); logEvent('Pulled: ' + t.text); } }
  const tbBtn = e.target.closest('[data-toobig]');
  if (tbBtn) { const t = tasks.find(x => x.id === +tbBtn.dataset.toobig); if (t) { t.tooBig = true; save(); renderPlanning(); } }
});
document.getElementById('plan-sprint')?.addEventListener('click', e => {
  const btn = e.target.closest('[data-unpull]');
  if (btn) { const t = tasks.find(x => x.id === +btn.dataset.unpull); if (t) { t.sprintId = null; t.col = 'backlog'; save(); renderPlanning(); renderBoard(); } }
});

function checkScope() {
  const warn = document.getElementById('scope-warn');
  if (!warn) return;
  if (!sprint) { warn.hidden = true; return; }
  const count = tasks.filter(t => t.sprintId === sprint.id && t.col !== 'cut').length;
  warn.hidden = count <= SCOPE_LIMITS[sprint.mode];
}

// ===== BOARD (items 2,12) =====
function renderBoard() {
  const grid = document.getElementById('board-grid');
  if (!grid) return; // board UI removed (informational now)
  if (!sprint) { grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-dim)">Start a sprint to activate the board.</div>'; return; }
  const sprintTasks = tasks.filter(t => t.sprintId === sprint.id);
  grid.innerHTML = BOARD_COLS.map(col => {
    const items = sprintTasks.filter(t => t.col === col);
    return `<div class="board__col"><div class="board__col-header"><span class="board__col-dot" style="background:${COL_COLORS[col]}"></span>${COL_LABELS[col]}<span class="board__col-count">${items.length}</span></div><div class="board__cards">${items.map(t => renderTaskCard(t, col)).join('')}</div></div>`;
  }).join('');
}

function renderTaskCard(t, col) {
  const ci = BOARD_COLS.indexOf(col);
  const left = ci > 0 ? `<button data-mv="${t.id}" data-dir="l" aria-label="Move left">←</button>` : '';
  const right = ci < BOARD_COLS.length - 1 ? `<button data-mv="${t.id}" data-dir="r" aria-label="Move right">→</button>` : '';
  const blocker = t.blockedReason ? `<span class="task-card__blocker">BLOCKED: ${escHtml(t.blockedReason)}</span>` : '';
  return `<div class="task-card"><span class="task-card__type">${escHtml(t.type)}</span>${escHtml(t.text)}${t.owner ? `<span class="task-card__owner">${escHtml(t.owner)}</span>` : ''}${blocker}<div class="task-card__actions">${left}${right}<button class="del-btn" data-del="${t.id}" aria-label="Delete task">×</button><button data-block="${t.id}" aria-label="Toggle blocker">🚫</button></div></div>`;
}

document.getElementById('board-grid')?.addEventListener('click', e => {
  const mv = e.target.closest('[data-mv]');
  if (mv) {
    const t = tasks.find(x => x.id === +mv.dataset.mv);
    if (!t) return;
    const ci = BOARD_COLS.indexOf(t.col);
    const ni = mv.dataset.dir === 'l' ? ci - 1 : ci + 1;
    if (ni < 0 || ni >= BOARD_COLS.length) return;
    t.col = BOARD_COLS[ni];
    save(); renderBoard(); logEvent(`Moved "${t.text}" → ${COL_LABELS[t.col]}`);
  }
  const del = e.target.closest('[data-del]');
  if (del) { tasks = tasks.filter(t => t.id !== +del.dataset.del); save(); renderBoard(); renderPlanning(); }
  const block = e.target.closest('[data-block]');
  if (block) {
    const t = tasks.find(x => x.id === +block.dataset.block);
    if (t) { const r = prompt('Blocker reason (leave empty to clear):', t.blockedReason || ''); t.blockedReason = r || ''; save(); renderBoard(); if (r) logEvent('Blocked: ' + t.text + ' — ' + r); }
  }
});

// ===== STANDUP (items 10,11) =====
document.getElementById('su-submit').addEventListener('click', () => {
  if (!sprint) return;
  const entry = {
    who: document.getElementById('su-who').value || 'Unknown',
    progress: document.getElementById('su-progress').value,
    next: document.getElementById('su-next').value,
    blockers: document.getElementById('su-blockers').value,
    time: new Date().toISOString()
  };
  sprint.standups.push(entry);
  save();
  logEvent('Standup recorded: ' + entry.who);
  document.getElementById('su-progress').value = '';
  document.getElementById('su-next').value = '';
  document.getElementById('su-blockers').value = '';
  renderStandups();
});

function renderStandups() {
  const log = document.getElementById('standup-log');
  const entries = sprint?.standups || [];
  log.innerHTML = entries.map(e => `<div class="standup-entry"><div class="standup-entry__header">${escHtml(e.who)} · ${new Date(e.time).toLocaleTimeString()}</div><div class="standup-entry__item"><div class="standup-entry__label">Progress</div><div class="standup-entry__text">${escHtml(e.progress) || '—'}</div></div><div class="standup-entry__item"><div class="standup-entry__label">Next</div><div class="standup-entry__text">${escHtml(e.next) || '—'}</div></div>${e.blockers ? `<div class="standup-entry__item"><div class="standup-entry__label">Blockers</div><div class="standup-entry__text">${escHtml(e.blockers)}</div></div>` : ''}</div>`).reverse().join('');
}

// ===== FACILITATOR (item 13) =====
function renderFacilitator() {
  const phase = sprint?.phase || 'planning';
  const prompts = FAC_PROMPTS[phase] || FAC_PROMPTS.planning;
  document.getElementById('facilitator-prompts').innerHTML = prompts.map(q => `<div class="fac-card"><div class="fac-card__phase">${PHASE_LABELS[phase]}</div><div class="fac-card__q">${q}</div></div>`).join('');
}

// ===== REVIEW (item 24) =====
document.getElementById('checklist').addEventListener('change', () => {
  const n = document.querySelectorAll('#checklist input:checked').length;
  document.getElementById('review-progress').textContent = `${n} / 6 verified`;
});

// ===== RETRO REPORT (items 16,18,40) =====
const RETRO_FIELDS = ['retro-well','retro-improve','retro-experiment','retro-actions','retro-carryover'];
function updateRetro() {
  const goal = document.getElementById('c-goal').value.trim() || '(not set)';
  const shipped = document.getElementById('r-shipped-desc')?.value || '';
  const demoLink = document.getElementById('r-demo-link')?.value || '';
  let md = `# Microsprint Report\n\n## Mode\n${currentMode} (${DURATIONS[currentMode]} min)\n\n## Sprint Goal\n${goal}\n\n## Shipped\n${shipped}\n\n## Demo\n${demoLink}\n\n`;
  const retroLabels = { 'retro-well':'What Went Well','retro-improve':'Improve Next Sprint','retro-experiment':'Process Experiment','retro-actions':'Action Items','retro-carryover':'Carry-Over' };
  RETRO_FIELDS.forEach(f => md += `## ${retroLabels[f]}\n${document.getElementById(f).value || '(none)'}\n\n`);

  // Increment summary (item 18)
  if (sprint) {
    const done = tasks.filter(t => t.sprintId === sprint.id && t.col === 'verified');
    if (done.length) md += `## Increment\n${done.map(t => `- [${t.type}] ${t.text}`).join('\n')}\n\n`;
  }
  document.getElementById('retro-output').textContent = md;
}
RETRO_FIELDS.forEach(f => document.getElementById(f).addEventListener('input', updateRetro));
['r-shipped-desc','r-demo-link','c-goal'].forEach(f => document.getElementById(f)?.addEventListener('input', updateRetro));
updateRetro();

// ===== HISTORY + METRICS (items 27,28) =====
function renderHistory() {
  const metrics = document.getElementById('metrics');
  const total = history.length;
  const allTasks = history.flatMap(h => h.tasks || []);
  const done = allTasks.filter(t => t.col === 'verified').length;
  const carried = allTasks.filter(t => t.col !== 'verified' && t.col !== 'cut').length;
  const blocked = allTasks.filter(t => t.blockedReason).length;

  if (total === 0) {
    metrics.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:20px;color:var(--text-dim);font-size:.85rem">Complete your first sprint to see metrics here.</div>';
  } else {
    metrics.innerHTML = `<div class="metric-card"><div class="metric-card__num">${total}</div><div class="metric-card__label">Sprints</div></div><div class="metric-card"><div class="metric-card__num">${done}</div><div class="metric-card__label">Completed</div></div><div class="metric-card"><div class="metric-card__num">${carried}</div><div class="metric-card__label">Carried Over</div></div><div class="metric-card"><div class="metric-card__num">${blocked}</div><div class="metric-card__label">Blockers</div></div>`;
  }

  document.getElementById('history-list').innerHTML = history.slice().reverse().map(h => {
    const d = h.tasks?.filter(t => t.col === 'verified').length || 0;
    const t = h.tasks?.length || 0;
    return `<div class="hist-card"><div class="hist-card__left"><div class="hist-card__goal">${escHtml(h.goal)}</div><div class="hist-card__meta">${escHtml(h.mode)} · ${new Date(h.startTime).toLocaleDateString()}</div></div><div class="hist-card__stats"><span class="hist-card__stat--done">${d}✓</span><span>${t} total</span></div></div>`;
  }).join('') || '<div style="color:var(--text-dim);font-size:.8rem">No sprints yet</div>';

  // Next sprint recommendation (item 30)
  const backlog = tasks.filter(t => !t.sprintId && t.col === 'backlog');
  const lastRetro = history.length ? history[history.length - 1].retroNotes : null;
  let rec = '<h3>Next Sprint</h3>';
  if (backlog.length) rec += `<p><strong>${backlog.length} tasks</strong> in backlog ready for the next sprint.</p>`;
  if (lastRetro?.actions) rec += `<p>Retro actions: ${escHtml(lastRetro.actions)}</p>`;
  if (!backlog.length && !lastRetro) rec += '<p>Backlog is empty. Add tasks to get started.</p>';
  document.getElementById('next-rec').innerHTML = rec;
}

// ===== EVENT LOG (item 25) =====
function renderEventLog() {
  document.getElementById('event-log').innerHTML = eventLog.map(e => `<div class="log-entry"><span>${new Date(e.time).toLocaleTimeString()}</span> ${escHtml(e.msg)}</div>`).reverse().join('');
}
document.getElementById('log-toggle').addEventListener('click', function() { const el = document.getElementById('event-log'); el.hidden = !el.hidden; this.setAttribute('aria-expanded', !el.hidden); });

// ===== THEORY =====
// Learn drawer (consolidated educational content)
document.getElementById('learn-toggle')?.addEventListener('click', function() { const b = document.getElementById('learn-body'); b.hidden = !b.hidden; this.textContent = b.hidden ? 'Learn: Scrum concepts, operating model, failure modes' : 'Hide learning content'; this.setAttribute('aria-expanded', !b.hidden); });

// ===== RENDER ALL =====
function renderAll() {
  toggleSprintSections();
  renderTimeline();
  renderPlanning();
  renderBoard();
  renderStandups();
  renderFacilitator();
  renderHistory();
  renderEventLog();
  updateRetro();
  updateTopbar();
  checkScope();
}

// ===== SCRUM MASTER SCRIPT TOGGLE =====
document.getElementById('sm-script-toggle')?.addEventListener('click', function() {
  const b = document.getElementById('sm-script-body');
  b.hidden = !b.hidden;
  this.textContent = b.hidden ? 'Scrum Master Script (click to expand)' : 'Scrum Master Script (click to collapse)';
});

// ===== FULLSCREEN TIMER MODAL =====
const PLAN_TIPS = ['Pick one clear goal.', 'Choose a tiny sprint backlog.', 'Define what done means.'];
const BUILD_TIPS = ['Work the smallest useful slice.', 'Keep scope from growing.', 'Capture proof as you go.'];
const REVIEW_TIPS = ['Demo the increment.', 'Show output, not effort.', 'Decide what feedback changes next.'];
const RETRO_TIPS = ['Name one thing that worked.', 'Name one thing that slowed you down.', 'Choose one change for the next hour.'];

const TM_PHASES = {
  spike: [
    { name: 'Plan', duration: 180, tips: PLAN_TIPS },
    { name: 'Build', duration: 1020, tips: BUILD_TIPS },
    { name: 'Review', duration: 300, tips: REVIEW_TIPS },
    { name: 'Retro', duration: 300, tips: RETRO_TIPS }
  ],
  build: [
    { name: 'Plan', duration: 300, tips: PLAN_TIPS },
    { name: 'Build', duration: 2700, tips: BUILD_TIPS },
    { name: 'Review', duration: 300, tips: REVIEW_TIPS },
    { name: 'Retro', duration: 300, tips: RETRO_TIPS }
  ],
  ship: [
    { name: 'Plan', duration: 600, tips: PLAN_TIPS },
    { name: 'Build', duration: 4800, tips: BUILD_TIPS },
    { name: 'Review', duration: 1200, tips: REVIEW_TIPS },
    { name: 'Retro', duration: 600, tips: RETRO_TIPS }
  ]
};

const tmState = {
  phaseIndex: 0,
  elapsed: 0,
  running: false,
  phases: TM_PHASES[currentMode]
};
let tmInterval = null;

function tmCurrentPhase() { return tmState.phases[tmState.phaseIndex]; }
function tmTotalDuration() { return tmState.phases.reduce((s, p) => s + p.duration, 0); }
function tmElapsedBefore() { return tmState.phases.slice(0, tmState.phaseIndex).reduce((s, p) => s + p.duration, 0); }

function tmFormatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m + ':' + String(s).padStart(2, '0');
}

function tmRender() {
  const phase = tmCurrentPhase();
  const remaining = Math.max(0, phase.duration - tmState.elapsed);

  // Countdown
  document.getElementById('tm-countdown').textContent = tmFormatTime(remaining);

  // Phase pill
  const pill = document.getElementById('tm-phase-pill');
  pill.textContent = phase.name;
  pill.dataset.phase = phase.name.toLowerCase();

  // Phase progress
  const phasePct = phase.duration > 0 ? Math.min(100, (tmState.elapsed / phase.duration) * 100) : 0;
  document.getElementById('tm-phase-progress').style.width = phasePct + '%';

  // Total progress
  const totalDur = tmTotalDuration();
  const totalElapsed = tmElapsedBefore() + tmState.elapsed;
  const totalPct = Math.min(100, (totalElapsed / totalDur) * 100);
  document.getElementById('tm-total-progress').style.width = totalPct + '%';
  const totalLabel = document.getElementById('tm-total-label');
  if (totalLabel) totalLabel.textContent = Math.round(totalDur / 60) + ' min';

  // Phase buttons
  document.querySelectorAll('.tm-phase-btn').forEach((btn, i) => {
    btn.classList.remove('tm-phase-btn--active', 'tm-phase-btn--completed');
    if (i === tmState.phaseIndex) btn.classList.add('tm-phase-btn--active');
    else if (i < tmState.phaseIndex) btn.classList.add('tm-phase-btn--completed');
  });

  // Start/Pause visibility
  document.getElementById('tm-start').hidden = tmState.running;
  document.getElementById('tm-pause').hidden = !tmState.running;
  document.getElementById('tm-start').textContent = tmState.elapsed > 0 ? 'Resume' : 'Start';

  // Tips
  const tipsEl = document.getElementById('tm-tips');
  tipsEl.innerHTML = phase.tips.map(t => `<div class="timer-modal__tip">${t}</div>`).join('');
}

function tmTick() {
  if (!tmState.running) return;
  tmState.elapsed++;
  const phase = tmCurrentPhase();
  if (tmState.elapsed >= phase.duration) {
    // Auto-advance
    if (tmState.phaseIndex < tmState.phases.length - 1) {
      tmState.phaseIndex++;
      tmState.elapsed = 0;
    } else {
      tmState.running = false;
      if (tmInterval) { clearInterval(tmInterval); tmInterval = null; }
    }
  }
  tmRender();
}

function tmOpen() {
  document.getElementById('timer-modal').classList.add('open');
  document.getElementById('timer-modal').setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  tmRender();
  setTimeout(() => document.getElementById('timer-modal-close')?.focus(), 100);
}

function tmClose() {
  tmState.running = false;
  if (tmInterval) { clearInterval(tmInterval); tmInterval = null; }
  document.getElementById('timer-modal').classList.remove('open');
  document.getElementById('timer-modal').setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  document.getElementById('launch-timer-btn')?.focus();
}

document.getElementById('launch-timer-btn').addEventListener('click', tmOpen);
document.getElementById('timer-modal-close').addEventListener('click', tmClose);
document.getElementById('timer-modal-backdrop').addEventListener('click', tmClose);

document.getElementById('tm-start').addEventListener('click', () => {
  tmState.running = true;
  if (!tmInterval) tmInterval = setInterval(tmTick, 1000);
  tmRender();
});

document.getElementById('tm-pause').addEventListener('click', () => {
  tmState.running = false;
  tmRender();
});

document.getElementById('tm-reset').addEventListener('click', () => {
  tmState.running = false;
  tmState.phaseIndex = 0;
  tmState.elapsed = 0;
  if (tmInterval) { clearInterval(tmInterval); tmInterval = null; }
  tmRender();
});

document.getElementById('tm-prev').addEventListener('click', () => {
  if (tmState.phaseIndex > 0) {
    tmState.phaseIndex--;
    tmState.elapsed = 0;
    tmRender();
  }
});

document.getElementById('tm-next').addEventListener('click', () => {
  if (tmState.phaseIndex < tmState.phases.length - 1) {
    tmState.phaseIndex++;
    tmState.elapsed = 0;
    tmRender();
  }
});

document.getElementById('tm-phases').addEventListener('click', e => {
  const btn = e.target.closest('[data-tmphase]');
  if (btn) {
    tmState.phaseIndex = parseInt(btn.dataset.tmphase, 10);
    tmState.elapsed = 0;
    tmRender();
  }
});

// Close on Escape key
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('timer-modal').classList.contains('open')) {
    tmClose();
  }
});

// Initial render of timer
tmRender();

// ===== FULL PERSISTENCE LAYER =====
// All form inputs, mode, toggles, checkboxes, and timer state are saved to localStorage

const PERSIST_INPUTS = [
  'project-a','c-goal-a','c-dod-a','c-nongoals-a','c-risk-a','c-impl-a',
  'project-b','c-goal-b','c-dod-b','c-nongoals-b','c-risk-b','c-impl-b',
  'retro-experiment',
  'retro-well-a','retro-improve-a','retro-actions-a','retro-carryover-a',
  'retro-well-b','retro-improve-b','retro-actions-b','retro-carryover-b'
];

const PERSIST_KEY = 'ms-form-state';

function saveFormState() {
  const state = {};
  PERSIST_INPUTS.forEach(id => { const el = document.getElementById(id); if (el) state[id] = el.value; });
  state.mode = currentMode;
  state.strict = document.getElementById('strict-toggle')?.checked || false;
  state.checklist = Array.from(document.querySelectorAll('#checklist input')).map(i => i.checked);
  state.learnOpen = !document.getElementById('learn-body')?.hidden;
  state.logOpen = !document.getElementById('event-log')?.hidden;
  SS(PERSIST_KEY, state);
}

function loadFormState() {
  const state = LS(PERSIST_KEY);
  if (!state) return;
  PERSIST_INPUTS.forEach(id => { const el = document.getElementById(id); if (el && state[id] !== undefined) el.value = state[id]; });
  if (state.mode && TIMELINES[state.mode]) setMode(state.mode);
  const strict = document.getElementById('strict-toggle');
  if (strict && state.strict !== undefined) strict.checked = state.strict;
  if (Array.isArray(state.checklist)) {
    document.querySelectorAll('#checklist input').forEach((cb, i) => { if (state.checklist[i]) cb.checked = true; });
    const n = document.querySelectorAll('#checklist input:checked').length;
    document.getElementById('review-progress').textContent = `${n} / 6 verified`;
  }
  if (state.learnOpen) { document.getElementById('learn-body').hidden = false; document.getElementById('learn-toggle')?.setAttribute('aria-expanded', 'true'); }
  if (state.logOpen) { document.getElementById('event-log').hidden = false; document.getElementById('log-toggle')?.setAttribute('aria-expanded', 'true'); }
  // Refresh derived UI
  updateOwnerSelects();
  updatePrompt();
  updateRetro();
}

// Attach auto-save to all persisted inputs
PERSIST_INPUTS.forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', saveFormState);
});
document.getElementById('strict-toggle')?.addEventListener('change', saveFormState);
document.getElementById('checklist')?.addEventListener('change', saveFormState);
document.querySelectorAll('.mode-card').forEach(c => c.addEventListener('click', saveFormState));
document.getElementById('learn-toggle')?.addEventListener('click', saveFormState);
document.getElementById('log-toggle')?.addEventListener('click', saveFormState);

// Persist timer modal state
const TM_KEY = 'ms-timer-state';
function saveTmState() { SS(TM_KEY, { phaseIndex: tmState.phaseIndex, elapsed: tmState.elapsed, running: false }); }
function loadTmState() {
  const s = LS(TM_KEY);
  if (s && typeof s.phaseIndex === 'number') {
    tmState.phaseIndex = Math.min(s.phaseIndex, tmState.phases.length - 1);
    tmState.elapsed = s.elapsed || 0;
    tmRender();
  }
}
['tm-start','tm-pause','tm-reset','tm-prev','tm-next'].forEach(id => document.getElementById(id)?.addEventListener('click', () => setTimeout(saveTmState, 50)));
document.getElementById('tm-phases')?.addEventListener('click', () => setTimeout(saveTmState, 50));

// ===== PREVIOUS REPORTS MODAL =====
function renderReportsModal() {
  const body = document.getElementById('reports-modal-body');
  if (!body) return;
  if (history.length === 0) {
    body.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:40px">No completed sprints yet. Finish a sprint and close it to see reports here.</div>';
    return;
  }
  body.innerHTML = history.slice().reverse().map(h => {
    const date = new Date(h.startTime).toLocaleString();
    const les = h.retroNotes?.les || {};
    const mattis = h.retroNotes?.mattis || {};
    const renderPerson = (cls, name, data) => `<div class="report-item__person ${cls}"><div class="report-item__person-name">${name}</div>${['well','improve','actions','carryover'].map(f => data[f] ? `<div class="report-item__field"><div class="report-item__field-label">${f}</div><div class="report-item__field-text">${escHtml(data[f])}</div></div>` : '').join('')}</div>`;
    return `<div class="report-item"><div class="report-item__header"><div class="report-item__goal">${escHtml(h.goal)}</div><div class="report-item__date">${escHtml(h.mode)} · ${date}</div></div>${les.well || les.improve || les.actions || les.carryover ? renderPerson('', 'Les', les) : ''}${mattis.well || mattis.improve || mattis.actions || mattis.carryover ? renderPerson('report-item__person--mattis', 'Mattis', mattis) : ''}${h.retroNotes?.experiment ? `<div class="report-item__field" style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border2)"><div class="report-item__field-label">Process experiment</div><div class="report-item__field-text">${escHtml(h.retroNotes.experiment)}</div></div>` : ''}</div>`;
  }).join('');
}

document.getElementById('view-reports-btn')?.addEventListener('click', () => {
  renderReportsModal();
  const m = document.getElementById('reports-modal');
  m.classList.add('open');
  m.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
});
function closeReportsModal() {
  const m = document.getElementById('reports-modal');
  m.classList.remove('open');
  m.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}
document.getElementById('reports-modal-close')?.addEventListener('click', closeReportsModal);
document.getElementById('reports-modal-backdrop')?.addEventListener('click', closeReportsModal);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && document.getElementById('reports-modal').classList.contains('open')) closeReportsModal(); });

// Clear-all utility (exposed for debugging via console)
window.msResetAll = function() {
  if (!confirm('Clear ALL Microsprint data (sprints, tasks, history, forms)?')) return;
  ['ms-sprint','ms-tasks','ms-history','ms-log','ms-form-state','ms-timer-state'].forEach(k => localStorage.removeItem(k));
  location.reload();
};

// ===== INIT =====
loadFormState();
loadTmState();
if (sprint && sprint.phase !== 'completed') {
  activateSprint();
} else {
  renderAll();
}

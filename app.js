// ===== STATE =====
const LS = k => JSON.parse(localStorage.getItem(k) || 'null');
const SS = (k, v) => localStorage.setItem(k, JSON.stringify(v));

let sprint = LS('ms-sprint') || null;
let tasks = LS('ms-tasks') || [];
let history = LS('ms-history') || [];
let eventLog = LS('ms-log') || [];
let tid = tasks.length ? Math.max(...tasks.map(t => t.id)) + 1 : 1;
let currentMode = sprint?.mode || 'build';
let timerInterval = null;

function save() { SS('ms-sprint', sprint); SS('ms-tasks', tasks); SS('ms-history', history); SS('ms-log', eventLog); }

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
}
document.querySelectorAll('.mode-card').forEach(c => c.addEventListener('click', () => setMode(c.dataset.mode)));

// ===== TEMPLATES =====
document.querySelectorAll('.templates__btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const t = TEMPLATES[btn.dataset.tpl];
    if (!t) return;
    document.getElementById('c-goal').value = t.goal;
    document.getElementById('c-nongoals').value = t.nongoals;
    document.getElementById('c-dod').value = t.dod;
    document.getElementById('c-risk').value = t.risk;
    updatePrompt();
  });
});

// DoD preset (item 20)
document.getElementById('dod-preset-btn').addEventListener('click', () => {
  document.getElementById('c-dod').value = 'Usable by teammate, tested or intentionally waived, proof attached, next step obvious.';
  updatePrompt();
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

// ===== OWNER SELECTS =====
function updateOwnerSelects() {
  const a = document.getElementById('person-a').value || 'Person A';
  const b = document.getElementById('person-b').value || 'Person B';
  [document.getElementById('task-owner'), document.getElementById('su-who')].forEach(sel => {
    sel.innerHTML = `<option value="">Unassigned</option><option value="${a}">${a}</option><option value="${b}">${b}</option>`;
  });
}
['person-a', 'person-b'].forEach(id => document.getElementById(id).addEventListener('input', updateOwnerSelects));
updateOwnerSelects();

// ===== SPRINT LIFECYCLE (items 1,4,25,26) =====
function logEvent(msg) {
  const entry = { time: new Date().toISOString(), msg };
  eventLog.push(entry);
  save();
  renderEventLog();
}

document.getElementById('start-sprint-btn').addEventListener('click', () => {
  const goal = document.getElementById('c-goal').value.trim();
  if (!goal) { document.getElementById('c-goal').focus(); return; }
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
  document.getElementById('retro').scrollIntoView({ behavior: 'smooth' });
  updateTopbar();
});

// Close & archive (items 29,39)
document.getElementById('close-sprint-btn').addEventListener('click', () => {
  if (!sprint) return;
  sprint.endTime = Date.now();
  sprint.retroNotes = {
    well: document.getElementById('retro-well').value,
    improve: document.getElementById('retro-improve').value,
    experiment: document.getElementById('retro-experiment').value,
    actions: document.getElementById('retro-actions').value,
    carryover: document.getElementById('retro-carryover').value,
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
  sprint = null;
  eventLog = [];
  save();
  document.body.classList.remove('sprint-active');
  document.getElementById('topbar').hidden = true;
  if (timerInterval) clearInterval(timerInterval);
  renderAll();
  logEvent('Sprint archived');
});

// ===== PROMPT GENERATOR =====
const PROMPT_FIELDS = ['c-goal','c-user','c-context','c-nongoals','c-dod','c-demo','c-risk'];
const PROMPT_LABELS = { 'c-goal':'Sprint Goal','c-user':'User / Customer','c-context':'Context','c-nongoals':'Non-goals','c-dod':'Definition of Done','c-demo':'Demo Moment','c-risk':'Main Risk' };

function updatePrompt() {
  const v = {};
  PROMPT_FIELDS.forEach(f => v[f] = document.getElementById(f).value.trim() || '(not specified)');
  const strict = document.getElementById('strict-toggle').checked;
  const dur = DURATIONS[currentMode];
  let txt = `We are running a ${dur}-minute Claude Code microsprint.\n\n`;
  PROMPT_FIELDS.forEach(f => txt += `${PROMPT_LABELS[f]}:\n${v[f]}\n\n`);
  txt += `Working Rules:\n1. First inspect the relevant files and summarize what you found.\n2. Propose a short implementation plan before editing.\n3. Keep the scope tight and aligned to the sprint goal.\n4. Do not modify unrelated files.\n5. Prefer simple, reversible changes.\n6. After implementation, run the most relevant checks available.\n7. End with a concise summary of files changed, validation results, risks, and recommended next steps.\n`;
  if (strict) txt += `\nStrict Mode:\n- Ask before making broad architectural changes.\n- Do not introduce new dependencies unless absolutely necessary.\n- Do not refactor unrelated code.\n- Stop and report if the task appears larger than ${dur} minutes.\n`;
  txt += `\nDeliverables:\n- Working implementation or prototype\n- Validation notes\n- Demo instructions\n- Follow-up tasks`;
  document.getElementById('prompt-output').textContent = txt;
}
PROMPT_FIELDS.forEach(f => document.getElementById(f).addEventListener('input', updatePrompt));
document.getElementById('strict-toggle').addEventListener('change', updatePrompt);
updatePrompt();

function copyBtn(btnId, textId) {
  document.getElementById(btnId).addEventListener('click', function() {
    navigator.clipboard.writeText(document.getElementById(textId).textContent);
    this.textContent = 'Copied!'; this.classList.add('copied');
    setTimeout(() => { this.textContent = btnId.includes('retro') ? 'Copy Report' : 'Copy Prompt'; this.classList.remove('copied'); }, 1200);
  });
}
copyBtn('copy-prompt', 'prompt-output');
copyBtn('copy-retro', 'retro-output');

// ===== TASK MANAGEMENT =====
document.getElementById('add-task-btn').addEventListener('click', addTask);
document.getElementById('task-title').addEventListener('keydown', e => { if (e.key === 'Enter') addTask(); });

function addTask() {
  const text = document.getElementById('task-title').value.trim();
  if (!text) return;
  tasks.push({
    id: tid++, text, type: document.getElementById('task-type').value,
    owner: document.getElementById('task-owner').value,
    sprintId: null, col: 'backlog', blockedReason: '', tooBig: false
  });
  document.getElementById('task-title').value = '';
  save(); renderPlanning(); renderBoard();
}

// ===== PLANNING (items 6,7,9,22,23) =====
function renderPlanning() {
  const backlog = tasks.filter(t => !t.sprintId && t.col === 'backlog');
  const sprintTasks = tasks.filter(t => sprint && t.sprintId === sprint.id);

  document.getElementById('plan-backlog').innerHTML = backlog.map(t =>
    `<div class="plan-card"><div class="plan-card__info"><span class="plan-card__type">${t.type}</span><span class="plan-card__title">${t.text}</span>${t.owner ? `<span class="plan-card__owner">${t.owner}</span>` : ''}${t.tooBig ? '<span class="plan-card__toobig">TOO BIG</span>' : ''}</div><div><button data-pull="${t.id}">Pull →</button>${!t.tooBig ? `<button data-toobig="${t.id}">⚠</button>` : ''}</div></div>`
  ).join('') || '<div style="color:var(--text-dim);font-size:.75rem">No backlog tasks</div>';

  document.getElementById('plan-sprint').innerHTML = sprintTasks.map(t =>
    `<div class="plan-card"><div class="plan-card__info"><span class="plan-card__type">${t.type}</span><span class="plan-card__title">${t.text}</span>${t.owner ? `<span class="plan-card__owner">${t.owner}</span>` : ''}</div><button data-unpull="${t.id}">← Back</button></div>`
  ).join('') || '<div style="color:var(--text-dim);font-size:.75rem">Pull tasks from backlog</div>';

  document.getElementById('sprint-count').textContent = sprintTasks.length;
  checkScope();
}

document.getElementById('plan-backlog').addEventListener('click', e => {
  const btn = e.target.closest('[data-pull]');
  if (btn && sprint) { const t = tasks.find(x => x.id === +btn.dataset.pull); if (t) { t.sprintId = sprint.id; t.col = 'selected'; save(); renderPlanning(); renderBoard(); logEvent('Pulled: ' + t.text); } }
  const tbBtn = e.target.closest('[data-toobig]');
  if (tbBtn) { const t = tasks.find(x => x.id === +tbBtn.dataset.toobig); if (t) { t.tooBig = true; save(); renderPlanning(); } }
});
document.getElementById('plan-sprint').addEventListener('click', e => {
  const btn = e.target.closest('[data-unpull]');
  if (btn) { const t = tasks.find(x => x.id === +btn.dataset.unpull); if (t) { t.sprintId = null; t.col = 'backlog'; save(); renderPlanning(); renderBoard(); } }
});

function checkScope() {
  if (!sprint) { document.getElementById('scope-warn').hidden = true; return; }
  const count = tasks.filter(t => t.sprintId === sprint.id && t.col !== 'cut').length;
  document.getElementById('scope-warn').hidden = count <= SCOPE_LIMITS[sprint.mode];
}

// ===== BOARD (items 2,12) =====
function renderBoard() {
  const grid = document.getElementById('board-grid');
  const sprintTasks = sprint ? tasks.filter(t => t.sprintId === sprint.id) : [];
  grid.innerHTML = BOARD_COLS.map(col => {
    const items = sprintTasks.filter(t => t.col === col);
    return `<div class="board__col"><div class="board__col-header"><span class="board__col-dot" style="background:${COL_COLORS[col]}"></span>${COL_LABELS[col]}<span class="board__col-count">${items.length}</span></div><div class="board__cards">${items.map(t => renderTaskCard(t, col)).join('')}</div></div>`;
  }).join('');
}

function renderTaskCard(t, col) {
  const ci = BOARD_COLS.indexOf(col);
  const left = ci > 0 ? `<button data-mv="${t.id}" data-dir="l">←</button>` : '';
  const right = ci < BOARD_COLS.length - 1 ? `<button data-mv="${t.id}" data-dir="r">→</button>` : '';
  const blocker = t.blockedReason ? `<span class="task-card__blocker">BLOCKED: ${t.blockedReason}</span>` : '';
  return `<div class="task-card"><span class="task-card__type">${t.type}</span>${t.text}${t.owner ? `<span class="task-card__owner">${t.owner}</span>` : ''}${blocker}<div class="task-card__actions">${left}${right}<button class="del-btn" data-del="${t.id}">×</button><button data-block="${t.id}">🚫</button></div></div>`;
}

document.getElementById('board-grid').addEventListener('click', e => {
  const mv = e.target.closest('[data-mv]');
  if (mv) {
    const t = tasks.find(x => x.id === +mv.dataset.mv);
    if (!t) return;
    const ci = BOARD_COLS.indexOf(t.col);
    t.col = mv.dataset.dir === 'l' ? BOARD_COLS[ci - 1] : BOARD_COLS[ci + 1];
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
  log.innerHTML = entries.map(e => `<div class="standup-entry"><div class="standup-entry__header">${e.who} · ${new Date(e.time).toLocaleTimeString()}</div><div class="standup-entry__item"><div class="standup-entry__label">Progress</div><div class="standup-entry__text">${e.progress || '—'}</div></div><div class="standup-entry__item"><div class="standup-entry__label">Next</div><div class="standup-entry__text">${e.next || '—'}</div></div>${e.blockers ? `<div class="standup-entry__item"><div class="standup-entry__label">Blockers</div><div class="standup-entry__text">${e.blockers}</div></div>` : ''}</div>`).reverse().join('');
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

  metrics.innerHTML = `<div class="metric-card"><div class="metric-card__num">${total}</div><div class="metric-card__label">Sprints</div></div><div class="metric-card"><div class="metric-card__num">${done}</div><div class="metric-card__label">Completed</div></div><div class="metric-card"><div class="metric-card__num">${carried}</div><div class="metric-card__label">Carried Over</div></div><div class="metric-card"><div class="metric-card__num">${blocked}</div><div class="metric-card__label">Blockers</div></div>`;

  document.getElementById('history-list').innerHTML = history.slice().reverse().map(h => {
    const d = h.tasks?.filter(t => t.col === 'verified').length || 0;
    const t = h.tasks?.length || 0;
    return `<div class="hist-card"><div class="hist-card__left"><div class="hist-card__goal">${h.goal}</div><div class="hist-card__meta">${h.mode} · ${new Date(h.startTime).toLocaleDateString()}</div></div><div class="hist-card__stats"><span class="hist-card__stat--done">${d}✓</span><span>${t} total</span></div></div>`;
  }).join('') || '<div style="color:var(--text-dim);font-size:.8rem">No sprints yet</div>';

  // Next sprint recommendation (item 30)
  const backlog = tasks.filter(t => !t.sprintId && t.col === 'backlog');
  const lastRetro = history.length ? history[history.length - 1].retroNotes : null;
  let rec = '<h3>Next Sprint</h3>';
  if (backlog.length) rec += `<p><strong>${backlog.length} tasks</strong> in backlog ready for the next sprint.</p>`;
  if (lastRetro?.actions) rec += `<p>Retro actions: ${lastRetro.actions}</p>`;
  if (!backlog.length && !lastRetro) rec += '<p>Backlog is empty. Add tasks to get started.</p>';
  document.getElementById('next-rec').innerHTML = rec;
}

// ===== EVENT LOG (item 25) =====
function renderEventLog() {
  document.getElementById('event-log').innerHTML = eventLog.map(e => `<div class="log-entry"><span>${new Date(e.time).toLocaleTimeString()}</span> ${e.msg}</div>`).reverse().join('');
}
document.getElementById('log-toggle').addEventListener('click', () => { const el = document.getElementById('event-log'); el.hidden = !el.hidden; });

// ===== THEORY =====
document.getElementById('theory-toggle').addEventListener('click', function() { const b = document.getElementById('theory-body'); b.hidden = !b.hidden; this.textContent = b.hidden ? 'Why this works: Scrum concepts behind the microsprint' : 'Hide Scrum concepts'; });

// ===== RENDER ALL =====
function renderAll() {
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

// ===== INIT =====
if (sprint && sprint.phase !== 'completed') {
  activateSprint();
} else {
  renderAll();
}

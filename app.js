/* ============================================================
   Dream — your gym buddy
   Pure front-end app. All data lives in localStorage.
   ============================================================ */

const STORE_KEY = 'dream.v1';

/* ---------- Default state ---------- */
const defaultState = () => ({
  profile: {
    name: '', age: 25, sex: 'male', units: 'metric',
    height: 175, goalWeight: 70, activity: 1.55, goal: 'cut'
  },
  // days keyed by YYYY-MM-DD
  days: {},
  weights: [],            // [{date, kg}]
  stepGoal: 8000,         // daily step target
  social: { name: '', leagueCode: '', playerId: '' }, // friends leaderboard
  goalTemplate: ['Go to the gym 🏋️', 'Drink 3L of water 💧', 'Hit my protein target 🍗', '8h sleep 😴']
});

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return Object.assign(defaultState(), JSON.parse(raw));
  } catch (e) { /* ignore */ }
  return defaultState();
}
function save() {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
  // Push today's stats to the friends leaderboard (debounced, no-op if not in a league)
  if (window.Social && window.Social.onSave) window.Social.onSave();
}

/* ---------- Date helpers ---------- */
function ymd(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function parseYmd(s) { const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d); }
const TODAY = ymd();

/* ---------- Day record ---------- */
function getDay(key) {
  if (!state.days[key]) {
    state.days[key] = {
      goals: state.goalTemplate.map(g => ({ text: g, done: false, gym: /gym/i.test(g) })),
      food: [],   // {name, kcal, protein}
      burn: [],   // {name, kcal}
      steps: 0    // step count for the day
    };
  }
  return state.days[key];
}

/* ============================================================
   Calculations
   ============================================================ */
const toCm = h => state.profile.units === 'imperial' ? h * 2.54 : h;
const toKg = w => state.profile.units === 'imperial' ? w * 0.453592 : w;
const fromKg = w => state.profile.units === 'imperial' ? w / 0.453592 : w;
const wtUnit = () => state.profile.units === 'imperial' ? 'lb' : 'kg';
const lenUnit = () => state.profile.units === 'imperial' ? 'in' : 'cm';

function latestWeightKg() {
  if (!state.weights.length) return null;
  return state.weights[state.weights.length - 1].kg;
}

// Mifflin-St Jeor
function bmr() {
  const p = state.profile;
  const wKg = latestWeightKg();
  if (!wKg || !p.height || !p.age) return null;
  const hCm = toCm(p.height);
  const base = 10 * wKg + 6.25 * hCm - 5 * p.age;
  return Math.round(p.sex === 'male' ? base + 5 : base - 161);
}
function tdee() {
  const b = bmr();
  return b ? Math.round(b * state.profile.activity) : null;
}
function targetCalories() {
  const t = tdee();
  if (!t) return null;
  if (state.profile.goal === 'cut') return t - 500;
  if (state.profile.goal === 'bulk') return t + 350;
  return t;
}
function proteinTargetG() {
  const wKg = latestWeightKg();
  if (!wKg) return null;
  // 1.8 g/kg for cut/bulk, 1.6 for maintain
  const factor = state.profile.goal === 'maintain' ? 1.6 : 1.8;
  return Math.round(wKg * factor);
}
function bmi() {
  const wKg = latestWeightKg();
  const hCm = toCm(state.profile.height);
  if (!wKg || !hCm) return null;
  return wKg / Math.pow(hCm / 100, 2);
}
function bmiCategory(v) {
  if (v < 18.5) return 'Underweight';
  if (v < 25) return 'Healthy';
  if (v < 30) return 'Overweight';
  return 'Obese';
}
function healthyWeightRangeKg() {
  const hCm = toCm(state.profile.height);
  if (!hCm) return null;
  const m = hCm / 100;
  return [18.5 * m * m, 24.9 * m * m];
}

/* ============================================================
   Steps → calories & distance
   ============================================================ */
function stepsOf(key) { return (state.days[key] && state.days[key].steps) || 0; }
// Stride length from height (~0.415 × height), fallback 0.75 m
function strideM() {
  const hCm = toCm(state.profile.height);
  return hCm ? (hCm * 0.415) / 100 : 0.75;
}
// ~0.04 kcal/step for a 70 kg person, scaled by body weight
function stepKcalOf(key) {
  const wKg = latestWeightKg() || 70;
  return Math.round(stepsOf(key) * 0.00057 * wKg);
}
function stepKmOf(key) { return stepsOf(key) * strideM() / 1000; }

/* ============================================================
   Day energy totals
   ============================================================ */
function dayTotals(key) {
  const d = getDay(key);
  const calIn = d.food.reduce((s,f) => s + (+f.kcal || 0), 0);
  // calories out = logged burns + calories burned from steps
  const calOut = d.burn.reduce((s,b) => s + (+b.kcal || 0), 0) + stepKcalOf(key);
  const protein = d.food.reduce((s,f) => s + (+f.protein || 0), 0);
  return { calIn, calOut, protein, net: calIn - calOut };
}

/* ============================================================
   Streak (consecutive days incl. today/yesterday with gym done)
   ============================================================ */
function gymStreak() {
  let streak = 0;
  let cursor = new Date();
  // allow today to be incomplete without breaking streak
  const todayDone = isGymDone(ymd(cursor));
  if (!todayDone) cursor.setDate(cursor.getDate() - 1);
  for (let i = 0; i < 3650; i++) {
    if (isGymDone(ymd(cursor))) { streak++; cursor.setDate(cursor.getDate() - 1); }
    else break;
  }
  return streak;
}
function isGymDone(key) {
  const d = state.days[key];
  if (!d) return false;
  return d.goals.some(g => g.gym && g.done);
}
function dayStatus(key) {
  const d = state.days[key];
  if (!d) return 'none';
  const done = d.goals.filter(g => g.done).length;
  if (isGymDone(key)) return 'gym';
  if (done > 0) return 'partial';
  if (key < TODAY) return 'miss';
  return 'none';
}

/* ============================================================
   Motivational quotes
   ============================================================ */
const QUOTES = [
  "The body achieves what the mind believes.",
  "You don't have to be extreme, just consistent.",
  "Sweat is just fat crying.",
  "One workout at a time, one day at a time.",
  "Discipline beats motivation.",
  "Your only competition is who you were yesterday.",
  "Push yourself, because no one else will.",
  "Strong is the new goal."
];

/* ============================================================
   Rendering
   ============================================================ */
function el(id) { return document.getElementById(id); }

function render() {
  renderTopbar();
  renderReminder();
  renderGoals();
  renderDashboardNutrition();
  renderDashboardSteps();
  renderDashboardWeight();
  renderWeekStrip();
  el('streakNum').textContent = gymStreak();
  save();
}

/* ---------- Ring helper (radius 52 circles) ---------- */
function setRing(id, frac, color) {
  const ring = el(id);
  if (!ring) return;
  const C = 2 * Math.PI * 52;
  ring.style.strokeDasharray = C;
  ring.style.strokeDashoffset = C * (1 - Math.max(0, Math.min(1, frac)));
  if (color) ring.style.stroke = color;
}

/* ---------- Dashboard steps card ---------- */
function renderDashboardSteps() {
  const steps = stepsOf(TODAY);
  const goal = state.stepGoal || 8000;
  el('dashSteps').textContent = steps.toLocaleString();
  el('dashStepGoalSub').textContent = '/ ' + goal.toLocaleString();
  el('dashStepKcal').textContent = stepKcalOf(TODAY);
  el('dashStepKm').textContent = stepKmOf(TODAY).toFixed(1);
  setRing('stepRing', steps / goal, steps >= goal ? 'var(--accent-2)' : 'var(--accent)');
}

function renderTopbar() {
  const name = state.profile.name || 'champ';
  el('hello').textContent = `Hey ${name} 👋`;
  el('dateToday').textContent = new Date().toLocaleDateString(undefined,
    { weekday: 'long', month: 'long', day: 'numeric' });
  // stable-ish daily quote
  const idx = new Date().getDate() % QUOTES.length;
  el('quote').textContent = '“' + QUOTES[idx] + '”';
}

function renderReminder() {
  const banner = el('reminderBanner');
  const done = isGymDone(TODAY);
  if (done) {
    banner.classList.add('done');
    banner.querySelector('.reminder-icon').textContent = '✅';
    banner.querySelector('strong').textContent = 'Gym crushed today! 🎉';
    el('reminderSub').textContent = `That's a ${gymStreak()}-day streak. Keep the momentum going!`;
  } else {
    banner.classList.remove('done');
    banner.querySelector('.reminder-icon').textContent = '🏋️';
    banner.querySelector('strong').textContent = "Time to hit your goals!";
    el('reminderSub').textContent = "You haven't logged the gym yet today. Let's get that workout in!";
  }
}

/* ---------- Goals ---------- */
function renderGoals() {
  const day = getDay(TODAY);
  const list = el('goalList');
  list.innerHTML = '';
  day.goals.forEach((g, i) => {
    const li = document.createElement('li');
    li.className = 'goal-item' + (g.done ? ' done' : '') + (g.gym ? ' gym' : '');
    li.innerHTML = `
      <div class="goal-check">${g.done ? '✓' : ''}</div>
      <span class="goal-name">${escapeHtml(g.text)}</span>
      <button class="goal-del" title="Remove">✕</button>`;
    li.addEventListener('click', e => {
      if (e.target.classList.contains('goal-del')) return;
      g.done = !g.done; render(); renderCalendar(); renderDayDetail();
    });
    li.querySelector('.goal-del').addEventListener('click', e => {
      e.stopPropagation();
      day.goals.splice(i, 1); render();
    });
    list.appendChild(li);
  });
  const total = day.goals.length;
  const done = day.goals.filter(g => g.done).length;
  const pct = total ? Math.round(done / total * 100) : 0;
  el('goalProgress').style.width = pct + '%';
  el('goalProgressLabel').textContent = pct + '%';
}

/* ---------- Dashboard nutrition ring ---------- */
function renderDashboardNutrition() {
  const t = dayTotals(TODAY);
  el('dashCalIn').textContent = t.calIn;
  el('dashCalOut').textContent = t.calOut;
  el('dashProtein').textContent = t.protein + 'g';
  el('calNet').textContent = t.net;
  const target = targetCalories() || 2000;
  const frac = Math.max(0, Math.min(1, t.calIn / target));
  const ring = el('calRing');
  const C = 2 * Math.PI * 52;
  ring.style.strokeDasharray = C;
  ring.style.strokeDashoffset = C * (1 - frac);
  ring.style.stroke = t.calIn > target ? 'var(--out)' : 'var(--accent)';
}

/* ---------- Dashboard weight ---------- */
function renderDashboardWeight() {
  const w = latestWeightKg();
  if (w == null) {
    el('dashWeight').textContent = '—';
    el('dashWeightDelta').textContent = 'Log your first weigh-in →';
  } else {
    el('dashWeight').textContent = round1(fromKg(w));
    el('dashWeightUnit').textContent = wtUnit();
    const goalKg = toKg(state.profile.goalWeight);
    const diff = fromKg(w - goalKg);
    if (Math.abs(diff) < 0.1) el('dashWeightDelta').textContent = '🎯 At your goal weight!';
    else el('dashWeightDelta').textContent =
      `${Math.abs(round1(diff))} ${wtUnit()} ${diff > 0 ? 'to lose' : 'to gain'} to reach goal`;
  }
}

/* ---------- Week strip ---------- */
function renderWeekStrip() {
  const strip = el('weekStrip');
  strip.innerHTML = '';
  const now = new Date();
  const start = new Date(now); start.setDate(now.getDate() - now.getDay()); // Sunday
  const names = ['S','M','T','W','T','F','S'];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const key = ymd(d);
    const status = dayStatus(key);
    const icon = status === 'gym' ? '💪' : status === 'partial' ? '🔸' : status === 'miss' ? '·' : '○';
    const div = document.createElement('div');
    div.className = 'week-day' + (key === TODAY ? ' today' : '');
    div.innerHTML = `<div class="wd-name">${names[i]}</div><div class="wd-icon">${icon}</div><div class="wd-date">${d.getDate()}</div>`;
    strip.appendChild(div);
  }
}

/* ============================================================
   Steps view
   ============================================================ */
function renderSteps() {
  const steps = stepsOf(TODAY);
  const goal = state.stepGoal || 8000;
  const pct = Math.round(Math.min(100, steps / goal * 100));
  el('stepsBig').textContent = steps.toLocaleString();
  el('stepsGoalBig').textContent = 'of ' + goal.toLocaleString() + ' steps';
  el('stepKcal').textContent = stepKcalOf(TODAY);
  el('stepKm').textContent = stepKmOf(TODAY).toFixed(2);
  el('stepPct').textContent = pct + '%';
  setRing('stepRingBig', steps / goal, steps >= goal ? 'var(--accent-2)' : 'var(--accent)');
  el('stepGoalInput').value = goal;

  const pill = el('stepStatusPill');
  if (steps >= goal) { pill.textContent = 'Goal smashed! 🎉'; pill.className = 'balance-pill deficit'; }
  else { pill.textContent = (goal - steps).toLocaleString() + ' steps to go'; pill.className = 'balance-pill'; }

  el('notifStatus').textContent = notifStatusText();
  Pedometer.updateUI();
  renderStepChart();
}

function renderStepChart() {
  const chart = el('stepChart');
  if (!chart) return;
  chart.innerHTML = '';
  const now = new Date();
  const start = new Date(now); start.setDate(now.getDate() - now.getDay()); // Sunday
  const goal = state.stepGoal || 8000;
  let total = 0, count = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const key = ymd(d);
    const s = stepsOf(key);
    if (s > 0) { total += s; count++; }
    const bar = document.createElement('div');
    bar.className = 'chart-bar' + (s >= goal ? ' goal-hit' : '');
    bar.style.height = Math.max(4, Math.min(100, s / goal * 100)) + '%';
    bar.innerHTML = `<span>${s >= 1000 ? (s/1000).toFixed(1)+'k' : s}</span>`;
    bar.title = `${key}: ${s.toLocaleString()} steps`;
    chart.appendChild(bar);
  }
  el('stepWeekAvg').textContent = count
    ? `Average ${Math.round(total / count).toLocaleString()} steps/day this week.`
    : 'No step data yet this week.';
}

/* ---------- Mutating steps ---------- */
function setStepsToday(n) {
  getDay(TODAY).steps = Math.max(0, Math.round(n));
  checkStepGoal();
  save();
  render();
  if (el('view-steps').classList.contains('active')) renderSteps();
}
function addStepsToday(n) { setStepsToday(stepsOf(TODAY) + n); }

// Quiet increment used by the live pedometer (UI refresh is throttled)
function incStepQuiet() { const d = getDay(TODAY); d.steps = (d.steps || 0) + 1; }
let _stepUiTimer = null;
function refreshStepsThrottled() {
  if (_stepUiTimer) return;
  _stepUiTimer = setTimeout(() => {
    _stepUiTimer = null;
    checkStepGoal();
    save();
    renderDashboardSteps();
    if (el('view-steps').classList.contains('active')) renderSteps();
  }, 700);
}

// Celebrate (once/day) when the step goal is reached
function checkStepGoal() {
  const goal = state.stepGoal || 8000;
  const day = getDay(TODAY);
  if (stepsOf(TODAY) >= goal && !day.stepGoalCelebrated) {
    day.stepGoalCelebrated = true;
    notify('🎉 Step goal reached!', `You hit ${goal.toLocaleString()} steps today. Amazing work — keep that streak alive!`);
  }
}

/* ============================================================
   Pedometer — counts steps from the phone's motion sensor
   while Dream is open (best-effort on the web).
   ============================================================ */
const Pedometer = (function () {
  let active = false, lastPeak = 0, listener = null;
  function onMotion(e) {
    const a = e.accelerationIncludingGravity || e.acceleration;
    if (!a) return;
    const mag = Math.sqrt((a.x||0)**2 + (a.y||0)**2 + (a.z||0)**2);
    const now = +new Date();
    // peak above gravity baseline, debounced to ~max 3 steps/sec
    if (mag > 12.5 && (now - lastPeak) > 300) {
      lastPeak = now;
      incStepQuiet();
      refreshStepsThrottled();
    }
  }
  async function start() {
    if (typeof DeviceMotionEvent === 'undefined') {
      alert("This device/browser doesn't expose motion sensors, so auto-count isn't available. You can still add steps manually.");
      return;
    }
    // iOS 13+ requires explicit permission
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      try {
        const p = await DeviceMotionEvent.requestPermission();
        if (p !== 'granted') { alert('Motion permission was denied.'); return; }
      } catch (err) { alert('Could not access motion sensors.'); return; }
    }
    listener = onMotion;
    window.addEventListener('devicemotion', listener);
    active = true;
    updateUI();
  }
  function stop() {
    if (listener) window.removeEventListener('devicemotion', listener);
    listener = null; active = false;
    updateUI();
  }
  function updateUI() {
    const btn = el('autoStepBtn'), st = el('autoStepStatus');
    if (!btn || !st) return;
    btn.textContent = active ? '⏸ Stop auto-count' : '▶ Start auto-count';
    st.textContent = active ? 'Counting… keep Dream open' : 'Off';
    st.className = 'auto-step-status' + (active ? ' on' : '');
  }
  return { start, stop, updateUI, isActive: () => active };
})();

/* ============================================================
   Notifications — reminders + goal celebration
   (work while Dream is open or installed as a PWA)
   ============================================================ */
function notifSupported() { return 'Notification' in window; }
function notifStatusText() {
  if (!notifSupported()) return 'Not supported here';
  if (Notification.permission === 'granted') return 'On ✓';
  if (Notification.permission === 'denied') return 'Blocked (enable in browser settings)';
  return 'Not enabled';
}
async function enableNotifications() {
  if (!notifSupported()) { alert('This browser does not support notifications.'); return; }
  const p = await Notification.requestPermission();
  el('notifStatus').textContent = notifStatusText();
  if (p === 'granted') notify('Dream notifications on 🔔', "We'll cheer you toward your step goal!");
}
function notify(title, body) {
  if (!notifSupported() || Notification.permission !== 'granted') return;
  const opts = { body, icon: 'icon.svg', badge: 'icon.svg' };
  try {
    if (navigator.serviceWorker && navigator.serviceWorker.ready) {
      navigator.serviceWorker.ready.then(reg => reg.showNotification(title, opts)).catch(() => new Notification(title, opts));
    } else {
      new Notification(title, opts);
    }
  } catch (e) { /* ignore */ }
}
// Nudge once, after 6pm, if the goal isn't met yet (only while app/PWA is open)
function maybeRemind() {
  const goal = state.stepGoal || 8000;
  const day = getDay(TODAY);
  if (new Date().getHours() >= 18 && stepsOf(TODAY) < goal && !day.stepReminded) {
    day.stepReminded = true;
    save();
    notify('👟 Step goal reminder', `You're at ${stepsOf(TODAY).toLocaleString()} / ${goal.toLocaleString()} steps. A short walk gets you there!`);
  }
}

/* ============================================================
   Calendar view
   ============================================================ */
let calYear, calMonth, selectedDay = TODAY;
(function initCal(){ const n = new Date(); calYear = n.getFullYear(); calMonth = n.getMonth(); })();

function renderCalendar() {
  const label = el('calMonthLabel');
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  label.textContent = `${monthNames[calMonth]} ${calYear}`;
  const grid = el('calDays');
  grid.innerHTML = '';
  const first = new Date(calYear, calMonth, 1).getDay();
  const days = new Date(calYear, calMonth + 1, 0).getDate();
  for (let i = 0; i < first; i++) {
    const e = document.createElement('div'); e.className = 'cal-cell empty'; grid.appendChild(e);
  }
  for (let d = 1; d <= days; d++) {
    const key = ymd(new Date(calYear, calMonth, d));
    const status = dayStatus(key);
    const cell = document.createElement('div');
    cell.className = 'cal-cell' + (key === TODAY ? ' today' : '') +
      (status === 'gym' ? ' gym' : status === 'partial' ? ' partial' : status === 'miss' ? ' miss' : '');
    const mark = status === 'gym' ? '💪' : status === 'partial' ? '🔸' : '';
    cell.innerHTML = `<span class="cnum">${d}</span><span class="cmark">${mark}</span>`;
    cell.addEventListener('click', () => { selectedDay = key; renderDayDetail(); });
    grid.appendChild(cell);
  }
}

function renderDayDetail() {
  const title = el('dayDetailTitle');
  const body = el('dayDetailBody');
  const d = parseYmd(selectedDay);
  title.textContent = d.toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' });
  const day = getDay(selectedDay);
  const t = dayTotals(selectedDay);
  let html = '<div style="margin-bottom:12px">';
  day.goals.forEach((g, i) => {
    html += `<label class="dd-goal">
      <input type="checkbox" data-i="${i}" ${g.done ? 'checked' : ''}/>
      <span>${escapeHtml(g.text)}</span></label>`;
  });
  if (!day.goals.length) html += '<div class="muted">No goals for this day.</div>';
  html += '</div>';
  html += `<div class="calc-out">
      <div class="calc-row"><span>Calories in</span><b>${t.calIn}</b></div>
      <div class="calc-row"><span>Calories out</span><b>${t.calOut}</b></div>
      <div class="calc-row"><span>Protein</span><b>${t.protein}g</b></div>
      <div class="calc-row highlight"><span>Net</span><b>${t.net} kcal</b></div></div>`;
  body.innerHTML = html;
  body.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', () => {
      day.goals[+cb.dataset.i].done = cb.checked;
      render(); renderCalendar();
    });
  });
}

/* ============================================================
   Nutrition view
   ============================================================ */
function renderNutrition() {
  el('bmrOut').textContent = bmr() ? bmr() + ' kcal' : 'Add weight →';
  el('tdeeOut').textContent = tdee() ? tdee() + ' kcal' : '—';
  const tc = targetCalories();
  el('targetCalOut').textContent = tc ? tc + ' kcal' : '—';
  el('goalCalLabel').textContent =
    state.profile.goal === 'cut' ? 'Target intake (−500 deficit)' :
    state.profile.goal === 'bulk' ? 'Target intake (+350 surplus)' : 'Target intake (maintain)';
  el('proteinTargetOut').textContent = proteinTargetG() ? proteinTargetG() + ' g' : '—';

  const t = dayTotals(TODAY);
  const target = tc || 2000;
  const pTarget = proteinTargetG() || 120;

  el('barIn').style.width = Math.min(100, t.calIn / target * 100) + '%';
  el('barOut').style.width = Math.min(100, t.calOut / target * 100) + '%';
  el('barPro').style.width = Math.min(100, t.protein / pTarget * 100) + '%';
  el('barInVal').textContent = t.calIn;
  el('barOutVal').textContent = t.calOut;
  el('barProVal').textContent = t.protein + 'g';

  const pill = el('balancePill');
  const net = t.net;
  if (t.calIn === 0 && t.calOut === 0) { pill.textContent = 'Log to see'; pill.className = 'balance-pill'; }
  else if (net < target) { pill.textContent = `Deficit ${target - net} kcal`; pill.className = 'balance-pill deficit'; }
  else { pill.textContent = `Surplus ${net - target} kcal`; pill.className = 'balance-pill surplus'; }

  // logs
  const day = getDay(TODAY);
  renderLog('foodLog', day.food, true);
  renderLog('burnLog', day.burn, false);
}

function renderLog(id, arr, isFood) {
  const ul = el(id);
  ul.innerHTML = '';
  if (!arr.length) { ul.innerHTML = '<li class="log-empty">Nothing logged yet.</li>'; return; }
  arr.forEach((item, i) => {
    const li = document.createElement('li');
    li.className = 'log-item';
    li.innerHTML = `<span class="li-name">${escapeHtml(item.name || (isFood?'Food':'Activity'))}</span>
      <span class="li-val">${item.kcal} kcal</span>
      ${isFood && item.protein ? `<span class="li-sub">${item.protein}g P</span>` : ''}
      <button title="Delete">✕</button>`;
    li.querySelector('button').addEventListener('click', () => {
      arr.splice(i, 1); render(); renderNutrition();
    });
    ul.appendChild(li);
  });
}

/* ============================================================
   Weight view
   ============================================================ */
function renderWeight() {
  const w = latestWeightKg();
  el('weightUnitLabel').textContent = wtUnit();
  el('curWeightUnit').textContent = wtUnit();

  el('curWeightBig').textContent = w == null ? '—' : round1(fromKg(w));

  const b = bmi();
  el('bmiOut').textContent = b ? b.toFixed(1) : '—';
  el('bmiCat').textContent = b ? bmiCategory(b) : '—';
  const range = healthyWeightRangeKg();
  el('healthyRange').textContent = range
    ? `${round1(fromKg(range[0]))}–${round1(fromKg(range[1]))} ${wtUnit()}` : '—';

  if (w != null) {
    const goalKg = toKg(state.profile.goalWeight);
    const diff = fromKg(w - goalKg);
    el('toGoal').textContent = Math.abs(diff) < 0.1 ? '🎯 Reached!'
      : `${Math.abs(round1(diff))} ${wtUnit()} ${diff > 0 ? 'to lose' : 'to gain'}`;
  } else el('toGoal').textContent = '—';

  // trend
  if (state.weights.length >= 2) {
    const first = state.weights[0].kg;
    const change = fromKg(w - first);
    el('weightTrend').textContent = change === 0 ? 'No change yet'
      : `${change < 0 ? '▼' : '▲'} ${Math.abs(round1(change))} ${wtUnit()} since start`;
  } else el('weightTrend').textContent = state.weights.length ? 'Keep logging to see trends' : 'No data yet';

  renderWeightChart();
  renderWeightLog();
}

function renderWeightChart() {
  const chart = el('weightChart');
  chart.innerHTML = '';
  const data = state.weights.slice(-14);
  if (!data.length) { chart.innerHTML = '<div class="chart-empty">No weigh-ins yet</div>'; return; }
  const vals = data.map(d => d.kg);
  const min = Math.min(...vals) - 1, max = Math.max(...vals) + 1;
  data.forEach(d => {
    const bar = document.createElement('div');
    bar.className = 'chart-bar';
    const h = max === min ? 50 : ((d.kg - min) / (max - min)) * 100;
    bar.style.height = Math.max(6, h) + '%';
    bar.innerHTML = `<span>${round1(fromKg(d.kg))}</span>`;
    bar.title = `${d.date}: ${round1(fromKg(d.kg))} ${wtUnit()}`;
    chart.appendChild(bar);
  });
}

function renderWeightLog() {
  const ul = el('weightLog');
  ul.innerHTML = '';
  const list = [...state.weights].reverse().slice(0, 10);
  if (!list.length) { ul.innerHTML = '<li class="log-empty">No weigh-ins yet.</li>'; return; }
  list.forEach(item => {
    const li = document.createElement('li');
    li.className = 'log-item';
    const d = parseYmd(item.date);
    li.innerHTML = `<span class="li-name">${d.toLocaleDateString(undefined,{month:'short',day:'numeric'})}</span>
      <span class="li-val">${round1(fromKg(item.kg))} ${wtUnit()}</span>
      <button title="Delete">✕</button>`;
    li.querySelector('button').addEventListener('click', () => {
      state.weights = state.weights.filter(x => x !== item);
      render(); renderWeight();
    });
    ul.appendChild(li);
  });
}

/* ============================================================
   Profile
   ============================================================ */
function loadProfileForm() {
  const p = state.profile;
  el('pName').value = p.name;
  el('pAge').value = p.age;
  el('pSex').value = p.sex;
  el('pUnits').value = p.units;
  el('pHeight').value = p.height;
  el('pGoalWeight').value = p.goalWeight;
  el('pActivity').value = p.activity;
  el('pGoal').value = p.goal;
  updateUnitLabels();
}
function updateUnitLabels() {
  document.querySelectorAll('.u-len').forEach(e => e.textContent = lenUnit());
  document.querySelectorAll('.u-wt').forEach(e => e.textContent = wtUnit());
}
function saveProfileForm() {
  const p = state.profile;
  p.name = el('pName').value.trim();
  p.age = +el('pAge').value || 25;
  p.sex = el('pSex').value;
  p.units = el('pUnits').value;
  p.height = +el('pHeight').value || 0;
  p.goalWeight = +el('pGoalWeight').value || 0;
  p.activity = +el('pActivity').value;
  p.goal = el('pGoal').value;
  save();
  render(); renderNutrition(); renderWeight();
  flash(el('saveProfile'), 'Saved ✓');
}

/* ============================================================
   Utilities
   ============================================================ */
function round1(n) { return Math.round(n * 10) / 10; }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function flash(btn, text) {
  const old = btn.textContent; btn.textContent = text;
  setTimeout(() => btn.textContent = old, 1200);
}

/* ============================================================
   Navigation
   ============================================================ */
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  el('view-' + name).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'steps') renderSteps();
  if (name === 'league' && window.Social) Social.renderView();
  if (name === 'calendar') { renderCalendar(); renderDayDetail(); }
  if (name === 'nutrition') renderNutrition();
  if (name === 'weight') renderWeight();
  if (name === 'profile') loadProfileForm();
}

/* ============================================================
   Event wiring
   ============================================================ */
document.querySelectorAll('.nav-btn').forEach(b =>
  b.addEventListener('click', () => showView(b.dataset.view)));
document.querySelectorAll('[data-jump]').forEach(b =>
  b.addEventListener('click', () => showView(b.dataset.jump)));

// Calendar nav
el('prevMonth').addEventListener('click', () => {
  calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } renderCalendar();
});
el('nextMonth').addEventListener('click', () => {
  calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } renderCalendar();
});

// Goal modal
const goalModal = el('goalModal');
el('addGoalBtn').addEventListener('click', () => { goalModal.classList.add('show'); el('goalInput').focus(); });
el('goalCancel').addEventListener('click', () => goalModal.classList.remove('show'));
goalModal.addEventListener('click', e => { if (e.target === goalModal) goalModal.classList.remove('show'); });
el('goalSave').addEventListener('click', addGoal);
el('goalInput').addEventListener('keydown', e => { if (e.key === 'Enter') addGoal(); });
function addGoal() {
  const text = el('goalInput').value.trim();
  if (!text) return;
  getDay(TODAY).goals.push({ text, done: false, gym: /gym|workout|train/i.test(text) });
  el('goalInput').value = '';
  goalModal.classList.remove('show');
  render();
}

// Calories in
el('addCalIn').addEventListener('click', () => {
  const kcal = +el('calInKcal').value;
  if (!kcal) return;
  getDay(TODAY).food.push({
    name: el('calInName').value.trim(),
    kcal, protein: +el('calInPro').value || 0
  });
  el('calInName').value = el('calInKcal').value = el('calInPro').value = '';
  render(); renderNutrition();
});

// Calories out
el('addCalOut').addEventListener('click', () => {
  const kcal = +el('calOutKcal').value;
  if (!kcal) return;
  getDay(TODAY).burn.push({ name: el('calOutName').value.trim(), kcal });
  el('calOutName').value = el('calOutKcal').value = '';
  render(); renderNutrition();
});

// Estimate burn — rough MET-based per 30 min using latest weight
el('estBurnBtn').addEventListener('click', () => {
  const wKg = latestWeightKg() || 70;
  const act = (el('calOutName').value || 'workout').toLowerCase();
  const METS = { walk:3.5, run:9.8, cycle:7.5, gym:6, weights:6, lift:6, swim:8, yoga:3, hiit:10, cardio:8 };
  let met = 6;
  for (const k in METS) if (act.includes(k)) { met = METS[k]; break; }
  const mins = +prompt(`How many minutes of "${el('calOutName').value || 'workout'}"?`, '45');
  if (!mins) return;
  const kcal = Math.round(met * 3.5 * wKg / 200 * mins);
  el('calOutKcal').value = kcal;
});

// Weight log
el('logWeight').addEventListener('click', () => {
  const v = +el('weightInput').value;
  if (!v) return;
  const kg = toKg(v);
  // replace if already logged today
  state.weights = state.weights.filter(w => w.date !== TODAY);
  state.weights.push({ date: TODAY, kg });
  state.weights.sort((a,b) => a.date.localeCompare(b.date));
  el('weightInput').value = '';
  render(); renderWeight(); renderNutrition();
  flash(el('logWeight'), 'Saved ✓');
});

// Steps — auto counter
el('autoStepBtn').addEventListener('click', () => Pedometer.isActive() ? Pedometer.stop() : Pedometer.start());
// Steps — manual add
el('addStepsBtn').addEventListener('click', () => {
  const n = +el('manualSteps').value;
  if (!n) return;
  addStepsToday(n);
  el('manualSteps').value = '';
});
el('manualSteps').addEventListener('keydown', e => {
  if (e.key === 'Enter') { const n = +el('manualSteps').value; if (n) { addStepsToday(n); el('manualSteps').value = ''; } }
});
// Steps — set exact total
el('setStepsBtn').addEventListener('click', () => {
  const v = prompt("Set today's total step count:", stepsOf(TODAY));
  if (v === null) return;
  const n = parseInt(v, 10);
  if (!isNaN(n)) setStepsToday(n);
});
// Step goal
el('saveStepGoal').addEventListener('click', () => {
  const n = +el('stepGoalInput').value;
  if (!n) return;
  state.stepGoal = Math.round(n);
  save(); render(); renderSteps();
  flash(el('saveStepGoal'), 'Saved ✓');
});
document.querySelectorAll('.quick-goals .chip').forEach(c =>
  c.addEventListener('click', () => {
    state.stepGoal = +c.dataset.goal;
    save(); render(); renderSteps();
  }));
// Notifications
el('enableNotifBtn').addEventListener('click', enableNotifications);
el('testNotifBtn').addEventListener('click', () =>
  notifSupported() && Notification.permission === 'granted'
    ? notify('Test from Dream 🔔', 'Notifications are working! 🎉')
    : alert('Enable notifications first (button above).'));

// League / leaderboard
el('createLeagueBtn').addEventListener('click', () => Social.createLeague());
el('joinLeagueBtn').addEventListener('click', () => Social.joinLeague());
el('leaveLeagueBtn').addEventListener('click', () => Social.leaveLeague());
el('refreshBoardBtn').addEventListener('click', () => Social.refreshBoard());
el('syncNowBtn').addEventListener('click', () => Social.syncNow());
el('shareLeagueBtn').addEventListener('click', () => Social.shareLeague());
el('addTaskBtn').addEventListener('click', () => Social.addTask());
el('saveRulesBtn').addEventListener('click', () => Social.saveRules());

// Profile
el('saveProfile').addEventListener('click', saveProfileForm);
el('pUnits').addEventListener('change', () => { state.profile.units = el('pUnits').value; updateUnitLabels(); });
el('resetAll').addEventListener('click', () => {
  if (confirm('Delete ALL your data and start fresh?')) {
    localStorage.removeItem(STORE_KEY);
    state = defaultState();
    render(); renderNutrition(); renderWeight(); loadProfileForm();
    showView('dashboard');
  }
});

/* ============================================================
   Social — friends league & leaderboard (Supabase)
   Additive: if not configured / not in a league, everything
   else in Dream keeps working offline.
   ============================================================ */
window.Social = (function () {
  let client = null, channel = null, syncTimer = null;
  let rules = null, leaderId = null, editTasks = [];

  function configured() {
    const c = window.DREAM_SUPABASE;
    return !!(c && c.url && c.anonKey &&
      c.url.indexOf('YOUR_') === -1 && c.anonKey.indexOf('YOUR_') === -1);
  }
  function ensureClient() {
    if (client) return client;
    if (!configured() || !window.supabase) return null;
    client = window.supabase.createClient(window.DREAM_SUPABASE.url, window.DREAM_SUPABASE.anonKey);
    return client;
  }
  function s() {
    if (!state.social) state.social = { name: '', leagueCode: '', playerId: '' };
    return state.social;
  }
  function ensurePlayerId() {
    if (!s().playerId) {
      s().playerId = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : 'p_' + Math.random().toString(36).slice(2) + (+new Date());
      save();
    }
    return s().playerId;
  }
  function inLeague() { return !!s().leagueCode; }
  function isLeader() { return !!leaderId && s().playerId === leaderId; }

  /* ---- rules (set by the clan leader) ---- */
  function defaultRules() {
    return {
      stepGoal: 10000, stepPoints: 10,
      tasks: [
        { id: 'gym',   text: 'Go to the gym 🏋️',     points: 5 },
        { id: 'water', text: 'Drink 3L of water 💧',  points: 3 },
        { id: 'sleep', text: '8h sleep 😴',            points: 2 }
      ]
    };
  }
  // Points for one day's row, computed from the league's rules
  function rowPoints(r, rl) {
    if (!rl) return r.points || 0;
    let p = ((r.steps || 0) >= rl.stepGoal ? rl.stepPoints : 0);
    const done = Array.isArray(r.tasks_done) ? r.tasks_done : [];
    (rl.tasks || []).forEach(t => { if (done.includes(t.id)) p += (+t.points || 0); });
    return p;
  }
  // Which league tasks I've ticked off today (stored locally + synced)
  function myTasksToday() {
    const d = getDay(TODAY);
    if (!Array.isArray(d.leagueTasks)) d.leagueTasks = [];
    return d.leagueTasks;
  }

  function myTodayRow() {
    const rl = rules || defaultRules();
    const steps = stepsOf(TODAY);
    const done = myTasksToday();
    return {
      player_id: ensurePlayerId(),
      date: TODAY,
      league_code: s().leagueCode,
      name: s().name || 'Player',
      steps, step_goal: rl.stepGoal,
      goal_hit: steps >= rl.stepGoal,
      gym_done: done.includes('gym'),
      tasks_done: done,
      points: rowPoints({ steps, tasks_done: done }, rl),
      updated_at: new Date().toISOString()
    };
  }

  /* ---- sync ---- */
  async function syncNow() {
    const c = ensureClient();
    if (!c || !inLeague()) return;
    setSyncStatus('Syncing…');
    const { error } = await c.from('daily_stats').upsert(myTodayRow(), { onConflict: 'player_id,date' });
    setSyncStatus(error ? 'Error — check setup' : 'Synced ✓');
    if (error) console.warn('Sync error:', error);
    else refreshBoard();
  }
  function scheduleSync() {
    if (!configured() || !inLeague()) return;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(syncNow, 2500);
  }

  /* ---- rules load/save ---- */
  async function loadRules() {
    const c = ensureClient();
    if (!c || !inLeague()) return null;
    const { data, error } = await c.from('leagues').select('*').eq('league_code', s().leagueCode).maybeSingle();
    if (error) console.warn('Rules load error:', error);
    rules = data ? data.rules : null;
    leaderId = data ? data.leader_id : null;
    return rules;
  }

  /* ---- leaderboard ---- */
  async function refreshBoard() {
    const c = ensureClient();
    if (!c || !inLeague()) return;
    if (!rules) await loadRules();
    const { data, error } = await c.from('daily_stats').select('*').eq('league_code', s().leagueCode);
    if (error) { renderBoardError(error.message); return; }
    renderBoard(aggregate(data || []));
  }
  function aggregate(rows) {
    const rl = rules;
    const byPlayer = {};
    rows.forEach(r => {
      const p = byPlayer[r.player_id] || (byPlayer[r.player_id] = { id: r.player_id, name: r.name || 'Player', total: 0, days: {} });
      r._hit = rl ? ((r.steps || 0) >= rl.stepGoal) : !!r.goal_hit;
      p.total += rowPoints(r, rl);
      if (r.name) p.name = r.name;
      p.days[r.date] = r;
    });
    const list = Object.values(byPlayer).map(p => {
      const today = p.days[TODAY];
      p.todaySteps = today ? today.steps : 0;
      p.todayHit = today ? today._hit : false;
      p.todayTasks = today && Array.isArray(today.tasks_done) ? today.tasks_done.length : 0;
      p.taskTotal = rl ? (rl.tasks || []).length : 0;
      p.streak = goalStreak(p.days);
      return p;
    });
    list.sort((a, b) => b.total - a.total || b.todaySteps - a.todaySteps);
    return list;
  }
  function goalStreak(days) {
    let streak = 0, cur = new Date();
    if (!(days[ymd(cur)] && days[ymd(cur)]._hit)) cur.setDate(cur.getDate() - 1);
    for (let i = 0; i < 400; i++) {
      const key = ymd(cur);
      if (days[key] && days[key]._hit) { streak++; cur.setDate(cur.getDate() - 1); }
      else break;
    }
    return streak;
  }

  /* ---- rendering ---- */
  function show(id) { const e = el(id); if (e) e.style.display = ''; }
  function hide(id) { const e = el(id); if (e) e.style.display = 'none'; }
  function setSyncStatus(t) { const e = el('leagueSyncStatus'); if (e) e.textContent = t; }

  function renderView() {
    if (!configured()) {
      show('leagueSetup'); hide('leagueJoin'); hide('leagueBoard');
      el('leagueBackendStatus').textContent = window.supabase
        ? 'Keys not set in supabase-config.js' : 'Library not loaded (needs internet)';
      return;
    }
    if (!inLeague()) {
      hide('leagueSetup'); show('leagueJoin'); hide('leagueBoard');
      el('leagueName').value = s().name || '';
      return;
    }
    hide('leagueSetup'); hide('leagueJoin'); show('leagueBoard');
    el('leagueCodeLabel').textContent = s().leagueCode;
    el('leagueMyName').textContent = s().name || 'Player';
    enterBoard();
    subscribeRealtime();
  }
  async function enterBoard() {
    await loadRules();
    renderChallenges();
    renderRules();
    refreshBoard();
    updateMyTodayStatus();
  }
  function updateMyTodayStatus() {
    const rl = rules || defaultRules(), steps = stepsOf(TODAY);
    const e = el('myTodayStatus'); if (!e) return;
    e.textContent = steps >= rl.stepGoal ? 'goal hit ✅' : steps.toLocaleString() + ' / ' + rl.stepGoal.toLocaleString() + ' steps';
  }

  /* ---- today's challenges (member checklist) ---- */
  function renderChallenges() {
    const rl = rules || defaultRules();
    const steps = stepsOf(TODAY);
    const sg = el('challengeStepGoal');
    if (sg) sg.innerHTML = `🎯 League step goal: <b>${rl.stepGoal.toLocaleString()}</b> steps — `
      + (steps >= rl.stepGoal ? '✅ done' : '⬜ ' + steps.toLocaleString())
      + ` <span class="ch-pts">+${rl.stepPoints}</span>`;
    const done = myTasksToday();
    const ul = el('challengeList'); if (!ul) return; ul.innerHTML = '';
    (rl.tasks || []).forEach(t => {
      const isDone = done.includes(t.id);
      const li = document.createElement('li');
      li.className = 'challenge-item' + (isDone ? ' done' : '');
      li.innerHTML = `<div class="goal-check">${isDone ? '✓' : ''}</div>
        <span class="goal-name">${escapeHtml(t.text)}</span>
        <span class="ch-pts">+${t.points}</span>`;
      li.addEventListener('click', () => toggleTask(t.id));
      ul.appendChild(li);
    });
    if (!(rl.tasks || []).length) ul.innerHTML = '<li class="log-empty">Your clan leader hasn\'t added tasks yet.</li>';
  }
  function toggleTask(id) {
    const done = myTasksToday();
    const i = done.indexOf(id);
    if (i >= 0) done.splice(i, 1); else done.push(id);
    save();
    renderChallenges();
    syncNow();
  }

  /* ---- clan rules (leader editor / member view) ---- */
  function renderRules() {
    const rl = rules || defaultRules();
    const leader = isLeader();
    const role = el('rulesRole'); if (role) role.textContent = leader ? "You're the clan leader 👑" : 'Set by your clan leader';
    const editor = el('rulesEditor'), view = el('rulesView');
    if (!editor || !view) return;
    if (leader) {
      editor.style.display = ''; view.style.display = 'none';
      el('ruleStepGoal').value = rl.stepGoal;
      el('ruleStepPoints').value = rl.stepPoints;
      editTasks = (rl.tasks || []).map(t => ({ ...t }));
      renderRuleTaskList();
    } else {
      editor.style.display = 'none'; view.style.display = '';
      let html = `<div class="calc-out"><div class="calc-row highlight"><span>🎯 ${rl.stepGoal.toLocaleString()} steps</span><b>+${rl.stepPoints}</b></div>`;
      (rl.tasks || []).forEach(t => html += `<div class="calc-row"><span>${escapeHtml(t.text)}</span><b>+${t.points}</b></div>`);
      html += '</div>';
      view.innerHTML = html;
    }
  }
  function renderRuleTaskList() {
    const ul = el('ruleTaskList'); if (!ul) return; ul.innerHTML = '';
    editTasks.forEach((t, i) => {
      const li = document.createElement('li'); li.className = 'rule-task';
      li.innerHTML = `<span class="rt-text">${escapeHtml(t.text)}</span><span class="rt-pts">+${t.points}</span><button class="rt-del" title="Remove">✕</button>`;
      li.querySelector('.rt-del').addEventListener('click', () => { editTasks.splice(i, 1); renderRuleTaskList(); });
      ul.appendChild(li);
    });
    if (!editTasks.length) ul.innerHTML = '<li class="log-empty">No tasks yet — add some below.</li>';
  }
  function addTask() {
    const text = (el('newTaskText').value || '').trim();
    const pts = parseInt(el('newTaskPoints').value, 10) || 0;
    if (!text) { alert('Enter a task description.'); return; }
    editTasks.push({ id: 't_' + Math.random().toString(36).slice(2, 7), text, points: pts });
    el('newTaskText').value = ''; el('newTaskPoints').value = '';
    renderRuleTaskList();
  }
  async function saveRules() {
    if (!isLeader()) { alert('Only the clan leader can change the rules.'); return; }
    const c = ensureClient(); if (!c) return;
    const rl = {
      stepGoal: parseInt(el('ruleStepGoal').value, 10) || 10000,
      stepPoints: parseInt(el('ruleStepPoints').value, 10) || 0,
      tasks: editTasks.map(t => ({ id: t.id, text: t.text, points: +t.points || 0 }))
    };
    const { error } = await c.from('leagues').update({ rules: rl, updated_at: new Date().toISOString() }).eq('league_code', s().leagueCode);
    if (error) { alert('Could not save rules: ' + error.message); return; }
    rules = rl;
    renderChallenges(); renderRules(); syncNow();
    alert('Rules updated for the whole clan! 🎉');
  }

  function renderBoardError(msg) {
    el('boardList').innerHTML = `<li class="log-empty">Couldn't load leaderboard: ${escapeHtml(msg)}</li>`;
  }
  function renderBoard(list) {
    el('leaguePlayerCount').textContent = list.length;
    const ul = el('boardList'); ul.innerHTML = '';
    if (!list.length) { ul.innerHTML = '<li class="log-empty">No players yet — share your code!</li>'; return; }
    const medals = ['🥇', '🥈', '🥉'];
    list.forEach((p, i) => {
      const me = p.id === s().playerId;
      const li = document.createElement('li');
      li.className = 'board-item' + (me ? ' me' : '');
      const crown = p.id === leaderId ? ' 👑' : '';
      const sub = (p.todayHit ? '✅ goal' : '⬜ ' + p.todaySteps.toLocaleString() + ' steps')
        + (p.taskTotal ? ` · ${p.todayTasks}/${p.taskTotal} tasks` : '')
        + (p.streak > 1 ? ' · 🔥' + p.streak : '');
      li.innerHTML =
        `<span class="board-rank">${medals[i] || (i + 1)}</span>
         <div class="board-who">
           <span class="board-name">${escapeHtml(p.name)}${crown}${me ? ' (you)' : ''}</span>
           <span class="board-sub">${sub}</span>
         </div>
         <span class="board-pts">${p.total}<small>pts</small></span>`;
      ul.appendChild(li);
    });
    updateMyTodayStatus();
  }

  /* ---- realtime (best-effort; polling backs it up) ---- */
  function subscribeRealtime() {
    const c = ensureClient();
    if (!c || channel) return;
    try {
      channel = c.channel('league_' + s().leagueCode)
        .on('postgres_changes',
          { event: '*', schema: 'public', table: 'daily_stats', filter: 'league_code=eq.' + s().leagueCode },
          () => refreshBoard())
        .on('postgres_changes',
          { event: '*', schema: 'public', table: 'leagues', filter: 'league_code=eq.' + s().leagueCode },
          async () => { await loadRules(); renderChallenges(); renderRules(); refreshBoard(); })
        .subscribe();
    } catch (e) { /* polling will cover it */ }
  }
  function unsubscribe() {
    if (channel && client) { try { client.removeChannel(channel); } catch (e) {} channel = null; }
  }

  /* ---- league membership ---- */
  function genCode() {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = 'D';
    for (let i = 0; i < 5; i++) out += A[Math.floor(Math.random() * A.length)];
    return out;
  }
  async function createLeague() {
    const name = (el('leagueName').value || '').trim();
    if (!name) { alert('Enter your display name first.'); return; }
    s().name = name; s().leagueCode = genCode(); ensurePlayerId(); save();
    const c = ensureClient();
    const rl = defaultRules();
    if (c) {
      const { error } = await c.from('leagues').upsert({
        league_code: s().leagueCode, name: name + "'s clan",
        leader_id: s().playerId, rules: rl, updated_at: new Date().toISOString()
      });
      if (error) alert('Could not create the clan (did you run the new SQL migration?):\n' + error.message);
    }
    rules = rl; leaderId = s().playerId;
    await syncNow();
    renderView();
  }
  async function joinLeague() {
    const name = (el('leagueName').value || '').trim();
    const code = (el('joinCode').value || '').trim().toUpperCase();
    if (!name) { alert('Enter your display name first.'); return; }
    if (!code) { alert('Enter a league code to join.'); return; }
    s().name = name; s().leagueCode = code; ensurePlayerId(); save();
    await loadRules();
    await syncNow();
    renderView();
  }
  function leaveLeague() {
    if (!confirm('Leave this league? Your score stays on the board but you stop syncing.')) return;
    unsubscribe();
    s().leagueCode = ''; rules = null; leaderId = null; save();
    renderView();
  }
  function shareLeague() {
    const code = s().leagueCode;
    const text = `Join my Dream fitness clan! In the app: League → Join, enter code: ${code}`;
    if (navigator.share) navigator.share({ title: 'Dream League', text }).catch(() => {});
    else if (navigator.clipboard) { navigator.clipboard.writeText(code); alert('League code ' + code + ' copied!'); }
    else alert('Your league code: ' + code);
  }

  function init() {
    if (configured() && inLeague()) { ensurePlayerId(); loadRules().then(syncNow); }
    // Poll while the League tab is open so you see friends update live
    setInterval(() => {
      if (inLeague() && el('view-league').classList.contains('active')) refreshBoard();
    }, 20000);
  }

  return {
    init, renderView, refreshBoard, syncNow,
    onSave: scheduleSync,
    createLeague, joinLeague, leaveLeague, shareLeague,
    addTask, saveRules
  };
})();

/* ============================================================
   Boot
   ============================================================ */
render();
showView('dashboard');
maybeRemind();
Social.init();
// Re-check the reminder periodically while the app/PWA stays open
setInterval(maybeRemind, 15 * 60 * 1000);

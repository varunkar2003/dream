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
  waterGoalMl: 3000,      // daily water target (ml)
  workouts: [],           // [{id, date, name, exercises:[{name, sets:[{reps, weight}]}]}]
  measurements: [],       // [{date, parts:{waist, chest, ...}}] stored in cm
  photos: [],             // [{id, date, data(base64), weightKg}]
  achievements: {},       // { badgeId: 'YYYY-MM-DD' (date unlocked) }
  theme: 'dark',          // 'dark' | 'light'
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
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { console.warn('Could not save (storage full?):', e); return false; }
  // Push today's stats to the friends leaderboard (debounced, no-op if not in a league)
  if (window.Social && window.Social.onSave) window.Social.onSave();
  return true;
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
  checkAchievements();
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
  if (name === 'workouts') renderWorkouts();
  if (name === 'steps') renderSteps();
  if (name === 'habits') renderHabits();
  if (name === 'body') renderBody();
  if (name === 'achievements') renderAchievements();
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
   Theme (light / dark)
   ============================================================ */
function applyTheme() {
  const t = state.theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  const btn = el('themeToggle');
  if (btn) btn.textContent = t === 'light' ? '☀️ Light' : '🌙 Dark';
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.setAttribute('content', t === 'light' ? '#f4f6fb' : '#0e1116');
}
function toggleTheme() {
  state.theme = state.theme === 'light' ? 'dark' : 'light';
  applyTheme(); save();
}

/* ============================================================
   Workout logger + Personal Records
   ============================================================ */
let draftExercises = [];   // [{name, sets:[{reps, weight}]}]  (weight in display units while editing)
let _uidSeq = 0;
function uid() { return 'w_' + Math.random().toString(36).slice(2, 9) + (_uidSeq++); }

// Best set ever for an exercise (by weight, tie-broken by reps). Weights stored in kg.
function prFor(name) {
  const key = (name || '').trim().toLowerCase();
  let best = null;
  state.workouts.forEach(w => (w.exercises || []).forEach(ex => {
    if ((ex.name || '').trim().toLowerCase() !== key) return;
    (ex.sets || []).forEach(s => {
      if (!s.weightKg && !s.reps) return;
      if (!best || s.weightKg > best.weightKg || (s.weightKg === best.weightKg && s.reps > best.reps))
        best = { weightKg: s.weightKg || 0, reps: s.reps || 0 };
    });
  }));
  return best;
}
function workoutVolumeKg(w) {
  return (w.exercises || []).reduce((s, ex) =>
    s + ex.sets.reduce((ss, st) => ss + (st.weightKg || 0) * (st.reps || 0), 0), 0);
}

function renderWorkouts() {
  renderExerciseBuilder();
  renderPRs();
  renderWorkoutHistory();
}

function renderExerciseBuilder() {
  const box = el('exerciseBuilder');
  if (!box) return;
  box.innerHTML = '';
  if (!draftExercises.length) {
    box.innerHTML = '<div class="builder-empty">No exercises yet — add one below to start your workout.</div>';
    return;
  }
  draftExercises.forEach((ex, ei) => {
    const block = document.createElement('div');
    block.className = 'ex-block';
    const pr = prFor(ex.name);
    block.innerHTML = `
      <div class="ex-block-head">
        <span class="ex-name">${escapeHtml(ex.name)}</span>
        <span>${pr ? `<span class="ex-pr">PR ${round1(fromKg(pr.weightKg))}${wtUnit()}×${pr.reps}</span> ` : ''}<button class="ex-del" title="Remove exercise">✕</button></span>
      </div>
      <div class="set-head"><span>#</span><span>Reps</span><span>Weight (${wtUnit()})</span><span></span></div>
      <div class="sets"></div>
      <button class="add-set-btn">+ Add set</button>`;
    const setsBox = block.querySelector('.sets');
    ex.sets.forEach((st, si) => {
      const row = document.createElement('div');
      row.className = 'set-row';
      row.innerHTML = `<span class="set-n">${si + 1}</span>
        <input type="number" inputmode="numeric" placeholder="reps" value="${st.reps || ''}" />
        <input type="number" inputmode="decimal" placeholder="wt" value="${st.weight || ''}" />
        <button class="set-x" title="Remove set">✕</button>`;
      const inputs = row.querySelectorAll('input');
      inputs[0].addEventListener('input', () => st.reps = +inputs[0].value || 0);
      inputs[1].addEventListener('input', () => st.weight = +inputs[1].value || 0);
      row.querySelector('.set-x').addEventListener('click', () => { ex.sets.splice(si, 1); renderExerciseBuilder(); });
      setsBox.appendChild(row);
    });
    block.querySelector('.ex-del').addEventListener('click', () => { draftExercises.splice(ei, 1); renderExerciseBuilder(); });
    block.querySelector('.add-set-btn').addEventListener('click', () => {
      const last = ex.sets[ex.sets.length - 1];
      ex.sets.push(last ? { reps: last.reps, weight: last.weight } : { reps: 0, weight: 0 });
      renderExerciseBuilder();
    });
    box.appendChild(block);
  });
}

function addDraftExercise() {
  const name = (el('newExName').value || '').trim();
  if (!name) { alert('Type an exercise name first.'); return; }
  draftExercises.push({ name, sets: [{ reps: 0, weight: 0 }] });
  el('newExName').value = '';
  renderExerciseBuilder();
}

function markGymDone() {
  const day = getDay(TODAY);
  const g = day.goals.find(x => x.gym);
  if (g) g.done = true;
  else day.goals.push({ text: 'Go to the gym 🏋️', done: true, gym: true });
}

function saveWorkout() {
  const exes = draftExercises.map(ex => ({
    name: ex.name.trim(),
    sets: ex.sets.filter(s => s.reps || s.weight)
                 .map(s => ({ reps: +s.reps || 0, weightKg: toKg(+s.weight || 0) }))
  })).filter(ex => ex.name && ex.sets.length);

  if (!exes.length) { alert('Add at least one exercise with reps or weight before saving.'); return; }

  // Detect new PRs (compare against history before we add this workout)
  const prMsgs = [];
  exes.forEach(ex => {
    const old = prFor(ex.name);
    const newMax = ex.sets.reduce((m, s) =>
      (s.weightKg > m.weightKg || (s.weightKg === m.weightKg && s.reps > m.reps)) ? { weightKg: s.weightKg, reps: s.reps } : m,
      { weightKg: 0, reps: 0 });
    if (newMax.weightKg > 0 && (!old || newMax.weightKg > old.weightKg))
      prMsgs.push(`${ex.name}: ${round1(fromKg(newMax.weightKg))}${wtUnit()} × ${newMax.reps}`);
  });

  state.workouts.push({ id: uid(), date: TODAY, name: (el('workoutName').value || '').trim() || 'Workout', exercises: exes });
  markGymDone();
  draftExercises = [];
  el('workoutName').value = '';
  save();
  render();          // refresh streak, calendar status, achievements
  renderWorkouts();

  if (prMsgs.length) notify('🏆 New personal record!', prMsgs.join(' · '));
  flash(el('saveWorkoutBtn'), prMsgs.length ? '🏆 PR saved!' : 'Saved ✓');
}

function renderPRs() {
  const ul = el('prList');
  if (!ul) return;
  ul.innerHTML = '';
  const names = [...new Set(state.workouts.flatMap(w => (w.exercises || []).map(e => e.name)))];
  const prs = names.map(n => ({ n, pr: prFor(n) })).filter(x => x.pr);
  if (!prs.length) { ul.innerHTML = '<li class="log-empty">Log a workout to set your first PR.</li>'; return; }
  prs.sort((a, b) => b.pr.weightKg - a.pr.weightKg).forEach(x => {
    const li = document.createElement('li');
    li.className = 'log-item';
    li.innerHTML = `<span class="li-name">${escapeHtml(x.n)}</span>
      <span class="li-val">${round1(fromKg(x.pr.weightKg))} ${wtUnit()}</span>
      <span class="li-sub">× ${x.pr.reps}</span>`;
    ul.appendChild(li);
  });
}

function renderWorkoutHistory() {
  const ul = el('workoutHistory');
  if (!ul) return;
  ul.innerHTML = '';
  const list = [...state.workouts].reverse().slice(0, 15);
  if (!list.length) { ul.innerHTML = '<li class="log-empty">No workouts logged yet.</li>'; return; }
  list.forEach(w => {
    const li = document.createElement('li');
    li.className = 'wh-item';
    const d = parseYmd(w.date);
    const exSummary = (w.exercises || []).map(e => `${escapeHtml(e.name)} (${e.sets.length})`).join(', ');
    const vol = Math.round(fromKg(workoutVolumeKg(w)));
    li.innerHTML = `<div class="wh-top">
        <span class="wh-title">${escapeHtml(w.name)}</span>
        <span><span class="wh-date">${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
        <button class="wh-del" title="Delete">✕</button></span></div>
      <div class="wh-ex">${exSummary || 'No exercises'} · <span class="wh-vol">${vol.toLocaleString()} ${wtUnit()} volume</span></div>`;
    li.querySelector('.wh-del').addEventListener('click', () => {
      if (confirm('Delete this workout?')) { state.workouts = state.workouts.filter(x => x !== w); save(); render(); renderWorkouts(); }
    });
    ul.appendChild(li);
  });
}

/* ============================================================
   Rest timer
   ============================================================ */
let timerState = { remaining: 0, total: 0, handle: null };
function renderTimer() {
  const m = Math.floor(Math.max(0, timerState.remaining) / 60);
  const s = Math.max(0, timerState.remaining) % 60;
  const d = el('timerDisplay');
  if (d) d.textContent = `${m}:${String(s).padStart(2, '0')}`;
}
function startTimer() {
  if (timerState.handle) { pauseTimer(); return; }
  if (timerState.remaining <= 0) timerState.remaining = timerState.total || 60;
  el('timerDisplay').classList.remove('ringing');
  el('timerStartBtn').textContent = '⏸ Pause';
  timerState.handle = setInterval(() => {
    timerState.remaining--;
    renderTimer();
    if (timerState.remaining <= 0) { stopTimer(); timerDone(); }
  }, 1000);
}
function pauseTimer() { stopTimer(); el('timerStartBtn').textContent = '▶ Start'; }
function stopTimer() { if (timerState.handle) { clearInterval(timerState.handle); timerState.handle = null; } }
function resetTimer() {
  stopTimer();
  timerState.remaining = timerState.total || 0;
  renderTimer();
  el('timerStartBtn').textContent = '▶ Start';
  el('timerDisplay').classList.remove('ringing');
}
function timerDone() {
  el('timerDisplay').classList.add('ringing');
  el('timerStartBtn').textContent = '▶ Start';
  notify('⏱️ Rest over!', 'Time for your next set 💪');
  beep();
}
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.2, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    o.start(); o.stop(ctx.currentTime + 0.6);
  } catch (e) { /* audio not available */ }
}

/* ============================================================
   Quick-add common foods
   ============================================================ */
const QUICK_FOODS = [
  // Eggs & dairy
  { name: 'Egg (1 large)', kcal: 78, protein: 6 },
  { name: '2 Eggs', kcal: 156, protein: 12 },
  { name: 'Egg whites (3)', kcal: 51, protein: 11 },
  { name: 'Milk 1 cup', kcal: 150, protein: 8 },
  { name: 'Greek yogurt 170g', kcal: 100, protein: 17 },
  { name: 'Curd 1 cup', kcal: 98, protein: 8 },
  { name: 'Cheese slice', kcal: 70, protein: 4 },
  { name: 'Paneer 100g', kcal: 265, protein: 18 },
  { name: 'Cottage cheese 100g', kcal: 98, protein: 11 },
  // Meat & fish
  { name: 'Chicken breast 100g', kcal: 165, protein: 31 },
  { name: 'Chicken thigh 100g', kcal: 209, protein: 26 },
  { name: 'Tuna can', kcal: 120, protein: 26 },
  { name: 'Salmon 100g', kcal: 208, protein: 20 },
  { name: 'Fish 100g', kcal: 140, protein: 22 },
  { name: 'Egg curry serving', kcal: 220, protein: 12 },
  { name: 'Mutton 100g', kcal: 250, protein: 25 },
  { name: 'Prawns 100g', kcal: 99, protein: 24 },
  // Carbs / grains
  { name: 'Rice 1 cup', kcal: 205, protein: 4 },
  { name: 'Brown rice 1 cup', kcal: 215, protein: 5 },
  { name: 'Roti / chapati', kcal: 120, protein: 3 },
  { name: 'Bread slice', kcal: 80, protein: 3 },
  { name: 'Oats 50g', kcal: 190, protein: 7 },
  { name: 'Pasta 1 cup', kcal: 220, protein: 8 },
  { name: 'Poha plate', kcal: 270, protein: 5 },
  { name: 'Idli (2)', kcal: 140, protein: 4 },
  { name: 'Dosa', kcal: 168, protein: 4 },
  { name: 'Potato (boiled)', kcal: 130, protein: 3 },
  { name: 'Sweet potato', kcal: 112, protein: 2 },
  // Legumes / veg
  { name: 'Dal 1 cup', kcal: 230, protein: 18 },
  { name: 'Rajma 1 cup', kcal: 215, protein: 13 },
  { name: 'Chickpeas 1 cup', kcal: 269, protein: 15 },
  { name: 'Tofu 100g', kcal: 144, protein: 17 },
  { name: 'Soya chunks 50g', kcal: 173, protein: 26 },
  { name: 'Mixed veg sabzi', kcal: 150, protein: 5 },
  { name: 'Salad bowl', kcal: 80, protein: 3 },
  // Snacks / fats / fruit
  { name: 'Banana', kcal: 105, protein: 1 },
  { name: 'Apple', kcal: 95, protein: 0 },
  { name: 'Whey scoop', kcal: 120, protein: 24 },
  { name: 'Peanut butter 1 tbsp', kcal: 95, protein: 4 },
  { name: 'Almonds 30g', kcal: 175, protein: 6 },
  { name: 'Peanuts 30g', kcal: 170, protein: 7 },
  { name: 'Protein bar', kcal: 200, protein: 20 },
  { name: 'Dark chocolate 30g', kcal: 170, protein: 2 },
  { name: 'Coffee w/ milk', kcal: 60, protein: 3 }
];
let foodFilter = '';
function renderQuickFood() {
  const box = el('quickFood');
  if (!box) return;
  box.innerHTML = '';
  const q = foodFilter.trim().toLowerCase();
  const list = QUICK_FOODS.filter(f => !q || f.name.toLowerCase().includes(q));
  if (!list.length) {
    box.innerHTML = '<div class="log-empty">No match — type the food &amp; calories above to add it manually.</div>';
    return;
  }
  list.forEach(f => {
    const b = document.createElement('button');
    b.className = 'food-chip';
    b.innerHTML = `${escapeHtml(f.name)}<small>${f.kcal} kcal · ${f.protein}g P</small>`;
    b.addEventListener('click', () => {
      getDay(TODAY).food.push({ name: f.name, kcal: f.kcal, protein: f.protein });
      render(); renderNutrition();
      flash(b, 'Added ✓');
    });
    box.appendChild(b);
  });
}

/* ============================================================
   Achievements & badges
   ============================================================ */
const ACHIEVEMENTS = [
  { id: 'first_workout', icon: '🏋️', name: 'First Rep',       desc: 'Log your first workout',        test: () => state.workouts.length >= 1 },
  { id: 'workouts_10',   icon: '💪', name: 'Committed',       desc: 'Log 10 workouts',               test: () => state.workouts.length >= 10 },
  { id: 'workouts_50',   icon: '🦾', name: 'Iron Addict',     desc: 'Log 50 workouts',               test: () => state.workouts.length >= 50 },
  { id: 'pr_set',        icon: '🏆', name: 'Record Breaker',  desc: 'Lift weight in a workout',      test: () => state.workouts.some(w => (w.exercises || []).some(e => e.sets.some(s => s.weightKg > 0))) },
  { id: 'streak_3',      icon: '🔥', name: 'On a Roll',       desc: 'Reach a 3-day gym streak',      test: () => gymStreak() >= 3 },
  { id: 'streak_7',      icon: '⚡', name: 'Week Warrior',    desc: 'Reach a 7-day gym streak',      test: () => gymStreak() >= 7 },
  { id: 'streak_30',     icon: '🌟', name: 'Unstoppable',     desc: 'Reach a 30-day gym streak',     test: () => gymStreak() >= 30 },
  { id: 'steps_10k',     icon: '👟', name: '10k Club',        desc: 'Hit 10,000 steps in one day',   test: () => Object.values(state.days).some(d => (d.steps || 0) >= 10000) },
  { id: 'steps_100k',    icon: '🚶', name: 'Century Walker',  desc: 'Walk 100k steps total',         test: () => Object.values(state.days).reduce((s, d) => s + (d.steps || 0), 0) >= 100000 },
  { id: 'first_weigh',   icon: '⚖️', name: 'On the Scale',    desc: 'Log your weight',               test: () => state.weights.length >= 1 },
  { id: 'protein_goal',  icon: '🍗', name: 'Protein Packed',  desc: 'Hit your daily protein target', test: () => { const p = proteinTargetG(); return p && dayTotals(TODAY).protein >= p; } },
  { id: 'food_log',      icon: '🥗', name: 'Food Logger',     desc: 'Log food in a day',             test: () => Object.values(state.days).some(d => (d.food || []).length > 0) },
  { id: 'hydrated',      icon: '💧', name: 'Hydrated',        desc: 'Hit your daily water goal',     test: () => waterOf(TODAY) >= (state.waterGoalMl || 3000) },
  { id: 'photo1',        icon: '📸', name: 'Picture Day',     desc: 'Add a progress photo',          test: () => state.photos.length >= 1 },
  { id: 'measured',      icon: '📐', name: 'Measured Up',     desc: 'Log body measurements',         test: () => state.measurements.length >= 1 },
  { id: 'all_goals',     icon: '✅', name: 'Perfect Day',     desc: 'Finish all of a day\'s goals',  test: () => Object.values(state.days).some(d => d.goals && d.goals.length && d.goals.every(g => g.done)) },
  { id: 'goal_weight',   icon: '🎯', name: 'Goal Crusher',    desc: 'Reach your goal weight',        test: () => { const w = latestWeightKg(); return w != null && state.profile.goalWeight && Math.abs(w - toKg(state.profile.goalWeight)) < 0.5; } }
];
function checkAchievements() {
  const newly = [];
  ACHIEVEMENTS.forEach(a => {
    try { if (!state.achievements[a.id] && a.test()) { state.achievements[a.id] = TODAY; newly.push(a); } }
    catch (e) { /* ignore */ }
  });
  if (newly.length) {
    newly.forEach(a => notify('🏅 Achievement unlocked!', `${a.icon} ${a.name} — ${a.desc}`));
    if (el('view-achievements') && el('view-achievements').classList.contains('active')) renderAchievements();
  }
}
function renderAchievements() {
  const grid = el('badgeGrid');
  if (!grid) return;
  grid.innerHTML = '';
  let unlocked = 0;
  ACHIEVEMENTS.forEach(a => {
    const got = !!state.achievements[a.id];
    if (got) unlocked++;
    const div = document.createElement('div');
    div.className = 'badge ' + (got ? 'unlocked' : 'locked');
    div.innerHTML = `${got ? '<span class="badge-tick">✅</span>' : ''}
      <div class="badge-icon">${a.icon}</div>
      <div class="badge-name">${a.name}</div>
      <div class="badge-desc">${escapeHtml(a.desc)}</div>`;
    grid.appendChild(div);
  });
  el('achSummary').textContent = `${unlocked} of ${ACHIEVEMENTS.length} badges unlocked — keep going! 💪`;
}

/* ============================================================
   Share / install the app
   ============================================================ */
const APP_URL = 'https://varunkar2003.github.io/dream_gymbuddy/';
function openShare() {
  el('shareLink').value = APP_URL;
  el('shareQr').src = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=12&data=' + encodeURIComponent(APP_URL);
  el('shareModal').classList.add('show');
}

/* ============================================================
   Event wiring — new features
   ============================================================ */
el('themeToggle').addEventListener('click', toggleTheme);
el('shareAppBtn').addEventListener('click', openShare);

// Workouts
el('addExBtn').addEventListener('click', addDraftExercise);
el('newExName').addEventListener('keydown', e => { if (e.key === 'Enter') addDraftExercise(); });
el('saveWorkoutBtn').addEventListener('click', saveWorkout);

// Rest timer
el('timerStartBtn').addEventListener('click', startTimer);
el('timerResetBtn').addEventListener('click', resetTimer);
document.querySelectorAll('.timer-presets .chip').forEach(c =>
  c.addEventListener('click', () => {
    stopTimer();
    timerState.total = +c.dataset.rest;
    timerState.remaining = timerState.total;
    el('timerStartBtn').textContent = '▶ Start';
    el('timerDisplay').classList.remove('ringing');
    renderTimer();
    document.querySelectorAll('.timer-presets .chip').forEach(x => x.classList.toggle('active', x === c));
  }));

// Share modal
el('shareClose').addEventListener('click', () => el('shareModal').classList.remove('show'));
el('shareModal').addEventListener('click', e => { if (e.target === el('shareModal')) el('shareModal').classList.remove('show'); });
el('copyLinkBtn').addEventListener('click', () => {
  if (navigator.clipboard) navigator.clipboard.writeText(APP_URL).then(() => flash(el('copyLinkBtn'), 'Copied ✓'));
  else { el('shareLink').select(); document.execCommand('copy'); flash(el('copyLinkBtn'), 'Copied ✓'); }
});
el('nativeShareBtn').addEventListener('click', () => {
  if (navigator.share) navigator.share({ title: 'Dream — your gym buddy', text: 'Track gym, steps, calories & more with me on Dream!', url: APP_URL }).catch(() => {});
  else { el('shareLink').select(); document.execCommand('copy'); alert('Link copied — paste it to a friend!'); }
});

/* ============================================================
   Habits — water, sleep, mood
   ============================================================ */
function waterOf(key) { return (state.days[key] && state.days[key].water) || 0; }
function addWater(ml) {
  const d = getDay(TODAY);
  d.water = Math.max(0, (d.water || 0) + ml);
  render(); renderHabits();
}
const MOODS = [
  { v: 1, e: '😫', l: 'Drained' }, { v: 2, e: '😕', l: 'Meh' },
  { v: 3, e: '😐', l: 'Okay' }, { v: 4, e: '🙂', l: 'Good' }, { v: 5, e: '😄', l: 'Great' }
];
function renderHabits() {
  const goal = state.waterGoalMl || 3000;
  const w = waterOf(TODAY);
  el('waterVal').textContent = w;
  el('waterPill').textContent = `${(w / 1000).toFixed(1)} / ${(goal / 1000).toFixed(1)} L`;
  el('waterPill').className = 'balance-pill' + (w >= goal ? ' deficit' : '');
  setRing('waterRing', w / goal, w >= goal ? 'var(--accent-2)' : 'var(--accent)');
  el('waterGoalInput').value = goal;

  const d = getDay(TODAY);
  el('sleepVal').textContent = d.sleep ? d.sleep : '—';

  // sleep chips 4–10h
  const sb = el('sleepBtns'); sb.innerHTML = '';
  for (let h = 4; h <= 10; h++) {
    const b = document.createElement('button');
    b.className = 'chip' + (d.sleep === h ? ' active' : '');
    b.textContent = h + 'h';
    b.addEventListener('click', () => { getDay(TODAY).sleep = h; save(); renderHabits(); });
    sb.appendChild(b);
  }
  // mood
  const mr = el('moodRow'); mr.innerHTML = '';
  MOODS.forEach(m => {
    const b = document.createElement('button');
    b.className = 'mood-btn' + (d.mood === m.v ? ' active' : '');
    b.textContent = m.e;
    b.addEventListener('click', () => { getDay(TODAY).mood = m.v; save(); renderHabits(); });
    mr.appendChild(b);
  });
  const sel = MOODS.find(m => m.v === d.mood);
  el('moodLabel').textContent = sel ? sel.l + ' today' : 'How do you feel today?';

  renderWaterChart();
}
function renderWaterChart() {
  const chart = el('waterChart'); if (!chart) return;
  chart.innerHTML = '';
  const now = new Date(); const start = new Date(now); start.setDate(now.getDate() - now.getDay());
  const goal = state.waterGoalMl || 3000;
  let tot = 0, c = 0;
  for (let i = 0; i < 7; i++) {
    const dt = new Date(start); dt.setDate(start.getDate() + i);
    const key = ymd(dt); const v = waterOf(key);
    if (v > 0) { tot += v; c++; }
    const bar = document.createElement('div');
    bar.className = 'chart-bar' + (v >= goal ? ' goal-hit' : '');
    bar.style.height = Math.max(4, Math.min(100, v / goal * 100)) + '%';
    bar.innerHTML = `<span>${(v / 1000).toFixed(1)}L</span>`;
    bar.title = `${key}: ${v} ml`;
    chart.appendChild(bar);
  }
  el('habitWeekNote').textContent = c ? `Average ${Math.round(tot / c).toLocaleString()} ml/day this week.` : 'Log water to see your week.';
}

/* ============================================================
   Body — measurements + progress photos
   ============================================================ */
const fromCm = c => state.profile.units === 'imperial' ? c / 2.54 : c;
const MEASURE_PARTS = [
  { k: 'chest', label: 'Chest' }, { k: 'waist', label: 'Waist' }, { k: 'hips', label: 'Hips' },
  { k: 'biceps', label: 'Biceps' }, { k: 'thighs', label: 'Thighs' }, { k: 'shoulders', label: 'Shoulders' },
  { k: 'neck', label: 'Neck' }, { k: 'calves', label: 'Calves' }
];
function latestMeasure() { return state.measurements.length ? state.measurements[state.measurements.length - 1] : null; }
function measureValue(entry, k) { return entry && entry.parts && entry.parts[k] != null ? entry.parts[k] : null; }

function renderBody() { renderMeasureInputs(); renderMeasureCompare(); renderPhotos(); }

function renderMeasureInputs() {
  const box = el('measureInputs'); if (!box) return;
  box.innerHTML = '';
  const latest = latestMeasure();
  MEASURE_PARTS.forEach(p => {
    const v = measureValue(latest, p.k);
    const wrap = document.createElement('label');
    wrap.className = 'fld';
    wrap.innerHTML = `<span>${p.label} (${lenUnit()})</span>
      <input data-k="${p.k}" type="number" inputmode="decimal" placeholder="${v != null ? round1(fromCm(v)) : '—'}" />`;
    box.appendChild(wrap);
  });
}
function saveMeasurements() {
  const parts = {}; let any = false;
  el('measureInputs').querySelectorAll('input').forEach(inp => {
    const val = +inp.value;
    if (val > 0) { parts[inp.dataset.k] = toCm(val); any = true; }
  });
  if (!any) { alert('Enter at least one measurement.'); return; }
  const latest = latestMeasure();
  const merged = Object.assign({}, latest ? latest.parts : {}, parts);
  state.measurements = state.measurements.filter(m => m.date !== TODAY);
  state.measurements.push({ date: TODAY, parts: merged });
  state.measurements.sort((a, b) => a.date.localeCompare(b.date));
  save(); render(); renderBody();
  flash(el('saveMeasure'), 'Saved ✓');
}
function renderMeasureCompare() {
  const box = el('measureCompare'); if (!box) return;
  if (!state.measurements.length) { box.innerHTML = '<div class="log-empty">No measurements yet.</div>'; return; }
  const first = state.measurements[0], last = state.measurements[state.measurements.length - 1];
  let html = '';
  MEASURE_PARTS.forEach(p => {
    const lv = measureValue(last, p.k);
    if (lv == null) return;
    const fv = measureValue(first, p.k);
    let diffTxt = '';
    if (fv != null) {
      const diff = fromCm(lv - fv);
      diffTxt = Math.abs(diff) < 0.1 ? '· same' : `${diff < 0 ? '▼' : '▲'} ${Math.abs(round1(diff))}`;
    }
    html += `<div class="calc-row"><span>${p.label}</span><b>${round1(fromCm(lv))} ${lenUnit()} <small class="muted">${diffTxt}</small></b></div>`;
  });
  box.innerHTML = html || '<div class="log-empty">No measurements yet.</div>';
}

function addPhotoFromFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const max = 900;
      let w = img.width, h = img.height;
      if (w > h && w > max) { h = Math.round(h * max / w); w = max; }
      else if (h > max) { w = Math.round(w * max / h); h = max; }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      let data;
      try { data = canvas.toDataURL('image/jpeg', 0.7); } catch (e) { data = reader.result; }
      state.photos.push({ id: uid(), date: TODAY, data, weightKg: latestWeightKg() });
      if (!save()) { state.photos.pop(); alert('Storage is full — delete some photos before adding more.'); return; }
      render(); renderPhotos();
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}
function renderPhotos() {
  const grid = el('photoGrid'); if (!grid) return;
  grid.innerHTML = '';
  if (!state.photos.length) { grid.innerHTML = '<div class="log-empty">No photos yet — add your first progress pic!</div>'; return; }
  [...state.photos].reverse().forEach(p => {
    const card = document.createElement('div');
    card.className = 'photo-card';
    const d = parseYmd(p.date);
    const wt = p.weightKg != null ? ` · ${round1(fromKg(p.weightKg))}${wtUnit()}` : '';
    card.innerHTML = `<img src="${p.data}" alt="progress photo" />
      <div class="photo-meta"><span>${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' })}${wt}</span>
      <button class="photo-del" title="Delete">✕</button></div>`;
    card.querySelector('.photo-del').addEventListener('click', () => {
      if (confirm('Delete this photo?')) { state.photos = state.photos.filter(x => x !== p); save(); render(); renderPhotos(); }
    });
    grid.appendChild(card);
  });
}

/* ============================================================
   Backup — export / import
   ============================================================ */
function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'dream-backup-' + TODAY + '.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function importData(file) {
  if (!file) return;
  const r = new FileReader();
  r.onload = () => {
    let data;
    try { data = JSON.parse(r.result); } catch (e) { alert('That file is not a valid Dream backup.'); return; }
    if (!data || typeof data !== 'object' || !('days' in data)) { alert('That file is not a valid Dream backup.'); return; }
    if (!confirm('This replaces your current data with the backup. Continue?')) return;
    state = Object.assign(defaultState(), data);
    save(); applyTheme(); render(); renderQuickFood(); showView('dashboard');
    alert('Backup restored! 🎉');
  };
  r.readAsText(file);
}

/* ============================================================
   Event wiring — habits, body, backup, dashboard share, food search
   ============================================================ */
document.querySelectorAll('.water-btns .chip').forEach(c =>
  c.addEventListener('click', () => addWater(+c.dataset.water)));
el('saveWaterGoal').addEventListener('click', () => {
  const n = +el('waterGoalInput').value;
  if (!n) return;
  state.waterGoalMl = Math.round(n);
  save(); renderHabits();
  flash(el('saveWaterGoal'), 'Saved ✓');
});

el('saveMeasure').addEventListener('click', saveMeasurements);
el('addPhotoBtn').addEventListener('click', () => el('photoFile').click());
el('photoFile').addEventListener('change', e => { addPhotoFromFile(e.target.files[0]); e.target.value = ''; });

el('exportBtn').addEventListener('click', exportData);
el('importBtn').addEventListener('click', () => el('importFile').click());
el('importFile').addEventListener('change', e => { importData(e.target.files[0]); e.target.value = ''; });

el('dashShareBtn').addEventListener('click', openShare);
el('foodSearch').addEventListener('input', e => { foodFilter = e.target.value; renderQuickFood(); });

/* ============================================================
   Boot
   ============================================================ */
applyTheme();
renderQuickFood();
render();
showView('dashboard');
maybeRemind();
Social.init();
// Re-check the reminder periodically while the app/PWA stays open
setInterval(maybeRemind, 15 * 60 * 1000);

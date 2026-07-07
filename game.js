'use strict';

// ═══════════════════════════════════════════════════════════════
// SUPABASE AUTH
// ═══════════════════════════════════════════════════════════════

let _supa = null;       // Supabase client, initialised async
let _currentUser = null;

async function initSupabase() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) return;
    const { supabaseUrl, supabaseAnonKey } = await res.json();
    if (!supabaseUrl || !supabaseAnonKey) return;
    _supa = supabase.createClient(supabaseUrl, supabaseAnonKey);

    // Auth state listener — fires on login, logout, and token refresh
    _supa.auth.onAuthStateChange((event, session) => {
      _currentUser = session?.user || null;
      _updateAuthUI();
      // After an OAuth redirect the user lands back on the menu.
      // If they had a pending score saved, restore the ending screen.
      if (event === 'SIGNED_IN') {
        const raw = sessionStorage.getItem('heatgame_ending');
        if (raw) {
          sessionStorage.removeItem('heatgame_ending');
          _restoreEndingScreen(JSON.parse(raw));
        }
      }
    });

    const { data: { session } } = await _supa.auth.getSession();
    _currentUser = session?.user || null;
    _updateAuthUI();
  } catch (e) {
    // Auth unavailable — game still fully playable, leaderboard submit disabled
    console.warn('Supabase auth unavailable:', e);
  }
}

async function signIn(provider) {
  if (!_supa) return;
  // Persist the ending screen data so we can restore it after the OAuth redirect
  const endingData = _captureEndingState();
  if (endingData) sessionStorage.setItem('heatgame_ending', JSON.stringify(endingData));
  await _supa.auth.signInWithOAuth({
    provider,
    options: { redirectTo: window.location.origin },
  });
}

async function signOut() {
  if (!_supa) return;
  await _supa.auth.signOut();
}

function _updateAuthUI() {
  const menuWidget = el('auth-status-menu');
  if (menuWidget) {
    if (_currentUser) {
      const name = _currentUser.user_metadata?.full_name
                || _currentUser.user_metadata?.user_name
                || _currentUser.email || 'Player';
      const provider = _currentUser.app_metadata?.provider || '';
      const icon = provider === 'github' ? '⚫' : provider === 'google' ? '🔵' : '✓';
      menuWidget.innerHTML = `
        <div class="auth-menu-signed-in">
          ${icon} Signed in as <strong>${esc(name)}</strong>
          — scores will be saved automatically.
          <button class="auth-btn-small" id="menu-signout-btn">Sign out</button>
        </div>`;
      el('menu-signout-btn')?.addEventListener('click', signOut);
    } else {
      menuWidget.innerHTML = `
        <div class="auth-menu-prompt">
          <span class="auth-menu-label">Sign in to save scores to the leaderboard:</span>
          <div class="auth-btns">
            <button class="auth-oauth-btn" id="menu-google-btn">🔵 Sign in with Google</button>
            <button class="auth-oauth-btn" id="menu-github-btn">⚫ Sign in with GitHub</button>
          </div>
        </div>`;
      el('menu-google-btn')?.addEventListener('click', () => signIn('google'));
      el('menu-github-btn')?.addEventListener('click', () => signIn('github'));
    }
  }
  _updateEndingAuthUI();
}

function _updateEndingAuthUI() {
  const prompt = el('auth-prompt');
  const form   = el('submit-form');
  if (!prompt || !form) return;
  if (_currentUser) {
    const name = (_currentUser.user_metadata?.full_name
               || _currentUser.user_metadata?.user_name
               || '').slice(0, 16);
    const provider = _currentUser.app_metadata?.provider || 'oauth';
    el('auth-user-info').textContent = `Signed in via ${provider}: ${name || _currentUser.email}`;
    el('player-name-input').value = name;
    prompt.classList.add('hidden');
    form.classList.remove('hidden');
  } else {
    prompt.classList.remove('hidden');
    form.classList.add('hidden');
  }
}

function _captureEndingState() {
  const ps = window._pendingScore;
  if (!ps) return null;
  return {
    emoji:   el('ending-emoji')?.textContent   || '',
    title:   el('ending-title')?.textContent   || '',
    flavour: el('ending-flavour')?.textContent || '',
    deaths:  el('sc-deaths')?.textContent      || '0',
    co2:     el('sc-co2')?.textContent         || '0%',
    econ:    el('sc-econ')?.textContent        || '€0M',
    approval:el('sc-approval')?.textContent    || '0%',
    score:   el('sc-score')?.textContent       || '0',
    country: ps.country,
    pending: ps,
  };
}

function _restoreEndingScreen(data) {
  el('ending-emoji').textContent     = data.emoji;
  el('ending-title').textContent     = data.title;
  el('ending-flavour').textContent   = data.flavour;
  el('sc-deaths').textContent        = data.deaths;
  el('sc-co2').textContent           = data.co2;
  el('sc-econ').textContent          = data.econ;
  el('sc-approval').textContent      = data.approval;
  el('sc-score').textContent         = data.score;
  el('lb-country-label').textContent = COUNTRIES[data.country]?.name || data.country;
  window._pendingScore               = data.pending;

  el('menu-screen').style.display = 'none';
  el('menu-screen').classList.remove('active');
  el('ending-screen').classList.remove('hidden');
  el('ending-screen').style.display = 'flex';
  el('lb-rank-result').classList.add('hidden');

  _updateEndingAuthUI();
  loadLeaderboard(data.country, 'lb-list');
}

// ═══════════════════════════════════════════════════════════════
// PART 1: CONFIG, PROFILES, TILES, CITY GENERATION, STATE
// ═══════════════════════════════════════════════════════════════

const CFG = {
  GRID:          20,
  POP:           500_000,
  DAYS:          30,
  // Real-time: each PHASE takes PHASE_MS ms. 3 phases = 1 day.
  PHASE_MS:      7000,   // 7s per phase → 21s per day at ×1 speed
  TICK_MS:       250,    // simulation tick interval

  BASE_DEMAND_MW: 1800,
  // 500k pop / 2.4 per household ≈ 208,000 households; 1% = ~2,080 units × 2.5kW ≈ 5.2 MW
  AC_MW_PER_PCT:  5,     // MW per 1% AC penetration at 500k pop
  DC_BASE_MW:     80,
  DC_HOT_MW_PER_DEG: 20, // extra MW per °C above 30°C

  CO2_BUDGET:    60_800, // tonnes, 30-day Paris-aligned energy budget
  CO2_COAL:      0.820,  // tCO₂/MWh
  CO2_GAS:       0.490,

  WORKFORCE:     0.55,
  PARENT_FRAC:   0.38,
  WAGE_EUR_DAY:  120,    // avg wage per worker per day

  MAX_DEATHS:    5000,
  MAX_ECON_M:    500,

  CANVAS_W:      820,
  CANVAS_H:      490,
  ISO_SCALE:     16,
  GRID_OFFSET:   10,     // center grid at origin ± GRID/2
};

// ───────────────────────────────────────────
// COUNTRY PROFILES
// ───────────────────────────────────────────
const COUNTRIES = {
  UK: {
    name: 'United Kingdom', flag: '🇬🇧',
    acStart: 0.05,
    grid: { coal: 500, gas: 650, nuclear: 350, wind: 500, solar: 420, hydro:  80 },
  },
  FR: {
    name: 'France', flag: '🇫🇷',
    acStart: 0.25,
    // Gas at 750 MW — France operates combined-cycle gas peakers as emergency
    // backup when nuclear is curtailed. They never mention it in press releases.
    grid: { coal:   0, gas: 750, nuclear:1600, wind: 350, solar: 380, hydro: 250 },
  },
  DE: {
    name: 'Germany', flag: '🇩🇪',
    acStart: 0.08,
    grid: { coal: 850, gas: 400, nuclear:   0, wind: 750, solar: 700, hydro: 150 },
  },
  ES: {
    name: 'Spain', flag: '🇪🇸',
    acStart: 0.85,
    grid: { coal: 150, gas: 500, nuclear: 300, wind: 900, solar:1800, hydro: 120 },
  },
};

// ───────────────────────────────────────────
// TILE DEFINITIONS  [r, g, b], height, label
// ───────────────────────────────────────────
const TILE = {
  road:             { c: [100, 100, 110], h: 0.08, lbl: 'Road' },
  residential_low:  { c: [200, 165, 130], h: 0.70, lbl: 'Housing' },
  residential_high: { c: [130, 165, 200], h: 1.80, lbl: 'Flats' },
  office:           { c: [ 90, 140, 200], h: 2.60, lbl: 'Offices' },
  factory:          { c: [160, 110,  85], h: 1.30, lbl: 'Factory' },
  hospital:         { c: [235, 235, 240], h: 1.50, lbl: 'Hospital' },
  school:           { c: [240, 200,  75], h: 0.90, lbl: 'School' },
  park:             { c: [ 80, 145,  80], h: 0.06, lbl: 'Park' },
  stadium:          { c: [ 90, 175,  90], h: 0.80, lbl: 'Stadium' },
  datacenter:       { c: [175, 185, 195], h: 0.95, lbl: 'Data Center' },
  power_coal:       { c: [ 70,  70,  75], h: 1.50, lbl: 'Coal Plant' },
  power_gas:        { c: [185, 120,  55], h: 1.20, lbl: 'Gas Plant' },
  power_nuclear:    { c: [200, 210, 215], h: 2.00, lbl: 'Nuclear' },
  power_wind:       { c: [215, 228, 235], h: 0.25, lbl: 'Wind Farm' },
  power_solar:      { c: [ 35,  55, 120], h: 0.18, lbl: 'Solar Farm' },
  power_hydro:      { c: [ 55, 115, 200], h: 1.00, lbl: 'Hydro' },
};

// ───────────────────────────────────────────
// SEEDED PRNG (Mulberry32)
// ───────────────────────────────────────────
function mkRng(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ───────────────────────────────────────────
// CITY GENERATION
// ───────────────────────────────────────────
function generateCity(country, seed = 42) {
  const rng = mkRng(seed);
  const G = CFG.GRID;
  // grid[col][row] — col is x-axis, row is y-axis
  const grid = Array.from({ length: G }, () => Array(G).fill('road'));

  // Roads on every 5th line (axis 0, 5, 10, 15, 19)
  // Everything else gets a zone tile, leaving roads as-is

  const fill = (x1, y1, x2, y2, primary, alt) => {
    for (let x = x1; x < x2; x++)
      for (let y = y1; y < y2; y++)
        if (x % 5 !== 0 && y % 5 !== 0)
          grid[x][y] = rng() < 0.82 ? primary : (alt || primary);
  };

  // Quadrant zones
  fill(1, 1, 10, 10, 'residential_low',  'park');
  fill(10, 1, 19, 10, 'residential_high', 'residential_low');
  fill(1, 10, 10, 19, 'factory',          'road');
  fill(10, 10, 19, 19, 'office',          'office');

  // Extra parks scattered in residential
  for (let i = 0; i < 10; i++) {
    const x = 1 + Math.floor(rng() * 9);
    const y = 1 + Math.floor(rng() * 9);
    grid[x][y] = 'park';
  }

  // Place singleton specials — try zone, fall back anywhere non-road
  const place = (x1, y1, x2, y2, type) => {
    for (let a = 0; a < 60; a++) {
      const x = x1 + Math.floor(rng() * (x2 - x1));
      const y = y1 + Math.floor(rng() * (y2 - y1));
      if (grid[x][y] !== 'road' && !['hospital','school','stadium','datacenter'].includes(grid[x][y])) {
        grid[x][y] = type;
        return;
      }
    }
  };

  place(1, 1, 9, 9, 'hospital');
  place(11, 1, 18, 9, 'hospital');
  place(11, 11, 18, 18, 'hospital');
  for (let i = 0; i < 4; i++) place(1, 1, 18, 9, 'school');
  place(1, 11, 9, 18, 'stadium');
  place(1, 11, 9, 18, 'datacenter');

  // Power plants at known corners/edges (so they're always visible)
  const profile = COUNTRIES[country];
  const sources = Object.entries(profile.grid)
    .filter(([, mw]) => mw > 0)
    .map(([src]) => `power_${src}`);
  const spots = [
    [0, 0], [19, 0], [0, 19], [19, 19],
    [0, 9], [9, 0], [19, 9], [9, 19],
  ];
  sources.forEach((s, i) => { if (i < spots.length) grid[spots[i][0]][spots[i][1]] = s; });

  return grid;
}

// ═══════════════════════════════════════════════════════════════
// PART 2: STATE + SIMULATION EQUATIONS
// ═══════════════════════════════════════════════════════════════

// ── Mutable game state (reset on each new game) ──────────────
let S = {};

function resetState(country) {
  const p = COUNTRIES[country];
  S = {
    country, profile: p,
    city: generateCity(country),
    day: 1, phase: 0, gameOver: false, paused: false, speed: 1,

    // Environment
    temp: 18, riverLevel: 1.0,

    // Power
    sources: { ...p.grid },         // current output per source (MW)
    powerSupply: 0, powerDemand: 0, loadFactor: 0,
    gridStatus: 'green',             // green | yellow | red | black
    coalOn: true, gasOn: true,

    // Policy toggles
    acPolicy: 'free',
    acCoverage: p.acStart,
    blackoutsOn: false,
    coolingCentresOpen: false,
    warningsOn: false,
    schoolPolicy: 'open',
    schoolsOpen: true,
    schoolStrikeDays: 0,
    retrofitDaysLeft: 0,
    retrofitComplete: false,
    dcThrottle: 100,          // 0–100 % of full data-centre load
    budgetM: 100,                    // €M available for spending

    // Yogurt Windows policy
    yogurtOn: false,
    yogurtPhases: 0,    // phases yogurt has been applied (bees scale with this)
    beeAttackActive: false,

    // Extra actions (unlocked mid-game)
    gridImportOn: false,        // EU emergency power import
    gridImportDaysLeft: 0,      // days remaining on import deal
    industrySheddingOn: false,  // mandatory industrial load reduction
    wfhOrderOn: false,          // work-from-home mandate
    surgeCapacityOn: false,     // hospital surge capacity deployed

    // Cumulative stats
    deaths: 0,
    deathsThisPhase: 0,
    co2Emitted: 0,                   // tonnes
    econLossM: 0,
    approval: 72,

    // Internals
    lastEventDay: -1,
    firedEvents: new Set(),
    phaseMs: 0,                      // ms elapsed in current phase
  };
}

// ───────────────────────────────────────────
// TEMPERATURE MODEL
// ───────────────────────────────────────────
// Heat wave curve: °C above base 18°C
function heatDelta(day) {
  if (day <= 4)  return (day - 1) * 1.0;
  if (day <= 8)  return 3 + (day - 4) * 2.75;
  if (day <= 15) return 14 + (day - 8) * 0.9;
  if (day <= 22) return 20.3 - (day - 15) * 1.2;
  return Math.max(0, 11.9 - (day - 22) * 1.6);
}

// Phase modifier: morning −3°C, noon +3°C, night −2°C
// (+5 originally overshot — spec says 35-38°C is the mean, not the noon peak)
const PHASE_OFF = [-3, 3, -2];

function calcTemp(day, phase) {
  return Math.round((18 + heatDelta(day) + PHASE_OFF[phase]) * 10) / 10;
}

// ───────────────────────────────────────────
// POWER GRID MODEL
// ───────────────────────────────────────────
function anticycloneStrength(day) {
  if (day < 7)  return 0;
  if (day <= 15) return Math.min(1, (day - 7) / 5);
  if (day <= 22) return Math.max(0, 1 - (day - 15) / 7);
  return 0;
}

function computePower(T, day) {
  const p = S.profile;
  const AC = anticycloneStrength(day);
  const rL = Math.max(0.1, 1 - 0.05 * Math.max(0, day - 7));
  // River temperature responds to the sustained heat wave level (mean
  // daily air temp, not the noisy per-phase reading) — this prevents
  // nuclear curtailment from firing spuriously during a cool morning or
  // mild Day 1 noon when the river itself hasn't warmed yet.
  const Tmean = 18 + heatDelta(day);
  const riverTemp = 14 + 0.5 * Tmean;

  // Renewables
  const irr = 0.6 + 0.4 * Math.sin(Math.PI * day / 30);
  const panelEff = Math.max(0.6, 1 - 0.004 * Math.max(0, (T + 20) - 25));
  const solar = p.grid.solar * irr * panelEff;
  const wind  = p.grid.wind * (1 - 0.4 * AC);
  const hydro = p.grid.hydro * rL;

  // Nuclear (curtailed >23°C river)
  let nuclear = p.grid.nuclear;
  // Nuclear curtailment above 23°C river temp. Floor 0.40 (60% max reduction):
  // 2022 France cut ~8–30% in practice; 60% models a severe multi-reactor crisis.
  if (riverTemp > 23) nuclear *= Math.max(0.40, (27 - riverTemp) / 4);
  nuclear = Math.max(0, nuclear);

  // Fossil (player controlled)
  const coal = S.coalOn ? p.grid.coal : 0;
  const gas  = S.gasOn  ? p.grid.gas  : 0;
  // EU emergency import: +350 MW from the interconnect (satirically,
  // neighbours are also in a heatwave but they answer the phone)
  const importMW = S.gridImportOn && S.gridImportDaysLeft > 0 ? 350 : 0;

  const supply = solar + wind + hydro + nuclear + coal + gas + importMW;

  // Demand
  const dcLoad = (CFG.DC_BASE_MW + Math.max(0, T - 30) * CFG.DC_HOT_MW_PER_DEG) * (S.dcThrottle / 100);
  const acLoad = S.acCoverage * 100 * CFG.AC_MW_PER_PCT;
  const heatFactor = 1 + 0.025 * Math.max(0, T - 20);
  const schoolExtra = S.schoolsOpen ? 0 : 15;
  const demand = CFG.BASE_DEMAND_MW * heatFactor + acLoad + dcLoad + schoolExtra;

  // Yogurt windows: evaporative cooling reduces AC load slightly
  const yogurtSaving = S.yogurtOn ? 30 : 0;
  // Industrial shedding: mandatory 20% cut to factory/office power
  const industrySave = S.industrySheddingOn ? 180 : 0;
  // WFH order: offices empty, AC demand growth halved (already baked into
  // acCoverage cap in the adoption model), small direct saving
  const wfhSave = S.wfhOrderOn ? 60 : 0;

  // Blackouts: shed up to 15% of demand (non-hospital zones)
  const shed = S.blackoutsOn ? demand * 0.15 : 0;
  const effectiveDemand = demand - shed - yogurtSaving - industrySave - wfhSave;

  const lf = effectiveDemand / Math.max(1, supply);

  // CO₂ for this tick (8h per phase / 3 for per-phase)
  const coalMWh = coal * 8;
  const gasMWh  = gas  * 8;
  S.co2Emitted += (coalMWh * CFG.CO2_COAL + gasMWh * CFG.CO2_GAS) / 1000;

  S.sources = {
    coal: Math.round(coal), gas: Math.round(gas),
    nuclear: Math.round(nuclear), wind: Math.round(wind),
    solar: Math.round(solar), hydro: Math.round(hydro),
  };
  S.powerSupply  = Math.round(supply);
  S.powerDemand  = Math.round(effectiveDemand);
  S.loadFactor   = lf;
  S.riverLevel   = rL;

  if      (lf < 0.85) S.gridStatus = 'green';
  else if (lf < 0.92) S.gridStatus = 'yellow';
  else if (lf < 1.00) S.gridStatus = 'red';
  else                S.gridStatus = 'black';
}

// ───────────────────────────────────────────
// MORTALITY MODEL
// ───────────────────────────────────────────
// Returns excess deaths per phase (= per 8 hours)
function computeDeaths(T) {
  // Base rate per 100k population per day
  let basePerDay = 0;
  if      (T < 30) basePerDay = 0;
  else if (T < 32) basePerDay = (T - 30) * 0.75;
  else if (T < 35) basePerDay = 1.5 + (T - 32) * 1.167;
  else if (T < 38) basePerDay = 5.0 + (T - 35) * 2.5;
  else             basePerDay = 12.5 + (T - 38) * 3.0;

  // Mitigations
  const acM       = S.acCoverage * 0.70;
  const coolingM  = S.coolingCentresOpen ? 0.45 * (1 - S.acCoverage) : 0;
  const warningM  = S.warningsOn ? 0.20 : 0;

  // Hospital strain multiplier — surge capacity (field hospitals + extra
  // generators) dramatically cuts the blackout death spike
  const strainMap = { green: 1.0, yellow: 1.1, red: 1.6, black: 2.5 };
  let strain = strainMap[S.gridStatus] || 1;
  if (S.blackoutsOn)    strain = Math.min(strain, 1.2); // hospitals exempt from rolling blackouts
  if (S.surgeCapacityOn) strain = Math.min(strain, 1.3); // surge: generators everywhere

  const mitFactor = Math.max(0.05, (1 - acM) * (1 - coolingM) * (1 - warningM));
  const deathsPerDay = (CFG.POP / 100_000) * basePerDay * mitFactor * strain;

  // Bee-attack deaths: anaphylaxis from bee stings draws hospital capacity,
  // compounding heat deaths. Bees are happiest when it's warm and someone
  // has smeared yogurt on every window in the city.
  const beeDeaths = S.beeAttackActive
    ? 0.15 * Math.max(1, strain) * (1 + Math.max(0, S.temp - 22) / 20)
    : 0;

  return (deathsPerDay + beeDeaths) / 3; // per phase
}

// ───────────────────────────────────────────
// ECONOMIC LOSS
// ───────────────────────────────────────────
// Returns €M lost this phase
function computeEcon(T) {
  const officeProd  = Math.max(0.5, 1 - 0.04 * Math.max(0, T - 25));
  const outdoorProd = Math.max(0.2, 1 - 0.07 * Math.max(0, T - 25));
  const parentProd  = S.schoolsOpen ? officeProd : 0.40;

  const workers  = CFG.POP * CFG.WORKFORCE;
  const parentW  = workers * CFG.PARENT_FRAC;
  const otherW   = workers * (1 - CFG.PARENT_FRAC);

  // ~60% office, ~40% outdoor/factory (rough split)
  const officeW  = otherW  * 0.6;
  const outdoorW = otherW  * 0.4;

  const lossPerDay =
    officeW  * CFG.WAGE_EUR_DAY * (1 - officeProd)  +
    outdoorW * CFG.WAGE_EUR_DAY * (1 - outdoorProd) +
    parentW  * CFG.WAGE_EUR_DAY * (1 - parentProd);

  // Blackouts add extra economic cost
  const blackoutCost = S.blackoutsOn ? 2.0 : 0;

  return (lossPerDay / 3 / 1_000_000) + blackoutCost;
}

// ───────────────────────────────────────────
// APPROVAL
// ───────────────────────────────────────────
function updateApproval(deathsPhase) {
  let d = 0;
  d -= deathsPhase * 0.04;
  if (S.gridStatus === 'yellow') d -= 0.3;
  if (S.gridStatus === 'red')    d -= 1.2;
  if (S.gridStatus === 'black')  d -= 2.8;
  if (S.warningsOn)              d += 0.2;
  if (S.coolingCentresOpen)      d += 0.4;
  if (S.acPolicy === 'ban')      d -= 1.5;
  if (!S.schoolsOpen)            d -= 0.3;
  if (S.schoolStrikeDays > 0)    d -= 1.2;
  if (S.blackoutsOn)             d -= 0.8;
  S.approval = Math.max(0, Math.min(100, S.approval + d));
}

// ═══════════════════════════════════════════════════════════════
// PART 3: RENDERER, UI, EVENTS, POLICIES, GAME LOOP
// ═══════════════════════════════════════════════════════════════

// ───────────────────────────────────────────
// RENDERER — custom Canvas 2D isometric
// (no external library required)
// ───────────────────────────────────────────
const ISO = {
  TW: 40,   // tile diamond total width  (half = 20)
  TH: 20,   // tile diamond total height (half = 10)
  UH: 18,   // wall height per 1 unit of building height
  OX: 410,  // canvas origin X  (canvas.width / 2)
  OY: 90,   // canvas origin Y  (adjusted so 20×20 grid fits vertically)

  // Grid (col, row, z) → canvas (x, y) for the diamond center at that height
  proj(col, row, z) {
    return {
      x: ISO.OX + (col - row) * (ISO.TW / 2),
      y: ISO.OY + (col + row) * (ISO.TH / 2) - z * ISO.UH,
    };
  },

  // Draw one isometric prism at grid (col, row) with height h, base color [r,g,b]
  prism(ctx, col, row, h, [r, g, b]) {
    const hw = ISO.TW / 2;
    const hh = ISO.TH / 2;
    const tp = ISO.proj(col, row, h);   // top-face center
    const bp = ISO.proj(col, row, 0);   // base center (z=0)

    // ── right side face (facing viewer's right, darkest) ──────
    if (h > 0.12) {
      ctx.fillStyle = `rgb(${Math.round(r * 0.53)},${Math.round(g * 0.53)},${Math.round(b * 0.53)})`;
      ctx.beginPath();
      ctx.moveTo(tp.x,       tp.y + hh);
      ctx.lineTo(tp.x + hw,  tp.y);
      ctx.lineTo(bp.x + hw,  bp.y);
      ctx.lineTo(bp.x,       bp.y + hh);
      ctx.closePath();
      ctx.fill();

      // ── left side face (medium shade) ─────────────────────
      ctx.fillStyle = `rgb(${Math.round(r * 0.70)},${Math.round(g * 0.70)},${Math.round(b * 0.70)})`;
      ctx.beginPath();
      ctx.moveTo(tp.x - hw,  tp.y);
      ctx.lineTo(tp.x,       tp.y + hh);
      ctx.lineTo(bp.x,       bp.y + hh);
      ctx.lineTo(bp.x - hw,  bp.y);
      ctx.closePath();
      ctx.fill();
    }

    // ── top face (full brightness) ─────────────────────────
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.beginPath();
    ctx.moveTo(tp.x,       tp.y - hh);  // top vertex
    ctx.lineTo(tp.x + hw,  tp.y);        // right vertex
    ctx.lineTo(tp.x,       tp.y + hh);  // bottom vertex
    ctx.lineTo(tp.x - hw,  tp.y);        // left vertex
    ctx.closePath();
    ctx.fill();

    // subtle edge line
    ctx.strokeStyle = 'rgba(0,0,0,0.13)';
    ctx.lineWidth = 0.5;
    ctx.stroke();
  },
};

let _canvas = null;
let _ctx    = null;

function renderCity() {
  if (!_canvas) {
    _canvas = document.getElementById('iso-canvas');
    _ctx    = _canvas.getContext('2d');
  }
  _ctx.clearRect(0, 0, _canvas.width, _canvas.height);

  const T   = S.temp;
  const G   = CFG.GRID;
  const heatI  = Math.min(1, Math.max(0, (T - 32) / 10));
  const darken = { green: 0, yellow: 0.05, red: 0.20, black: 0.65 }[S.gridStatus] ?? 0;

  // Back-to-front (ascending col+row sum = painter's algorithm for iso)
  for (let sum = 0; sum <= 2 * (G - 1); sum++) {
    for (let col = 0; col < G; col++) {
      const row = sum - col;
      if (row < 0 || row >= G) continue;

      const tileKey = S.city[col][row] || 'road';
      const td = TILE[tileKey] || TILE.road;
      let [r, g, b] = td.c;
      const h = td.h;

      // School closed → grey out school tiles
      if (tileKey === 'school' && !S.schoolsOpen) {
        r = Math.round(r * 0.65 + 70 * 0.35);
        g = Math.round(g * 0.65 + 70 * 0.35);
        b = Math.round(b * 0.65 + 70 * 0.35);
      }

      // Heat tint above 32°C: push warm
      if (heatI > 0) {
        r = Math.min(255, Math.round(r + heatI * 50));
        g = Math.max(0,   Math.round(g - heatI * 20));
        b = Math.max(0,   Math.round(b - heatI * 38));
      }

      // Brownout / blackout darkening
      if (darken > 0) {
        const f = 1 - darken;
        r = Math.round(r * f);
        g = Math.round(g * f);
        b = Math.round(b * f);
      }

      ISO.prism(_ctx, col, row, h, [r, g, b]);
    }
  }

  // Heat shimmer CSS overlay
  const heatEl = document.getElementById('heat-overlay');
  if (T > 34) {
    heatEl.style.display  = 'block';
    heatEl.style.opacity  = String(Math.min(0.85, (T - 34) / 6));
  } else {
    heatEl.style.display  = 'none';
  }

  // Blackout overlay
  document.getElementById('blackout-overlay').style.background =
    S.gridStatus === 'black' ? 'rgba(0,0,0,0.60)'
    : S.blackoutsOn ? 'rgba(0,0,0,0.16)'
    : 'rgba(0,0,0,0)';

  // Crisis banner
  const banner = document.getElementById('grid-crisis-banner');
  if (S.gridStatus === 'black') {
    banner.textContent = '⚡ GRID COLLAPSE — BLACKOUT IN PROGRESS';
    banner.classList.remove('hidden');
  } else if (S.gridStatus === 'red') {
    banner.textContent = '⚡ GRID OVERLOADED — ROLLING BROWNOUTS';
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

// ───────────────────────────────────────────
// UI UPDATES
// ───────────────────────────────────────────
function el(id) { return document.getElementById(id); }

function setBar(id, pct, color) {
  const b = el(id);
  b.style.width = Math.min(100, Math.max(0, pct)) + '%';
  if (color) b.style.backgroundColor = color;
}

function tempColor(T) {
  if (T < 25) return '#50c050';
  if (T < 30) return '#e8c020';
  if (T < 35) return '#e88020';
  return '#e05050';
}

function _updateDcLabel() {
  const pct = S.dcThrottle;
  const fullLoad = CFG.DC_BASE_MW + Math.max(0, (S.temp || 18) - 30) * CFG.DC_HOT_MW_PER_DEG;
  const mw = Math.round(fullLoad * pct / 100);
  const lbl = el('dc-throttle-label');
  if (lbl) lbl.textContent = `${pct}% — ~${mw} MW`;
  const sl = el('dc-throttle-slider');
  if (sl) sl.value = pct;
}

function updateUI() {
  const T = S.temp;
  _updateDcLabel();

  // Top bar
  el('day-display').textContent  = `Day ${S.day} / ${CFG.DAYS}`;
  el('phase-display').textContent = ['☀️ Morning', '🌞 Noon', '🌙 Night'][S.phase] || '';

  // Temperature
  el('temp-val').textContent = `${T}°C`;
  const tPct = Math.min(100, (T - 10) / 40 * 100);
  setBar('bar-temp', tPct, tempColor(T));
  const tLabels = T < 24 ? 'Normal' : T < 30 ? 'Warm' : T < 34 ? '⚠️ Hot' : T < 37 ? '🔥 Heatwave' : '💀 Extreme';
  el('temp-label').textContent = tLabels;

  // Power grid
  el('supply-val').textContent = `${S.powerSupply} MW`;
  el('demand-val').textContent = `${S.powerDemand} MW`;
  const loadPct = Math.min(100, S.loadFactor * 100);
  const loadColor = { green: '#50c050', yellow: '#e8c020', red: '#e87020', black: '#e05050' }[S.gridStatus];
  setBar('bar-grid', loadPct, loadColor);
  const gridLabels = {
    green: '🟢 Stable',
    yellow: '🟡 Strained',
    red: '🔴 Brownouts',
    black: '⚫ BLACKOUT',
  };
  el('grid-label').textContent = gridLabels[S.gridStatus] || '';

  // Source breakdown
  const srcHtml = Object.entries(S.sources)
    .filter(([, mw]) => mw > 0)
    .map(([src, mw]) => {
      const icons = { coal:'⛏', gas:'🔥', nuclear:'⚛', wind:'💨', solar:'☀', hydro:'💧' };
      return `<div class="src-row"><span>${icons[src] || ''} ${src}</span><span>${mw} MW</span></div>`;
    }).join('');
  el('source-list').innerHTML = srcHtml;

  // Deaths
  el('deaths-val').textContent = Math.round(S.deaths).toLocaleString();
  el('deaths-rate').textContent = `+${Math.round(S.deathsThisPhase * 3)}/day`;

  // CO2
  const co2Pct = Math.min(200, (S.co2Emitted / CFG.CO2_BUDGET) * 100);
  el('co2-val').textContent = `${Math.round(co2Pct)}%`;
  setBar('bar-co2', Math.min(100, co2Pct), co2Pct > 100 ? '#e05050' : '#4088cc');

  // Economy
  el('econ-val').textContent = `€${Math.round(S.econLossM)}M`;
  el('budget-val').textContent = `€${Math.round(S.budgetM)}M`;

  // Approval
  el('approval-val').textContent = `${Math.round(S.approval)}%`;
  setBar('bar-approval', S.approval, S.approval < 30 ? '#e05050' : S.approval < 55 ? '#e8c020' : '#e8a020');

  // AC
  el('ac-val').textContent = `${Math.round(S.acCoverage * 100)}%`;

  // Schools
  el('school-val').textContent = S.retrofitDaysLeft > 0
    ? `🔧 Retrofit (${Math.ceil(S.retrofitDaysLeft)}d left)`
    : S.retrofitComplete && S.schoolsOpen
      ? '✅ Open (AC fitted)'
      : S.schoolsOpen
        ? (S.schoolStrikeDays > 0 ? `⚠️ Strike (day ${S.schoolStrikeDays})` : 'Open')
        : 'Closed';
}

// ───────────────────────────────────────────
// SATIRICAL EVENTS
// ───────────────────────────────────────────
const EVENTS_SCRIPTED = [
  { day: 1,  id: 'intro',      text: '🌡️ Day 1: Temperature at 18°C. Europolis enjoys a pleasant spring day. Meteorologists warn of an unusual high-pressure system building to the south.\n\nThe minister has been briefed. The minister is on a mini-break in Tuscany. A strongly worded memo has been sent.' },
  { day: 5,  id: 'wave_start', text: '🔥 Day 5: A high-pressure blocking anticyclone has settled over Europolis. Temperatures rising rapidly. Wind turbines producing 40% below rated capacity.\n\n"This is fine," says the minister, returning a day early.' },
  { day: 9,  id: 'peak_begin', text: '💀 Day 9: Temperature exceeds 34°C. The first heat-related deaths have been recorded — all elderly residents. The heat wave is now projected to last another week.\n\n"Temporary phenomenon," notes a think tank funded by an energy company.' },
  { day: 12, id: 'river',      text: '💧 Day 12: River levels have dropped 40% since the heat wave began. Hydro power curtailed. River temperature approaching limits for nuclear cooling water discharge.\n\nA government spokesperson says rivers "are performing within expected parameters."' },
  { day: 15, id: 'peak',       text: '🌡️ Day 15: PEAK HEAT WAVE. Temperatures at maximum. Emergency services overwhelmed. The data centre is consuming more power than 40,000 homes. Its servers are generating motivational LinkedIn posts.\n\nNot one has been about climate change.' },
  { day: 20, id: 'decline',    text: '📉 Day 20: Temperatures beginning to fall. The worst appears to be over. Parliament is preparing for an inquiry into the government\'s response.\n\nThe inquiry is expected to report in 2031.' },
  { day: 28, id: 'end_warn',   text: '📰 Day 28: Heat wave subsiding. Post-crisis analysis beginning. Whatever choices you made have now shaped the fate of Europolis.\n\n"Lessons will be learned," says the minister. This is the 4th time this year.' },
];

const EVENTS_RANDOM = [
  // Climate sceptic / right wing
  'Local MP: "Europolis doesn\'t need AC — it needs backbone." MP\'s own office features two Mitsubishi split units.',
  'New gas plant approved in 48 hours via emergency planning rules. Offshore wind farm: under review since 2011 (bat habitat survey pending).',
  'Oil company CEO earns 14,000 carbon credits by planting trees in a car park. Uses credits to offset his private jet. Net result: one slightly shadier car park.',
  '"Germany reopens coal plant — just temporarily," says government for the 9th consecutive year.',
  'Energy company announces record quarterly profits during crisis. Describes them as "reflecting market conditions." Market conditions: people are dying.',
  // Naive net-zero
  'Environmental NGO sues solar panel installer for "visual impact on listed countryside." The countryside is currently 41°C.',
  'Minister suggests residents should "draw their curtains and think cool thoughts." Curtains: 87% polyester. Thoughts: increasingly warm.',
  'EU announces new passive cooling building standard applicable to buildings constructed after 2030. Average Europolis home: built 1952.',
  'Net Zero activists block the road outside the grid operator\'s office. In diesel vans. Grid operator unable to reach emergency meeting.',
  'Green party proposes a €50 voucher for "personal cooling devices." Voucher is not valid for air conditioning. It is valid for hand fans.',
  // Data center
  'NeuralBrains Inc. CEO tweets: "Our AI campus is Net Zero by 2040 🌱. Current data centre water consumption: 4 million litres/day. Please reduce your showers." Tweet generated by AI (power: 3 kWh).',
  'TechGiant data centre draws 80 MW during blackout — equivalent to 40,000 homes. It is categorised as Essential Infrastructure (Category A). Hospitals are Category B.',
  'MegaCloud AI services report: running a single chatbot query uses 10× more energy than a Google search. Chatbot queries during heat wave: up 340%. Queries about climate change: 0.3%.',
  'Data centre files legal challenge against grid throttling order. Their lawyers arrive in Tesla. The Tesla was charged at the hotel using the grid they are suing to protect.',
  // Schools
  'UK Education Secretary: "There is no legal maximum temperature for classrooms." Teachers: "It is 41°C." Secretary: "That is an alleged temperature, and teachers are salaried professionals."',
  'Parents furious schools are closed during heat wave. Same parents furious schools were staying open during heat wave. Government declares both positions valid and forms a committee.',
  '"Schools closed for heat. Schools also closed last Monday (INSET day). Week before: half-term. Total teaching days this month: 4." — Local newspaper.',
  'PE teacher insists outdoor sports day continues at 38°C. "It builds character." Six children hospitalised. Character: built.',
  // Yogurt & bees
  'Dairy industry reports yogurt sales up 4,000% since government advice. CEO of Danone names new product line "GovCool™ Window Collection." Scientists note that applying yogurt indoors also works but are not asked.',
  'Apiarists confirm bee colonies in Europolis up 340% since yogurt windows introduced. "This is an ecological triumph," says bee charity. Hospital triage nurse: "I have a different perspective."',
  'Anaphylaxis kit shortage reported across Europolis pharmacies. EpiPen manufacturer releases a statement of "deep sympathy" and also a new pricing structure.',
  // Systemic irony
  'Wind turbines generating 12% capacity during anticyclone. Solar generating 115% of baseline thanks to record sun. Net change to grid: −2%. Grid operator: weeping.',
  'River too warm for nuclear cooling — 3 reactors curtailed. Same river too low for hydro — output at 18%. Same heat wave caused both.',
  'Hospital backup diesel generator ran out of fuel. Diesel lorry stuck in heat-wave traffic. Patient deceased. Press release issued in 72 hours describing situation as "not foreseen."',
  '"France immune to heat wave due to nuclear power," reports newspaper. France currently curtailing 5.2 GW of nuclear because the Loire is a puddle.',
  'Europolis city hall installs air conditioning in the chamber where AC policy is debated, to ensure officials can think clearly about the issue.',
];

function fireEvent(text) {
  const popup = el('event-popup');
  el('event-headline').textContent = text;
  el('event-date-stamp').textContent = `Day ${S.day}`;
  popup.classList.remove('hidden');
  S.paused = true;
  el('pause-btn').textContent = '▶ Resume';
  el('pause-btn').classList.add('paused');
}

function checkScriptedEvents() {
  for (const ev of EVENTS_SCRIPTED) {
    if (ev.day === S.day && !S.firedEvents.has(ev.id)) {
      S.firedEvents.add(ev.id);
      fireEvent(ev.text);
      return;
    }
  }
}

function maybeFireRandomEvent() {
  if (S.day === S.lastEventDay) return;
  if (Math.random() > 0.40) return;
  const idx = Math.floor(Math.random() * EVENTS_RANDOM.length);
  const key = `rand_${idx}`;
  if (S.firedEvents.has(key)) return;
  S.firedEvents.add(key);
  S.lastEventDay = S.day;
  setTimeout(() => fireEvent(EVENTS_RANDOM[idx]), 400);
}

// ───────────────────────────────────────────
// POLICY HANDLERS
// ───────────────────────────────────────────
function applyGroupPolicy(group, val) {
  // Deactivate all in group, activate chosen
  document.querySelectorAll(`.pol-btn[data-group="${group}"]`).forEach(b => b.classList.remove('active'));
  const chosen = document.querySelector(`.pol-btn[data-group="${group}"][data-val="${val}"]`);
  if (chosen) chosen.classList.add('active');

  if (group === 'ac') {
    S.acPolicy = val;
    if (val === 'subsidise') S.acCoverage = Math.max(S.acCoverage, 0.30);
  }
  if (group === 'schools') {
    S.schoolPolicy = val;
    if (val === 'close') {
      S.schoolsOpen = false;
    } else if (val === 'open') {
      if (S.schoolStrikeDays < 3 && S.retrofitDaysLeft === 0) S.schoolsOpen = true;
    }
  }
  // datacenter is handled by slider — nothing here
}

function applyToggle(name, btnId) {
  const btn = el(btnId);
  if (name === 'coal') {
    S.coalOn = !S.coalOn;
    btn.textContent = `⛏ Coal ${S.coalOn ? 'ON' : 'OFF'}`;
    btn.classList.toggle('on', S.coalOn);
    btn.classList.toggle('danger', S.coalOn);
    if (S.coalOn) fireEvent('⛏ Coal plant activated. CO₂ emissions will increase significantly.\n\n"Temporary measure," says the minister. (Day ' + S.day + ')\n\nGermany on the phone: "We do this every year. It gets easier."');
  }
  if (name === 'gas') {
    S.gasOn = !S.gasOn;
    btn.textContent = `🔥 Gas ${S.gasOn ? 'ON' : 'OFF'}`;
    btn.classList.toggle('on', S.gasOn);
  }
  if (name === 'blackout') {
    S.blackoutsOn = !S.blackoutsOn;
    btn.textContent = `🔌 Blackouts ${S.blackoutsOn ? 'ON' : 'OFF'}`;
    btn.classList.toggle('on', S.blackoutsOn);
    btn.classList.toggle('danger', S.blackoutsOn);
  }
  if (name === 'warnings') {
    S.warningsOn = !S.warningsOn;
    btn.textContent = `📢 Warnings ${S.warningsOn ? 'ON' : 'OFF'}`;
    btn.classList.toggle('on', S.warningsOn);
  }
  if (name === 'yogurt') {
    S.yogurtOn = !S.yogurtOn;
    btn.textContent = `🫙 Yogurt Windows ${S.yogurtOn ? 'ON' : 'OFF'}`;
    btn.classList.toggle('on', S.yogurtOn);
    if (S.yogurtOn && !S.firedEvents.has('yogurt_activate')) {
      S.firedEvents.add('yogurt_activate');
      fireEvent('🫙 GOVERNMENT ISSUES YOGURT GUIDANCE\n\nFollowing scientific advice inspired by a BBC news article, the Ministry of Health has recommended citizens apply yogurt to their windows. The evaporative cooling effect, they say, can reduce indoor temperatures by up to 2°C.\n\nThe yogurt industry has issued a statement of full support.\n\nThe beekeepers\' association has issued no statement yet. They are watching.\n\n"Are we seriously doing this?" — senior civil servant, internal memo, leaked immediately.');
    }
  }
}

function applyAction(action) {
  if (action === 'cooling') {
    if (S.coolingCentresOpen) return;
    if (S.budgetM < 2) { alert('Insufficient budget.'); return; }
    S.budgetM -= 2;
    S.coolingCentresOpen = true;
    el('btn-cooling').textContent = '🏛 Cooling Centres: OPEN';
    el('btn-cooling').classList.add('on');
    fireEvent('🏛 Cooling centres opened across Europolis. Elderly residents now have a cool place to go.\n\nUptake: moderate. Many elderly residents are not aware the centres exist. Informational leaflets are being printed. They will be ready in 5 days.\n\n"Lessons will be learned about communication," says a spokesperson.');
  }

  if (action === 'grid-import') {
    if (S.gridImportOn) return;
    if (S.budgetM < 25) { alert('Insufficient budget (€25M required).'); return; }
    S.budgetM -= 25;
    S.gridImportOn = true;
    S.gridImportDaysLeft = 20;
    el('btn-grid-import').textContent = '🔌 EU Import: ACTIVE (20d)';
    el('btn-grid-import').classList.add('on');
    fireEvent('🔌 EMERGENCY EU POWER IMPORT SECURED\n\n+350 MW arriving via the Channel interconnect. Cost: €25M.\n\nFrance noted they are "also quite warm" but agreed to help. Germany sent coal power and issued a 4-page apology about it. Spain offered solar but the cable isn\'t long enough.\n\nDeal expires in 10 days. By then you\'re on your own.');
  }

  if (action === 'industry-shed') {
    if (S.industrySheddingOn) return;
    S.industrySheddingOn = true;
    el('btn-industry-shed').textContent = '🏭 Industry Shed: ON';
    el('btn-industry-shed').classList.add('on');
    fireEvent('🏭 MANDATORY INDUSTRIAL LOAD SHEDDING\n\nAll non-essential factories and large offices have been ordered to cut electricity use by 20% immediately. Estimated saving: −180 MW.\n\nThe Confederation of Industry has described this as "an unprecedented attack on productivity." They issued this statement from a fully air-conditioned press suite.\n\n"We are all in this together," says the minister, from a fully air-conditioned office.');
  }

  if (action === 'wfh-order') {
    if (S.wfhOrderOn) return;
    S.wfhOrderOn = true;
    el('btn-wfh').textContent = '💻 WFH Order: ON';
    el('btn-wfh').classList.add('on');
    fireEvent('💻 WORK-FROM-HOME ORDER ISSUED\n\nAll non-essential office workers must work from home effective immediately. Empty offices reduce cooling demand. AC sales growth slows as people discover their home already has a ceiling fan.\n\n"Finally," says every introvert.\n"What about my standing desk," says every other worker.\n\nOffice canteen industry: devastated. Home biscuit industry: thriving.');
  }

  if (action === 'surge-capacity') {
    if (S.surgeCapacityOn) return;
    if (S.budgetM < 12) { alert('Insufficient budget (€12M required).'); return; }
    S.budgetM -= 12;
    S.surgeCapacityOn = true;
    el('btn-surge').textContent = '🏥 Surge Capacity: ON';
    el('btn-surge').classList.add('on');
    fireEvent('🏥 HOSPITAL SURGE CAPACITY DEPLOYED\n\nField hospitals and emergency generators have been deployed across Europolis. Every ward now has backup power. The 2.5× mortality spike from grid failures is dramatically reduced.\n\nCost: €12M. The generators were sourced from a supplier who usually rents them to festival organisers. They smell faintly of diesel and Glastonbury.\n\n"It works," says the lead consultant. "Unexpectedly."');
  }

  if (action === 'school-retrofit') {
    if (S.retrofitDaysLeft > 0 || S.retrofitComplete) return; // already done or in progress
    if (S.budgetM < 8) { alert('Insufficient budget (€8M required).'); return; }
    S.budgetM -= 8;
    S.retrofitDaysLeft = 8;
    S.schoolsOpen = false; // closed during installation
    const btn = el('btn-school-retrofit');
    btn.disabled = true;
    btn.textContent = '🔧 Retrofitting... (8d)';
    btn.classList.add('on');
    fireEvent('🔧 SCHOOL AC RETROFIT COMMISSIONED\n\nAll 4 schools in Europolis will have air conditioning installed over the next 8 days. Schools must close during installation.\n\nThe contractor has promised to finish on time. The contractor has never finished on time.\n\nParents have been notified via a letter sent home with children who are not currently at school because the schools are closed.\n\nCost: €8M. Estimated actual cost once overruns are included: ask again in 2031.');
  }
}

// ───────────────────────────────────────────
// ENDING / SCORE
// ───────────────────────────────────────────
function calcScore() {
  const dPct  = Math.min(1, S.deaths / CFG.MAX_DEATHS);
  const co2Pct = Math.min(1, S.co2Emitted / CFG.CO2_BUDGET);
  const ePct  = Math.min(1, S.econLossM / CFG.MAX_ECON_M);
  return Math.round(
    (1 - dPct)        * 4000 +
    (1 - co2Pct)      * 3000 +
    (S.approval / 100) * 2000 +
    (1 - ePct)        * 1000
  );
}

function pickEnding() {
  const d = Math.round(S.deaths);
  const co2Over = S.co2Emitted > CFG.CO2_BUDGET * 3;
  const collapsed = S.firedEvents.has('grid_collapse');

  if (d < 200 && S.co2Emitted < CFG.CO2_BUDGET && !collapsed)
    return { emoji: '📊', title: 'The Denmark Path', text: 'You governed boringly and effectively. Deaths below 200. CO₂ on target. Grid stable.\n\nNobody will make a documentary about this. A mid-tier podcast might mention it. Well done.' };
  if (d < 300 && co2Over)
    return { emoji: '🌡️', title: 'The Spain Path', text: 'Relatively few deaths! Your CO₂ emissions were 200% over the Paris-aligned budget.\n\nThe next heat wave will be 0.3°C hotter. See you next summer. And the summer after that. And every summer, forever.' };
  if (d < 200 && collapsed)
    return { emoji: '🌿', title: 'The Idealist', text: 'Your carbon score is exemplary. Renewables only. No coal, no gas.\n\nUnfortunately the grid collapsed on Day ' + S.day + '. Hospitals lost power. The coroner\'s report uses the phrase "entirely preventable" seventeen times.\n\nYour principles remain intact.' };
  if (d >= 1000)
    return { emoji: '📋', title: 'The 2003 Special', text: `${d.toLocaleString()} excess deaths were recorded during the heat wave.\n\nThe Prime Minister has expressed "deep regret." An independent inquiry will report findings by 2031. A memorial garden is planned, subject to planning permission (currently under review; bat survey required).` };
  if (d < 600 && !co2Over)
    return { emoji: '☕', title: 'The British Muddle', text: `${d.toLocaleString()} excess deaths. Partial brownouts. No decisive policy enacted.\n\nA strongly worded Times editorial ran on Day 16. The Minister gave a statement describing events as "complex." Public approval at ${Math.round(S.approval)}%.\n\n"Lessons will be learned."` };
  if (d < 50 && co2Over)
    return { emoji: '🏭', title: 'The Pragmatist Villain', text: 'Zero deaths. Grid stable. CO₂ budget: 350% over target.\n\nEvery fossil fuel plant was running at capacity. Everyone stayed cool. The next heat wave — which will now arrive 0.5°C hotter — is someone else\'s problem.\n\nYou will not be minister then. Statistically.' };
  // Default
  return { emoji: '📰', title: 'A Complex Outcome', text: `Europolis survived. ${d.toLocaleString()} people did not.\n\nWhether you made the right calls is a matter of perspective. That perspective is unlikely to be shared by those who lost relatives.\n\nThe inquiry continues.` };
}

function showEnding() {
  S.gameOver = true;
  const score  = calcScore();
  const ending = pickEnding();

  el('ending-emoji').textContent     = ending.emoji;
  el('ending-title').textContent     = ending.title;
  el('ending-flavour').textContent   = ending.text;
  el('sc-deaths').textContent        = Math.round(S.deaths).toLocaleString();
  el('sc-co2').textContent           = `${Math.round((S.co2Emitted / CFG.CO2_BUDGET) * 100)}%`;
  el('sc-econ').textContent          = `€${Math.round(S.econLossM)}M`;
  el('sc-approval').textContent      = `${Math.round(S.approval)}%`;
  el('sc-score').textContent         = score.toLocaleString();
  el('lb-country-label').textContent = COUNTRIES[S.country]?.name || S.country;

  el('game-screen').classList.remove('active');
  el('game-screen').style.display = 'none';
  el('ending-screen').classList.remove('hidden');
  el('ending-screen').style.display = 'flex';

  // Store score data for submission
  window._pendingScore = {
    country: S.country,
    deaths:  Math.round(S.deaths),
    co2Pct:  Math.round((S.co2Emitted / CFG.CO2_BUDGET) * 100),
    econLoss: Math.round(S.econLossM),
    approval: Math.round(S.approval),
    ending:  ending.title,
    score,
  };

  loadLeaderboard(S.country, 'lb-list');
}

// ───────────────────────────────────────────
// LEADERBOARD API
// ───────────────────────────────────────────
async function loadLeaderboard(country, targetId) {
  const listEl = el(targetId);
  if (!listEl) return;
  listEl.textContent = 'Loading...';
  try {
    const url = country && country !== 'ALL'
      ? `/api/scores?country=${country}&limit=10`
      : '/api/scores?limit=10';
    const res = await fetch(url);
    if (!res.ok) throw new Error('API unavailable');
    const data = await res.json();
    if (!data.scores?.length) { listEl.textContent = 'No scores yet. Be the first!'; return; }
    listEl.innerHTML = data.scores.map((s, i) =>
      `<div class="lb-entry">
        <span class="lb-rank">#${i + 1}</span>
        <span class="lb-name">${esc(s.player)}</span>
        <span class="lb-country">${s.country}</span>
        <span class="lb-ending">${esc(s.ending)}</span>
        <span class="lb-score">${s.score.toLocaleString()}</span>
      </div>`
    ).join('');
  } catch {
    listEl.textContent = '(Leaderboard unavailable — configure SUPABASE_URL + SUPABASE_ANON_KEY to enable)';
  }
}

async function submitScore() {
  if (!_currentUser || !_supa) return;
  const ps = window._pendingScore;
  if (!ps) return;

  const name = el('player-name-input').value.trim().slice(0, 16) || 'Anonymous';
  const btn  = el('submit-score-btn');
  btn.disabled    = true;
  btn.textContent = 'Submitting...';

  try {
    const { data: { session } } = await _supa.auth.getSession();
    if (!session?.access_token) throw new Error('No session');

    const res = await fetch('/api/submit', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ player: name, ...ps }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { rank, updated, message } = await res.json();
    const rankEl = el('lb-rank-result');
    rankEl.textContent = updated === false
      ? (message || `Personal best unchanged. You rank #${rank}.`)
      : `Submitted! You ranked #${rank} globally.`;
    rankEl.classList.remove('hidden');
    loadLeaderboard(ps.country, 'lb-list');
  } catch (err) {
    btn.textContent = 'Submit failed — try again';
    btn.disabled    = false;
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

// ───────────────────────────────────────────
// MAIN GAME LOOP
// ───────────────────────────────────────────
let loopId = null;
let lastTs  = null;

function gameLoop(ts) {
  if (S.gameOver) return;
  loopId = requestAnimationFrame(gameLoop);

  if (lastTs === null) { lastTs = ts; return; }
  const rawDt = ts - lastTs;
  lastTs = ts;

  if (S.paused) return;

  const effectiveMs = CFG.PHASE_MS / S.speed;
  S.phaseMs += rawDt;

  if (S.phaseMs >= effectiveMs) {
    S.phaseMs -= effectiveMs;
    tickPhase();
  }

  // Render every frame
  renderCity();
  updateUI();
}

function tickPhase() {
  if (S.gameOver) return;

  // Advance to the phase/day we are about to simulate FIRST, so the
  // temperature computed below matches the phase label shown in the UI.
  S.phase++;
  let dayRolled = false;
  if (S.phase >= 3) {
    S.phase = 0;
    S.day++;
    dayRolled = true;
    if (S.day > CFG.DAYS) {
      showEnding();
      return;
    }
  }

  const T = calcTemp(S.day, S.phase);
  S.temp = T;

  // Power
  computePower(T, S.day);

  // Grid collapse event
  if (S.gridStatus === 'black' && !S.firedEvents.has('grid_collapse')) {
    S.firedEvents.add('grid_collapse');
    fireEvent('⚫ GRID COLLAPSE\n\nDemand exceeded supply. The Europolis power grid has entered cascade failure. All zones except hospitals (with backup) are now without power. Emergency generators are running — for up to 6 hours.\n\nEstimated recovery: 6 hours.\n\nThis will have consequences.');
  }

  // AC adoption
  if (S.acPolicy === 'free') {
    // Cap at 0.65: even in a free market, not everyone can afford AC in a heatwave.
    // WFH mandate slows adoption: people at home use existing fans rather than buying AC.
    const growthScale = S.wfhOrderOn ? 0.5 : 1.0;
    const growth = (0.004 + 0.012 / (1 + Math.exp(-(T - 28)))) * growthScale;
    S.acCoverage = Math.min(0.65, S.acCoverage + growth);
  } else if (S.acPolicy === 'subsidise') {
    S.acCoverage = Math.min(0.55, S.acCoverage + 0.003);
  } else {
    // ban: slow black-market growth
    S.acCoverage = Math.min(0.10, S.acCoverage + 0.001);
  }

  // Schools — retrofit is a one-off action, independent of the open/close toggle
  if (S.retrofitDaysLeft > 0) {
    // Retrofit in progress: schools stay closed, count down
    S.retrofitDaysLeft -= 1 / 3;
    S.schoolsOpen = false;
    if (S.retrofitDaysLeft <= 0) {
      S.retrofitDaysLeft = 0;
      S.retrofitComplete = true;
      S.schoolStrikeDays = 0;
      S.schoolsOpen = S.schoolPolicy !== 'close'; // reopen unless player chose to keep closed
      const btn = el('btn-school-retrofit');
      btn.textContent = '✅ AC Retrofit Done';
      btn.classList.remove('on');
      setTimeout(() => fireEvent('🏫 SCHOOL AC RETROFIT COMPLETE\n\nAll 4 schools in Europolis now have air conditioning. Teachers are pleased. Parents are pleased. Students are suspicious.\n\n"Why didn\'t we do this 20 years ago?" — everyone.\n\nThe contractor has been paid. The contractor is not available for comment about the timeline.\n\nSchools reopen immediately. The first student complaint about the AC being "too cold" was logged within four minutes.'), 300);
    }
  } else if (S.schoolPolicy === 'open') {
    if (S.retrofitComplete) {
      S.schoolsOpen = true; // AC installed — no heat strikes possible
    } else if (T > 35) {
      S.schoolStrikeDays++;
      if (S.schoolStrikeDays === 3) {
        S.schoolsOpen = false;
        setTimeout(() => fireEvent('🏫 TEACHER STRIKE — SCHOOLS FORCIBLY CLOSED\n\nAfter 3 days above 35°C, teachers have voted to refuse entry. The classrooms have no thermometers, so officially the temperature is still "unknown."\n\nParents are now working from home with children. Economic productivity: collapsing.\n\n"Lessons will be learned about classroom temperature monitoring," says the Minister.'), 300);
      }
    } else if (T < 30) {
      S.schoolStrikeDays = Math.max(0, S.schoolStrikeDays - 1);
      if (!S.schoolsOpen && S.schoolStrikeDays === 0) S.schoolsOpen = true;
    }
  } else if (S.schoolPolicy === 'close') {
    S.schoolsOpen = false;
  }

  // EU Grid Import: count down the 10-day deal
  if (S.gridImportOn && S.gridImportDaysLeft > 0) {
    S.gridImportDaysLeft -= 1 / 3; // per phase
    if (S.gridImportDaysLeft <= 0) {
      S.gridImportDaysLeft = 0;
      S.gridImportOn = false;
      setTimeout(() => fireEvent('🔌 EU POWER IMPORT DEAL EXPIRED\n\nThe 10-day emergency power import agreement with EU neighbours has ended. France, Germany and Spain have politely explained that they are also in a heatwave and need their electricity back.\n\n"We did say \'temporary,\'" says the EU spokesperson.\n\nYour grid is now on its own. Good luck.'), 300);
    }
  }

  // Yogurt Windows: track exposure and escalate bee situation
  if (S.yogurtOn) {
    S.yogurtPhases++;
    if (S.yogurtPhases === 3 && !S.firedEvents.has('yogurt_bees_warning')) {
      S.firedEvents.add('yogurt_bees_warning');
      setTimeout(() => fireEvent('🐝 EMERGING CONCERN: BEES\n\nResidents following the government\'s yogurt-window advice have noticed an uptick in bee activity. Scientists suggest this may be because bees are attracted to fermented dairy products.\n\n"This was not in the original BBC article," says the Health Secretary.\n\nThe minister has asked for an urgent briefing. The briefing will be ready in 4 days.'), 400);
    }
    if (S.yogurtPhases >= 9 && !S.beeAttackActive) {
      S.beeAttackActive = true;
      setTimeout(() => fireEvent('🐝🐝🐝 FULL BEE EMERGENCY\n\nEuropolis hospitals are reporting a surge in anaphylactic shock cases. Bee colonies across the city have been drawn to the yogurt applied to an estimated 180,000 windows.\n\nA&E departments are at 140% capacity. The lead consultant described the situation as "a clinical experience I did not prepare for at medical school."\n\nThe beekeeper\'s union has issued a statement of apology and also one of pride.\n\n"The government told people to put yogurt on their windows," says a paramedic. "We cannot stress enough how much this is now our problem."'), 400);
    }
  } else if (S.beeAttackActive) {
    // Bees linger for 2 days after yogurt is removed (residual smell)
    S.yogurtPhases = Math.max(0, S.yogurtPhases - 0.5);
    if (S.yogurtPhases === 0) {
      S.beeAttackActive = false;
      setTimeout(() => fireEvent('🐝 BEE SITUATION IMPROVING\n\nWith windows cleaned of yogurt, the bee population of Europolis is gradually dispersing.\n\nHospital admissions for bee stings have dropped 80%. The remaining 20% are residents who "quite enjoyed the experience" and have applied more yogurt.\n\n"We cannot legislate against that," says the minister.'), 400);
    }
  }

  // Deaths
  const d = computeDeaths(T);
  S.deathsThisPhase = d;
  S.deaths += d;

  // Economy
  S.econLossM += computeEcon(T);

  // Approval
  updateApproval(d);

  if (dayRolled) {
    checkScriptedEvents();
    maybeFireRandomEvent();
  }
}

// ───────────────────────────────────────────
// STARTUP & EVENT LISTENERS
// ───────────────────────────────────────────
let selectedCountry = null;

document.addEventListener('DOMContentLoaded', () => {
  // Initialise Supabase auth (non-blocking — game works without it)
  initSupabase();

  // OAuth sign-in buttons on the ending screen
  el('btn-google-signin')?.addEventListener('click', () => signIn('google'));
  el('btn-github-signin')?.addEventListener('click', () => signIn('github'));

  // Country selection
  document.querySelectorAll('.country-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.country-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedCountry = card.dataset.country;
      el('start-btn').disabled = false;
      el('start-btn').textContent = `▶ Start as ${COUNTRIES[selectedCountry].name}`;
    });
  });

  el('start-btn').addEventListener('click', () => {
    if (!selectedCountry) return;
    startGame(selectedCountry);
  });

  // Pause / speed
  el('pause-btn').addEventListener('click', () => {
    S.paused = !S.paused;
    el('pause-btn').textContent = S.paused ? '▶ Resume' : '⏸ Pause';
    el('pause-btn').classList.toggle('paused', S.paused);
  });

  el('speed-btn').addEventListener('click', () => {
    const speeds = [1, 2, 4];
    const idx = speeds.indexOf(S.speed);
    S.speed = speeds[(idx + 1) % speeds.length];
    el('speed-btn').textContent = `⏩ ×${S.speed}`;
  });

  el('quit-btn').addEventListener('click', () => {
    if (!confirm('Return to menu? Current game will be lost.')) return;
    stopGame();
    showMenu();
  });

  // Policy group buttons (AC, Schools, DataCenter)
  document.querySelectorAll('.pol-btn[data-group]').forEach(btn => {
    btn.addEventListener('click', () => applyGroupPolicy(btn.dataset.group, btn.dataset.val));
  });

  // Toggle buttons
  document.querySelectorAll('.pol-btn[data-toggle]').forEach(btn => {
    btn.addEventListener('click', () => applyToggle(btn.dataset.toggle, btn.id));
  });

  // Action buttons
  document.querySelectorAll('.pol-btn[data-action]').forEach(btn => {
    btn.addEventListener('click', () => applyAction(btn.dataset.action));
  });

  // Data centre throttle slider
  const dcSlider = el('dc-throttle-slider');
  if (dcSlider) {
    let _lastDcEventBucket = null; // track which satirical tier we last announced
    dcSlider.addEventListener('input', () => {
      const pct = +dcSlider.value;
      S.dcThrottle = pct;
      _updateDcLabel();
      // Fire satirical event once per bucket crossing (100→75, 75→50, 50→25, 25→0)
      const bucket = pct >= 75 ? 'full' : pct >= 50 ? 'high' : pct >= 25 ? 'mid' : 'low';
      if (bucket !== _lastDcEventBucket) {
        _lastDcEventBucket = bucket;
        if (bucket === 'high') setTimeout(() => fireEvent(
          '📉 Data centre throttled to 75%. NeuralBrains Inc. issues a strongly-worded press release.\n\n"We are deeply concerned," tweeted the CEO from his air-conditioned villa. "This is an attack on digital sovereignty."\n\nEnvironmental groups issue a statement of support that nobody reads.'
        ), 200);
        else if (bucket === 'mid') setTimeout(() => fireEvent(
          '⚠️ Data centre at 50%. TechGiant\'s legal team has filed an emergency injunction.\n\n"Our servers are essential infrastructure," they argue. The injunction lists 47 AI cat-video generation services as critical national assets.'
        ), 200);
        else if (bucket === 'low') setTimeout(() => fireEvent(
          '🖥 Data centre near shutdown. TechGiant has suspended its "Digital Innovation Partnership" with Europolis.\n\nTheir CEO is tweeting from his yacht about "government overreach". The grid has been relieved. The cat videos can wait.'
        ), 200);
      }
    });
  }

  // Event dismiss
  el('event-dismiss').addEventListener('click', () => {
    el('event-popup').classList.add('hidden');
    S.paused = false;
    el('pause-btn').textContent = '⏸ Pause';
    el('pause-btn').classList.remove('paused');
  });

  // Submit score
  el('submit-score-btn').addEventListener('click', submitScore);

  // Play again
  el('play-again-btn').addEventListener('click', () => {
    el('ending-screen').style.display = 'none';
    el('ending-screen').classList.add('hidden');
    showMenu();
  });

  // Leaderboard link on menu
  el('full-lb-link').addEventListener('click', e => {
    e.preventDefault();
    el('lb-modal').classList.remove('hidden');
    loadLeaderboard('ALL', 'lb-modal-list');
  });

  el('lb-close').addEventListener('click', () => el('lb-modal').classList.add('hidden'));

  document.querySelectorAll('.lb-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.lb-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      loadLeaderboard(tab.dataset.country, 'lb-modal-list');
    });
  });

  // Load leaderboard preview on menu
  loadLeaderboard('ALL', 'lb-preview-list');
  showMenu();
});

function showMenu() {
  selectedCountry = null;
  el('start-btn').disabled = true;
  el('start-btn').textContent = '← Select a country to begin';
  document.querySelectorAll('.country-card').forEach(c => c.classList.remove('selected'));
  el('menu-screen').style.display = 'flex';
  el('menu-screen').classList.add('active');
  el('game-screen').style.display = 'none';
  el('game-screen').classList.remove('active');
}

function startGame(country) {
  resetState(country);
  el('country-badge').textContent = `${COUNTRIES[country].flag} ${COUNTRIES[country].name}`;

  // Reset toggle buttons to initial state (coal/gas start ON — the
  // city currently runs on its existing fossil baseline; turning them
  // off is the player's green choice, not an emergency rescue)
  el('btn-coal').textContent = '⛏ Coal ON';
  el('btn-coal').classList.add('on', 'danger');
  el('btn-gas').textContent  = '🔥 Gas ON';
  el('btn-gas').classList.add('on');
  el('btn-blackout').textContent = '🔌 Blackouts OFF';
  el('btn-blackout').classList.remove('on', 'danger');
  el('btn-warnings').textContent = '📢 Warnings OFF';
  el('btn-warnings').classList.remove('on');
  el('btn-cooling').textContent = '🏛 Cooling Centres (€2M)';
  el('btn-cooling').classList.remove('on');
  el('speed-btn').textContent = '⏩ ×1';
  el('pause-btn').textContent = '⏸ Pause';
  el('pause-btn').classList.remove('paused');
  el('btn-yogurt').textContent = '🫙 Yogurt Windows OFF';
  el('btn-yogurt').classList.remove('on');
  el('btn-grid-import').textContent = '🔌 EU Import (€25M / 10d)';
  el('btn-grid-import').classList.remove('on');
  el('btn-industry-shed').textContent = '🏭 Industry Shedding OFF';
  el('btn-industry-shed').classList.remove('on');
  el('btn-wfh').textContent = '💻 WFH Order OFF';
  el('btn-wfh').classList.remove('on');
  el('btn-surge').textContent = '🏥 Hospital Surge (€12M)';
  el('btn-surge').classList.remove('on');

  // Reset group buttons
  document.querySelectorAll('.pol-btn[data-group="ac"]').forEach(b => b.classList.remove('active'));
  document.querySelector('.pol-btn[data-group="ac"][data-val="free"]').classList.add('active');
  document.querySelectorAll('.pol-btn[data-group="schools"]').forEach(b => b.classList.remove('active'));
  document.querySelector('.pol-btn[data-group="schools"][data-val="open"]').classList.add('active');
  el('btn-school-retrofit').disabled = false;
  el('btn-school-retrofit').textContent = '🔧 AC Retrofit (€8M / 8d)';
  el('btn-school-retrofit').classList.remove('on');
  // Reset data-centre slider to 100%
  S.dcThrottle = 100;
  _updateDcLabel();

  el('lb-rank-result').classList.add('hidden');
  el('player-name-input').value = '';

  el('menu-screen').style.display = 'none';
  el('menu-screen').classList.remove('active');
  el('game-screen').style.display = 'flex';
  el('game-screen').classList.add('active');

  renderCity();
  updateUI();

  // Fire intro event
  setTimeout(() => fireEvent(EVENTS_SCRIPTED[0].text), 500);
  S.firedEvents.add('intro');

  // Start loop
  lastTs = null;
  loopId = requestAnimationFrame(gameLoop);
}

function stopGame() {
  S.gameOver = true;
  if (loopId) cancelAnimationFrame(loopId);
  loopId = null;
}

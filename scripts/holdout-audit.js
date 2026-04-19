// ============================================================
// HOLDOUT AUDIT — Walk-forward temporal honesto
//
// Entrena el modelo Poisson con temporadas ANTERIORES y valida
// contra temporadas que el modelo nunca vio. Simula las apuestas
// con los mismos filtros que el bot real (BASELINE + EXTEND-UP).
//
// Los CSVs de football-data.co.uk incluyen odds históricas (B365,
// WHH, etc.) para cada partido → permite simular apuestas reales
// que se hubieran podido colocar en cada fecha, sin lookahead.
//
// Objetivo: detectar si el ROI reportado del backtest es real o
// producto de sobreajuste.
// ============================================================

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const SEASONS = ["2223", "2324", "2425"];
const LEAGUES = {
  SP1: "La Liga", E0: "Premier League", D1: "Bundesliga",
  I1: "Serie A", F1: "Ligue 1", D2: "2. Bundesliga",
  I2: "Serie B", T1: "Turquía Super Lig", N1: "Eredivisie",
  P1: "Liga Portugal", SP2: "Segunda España",
};
const BANKROLL = 5000;
const KELLY_FRACTION = 0.33;
const MIN_EDGE = 0.06;
const MAX_EDGE = 0.15;
const MAX_BET_PCT = 0.03;
const MIN_TEAM_MATCHES = 8;
const ZONES = {
  baseline: [[2.30, 2.60], [3.00, 3.50]],
  "extend-up": [[2.30, 2.60], [3.00, 4.00]],
};

// ============================================================
// CSV PARSING
// ============================================================
function parseCSV(raw, league) {
  const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const header = lines[0].split(",");
  const idx = (name) => header.indexOf(name);
  const iDate = idx("Date"), iHome = idx("HomeTeam"), iAway = idx("AwayTeam");
  const iHG = idx("FTHG"), iAG = idx("FTAG"), iResult = idx("FTR");
  const iHST = idx("HST"), iAST = idx("AST");
  // Usamos la MEJOR odds disponible entre los bookies principales para 1X2
  const oddsHomeCols = ["B365H", "BWH", "IWH", "WHH", "VCH", "PSH"];
  const oddsDrawCols = ["B365D", "BWD", "IWD", "WHD", "VCD", "PSD"];
  const oddsAwayCols = ["B365A", "BWA", "IWA", "WHA", "VCA", "PSA"];
  const iOH = oddsHomeCols.map(idx).filter(i => i >= 0);
  const iOD = oddsDrawCols.map(idx).filter(i => i >= 0);
  const iOA = oddsAwayCols.map(idx).filter(i => i >= 0);

  const out = [];
  for (let r = 1; r < lines.length; r++) {
    const cols = lines[r].split(",");
    if (cols.length < 6) continue;
    const dateStr = cols[iDate];
    if (!dateStr) continue;
    // formato DD/MM/YYYY o DD/MM/YY
    const m = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (!m) continue;
    let [_, dd, mm, yy] = m;
    if (yy.length === 2) yy = (Number(yy) > 50 ? "19" : "20") + yy;
    const date = new Date(`${yy}-${mm.padStart(2,"0")}-${dd.padStart(2,"0")}`);
    if (isNaN(date)) continue;
    const parseNum = (i) => {
      if (i < 0) return null;
      const n = parseFloat(cols[i]);
      return isNaN(n) ? null : n;
    };
    const maxOdd = (idxs) => {
      let max = 0;
      for (const i of idxs) {
        const v = parseNum(i);
        if (v && v > max) max = v;
      }
      return max > 0 ? max : null;
    };
    const hg = parseNum(iHG), ag = parseNum(iAG);
    if (hg === null || ag === null) continue;
    out.push({
      league, date,
      home: cols[iHome], away: cols[iAway],
      hg, ag,
      result: cols[iResult] || (hg > ag ? "H" : hg < ag ? "A" : "D"),
      hst: parseNum(iHST), ast: parseNum(iAST),
      oddsH: maxOdd(iOH), oddsD: maxOdd(iOD), oddsA: maxOdd(iOA),
    });
  }
  return out;
}

function loadAllData() {
  const all = [];
  for (const league of Object.keys(LEAGUES)) {
    for (const season of SEASONS) {
      const file = path.join(DATA_DIR, `${league}_${season}.csv`);
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, "utf8");
      all.push(...parseCSV(raw, league).map(m => ({ ...m, season })));
    }
  }
  all.sort((a, b) => a.date - b.date);
  return all;
}

// ============================================================
// MODELO (copia fiel de paper-trade-compare.js)
// ============================================================
function avg(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }

function buildTeamStats(matches) {
  const stats = {};
  for (const m of matches) {
    for (const side of ["home", "away"]) {
      const team = side === "home" ? m.home : m.away;
      if (!stats[team]) stats[team] = { matches: [], league: m.league };
      const isHome = side === "home";
      stats[team].matches.push({
        date: m.date, isHome,
        goalsFor: isHome ? m.hg : m.ag,
        goalsAgainst: isHome ? m.ag : m.hg,
        shotsOnTarget: isHome ? m.hst : m.ast,
        shotsOnTargetAgainst: isHome ? m.ast : m.hst,
        result: m.result === "D" ? "D"
          : ((isHome && m.result === "H") || (!isHome && m.result === "A")) ? "W" : "L",
      });
    }
  }
  return stats;
}

function getFeatures(teamStats, teamName) {
  const ts = teamStats[teamName];
  if (!ts || ts.matches.length < MIN_TEAM_MATCHES) return null;
  const recent = ts.matches.slice(-10);
  const homeMatches = ts.matches.filter(m => m.isHome).slice(-10);
  const awayMatches = ts.matches.filter(m => !m.isHome).slice(-10);

  const points = recent.reduce((s, m) => s + (m.result === "W" ? 3 : m.result === "D" ? 1 : 0), 0);
  const formPctLong = points / (recent.length * 3);
  const recent4 = ts.matches.slice(-4);
  const points4 = recent4.reduce((s, m) => s + (m.result === "W" ? 3 : m.result === "D" ? 1 : 0), 0);
  const recentFormPct = points4 / (recent4.length * 3);
  const formPct = formPctLong * 0.4 + recentFormPct * 0.6;

  const goalsFor = avg(recent.map(m => m.goalsFor));
  const goalsAgainst = avg(recent.map(m => m.goalsAgainst));
  const goalsRatio = goalsAgainst > 0 ? Math.min(3.0, goalsFor / goalsAgainst) : goalsFor > 0 ? 3.0 : 1.0;
  const homeWinPct = homeMatches.length >= 3 ? homeMatches.filter(m => m.result === "W").length / homeMatches.length : 0.45;
  const awayWinPct = awayMatches.length >= 3 ? awayMatches.filter(m => m.result === "W").length / awayMatches.length : 0.30;
  const sotFor = avg(recent.map(m => m.shotsOnTarget || 0));
  const sotAgainst = avg(recent.map(m => m.shotsOnTargetAgainst || 0));
  const sotRatio = sotAgainst > 0 ? Math.min(3.0, sotFor / sotAgainst) : sotFor > 0 ? 3.0 : 1.0;
  const shotRatio = sotFor > 0.1 ? Math.min(3.0, sotFor / Math.max(0.1, sotAgainst)) : 1.0;
  const performanceRatio = goalsRatio * 0.5 + shotRatio * 0.5;
  return { formPct, goalsFor, goalsAgainst, goalsRatio, performanceRatio, homeWinPct, awayWinPct, sotFor, sotAgainst, sotRatio, totalMatches: ts.matches.length };
}

function poisson(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let r = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) r *= lambda / i;
  return r;
}

function predict(hf, af, leagueAvg) {
  if (!hf || !af) return null;
  const baseHome = leagueAvg.homeGoals || 1.45;
  const baseAway = leagueAvg.awayGoals || 1.10;
  const avgGoals = (baseHome + baseAway) / 2;
  let homeAttack = hf.goalsFor / avgGoals;
  let awayAttack = af.goalsFor / avgGoals;
  let homeDefense = hf.goalsAgainst / avgGoals;
  let awayDefense = af.goalsAgainst / avgGoals;
  if (hf.performanceRatio > 0 && hf.goalsRatio > 0) homeAttack *= Math.max(0.92, Math.min(1.08, hf.performanceRatio / hf.goalsRatio));
  if (af.performanceRatio > 0 && af.goalsRatio > 0) awayAttack *= Math.max(0.92, Math.min(1.08, af.performanceRatio / af.goalsRatio));
  const homeFormAdj = 0.95 + hf.formPct * 0.10;
  const awayFormAdj = 0.95 + af.formPct * 0.10;
  const homeAdv = hf.homeWinPct > 0.1 ? Math.max(0.95, Math.min(1.08, hf.homeWinPct / 0.45)) : 1.0;
  let lambdaHome = homeAttack * awayDefense * baseHome * homeFormAdj * homeAdv;
  let lambdaAway = awayAttack * homeDefense * baseAway * awayFormAdj;
  const homeShrink = Math.min(1, hf.totalMatches / 20);
  const awayShrink = Math.min(1, af.totalMatches / 20);
  lambdaHome = lambdaHome * homeShrink + baseHome * (1 - homeShrink);
  lambdaAway = lambdaAway * awayShrink + baseAway * (1 - awayShrink);
  lambdaHome = Math.max(0.4, Math.min(3.5, lambdaHome));
  lambdaAway = Math.max(0.3, Math.min(3.0, lambdaAway));
  let pH = 0, pD = 0, pA = 0;
  for (let i = 0; i <= 7; i++) for (let j = 0; j <= 7; j++) {
    const p = poisson(i, lambdaHome) * poisson(j, lambdaAway);
    if (i > j) pH += p; else if (i === j) pD += p; else pA += p;
  }
  const total = pH + pD + pA; pH /= total; pD /= total; pA /= total;
  const baseH = 0.45, baseD = 0.27, baseA = 0.28;
  const vs = (r, b) => r * (r < 0.45 ? 0.60 : r < 0.55 ? 0.45 : 0.35) + b * (r < 0.45 ? 0.40 : r < 0.55 ? 0.55 : 0.65);
  pH = vs(pH, baseH); pD = vs(pD, baseD); pA = vs(pA, baseA);
  pH = Math.min(pH, 0.48); pA = Math.min(pA, 0.40);
  const t2 = pH + pD + pA;
  return { pH: pH/t2, pD: pD/t2, pA: pA/t2 };
}

function leagueAverages(matches, league) {
  const m = matches.filter(x => x.league === league);
  if (!m.length) return { homeGoals: 1.45, awayGoals: 1.10 };
  return { homeGoals: avg(m.map(x=>x.hg)), awayGoals: avg(m.map(x=>x.ag)) };
}

function inAnyZone(odds, zones) {
  for (const [lo, hi] of zones) if (odds >= lo && odds <= hi) return true;
  return false;
}

// ============================================================
// WALK-FORWARD SIMULATION
// ============================================================
function simulate(variantZones, heldOutSeason) {
  const all = loadAllData();
  const train = all.filter(m => m.season !== heldOutSeason);
  const test = all.filter(m => m.season === heldOutSeason);

  const leagueAvg = {};
  for (const lg of Object.keys(LEAGUES)) leagueAvg[lg] = leagueAverages(train, lg);

  // Construimos teamStats incremental: arrancamos del train completo y
  // vamos añadiendo partidos del test conforme se juegan. Así, para cada
  // partido a predecir, solo usamos datos estrictamente anteriores.
  const teamStats = buildTeamStats(train);
  const byLeague = {};
  for (const m of test) { (byLeague[m.league] ??= []).push(m); }
  for (const lg of Object.keys(byLeague)) byLeague[lg].sort((a,b) => a.date - b.date);

  let bankroll = BANKROLL;
  let bets = 0, wins = 0, losses = 0;
  let totalStaked = 0, totalProfit = 0;
  const trades = [];

  for (const league of Object.keys(byLeague)) {
    for (const match of byLeague[league]) {
      const hf = getFeatures(teamStats, match.home);
      const af = getFeatures(teamStats, match.away);
      const pred = predict(hf, af, leagueAvg[league] || { homeGoals: 1.45, awayGoals: 1.10 });
      if (pred && match.oddsH && inAnyZone(match.oddsH, variantZones)) {
        const edge = pred.pH * match.oddsH - 1;
        if (edge >= MIN_EDGE && edge <= MAX_EDGE) {
          const kelly = Math.max(0, (pred.pH * match.oddsH - 1) / (match.oddsH - 1));
          const betPct = Math.min(MAX_BET_PCT, kelly * KELLY_FRACTION);
          const stake = Math.round(bankroll * betPct * 100) / 100;
          if (stake >= 1) {
            const won = match.result === "H";
            const profit = won ? stake * (match.oddsH - 1) : -stake;
            bankroll += profit; totalStaked += stake; totalProfit += profit;
            bets++; if (won) wins++; else losses++;
            trades.push({ date: match.date.toISOString().slice(0,10), league, home: match.home, away: match.away, odds: match.oddsH, edge, stake, won, profit });
          }
        }
      }
      // Añadir este partido al teamStats (ya jugado, datos disponibles para siguientes)
      for (const side of ["home","away"]) {
        const team = side === "home" ? match.home : match.away;
        if (!teamStats[team]) teamStats[team] = { matches: [], league };
        const isHome = side === "home";
        teamStats[team].matches.push({
          date: match.date, isHome,
          goalsFor: isHome ? match.hg : match.ag,
          goalsAgainst: isHome ? match.ag : match.hg,
          shotsOnTarget: isHome ? match.hst : match.ast,
          shotsOnTargetAgainst: isHome ? match.ast : match.hst,
          result: match.result === "D" ? "D"
            : ((isHome && match.result === "H") || (!isHome && match.result === "A")) ? "W" : "L",
        });
      }
    }
  }

  const pnl = bankroll - BANKROLL;
  const roi = totalStaked > 0 ? (pnl / totalStaked) * 100 : 0;
  const winRate = bets > 0 ? (wins / bets) * 100 : 0;
  return { heldOutSeason, bets, wins, losses, totalStaked, pnl, roi, winRate, finalBankroll: bankroll, trades };
}

// ============================================================
// MAIN
// ============================================================
console.log("=".repeat(70));
console.log(" HOLDOUT AUDIT — walk-forward temporal honesto");
console.log("=".repeat(70));
console.log(`Ligas: ${Object.keys(LEAGUES).length} | Temporadas: ${SEASONS.join(", ")}`);
console.log(`Zonas BASELINE:   ${JSON.stringify(ZONES.baseline)}`);
console.log(`Zonas EXTEND-UP:  ${JSON.stringify(ZONES["extend-up"])}`);
console.log(`Filtros: edge ${MIN_EDGE*100}%-${MAX_EDGE*100}% | Kelly ${KELLY_FRACTION} | cap ${MAX_BET_PCT*100}%`);
console.log("");

const results = {};
for (const [variantName, zones] of Object.entries(ZONES)) {
  console.log(`\n━━━ VARIANTE: ${variantName.toUpperCase()} ━━━`);
  results[variantName] = {};
  for (const season of SEASONS) {
    const r = simulate(zones, season);
    results[variantName][season] = r;
    const emoji = r.roi > 5 ? "🟢" : r.roi < -5 ? "🔴" : "🟡";
    console.log(`  ${emoji} Holdout ${season}: ${r.bets} apuestas | ${r.wins}W/${r.losses}L | WR ${r.winRate.toFixed(1)}% | ROI ${r.roi.toFixed(2)}% | PnL ${r.pnl >= 0 ? "+" : ""}${r.pnl.toFixed(2)}€`);
  }
  // Agregado
  const agg = Object.values(results[variantName]).reduce((a, r) => ({
    bets: a.bets + r.bets, wins: a.wins + r.wins, losses: a.losses + r.losses,
    totalStaked: a.totalStaked + r.totalStaked, pnl: a.pnl + r.pnl,
  }), { bets: 0, wins: 0, losses: 0, totalStaked: 0, pnl: 0 });
  const aggRoi = agg.totalStaked > 0 ? (agg.pnl / agg.totalStaked) * 100 : 0;
  const aggWR = agg.bets > 0 ? (agg.wins / agg.bets) * 100 : 0;
  console.log(`  ═══ AGREGADO: ${agg.bets} apuestas | WR ${aggWR.toFixed(1)}% | ROI ${aggRoi.toFixed(2)}% | PnL ${agg.pnl >= 0 ? "+" : ""}${agg.pnl.toFixed(2)}€`);
  results[variantName]._aggregate = { ...agg, roi: aggRoi, winRate: aggWR };
}

const out = path.join(__dirname, "holdout-audit-results.json");
fs.writeFileSync(out, JSON.stringify(results, null, 2));
console.log(`\n✅ Resultados guardados en scripts/holdout-audit-results.json`);

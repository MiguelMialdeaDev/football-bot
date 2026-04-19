// ============================================================
// BACKTEST-ZONES — Compara diferentes configuraciones de odds zones
// usando exactamente la misma logica del predictor-v3 walk-forward.
//
// Uso: node backtest-zones.js
// ============================================================

const fs = require("fs");

// Config base (identica a predictor-v3.js)
const BANKROLL = 5000;
const KELLY_FRACTION = 0.33;
const MIN_EDGE = 0.06;
const MAX_BET_PCT = 0.03;
const MAX_EDGE = 0.15;
const DATA_DIR = "./data";

const WF_TRAIN_MONTHS = 12;
const WF_TEST_MONTHS = 3;
const WF_STEP_MONTHS = 3;
const MIN_TEAM_MATCHES = 8;

const TARGET_LEAGUES = {
  SP2: "Segunda", F2: "Ligue 2", G1: "Greek Super", D2: "2. Bundesliga",
};

const ALL_LEAGUES = {
  SP1: "La Liga", E0: "Premier League", D1: "Bundesliga", I1: "Serie A",
  F1: "Ligue 1", D2: "2. Bundesliga", I2: "Serie B", T1: "Turquia",
  N1: "Eredivisie", P1: "Portugal", SP2: "Segunda",
  E1: "Championship", F2: "Ligue 2", SC0: "Scottish Prem",
  B1: "Belgian Pro", G1: "Greek Super",
  EC: "English League 1", E2: "English League 2", SC1: "Scottish Championship",
};
const SEASONS = ["2223", "2324", "2425"];
const BET_TYPES = ["H"];

// ============================================================
// CONFIGURACIONES A COMPARAR
// ============================================================
// Cada zona es un array de pares [min, max]. Una apuesta entra
// si sus odds caen en CUALQUIERA de los pares.
const VARIANTS = [
  {
    name: "BASELINE (actual)",
    zones: [[2.30, 2.60], [3.00, 3.50]],
  },
  {
    name: "GAP-FILL (rellenar 2.60-3.00)",
    zones: [[2.30, 3.50]],
  },
  {
    name: "EXTEND-DOWN (2.00-2.60 + 3.00-3.50)",
    zones: [[2.00, 2.60], [3.00, 3.50]],
  },
  {
    name: "EXTEND-UP (2.30-2.60 + 3.00-4.00)",
    zones: [[2.30, 2.60], [3.00, 4.00]],
  },
  {
    name: "WIDE (1.90-3.50 todo)",
    zones: [[1.90, 3.50]],
  },
  {
    name: "VERY-WIDE (1.70-4.00 todo)",
    zones: [[1.70, 4.00]],
  },
  {
    name: "NO ZONES (solo edge filtra)",
    zones: [[1.01, 100]],
  },
];

function inAnyZone(odds, zones) {
  for (const [min, max] of zones) {
    if (odds >= min && odds <= max) return true;
  }
  return false;
}

// ============================================================
// DATA LOADING — copia exacta de predictor-v3
// ============================================================
function loadAllData() {
  const all = [];
  for (const league of Object.keys(ALL_LEAGUES)) {
    for (const season of SEASONS) {
      const file = `${DATA_DIR}/${league}_${season}.csv`;
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
      const lines = raw.split("\n").filter(l => l.trim());
      if (lines.length < 2) continue;
      const h = lines[0].split(",");
      const g = (n) => h.indexOf(n);

      for (let i = 1; i < lines.length; i++) {
        const c = lines[i].split(",");
        if (c.length < 10) continue;
        const fthg = parseInt(c[g("FTHG")]), ftag = parseInt(c[g("FTAG")]);
        if (isNaN(fthg) || isNaN(ftag)) continue;

        const dp = (c[g("Date")] || "").split("/");
        let date = null;
        if (dp.length === 3) {
          let y = parseInt(dp[2]);
          if (y < 100) y += 2000;
          date = new Date(y, parseInt(dp[1]) - 1, parseInt(dp[0]));
        }
        if (!date || isNaN(date.getTime())) continue;

        all.push({
          league, date, dateStr: c[g("Date")],
          home: c[g("HomeTeam")], away: c[g("AwayTeam")],
          hg: fthg, ag: ftag,
          result: c[g("FTR")],
          totalGoals: fthg + ftag,
          hs: parseInt(c[g("HS")]) || 0, as: parseInt(c[g("AS")]) || 0,
          hst: parseInt(c[g("HST")]) || 0, ast: parseInt(c[g("AST")]) || 0,
          hthg: parseInt(c[g("HTHG")]) || 0, htag: parseInt(c[g("HTAG")]) || 0,
          pinnH: parseFloat(c[g("PSH")]) || 0,
          pinnD: parseFloat(c[g("PSD")]) || 0,
          pinnA: parseFloat(c[g("PSA")]) || 0,
          pinnCH: parseFloat(c[g("PSCH")]) || 0,
          pinnCD: parseFloat(c[g("PSCD")]) || 0,
          pinnCA: parseFloat(c[g("PSCA")]) || 0,
        });
      }
    }
  }
  all.sort((a, b) => a.date - b.date);
  return all;
}

// ============================================================
// MODELO — copia exacta de predictor-v3
// ============================================================
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

  const points = recent.reduce((s, m) =>
    s + (m.result === "W" ? 3 : m.result === "D" ? 1 : 0), 0);
  const formPctLong = points / (recent.length * 3);
  const recent4 = ts.matches.slice(-4);
  const points4 = recent4.reduce((s, m) =>
    s + (m.result === "W" ? 3 : m.result === "D" ? 1 : 0), 0);
  const recentFormPct = points4 / (recent4.length * 3);
  const formPct = formPctLong * 0.4 + recentFormPct * 0.6;

  const goalsFor = avg(recent.map(m => m.goalsFor));
  const goalsAgainst = avg(recent.map(m => m.goalsAgainst));
  const goalsRatio = goalsAgainst > 0
    ? Math.min(3.0, goalsFor / goalsAgainst)
    : goalsFor > 0 ? 3.0 : 1.0;

  const homeWinPct = homeMatches.length >= 3
    ? homeMatches.filter(m => m.result === "W").length / homeMatches.length
    : 0.45;
  const awayWinPct = awayMatches.length >= 3
    ? awayMatches.filter(m => m.result === "W").length / awayMatches.length
    : 0.30;

  const sotFor = avg(recent.map(m => m.shotsOnTarget || 0));
  const sotAgainst = avg(recent.map(m => m.shotsOnTargetAgainst || 0));
  const sotRatio = sotAgainst > 0
    ? Math.min(3.0, sotFor / sotAgainst)
    : sotFor > 0 ? 3.0 : 1.0;
  const shotRatio = sotFor > 0.1 ? Math.min(3.0, sotFor / Math.max(0.1, sotAgainst)) : 1.0;
  const performanceRatio = goalsRatio * 0.5 + shotRatio * 0.5;

  return {
    formPct, goalsFor, goalsAgainst, goalsRatio, performanceRatio,
    homeWinPct, awayWinPct, sotFor, sotAgainst, sotRatio,
    totalMatches: ts.matches.length,
  };
}

function predict(homeFeatures, awayFeatures, leagueAvg, motivation) {
  if (!homeFeatures || !awayFeatures) return null;
  const baseHome = leagueAvg.homeGoals || 1.45;
  const baseAway = leagueAvg.awayGoals || 1.10;
  const avgGoals = (baseHome + baseAway) / 2;

  let homeAttack = homeFeatures.goalsFor / avgGoals;
  let awayAttack = awayFeatures.goalsFor / avgGoals;
  let homeDefense = homeFeatures.goalsAgainst / avgGoals;
  let awayDefense = awayFeatures.goalsAgainst / avgGoals;

  if (homeFeatures.performanceRatio > 0 && homeFeatures.goalsRatio > 0) {
    const perfAdj = homeFeatures.performanceRatio / homeFeatures.goalsRatio;
    homeAttack *= Math.max(0.92, Math.min(1.08, perfAdj));
  }
  if (awayFeatures.performanceRatio > 0 && awayFeatures.goalsRatio > 0) {
    const perfAdj = awayFeatures.performanceRatio / awayFeatures.goalsRatio;
    awayAttack *= Math.max(0.92, Math.min(1.08, perfAdj));
  }

  const homeFormAdj = 0.95 + homeFeatures.formPct * 0.10;
  const awayFormAdj = 0.95 + awayFeatures.formPct * 0.10;
  const homeAdv = homeFeatures.homeWinPct > 0.1
    ? Math.max(0.95, Math.min(1.08, homeFeatures.homeWinPct / 0.45))
    : 1.0;

  let lambdaHome = homeAttack * awayDefense * baseHome * homeFormAdj * homeAdv;
  let lambdaAway = awayAttack * homeDefense * baseAway * awayFormAdj;

  if (motivation) {
    if (motivation.homeInTop3 || motivation.homeInBottom3) lambdaHome *= 1.03;
    if (motivation.homeInDeadZone) lambdaHome *= 0.97;
    if (motivation.awayInTop3) lambdaHome *= 0.98;
  }

  const homeShrink = Math.min(1, homeFeatures.totalMatches / 20);
  const awayShrink = Math.min(1, awayFeatures.totalMatches / 20);
  lambdaHome = lambdaHome * homeShrink + baseHome * (1 - homeShrink);
  lambdaAway = lambdaAway * awayShrink + baseAway * (1 - awayShrink);

  lambdaHome = Math.max(0.4, Math.min(3.5, lambdaHome));
  lambdaAway = Math.max(0.3, Math.min(3.0, lambdaAway));

  let pH = 0, pD = 0, pA = 0;
  for (let i = 0; i <= 7; i++) {
    for (let j = 0; j <= 7; j++) {
      const p = poisson(i, lambdaHome) * poisson(j, lambdaAway);
      if (i > j) pH += p;
      else if (i === j) pD += p;
      else pA += p;
    }
  }
  const total = pH + pD + pA;
  pH /= total; pD /= total; pA /= total;

  const baseH = 0.45, baseD = 0.27, baseA = 0.28;
  function variableShrink(rawP, baseP) {
    let shrink;
    if (rawP < 0.45) shrink = 0.40;
    else if (rawP < 0.55) shrink = 0.55;
    else shrink = 0.65;
    return rawP * (1 - shrink) + baseP * shrink;
  }
  pH = variableShrink(pH, baseH);
  pD = variableShrink(pD, baseD);
  pA = variableShrink(pA, baseA);
  pH = Math.min(pH, 0.48);
  pA = Math.min(pA, 0.40);
  const total2 = pH + pD + pA;
  pH /= total2; pD /= total2; pA /= total2;

  return { pH, pD, pA };
}

function poisson(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let r = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) r *= lambda / i;
  return r;
}

function buildStandings(matches, league) {
  const table = {};
  const leagueMatches = matches.filter(m => m.league === league);
  for (const m of leagueMatches) {
    if (!table[m.home]) table[m.home] = { team: m.home, pts: 0, gd: 0, played: 0 };
    if (!table[m.away]) table[m.away] = { team: m.away, pts: 0, gd: 0, played: 0 };
    table[m.home].played++;
    table[m.away].played++;
    table[m.home].gd += m.hg - m.ag;
    table[m.away].gd += m.ag - m.hg;
    if (m.result === "H") table[m.home].pts += 3;
    else if (m.result === "D") { table[m.home].pts += 1; table[m.away].pts += 1; }
    else table[m.away].pts += 3;
  }
  const sorted = Object.values(table).sort((a, b) => b.pts - a.pts || b.gd - a.gd);
  const positions = {};
  sorted.forEach((t, i) => { positions[t.team] = i + 1; });
  return { positions, totalTeams: sorted.length };
}

function isDeadZone(position, totalTeams) {
  if (totalTeams < 12) return false;
  const thirdSize = Math.floor(totalTeams / 3);
  return position >= thirdSize + 1 && position <= totalTeams - thirdSize;
}

function computeLeagueStats(matches) {
  const stats = {};
  for (const m of matches) {
    if (!stats[m.league]) stats[m.league] = { totalH: 0, totalA: 0, n: 0 };
    stats[m.league].totalH += m.hg;
    stats[m.league].totalA += m.ag;
    stats[m.league].n++;
  }
  for (const ls of Object.values(stats)) {
    ls.homeGoals = ls.n > 0 ? ls.totalH / ls.n : 1.45;
    ls.awayGoals = ls.n > 0 ? ls.totalA / ls.n : 1.10;
  }
  return stats;
}

function addMatchToStats(teamStats, match) {
  for (const side of ["home", "away"]) {
    const team = side === "home" ? match.home : match.away;
    if (!teamStats[team]) teamStats[team] = { matches: [], league: match.league };
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

// ============================================================
// WALK-FORWARD parametrizado por zonas
// ============================================================
function runWalkForward(allMatches, zones) {
  const firstDate = allMatches[0].date;
  const lastDate = allMatches[allMatches.length - 1].date;

  const windows = [];
  let trainStart = new Date(firstDate);
  while (true) {
    const trainEnd = addMonths(trainStart, WF_TRAIN_MONTHS);
    const testEnd = addMonths(trainEnd, WF_TEST_MONTHS);
    if (testEnd > lastDate) break;
    windows.push({ trainStart, trainEnd, testEnd });
    trainStart = addMonths(trainStart, WF_STEP_MONTHS);
  }

  let bankroll = BANKROLL;
  let totalBets = 0, wins = 0, totalStaked = 0;
  let maxBR = BANKROLL, minBR = BANKROLL;
  const monthlyPnL = {};

  for (const win of windows) {
    const trainData = allMatches.filter(m =>
      m.date >= win.trainStart && m.date < win.trainEnd);
    const testData = allMatches.filter(m =>
      m.date >= win.trainEnd && m.date < win.testEnd);

    if (trainData.length < 100 || testData.length < 20) continue;

    const teamStats = buildTeamStats(trainData);
    const leagueStats = computeLeagueStats(trainData);
    const standingsByLeague = {};
    for (const lg of Object.keys(TARGET_LEAGUES)) {
      standingsByLeague[lg] = buildStandings(trainData, lg);
    }

    for (const match of testData) {
      if (!TARGET_LEAGUES[match.league]) continue;
      if (bankroll < 100) break;

      const homeF = getFeatures(teamStats, match.home);
      const awayF = getFeatures(teamStats, match.away);
      const ls = leagueStats[match.league] || { homeGoals: 1.45, awayGoals: 1.10 };

      let motivation = null;
      const standings = standingsByLeague[match.league];
      if (standings && standings.totalTeams >= 12) {
        const homePos = standings.positions[match.home];
        const awayPos = standings.positions[match.away];
        if (homePos && awayPos) {
          motivation = {
            homeInTop3: homePos <= 3,
            homeInBottom3: homePos > standings.totalTeams - 3,
            homeInDeadZone: isDeadZone(homePos, standings.totalTeams),
            awayInTop3: awayPos <= 3,
          };
        }
      }

      const pred = predict(homeF, awayF, ls, motivation);
      if (!pred) continue;

      if (BET_TYPES.includes("H") && match.pinnH > 0) {
        const bet = {
          side: "H", prob: pred.pH, odds: match.pinnH,
          won: match.result === "H",
        };

        if (!inAnyZone(bet.odds, zones)) continue;

        const edge = bet.prob - 1 / bet.odds;
        if (edge < MIN_EDGE) continue;
        if (edge > MAX_EDGE) continue;

        const b = bet.odds - 1;
        const kelly = (b * bet.prob - (1 - bet.prob)) / b;
        if (kelly <= 0) continue;

        const size = Math.min(
          kelly * KELLY_FRACTION * bankroll,
          bankroll * MAX_BET_PCT
        );
        if (size < 5) continue;

        const payout = bet.won ? size * bet.odds : 0;
        const profit = payout - size;
        bankroll += profit;
        totalBets++; totalStaked += size;
        if (bet.won) wins++;
        maxBR = Math.max(maxBR, bankroll);
        minBR = Math.min(minBR, bankroll);

        if (match.date) {
          const mk = `${match.date.getFullYear()}-${String(match.date.getMonth() + 1).padStart(2, "0")}`;
          if (!monthlyPnL[mk]) monthlyPnL[mk] = { bets: 0, pnl: 0, staked: 0 };
          monthlyPnL[mk].bets++;
          monthlyPnL[mk].pnl += profit;
          monthlyPnL[mk].staked += size;
        }
      }

      addMatchToStats(teamStats, match);
    }
  }

  const profit = bankroll - BANKROLL;
  const roi = totalStaked > 0 ? (profit / totalStaked) * 100 : 0;
  const dd = maxBR > 0 ? ((maxBR - minBR) / maxBR) * 100 : 0;

  const monthlyReturns = Object.values(monthlyPnL).map(m =>
    m.staked > 0 ? m.pnl / m.staked : 0);
  const avgReturn = monthlyReturns.length > 0
    ? monthlyReturns.reduce((a, b) => a + b, 0) / monthlyReturns.length : 0;
  const stdReturn = monthlyReturns.length > 1
    ? Math.sqrt(monthlyReturns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / monthlyReturns.length)
    : 1;
  const sharpe = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(12) : 0;

  // Calcular meses positivos
  const totalMonths = Object.keys(monthlyPnL).length;
  const positiveMonths = Object.values(monthlyPnL).filter(m => m.pnl > 0).length;

  return {
    profit: Math.round(profit),
    roi: roi,
    sharpe: sharpe,
    totalBets, wins,
    winRate: totalBets > 0 ? (wins / totalBets * 100) : 0,
    finalBR: Math.round(bankroll),
    dd: dd,
    avgBetSize: totalBets > 0 ? totalStaked / totalBets : 0,
    totalStaked: Math.round(totalStaked),
    months: totalMonths,
    positiveMonths,
    avgMonthlyProfit: totalMonths > 0 ? profit / totalMonths : 0,
  };
}

function avg(arr) {
  return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

// ============================================================
// MAIN
// ============================================================
function main() {
  console.log("=".repeat(95));
  console.log("   BACKTEST DE ZONAS DE ODDS — Comparativa walk-forward");
  console.log("=".repeat(95));
  console.log(`   Modelo: predictor-v3 | Bankroll: EUR ${BANKROLL} | Kelly: ${KELLY_FRACTION}`);
  console.log(`   Min edge: ${MIN_EDGE * 100}% | Max edge: ${MAX_EDGE * 100}% | Max bet: ${MAX_BET_PCT * 100}%`);
  console.log(`   Walk-forward: ${WF_TRAIN_MONTHS}m train -> ${WF_TEST_MONTHS}m test`);
  console.log(`   Ligas: ${Object.values(TARGET_LEAGUES).join(", ")}`);
  console.log("=".repeat(95));

  console.log("\nCargando datos historicos...");
  const allMatches = loadAllData();
  console.log(`${allMatches.length} partidos cargados de ${Object.keys(ALL_LEAGUES).length} ligas`);
  console.log(`Periodo: ${allMatches[0].date.toISOString().slice(0,10)} -> ${allMatches[allMatches.length-1].date.toISOString().slice(0,10)}`);

  const results = [];
  for (const variant of VARIANTS) {
    console.log(`\nEjecutando: ${variant.name}...`);
    const r = runWalkForward(allMatches, variant.zones);
    results.push({ ...variant, ...r });
    console.log(`  -> ${r.totalBets} bets | ROI ${r.roi.toFixed(1)}% | Profit EUR ${r.profit} | DD ${r.dd.toFixed(1)}%`);
  }

  // Tabla comparativa
  console.log("\n" + "=".repeat(115));
  console.log("   RESULTADOS COMPARATIVOS");
  console.log("=".repeat(115));
  console.log(
    "   " +
    "Variante".padEnd(40) +
    "Bets".padStart(7) +
    "Profit".padStart(11) +
    "ROI".padStart(9) +
    "WinRate".padStart(10) +
    "Sharpe".padStart(9) +
    "DD".padStart(8) +
    "EUR/mes".padStart(11)
  );
  console.log("   " + "-".repeat(105));

  for (const r of results) {
    const profitStr = `EUR ${r.profit >= 0 ? "+" : ""}${r.profit}`;
    const monthlyStr = `EUR ${r.avgMonthlyProfit >= 0 ? "+" : ""}${r.avgMonthlyProfit.toFixed(0)}`;
    console.log(
      "   " +
      r.name.padEnd(40) +
      String(r.totalBets).padStart(7) +
      profitStr.padStart(11) +
      `${r.roi.toFixed(1)}%`.padStart(9) +
      `${r.winRate.toFixed(1)}%`.padStart(10) +
      r.sharpe.toFixed(2).padStart(9) +
      `${r.dd.toFixed(0)}%`.padStart(8) +
      monthlyStr.padStart(11)
    );
  }

  // Comparativa vs baseline
  const baseline = results[0];
  console.log("\n" + "=".repeat(95));
  console.log("   DIFERENCIA RESPECTO A BASELINE (actual)");
  console.log("=".repeat(95));
  console.log(
    "   " +
    "Variante".padEnd(40) +
    "Bets +/-".padStart(11) +
    "Profit +/-".padStart(13) +
    "ROI +/-".padStart(11) +
    "Sharpe +/-".padStart(13)
  );
  console.log("   " + "-".repeat(85));

  for (const r of results) {
    if (r === baseline) continue;
    const dBets = r.totalBets - baseline.totalBets;
    const dProfit = r.profit - baseline.profit;
    const dRoi = r.roi - baseline.roi;
    const dSharpe = r.sharpe - baseline.sharpe;

    console.log(
      "   " +
      r.name.padEnd(40) +
      `${dBets >= 0 ? "+" : ""}${dBets}`.padStart(11) +
      `EUR ${dProfit >= 0 ? "+" : ""}${dProfit}`.padStart(13) +
      `${dRoi >= 0 ? "+" : ""}${dRoi.toFixed(1)}%`.padStart(11) +
      `${dSharpe >= 0 ? "+" : ""}${dSharpe.toFixed(2)}`.padStart(13)
    );
  }

  console.log("\n" + "=".repeat(95));
  console.log("   INTERPRETACION");
  console.log("=".repeat(95));
  const bestProfit = [...results].sort((a, b) => b.profit - a.profit)[0];
  const bestRoi = [...results].sort((a, b) => b.roi - a.roi)[0];
  const bestSharpe = [...results].sort((a, b) => b.sharpe - a.sharpe)[0];

  console.log(`   Mayor profit absoluto:  ${bestProfit.name} (EUR ${bestProfit.profit})`);
  console.log(`   Mayor ROI:              ${bestRoi.name} (${bestRoi.roi.toFixed(1)}%)`);
  console.log(`   Mayor Sharpe:           ${bestSharpe.name} (${bestSharpe.sharpe.toFixed(2)})`);
  console.log("=".repeat(95));

  // Guardar resultados
  fs.writeFileSync("backtest-zones-results.json", JSON.stringify(results, null, 2));
  console.log("\nResultados guardados en backtest-zones-results.json\n");
}

main();

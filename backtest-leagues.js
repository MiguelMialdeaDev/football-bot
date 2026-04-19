// ============================================================
// BACKTEST-LEAGUES — Testea cada liga individualmente con los
// filtros actuales (baseline) para ver cuales son rentables si
// las añadimos al bot.
//
// Uso: node backtest-leagues.js
// ============================================================

const fs = require("fs");

const BANKROLL = 5000;
const KELLY_FRACTION = 0.33;
const MIN_EDGE = 0.06;
const MAX_EDGE = 0.15;
const MAX_BET_PCT = 0.03;
const DATA_DIR = "./data";

const WF_TRAIN_MONTHS = 12;
const WF_TEST_MONTHS = 3;
const WF_STEP_MONTHS = 3;
const MIN_TEAM_MATCHES = 8;
const BET_TYPES = ["H"];

// Zonas a usar: BASELINE (mismo filtro actual)
const ZONES = [[2.30, 2.60], [3.00, 3.50]];

// Probamos TODAS las ligas del dataset, no solo las 4 actuales
const ALL_LEAGUES = {
  SP1: "La Liga", SP2: "Segunda",
  E0: "Premier League", E1: "Championship", E2: "English L1", EC: "English L2",
  D1: "Bundesliga", D2: "2. Bundesliga",
  I1: "Serie A", I2: "Serie B",
  F1: "Ligue 1", F2: "Ligue 2",
  N1: "Eredivisie", P1: "Portugal", B1: "Belgian Pro", T1: "Turquia",
  G1: "Greek Super",
  SC0: "Scottish Prem", SC1: "Scottish Champ",
};
const SEASONS = ["2223", "2324", "2425"];

function inAnyZone(odds, zones) {
  for (const [min, max] of zones) {
    if (odds >= min && odds <= max) return true;
  }
  return false;
}

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
          league, date,
          home: c[g("HomeTeam")], away: c[g("AwayTeam")],
          hg: fthg, ag: ftag,
          result: c[g("FTR")],
          hst: parseInt(c[g("HST")]) || 0, ast: parseInt(c[g("AST")]) || 0,
          pinnH: parseFloat(c[g("PSH")]) || 0,
          pinnD: parseFloat(c[g("PSD")]) || 0,
          pinnA: parseFloat(c[g("PSA")]) || 0,
        });
      }
    }
  }
  all.sort((a, b) => a.date - b.date);
  return all;
}

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
  const shotRatio = sotFor > 0.1 ? Math.min(3.0, sotFor / Math.max(0.1, sotAgainst)) : 1.0;
  const performanceRatio = goalsRatio * 0.5 + shotRatio * 0.5;

  return {
    formPct, goalsFor, goalsAgainst, goalsRatio, performanceRatio,
    homeWinPct, awayWinPct, sotFor, sotAgainst,
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

function avg(arr) {
  return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

// ============================================================
// BACKTEST por liga individual
// ============================================================
function runBacktestForLeague(allMatches, targetLeague) {
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
    const standings = buildStandings(trainData, targetLeague);

    for (const match of testData) {
      if (match.league !== targetLeague) continue;
      if (bankroll < 100) break;

      const homeF = getFeatures(teamStats, match.home);
      const awayF = getFeatures(teamStats, match.away);
      const ls = leagueStats[match.league] || { homeGoals: 1.45, awayGoals: 1.10 };

      let motivation = null;
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
          prob: pred.pH, odds: match.pinnH,
          won: match.result === "H",
        };

        if (!inAnyZone(bet.odds, ZONES)) continue;
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
  const winRate = totalBets > 0 ? (wins / totalBets * 100) : 0;

  return {
    league: targetLeague,
    leagueName: ALL_LEAGUES[targetLeague],
    bets: totalBets,
    wins,
    winRate,
    profit: Math.round(profit),
    roi,
    dd,
    totalStaked: Math.round(totalStaked),
    months: Object.keys(monthlyPnL).length,
  };
}

// ============================================================
// MAIN
// ============================================================
function main() {
  console.log("=".repeat(95));
  console.log("   BACKTEST POR LIGA — Rentabilidad individual con filtros BASELINE");
  console.log("=".repeat(95));
  console.log(`   Zonas: 2.30-2.60 + 3.00-3.50 | Min edge: ${MIN_EDGE*100}% | Max edge: ${MAX_EDGE*100}%`);
  console.log(`   Kelly: ${KELLY_FRACTION} | Max bet: ${MAX_BET_PCT*100}%`);
  console.log("=".repeat(95));

  console.log("\nCargando datos historicos de TODAS las ligas...");
  const allMatches = loadAllData();
  console.log(`${allMatches.length} partidos cargados`);

  const results = [];
  for (const league of Object.keys(ALL_LEAGUES)) {
    const leagueMatches = allMatches.filter(m => m.league === league);
    if (leagueMatches.length < 100) {
      console.log(`  [SKIP] ${league} (${ALL_LEAGUES[league]}): solo ${leagueMatches.length} partidos`);
      continue;
    }
    console.log(`  Testeando ${league} (${ALL_LEAGUES[league]})... (${leagueMatches.length} partidos)`);
    const r = runBacktestForLeague(allMatches, league);
    results.push(r);
  }

  // Ordenar por ROI
  results.sort((a, b) => b.roi - a.roi);

  console.log("\n" + "=".repeat(105));
  console.log("   RESULTADOS POR LIGA (ordenados por ROI)");
  console.log("=".repeat(105));
  console.log(
    "   " +
    "Liga".padEnd(25) +
    "Bets".padStart(7) +
    "Win%".padStart(9) +
    "Profit".padStart(12) +
    "ROI".padStart(10) +
    "DD".padStart(9) +
    "  Verdict"
  );
  console.log("   " + "-".repeat(100));

  for (const r of results) {
    let verdict;
    if (r.bets < 10) verdict = "INSUFICIENTE (pocos bets)";
    else if (r.roi >= 10 && r.bets >= 20) verdict = "EXCELENTE (anadir)";
    else if (r.roi >= 5 && r.bets >= 15) verdict = "RENTABLE (anadir)";
    else if (r.roi >= 0) verdict = "MARGINAL (dudoso)";
    else verdict = "NO RENTABLE (descartar)";

    console.log(
      "   " +
      (`${r.league} (${r.leagueName})`).padEnd(25) +
      String(r.bets).padStart(7) +
      `${r.winRate.toFixed(1)}%`.padStart(9) +
      `EUR ${r.profit >= 0 ? "+" : ""}${r.profit}`.padStart(12) +
      `${r.roi.toFixed(1)}%`.padStart(10) +
      `${r.dd.toFixed(0)}%`.padStart(9) +
      "  " + verdict
    );
  }

  // Mostrar candidatos a anadir
  console.log("\n" + "=".repeat(95));
  console.log("   LIGAS CANDIDATAS A ANADIR AL BOT");
  console.log("=".repeat(95));

  const currentLeagues = ["SP2", "F2", "G1", "SC0"];
  const newCandidates = results.filter(r =>
    !currentLeagues.includes(r.league) &&
    r.roi >= 5 &&
    r.bets >= 15
  );

  if (newCandidates.length === 0) {
    console.log("   Ninguna liga nueva cumple criterios (ROI >= 5%, >= 15 bets)");
  } else {
    let totalExtraBets = 0;
    let totalExtraProfit = 0;
    for (const r of newCandidates) {
      console.log(`   [ANADIR] ${r.league} (${r.leagueName}): ${r.bets} bets, ${r.roi.toFixed(1)}% ROI, EUR +${r.profit}`);
      totalExtraBets += r.bets;
      totalExtraProfit += r.profit;
    }
    console.log(`\n   TOTAL si las añadimos todas:`);
    console.log(`     +${totalExtraBets} bets extra (en 3 anos = ~${(totalExtraBets/36).toFixed(1)} bets/mes mas)`);
    console.log(`     +EUR ${totalExtraProfit} profit extra`);
    console.log(`     ~EUR ${(totalExtraProfit/36).toFixed(0)}/mes adicionales`);
  }
  console.log("=".repeat(95));

  // Guardar
  fs.writeFileSync("backtest-leagues-results.json", JSON.stringify(results, null, 2));
  console.log("\nResultados guardados en backtest-leagues-results.json\n");
}

main();

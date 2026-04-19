// ============================================================
// FOOTBALL PREDICTOR V2 — Enhanced with advanced features
// Features: Form, H2H, shots model, home/away strength,
//           goal timing, defensive solidity, attack diversity
// ============================================================

const fs = require("fs");

// ============================================================
// CONFIG (Optimized from optimizer.js)
// ============================================================
const BANKROLL = 5000;
const KELLY_FRACTION = 0.10;
const MIN_VALUE_EDGE = 0.01;
const MAX_BET_PCT = 0.03;
const MIN_ODDS = 1.50;
const MAX_ODDS = 5.0;
const DATA_DIR = "./data";
const LOG_FILE = "predictor-v2-backtest.json";

const LEAGUES = { D1:1, I1:1, D2:1, I2:1, T1:1, N1:1, SP2:1 };
const ALL_LEAGUES = {
  SP1:"La Liga", E0:"Premier League", D1:"Bundesliga", I1:"Serie A",
  F1:"Ligue 1", D2:"2. Bundesliga", I2:"Serie B", T1:"Turquía",
  N1:"Eredivisie", P1:"Portugal", SP2:"Segunda",
  B1:"Bélgica", G1:"Grecia", SC0:"Escocia",
};
const SEASONS = ["2223", "2324", "2425"];

// ============================================================
// DATA
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
      const g = (n) => { const i = h.indexOf(n); return i; };

      for (let i = 1; i < lines.length; i++) {
        const c = lines[i].split(",");
        if (c.length < 10) continue;
        const fthg = parseInt(c[g("FTHG")]), ftag = parseInt(c[g("FTAG")]);
        if (isNaN(fthg) || isNaN(ftag)) continue;

        const dp = (c[g("Date")] || "").split("/");
        let date = null;
        if (dp.length === 3) { let y = parseInt(dp[2]); if (y<100) y+=2000; date = new Date(y, parseInt(dp[1])-1, parseInt(dp[0])); }

        all.push({
          league, date, dateStr: c[g("Date")],
          home: c[g("HomeTeam")], away: c[g("AwayTeam")],
          hg: fthg, ag: ftag, result: c[g("FTR")], totalGoals: fthg+ftag,
          // Stats
          hs: parseInt(c[g("HS")])||0, as: parseInt(c[g("AS")])||0,
          hst: parseInt(c[g("HST")])||0, ast: parseInt(c[g("AST")])||0,
          hc: parseInt(c[g("HC")])||0, ac: parseInt(c[g("AC")])||0,
          hf: parseInt(c[g("HF")])||0, af: parseInt(c[g("AF")])||0,
          hy: parseInt(c[g("HY")])||0, ay: parseInt(c[g("AY")])||0,
          hr: parseInt(c[g("HR")])||0, ar: parseInt(c[g("AR")])||0,
          // Half time
          hthg: parseInt(c[g("HTHG")])||0, htag: parseInt(c[g("HTAG")])||0,
          // Odds
          pinnH: parseFloat(c[g("PSH")])||0, pinnD: parseFloat(c[g("PSD")])||0,
          pinnA: parseFloat(c[g("PSA")])||0,
          maxH: parseFloat(c[g("MaxH")])||0, maxD: parseFloat(c[g("MaxD")])||0,
          maxA: parseFloat(c[g("MaxA")])||0,
          pinnOver: parseFloat(c[g("P>2.5")])||0, pinnUnder: parseFloat(c[g("P<2.5")])||0,
          maxOver: parseFloat(c[g("Max>2.5")])||0, maxUnder: parseFloat(c[g("Max<2.5")])||0,
        });
      }
    }
  }
  all.sort((a,b) => (a.date||0) - (b.date||0));
  return all;
}

// ============================================================
// FEATURE ENGINEERING
// ============================================================

function buildFeatures(allMatches, upToIndex) {
  const matches = allMatches.slice(0, upToIndex);
  const teamStats = {};

  // Build per-team rolling stats
  for (const m of matches) {
    for (const side of ["home", "away"]) {
      const team = side === "home" ? m.home : m.away;
      if (!teamStats[team]) teamStats[team] = { matches: [], league: m.league };

      const isHome = side === "home";
      teamStats[team].matches.push({
        date: m.date,
        isHome,
        goalsFor: isHome ? m.hg : m.ag,
        goalsAgainst: isHome ? m.ag : m.hg,
        shotsFor: isHome ? m.hs : m.as,
        shotsAgainst: isHome ? m.as : m.hs,
        shotsOnTargetFor: isHome ? m.hst : m.ast,
        shotsOnTargetAgainst: isHome ? m.ast : m.hst,
        cornersFor: isHome ? m.hc : m.ac,
        result: m.result === "D" ? "D" : ((isHome && m.result === "H") || (!isHome && m.result === "A")) ? "W" : "L",
        opponent: isHome ? m.away : m.home,
        htGoalsFor: isHome ? m.hthg : m.htag,
        htGoalsAgainst: isHome ? m.htag : m.hthg,
      });
    }
  }

  return teamStats;
}

function getTeamFeatures(teamStats, teamName, n = 10) {
  if (!teamStats) return null;
  const ts = teamStats[teamName];
  if (!ts || ts.matches.length < 5) return null;

  const recent = ts.matches.slice(-n);
  const homeMatches = ts.matches.filter(m => m.isHome).slice(-10);
  const awayMatches = ts.matches.filter(m => !m.isHome).slice(-10);

  // Form (points in last N)
  const points = recent.reduce((s, m) => s + (m.result === "W" ? 3 : m.result === "D" ? 1 : 0), 0);
  const maxPoints = recent.length * 3;
  const formPct = maxPoints > 0 ? points / maxPoints : 0.33;

  // Goals
  const avgGoalsFor = avg(recent.map(m => m.goalsFor));
  const avgGoalsAgainst = avg(recent.map(m => m.goalsAgainst));

  // Shots efficiency (xG proxy — shots on target / shots)
  const shotEfficiency = avg(recent.map(m => m.shotsFor > 0 ? m.shotsOnTargetFor / m.shotsFor : 0));
  const shotVolume = avg(recent.map(m => m.shotsFor));

  // Defensive solidity
  const cleanSheets = recent.filter(m => m.goalsAgainst === 0).length / recent.length;
  const shotsAgainst = avg(recent.map(m => m.shotsAgainst));

  // Second half goals (teams that score late — comeback potential)
  const secondHalfGoals = avg(recent.map(m => m.goalsFor - m.htGoalsFor));
  const firstHalfGoals = avg(recent.map(m => m.htGoalsFor));

  // Home/Away specific strength
  const homeForm = homeMatches.length >= 3
    ? homeMatches.reduce((s, m) => s + (m.result === "W" ? 3 : m.result === "D" ? 1 : 0), 0) / (homeMatches.length * 3)
    : 0.5;
  const awayForm = awayMatches.length >= 3
    ? awayMatches.reduce((s, m) => s + (m.result === "W" ? 3 : m.result === "D" ? 1 : 0), 0) / (awayMatches.length * 3)
    : 0.33;

  // Streak
  let streak = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].result === "W") streak++;
    else if (recent[i].result === "L") { streak = -1; break; }
    else break;
  }

  return {
    formPct,
    avgGoalsFor, avgGoalsAgainst,
    shotEfficiency, shotVolume,
    cleanSheets, shotsAgainst,
    secondHalfGoals, firstHalfGoals,
    homeForm, awayForm,
    streak,
    totalMatches: ts.matches.length,
  };
}

function getH2H(allMatches, upToIndex, home, away) {
  const h2h = allMatches.slice(0, upToIndex).filter(m =>
    (m.home === home && m.away === away) || (m.home === away && m.away === home)
  ).slice(-6); // Last 6 meetings

  if (h2h.length < 2) return null;

  const homeWins = h2h.filter(m =>
    (m.home === home && m.result === "H") || (m.away === home && m.result === "A")
  ).length;
  const draws = h2h.filter(m => m.result === "D").length;
  const avgGoals = avg(h2h.map(m => m.totalGoals));

  return {
    homeWinPct: homeWins / h2h.length,
    drawPct: draws / h2h.length,
    avgGoals,
    totalMeetings: h2h.length,
  };
}

// ============================================================
// ENHANCED PREDICTION
// ============================================================

function predictEnhanced(homeTeam, awayTeam, homeFeatures, awayFeatures, h2h, leagueStats) {
  if (!homeFeatures || !awayFeatures) return null;

  // Base: league average goals
  const baseHome = leagueStats.avgHomeGoals || 1.5;
  const baseAway = leagueStats.avgAwayGoals || 1.1;

  // Attack strength (relative to league)
  const homeAttack = homeFeatures.avgGoalsFor / ((baseHome + baseAway) / 2);
  const awayAttack = awayFeatures.avgGoalsFor / ((baseHome + baseAway) / 2);

  // Defense strength
  const homeDefense = homeFeatures.avgGoalsAgainst / ((baseHome + baseAway) / 2);
  const awayDefense = awayFeatures.avgGoalsAgainst / ((baseHome + baseAway) / 2);

  // Shot efficiency boost (proxy for xG — team that converts well)
  const homeEffBoost = 1 + (homeFeatures.shotEfficiency - 0.35) * 0.5;
  const awayEffBoost = 1 + (awayFeatures.shotEfficiency - 0.35) * 0.5;

  // Form adjustment
  const homeFormAdj = 0.85 + homeFeatures.formPct * 0.30; // 0.85-1.15
  const awayFormAdj = 0.85 + awayFeatures.formPct * 0.30;

  // Home advantage from actual data
  const homeAdvantage = homeFeatures.homeForm / Math.max(0.1, awayFeatures.awayForm);
  const homeAdvAdj = Math.max(0.7, Math.min(1.5, homeAdvantage));

  // Calculate lambdas
  let lambdaHome = homeAttack * awayDefense * baseHome * homeEffBoost * homeFormAdj * homeAdvAdj;
  let lambdaAway = awayAttack * homeDefense * baseAway * awayEffBoost * awayFormAdj;

  // Shrinkage: pull toward league average with few matches
  const homeShrink = Math.min(1, homeFeatures.totalMatches / 25);
  const awayShrink = Math.min(1, awayFeatures.totalMatches / 25);
  lambdaHome = lambdaHome * homeShrink + baseHome * (1 - homeShrink);
  lambdaAway = lambdaAway * awayShrink + baseAway * (1 - awayShrink);

  // H2H adjustment
  if (h2h && h2h.totalMeetings >= 3) {
    // If H2H shows more draws than expected, boost draw probability
    const h2hDrawBoost = h2h.drawPct > 0.35 ? 1.15 : h2h.drawPct < 0.15 ? 0.90 : 1.0;
    // Apply subtly via lambda compression (closer lambdas = more draws)
    if (h2hDrawBoost > 1) {
      const mid = (lambdaHome + lambdaAway) / 2;
      lambdaHome = lambdaHome * 0.9 + mid * 0.1;
      lambdaAway = lambdaAway * 0.9 + mid * 0.1;
    }
  }

  // Cap
  lambdaHome = Math.max(0.3, Math.min(4.0, lambdaHome));
  lambdaAway = Math.max(0.2, Math.min(3.5, lambdaAway));

  // Poisson calculation
  let pH = 0, pD = 0, pA = 0, pOver = 0;
  for (let i = 0; i <= 7; i++) {
    for (let j = 0; j <= 7; j++) {
      const p = poisson(i, lambdaHome) * poisson(j, lambdaAway);
      if (i > j) pH += p;
      else if (i === j) pD += p;
      else pA += p;
      if (i + j > 2) pOver += p;
    }
  }

  const total = pH + pD + pA;
  pH /= total; pD /= total; pA /= total;

  return { pH, pD, pA, pOver, lambdaHome, lambdaAway };
}

function poisson(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let r = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) r *= lambda / i;
  return r;
}

// ============================================================
// BACKTEST
// ============================================================

function runBacktest(allMatches) {
  const trainSize = Math.floor(allMatches.length * 0.6);
  const testMatches = allMatches.slice(trainSize);

  console.log(`   Train: ${trainSize} | Test: ${testMatches.length}`);

  let bankroll = BANKROLL, totalBets = 0, wins = 0, totalStaked = 0, totalReturned = 0;
  let maxBR = BANKROLL, minBR = BANKROLL;
  const monthlyPnL = {}, leaguePnL = {}, typePnL = {};
  const betLog = [];

  // Compute league stats from training data
  const leagueStats = {};
  for (const m of allMatches.slice(0, trainSize)) {
    if (!leagueStats[m.league]) leagueStats[m.league] = { totalH: 0, totalA: 0, n: 0 };
    leagueStats[m.league].totalH += m.hg;
    leagueStats[m.league].totalA += m.ag;
    leagueStats[m.league].n++;
  }
  for (const ls of Object.values(leagueStats)) {
    ls.avgHomeGoals = ls.totalH / ls.n;
    ls.avgAwayGoals = ls.totalA / ls.n;
  }

  let featureCache = null;
  let lastRebuild = -1;
  const rebuildEvery = 40;

  for (let i = 0; i < testMatches.length; i++) {
    const match = testMatches[i];
    if (!LEAGUES[match.league]) continue;
    if (bankroll < 50) break;

    // Rebuild features periodically
    if (i - lastRebuild >= rebuildEvery) {
      featureCache = buildFeatures(allMatches, trainSize + i);
      lastRebuild = i;
    }

    const homeF = getTeamFeatures(featureCache, match.home);
    const awayF = getTeamFeatures(featureCache, match.away);
    const h2h = getH2H(allMatches, trainSize + i, match.home, match.away);
    const ls = leagueStats[match.league] || { avgHomeGoals: 1.5, avgAwayGoals: 1.1 };

    const pred = predictEnhanced(match.home, match.away, homeF, awayF, h2h, ls);
    if (!pred) continue;

    // Pinnacle fair odds
    const pOr = (match.pinnH > 0 && match.pinnD > 0 && match.pinnA > 0)
      ? 1/match.pinnH + 1/match.pinnD + 1/match.pinnA : 0;
    if (pOr <= 0) continue;

    const pinnFairH = (1/match.pinnH)/pOr;
    const pinnFairD = (1/match.pinnD)/pOr;
    const pinnFairA = (1/match.pinnA)/pOr;

    // Blend: 60% Pinnacle + 40% Enhanced Model
    // (the model adds form, H2H, shots — information Pinnacle has but we weight differently)
    const bH = pinnFairH * 0.6 + pred.pH * 0.4;
    const bD = pinnFairD * 0.6 + pred.pD * 0.4;
    const bA = pinnFairA * 0.6 + pred.pA * 0.4;
    const bT = bH + bD + bA;

    // Bet types: H (home), D (draw) — no away (negative ROI from optimizer)
    // Plus Over 2.5
    const bets = [
      { side: "H", prob: bH/bT, odds: match.maxH, won: match.result === "H" },
      { side: "D", prob: bD/bT, odds: match.maxD, won: match.result === "D" },
    ];

    // Over 2.5
    if (match.pinnOver > 0 && match.pinnUnder > 0 && match.maxOver > 0) {
      const ouOr = 1/match.pinnOver + 1/match.pinnUnder;
      const pinnFairOver = (1/match.pinnOver)/ouOr;
      // Blend with model
      const modelOver = pred.pOver;
      const blendOver = pinnFairOver * 0.6 + modelOver * 0.4;
      bets.push({ side: "Over", prob: blendOver, odds: match.maxOver, won: match.totalGoals > 2.5 });
    }

    for (const bet of bets) {
      if (!bet.odds || bet.odds < MIN_ODDS || bet.odds > MAX_ODDS) continue;
      const edge = bet.prob - 1/bet.odds;
      if (edge < MIN_VALUE_EDGE) continue;

      const b = bet.odds - 1;
      const kelly = (b * bet.prob - (1 - bet.prob)) / b;
      if (kelly <= 0) continue;

      const size = Math.min(kelly * KELLY_FRACTION * bankroll, bankroll * MAX_BET_PCT);
      if (size < 5) continue;

      const payout = bet.won ? size * bet.odds : 0;
      const profit = payout - size;
      bankroll += profit;
      totalBets++; totalStaked += size; totalReturned += payout;
      if (bet.won) wins++;
      maxBR = Math.max(maxBR, bankroll);
      minBR = Math.min(minBR, bankroll);

      // Track
      if (match.date) {
        const mk = `${match.date.getFullYear()}-${String(match.date.getMonth()+1).padStart(2,"0")}`;
        if (!monthlyPnL[mk]) monthlyPnL[mk] = { bets: 0, pnl: 0 };
        monthlyPnL[mk].bets++; monthlyPnL[mk].pnl += profit;
      }
      if (!leaguePnL[match.league]) leaguePnL[match.league] = { bets: 0, pnl: 0, staked: 0 };
      leaguePnL[match.league].bets++; leaguePnL[match.league].pnl += profit; leaguePnL[match.league].staked += size;
      if (!typePnL[bet.side]) typePnL[bet.side] = { bets: 0, pnl: 0, staked: 0 };
      typePnL[bet.side].bets++; typePnL[bet.side].pnl += profit; typePnL[bet.side].staked += size;

      betLog.push({
        date: match.dateStr, league: match.league,
        match: `${match.home} vs ${match.away}`,
        side: bet.side, prob: (bet.prob*100).toFixed(1)+"%",
        odds: bet.odds.toFixed(2), edge: (edge*100).toFixed(1)+"%",
        bet: Math.round(size), won: bet.won, profit: Math.round(profit),
        bankroll: Math.round(bankroll),
        // Extra context
        homeForm: homeF?.formPct?.toFixed(2) || "?",
        awayForm: awayF?.formPct?.toFixed(2) || "?",
        h2hDraws: h2h?.drawPct?.toFixed(2) || "?",
      });
    }
  }

  const profit = bankroll - BANKROLL;
  const roi = totalStaked > 0 ? (profit/totalStaked)*100 : 0;
  const dd = maxBR > 0 ? ((maxBR-minBR)/maxBR)*100 : 0;
  const mr = Object.values(monthlyPnL).map(m => m.pnl/BANKROLL);
  const avgR = mr.length > 0 ? mr.reduce((a,b)=>a+b,0)/mr.length : 0;
  const stdR = mr.length > 1 ? Math.sqrt(mr.reduce((s,r) => s+(r-avgR)**2, 0)/mr.length) : 1;
  const sharpe = stdR > 0 ? (avgR/stdR)*Math.sqrt(12) : 0;

  return { profit: Math.round(profit), roi: roi.toFixed(1)+"%", sharpe: sharpe.toFixed(2),
    totalBets, wins, winRate: (totalBets>0?(wins/totalBets*100):0).toFixed(1)+"%",
    finalBR: Math.round(bankroll), dd: dd.toFixed(1)+"%",
    monthlyPnL, leaguePnL, typePnL, betLog };
}

// ============================================================
// DASHBOARD
// ============================================================

function printResults(r) {
  console.log("\n" + "=".repeat(80));
  console.log("   PREDICTOR V2 — Enhanced Features Backtest");
  console.log("=".repeat(80));

  console.log(`\n   Bankroll: €${BANKROLL} → €${r.finalBR} (${r.profit >= 0 ? "+" : ""}€${r.profit})`);
  console.log(`   ROI: ${r.roi} | Sharpe: ${r.sharpe} | Drawdown: ${r.dd}`);
  console.log(`   Bets: ${r.totalBets} | Won: ${r.wins} (${r.winRate})`);

  console.log("\n   POR TIPO DE APUESTA:");
  for (const [type, d] of Object.entries(r.typePnL).sort((a,b) => b[1].pnl - a[1].pnl)) {
    const roi = d.staked > 0 ? ((d.pnl/d.staked)*100).toFixed(1) : "0";
    console.log(`     ${type.padEnd(8)}: ${String(d.bets).padStart(4)} bets | €${d.pnl>=0?"+":""}${Math.round(d.pnl).toString().padStart(6)} | ${roi.padStart(5)}% ROI`);
  }

  console.log("\n   POR LIGA:");
  for (const [lg, d] of Object.entries(r.leaguePnL).sort((a,b) => b[1].pnl - a[1].pnl)) {
    const roi = d.staked > 0 ? ((d.pnl/d.staked)*100).toFixed(1) : "0";
    console.log(`     ${(ALL_LEAGUES[lg]||lg).padEnd(16)}: ${String(d.bets).padStart(4)} bets | €${d.pnl>=0?"+":""}${Math.round(d.pnl).toString().padStart(6)} | ${roi.padStart(6)}% ROI`);
  }

  console.log("\n   P&L MENSUAL:");
  for (const [m, d] of Object.entries(r.monthlyPnL).sort()) {
    const bar = d.pnl >= 0
      ? "+" + "#".repeat(Math.min(25, Math.floor(d.pnl/30)))
      : "-" + "░".repeat(Math.min(25, Math.floor(Math.abs(d.pnl)/30)));
    console.log(`     ${m}: ${String(d.bets).padStart(3)} bets | €${d.pnl>=0?"+":""}${Math.round(d.pnl).toString().padStart(6)} | ${bar}`);
  }

  console.log("\n   ULTIMAS 15 APUESTAS:");
  for (const b of r.betLog.slice(-15)) {
    console.log(`     ${(b.date||"?").padEnd(12)} ${b.match.slice(0,25).padEnd(27)} ${b.side.padEnd(6)} ${b.odds.padStart(5)} ${b.edge.padStart(5)} ${b.won?"W":"L"} €${b.profit>=0?"+":""}${b.profit}`);
  }

  const verdict = r.profit > 0 && parseFloat(r.sharpe) > 1.5 ? "EXCELENTE" :
    r.profit > 0 && parseFloat(r.sharpe) > 1.0 ? "BUENO — Live testing" :
    r.profit > 0 ? "MARGINAL" : "NO RENTABLE";
  console.log(`\n   VEREDICTO: ${verdict}`);
  console.log("=".repeat(80));
}

function avg(arr) { return arr.length > 0 ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }

// ============================================================
// MAIN
// ============================================================

function main() {
  console.log("=".repeat(80));
  console.log("   PREDICTOR V2 — Form + H2H + Shots + Home/Away Strength");
  console.log("=".repeat(80));

  const allMatches = loadAllData();
  console.log(`   ${allMatches.length} partidos cargados`);

  const result = runBacktest(allMatches);
  printResults(result);

  fs.writeFileSync(LOG_FILE, JSON.stringify({
    config: { BANKROLL, KELLY_FRACTION, MIN_VALUE_EDGE, MIN_ODDS, MAX_ODDS },
    results: { profit: result.profit, roi: result.roi, sharpe: result.sharpe,
      bets: result.totalBets, wins: result.wins, winRate: result.winRate, dd: result.dd },
    monthlyPnL: result.monthlyPnL, leaguePnL: result.leaguePnL,
    typePnL: result.typePnL, lastBets: result.betLog.slice(-50),
  }, null, 2));
}

main();

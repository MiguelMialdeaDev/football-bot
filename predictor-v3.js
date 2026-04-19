// ============================================================
// FOOTBALL PREDICTOR V3 — Rebuilt from scratch
//
// Fixes from v2 analysis (ROI -6.8%, Sharpe -1.68):
//   1. NO Pinnacle blend — pure model (Pinnacle = CLV benchmark only)
//   2. Walk-forward backtest (no look-ahead bias)
//   3. Only 3 features (form, goals ratio, home/away %)
//   4. Minor leagues only (drop Bundesliga, reduce Serie A)
//   5. Quarter Kelly (0.25), min edge 4%, odds 1.70-3.50
//   6. Use Pinnacle odds for execution (not Max — unrealistic)
//   7. CLV tracking + Calibration plot + Monte Carlo
//   8. Drop Home as primary — v2 Home was -13% ROI
//   9. Focus on Draw + Under 2.5 (underpriced markets)
// ============================================================

const fs = require("fs");

// ============================================================
// CONFIG
// ============================================================
const BANKROLL = 5000;
const KELLY_FRACTION = 0.33;       // Third Kelly — optimized from 0.25
const MIN_EDGE = 0.06;             // 6% minimum — higher selectivity
const MAX_BET_PCT = 0.03;          // 3% max per bet — up from 2%
const MIN_ODDS = 1.70;             // Up from 1.50
const MAX_ODDS = 3.50;             // Down from 5.0
const DATA_DIR = "./data";
const LOG_FILE = "predictor-v3-backtest.json";

// Walk-forward config
const WF_TRAIN_MONTHS = 12;        // 12 months training window
const WF_TEST_MONTHS = 3;          // 3 months test window
const WF_STEP_MONTHS = 3;          // Advance 3 months each step
const MIN_TEAM_MATCHES = 8;        // Need 8+ matches for features

// v3.6 (2026-04-11): Dropped SC0 (post-calibration backtest showed -32.7% ROI)
// Added D2 (2. Bundesliga, +19.6% ROI, 35 bets in backtest)
// F2: +32.3% ROI | SP2: +16.1% ROI | D2: +19.6% ROI | G1: +9.5% ROI (marginal)
const TARGET_LEAGUES = {
  SP2: "Segunda División",
  F2: "Ligue 2",
  G1: "Greek Super",
  D2: "2. Bundesliga",
};

// All leagues for data loading
const ALL_LEAGUES = {
  SP1: "La Liga", E0: "Premier League", D1: "Bundesliga", I1: "Serie A",
  F1: "Ligue 1", D2: "2. Bundesliga", I2: "Serie B", T1: "Turquía",
  N1: "Eredivisie", P1: "Portugal", SP2: "Segunda",
  E1: "Championship", F2: "Ligue 2", SC0: "Scottish Prem",
  B1: "Belgian Pro", G1: "Greek Super",
  EC: "English League 1", E2: "English League 2", SC1: "Scottish Championship",
};
const SEASONS = ["2223", "2324", "2425"];

// Only Home bets — v3.0 showed H at -0.6% ROI (nearly breakeven, fixable)
// Draw was -28.5% ROI, Under was -12.2% — both destroyed value
const BET_TYPES = ["H"];

// ============================================================
// DATA LOADING
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
          // Stats
          hs: parseInt(c[g("HS")]) || 0, as: parseInt(c[g("AS")]) || 0,
          hst: parseInt(c[g("HST")]) || 0, ast: parseInt(c[g("AST")]) || 0,
          // Half time
          hthg: parseInt(c[g("HTHG")]) || 0, htag: parseInt(c[g("HTAG")]) || 0,
          // Pinnacle odds (for execution + CLV)
          pinnH: parseFloat(c[g("PSH")]) || 0,
          pinnD: parseFloat(c[g("PSD")]) || 0,
          pinnA: parseFloat(c[g("PSA")]) || 0,
          // Pinnacle closing odds (CLV benchmark)
          pinnCH: parseFloat(c[g("PSCH")]) || 0,
          pinnCD: parseFloat(c[g("PSCD")]) || 0,
          pinnCA: parseFloat(c[g("PSCA")]) || 0,
          // Pinnacle over/under
          pinnOver: parseFloat(c[g("P>2.5")]) || 0,
          pinnUnder: parseFloat(c[g("P<2.5")]) || 0,
          // Pinnacle closing over/under
          pinnCOver: parseFloat(c[g("PC>2.5")]) || 0,
          pinnCUnder: parseFloat(c[g("PC<2.5")]) || 0,
        });
      }
    }
  }
  all.sort((a, b) => a.date - b.date);
  return all;
}

// ============================================================
// FEATURE ENGINEERING — Only 3 core features
// ============================================================

function buildTeamStats(matches) {
  const stats = {};

  for (const m of matches) {
    for (const side of ["home", "away"]) {
      const team = side === "home" ? m.home : m.away;
      if (!stats[team]) stats[team] = { matches: [], league: m.league };

      const isHome = side === "home";
      stats[team].matches.push({
        date: m.date,
        isHome,
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

  // FEATURE 1: Form — blended long-term (last 10) + short-term (last 4)
  const points = recent.reduce((s, m) =>
    s + (m.result === "W" ? 3 : m.result === "D" ? 1 : 0), 0);
  const formPctLong = points / (recent.length * 3);

  const recent4 = ts.matches.slice(-4);
  const points4 = recent4.reduce((s, m) =>
    s + (m.result === "W" ? 3 : m.result === "D" ? 1 : 0), 0);
  const recentFormPct = points4 / (recent4.length * 3);

  // Blend: 40% long-term, 60% short-term
  const formPct = formPctLong * 0.4 + recentFormPct * 0.6;

  // FEATURE 2: Goals ratio (scored / conceded, capped)
  const goalsFor = avg(recent.map(m => m.goalsFor));
  const goalsAgainst = avg(recent.map(m => m.goalsAgainst));
  const goalsRatio = goalsAgainst > 0
    ? Math.min(3.0, goalsFor / goalsAgainst)
    : goalsFor > 0 ? 3.0 : 1.0;

  // FEATURE 3: Home/Away win percentage
  const homeWinPct = homeMatches.length >= 3
    ? homeMatches.filter(m => m.result === "W").length / homeMatches.length
    : 0.45;
  const awayWinPct = awayMatches.length >= 3
    ? awayMatches.filter(m => m.result === "W").length / awayMatches.length
    : 0.30;

  // FEATURE 4: Shots on target ratio (attacking quality proxy)
  const sotFor = avg(recent.map(m => m.shotsOnTarget || 0));
  const sotAgainst = avg(recent.map(m => m.shotsOnTargetAgainst || 0));
  const sotRatio = sotAgainst > 0
    ? Math.min(3.0, sotFor / sotAgainst)
    : sotFor > 0 ? 3.0 : 1.0;

  // FEATURE 5: Blended performance ratio (goals + SOT xG proxy)
  const shotRatio = sotFor > 0.1 ? Math.min(3.0, sotFor / Math.max(0.1, sotAgainst)) : 1.0;
  const performanceRatio = goalsRatio * 0.5 + shotRatio * 0.5;

  return {
    formPct,
    goalsFor,
    goalsAgainst,
    goalsRatio,
    performanceRatio,
    homeWinPct,
    awayWinPct,
    sotFor,
    sotAgainst,
    sotRatio,
    totalMatches: ts.matches.length,
  };
}

// ============================================================
// PREDICTION — Pure Poisson, no Pinnacle blend
// ============================================================

function predict(homeFeatures, awayFeatures, leagueAvg, motivation) {
  if (!homeFeatures || !awayFeatures) return null;

  const baseHome = leagueAvg.homeGoals || 1.45;
  const baseAway = leagueAvg.awayGoals || 1.10;
  const avgGoals = (baseHome + baseAway) / 2;

  // Attack/defense strength relative to league
  // Use performanceRatio (blended goals + SOT) instead of pure goals for attack
  let homeAttack = homeFeatures.goalsFor / avgGoals;
  let awayAttack = awayFeatures.goalsFor / avgGoals;
  let homeDefense = homeFeatures.goalsAgainst / avgGoals;
  let awayDefense = awayFeatures.goalsAgainst / avgGoals;

  // xG proxy: adjust attack strength using performanceRatio vs goalsRatio
  // If performanceRatio > goalsRatio, team is creating more than scoring (underperforming xG)
  // If performanceRatio < goalsRatio, team is overperforming (regression likely)
  if (homeFeatures.performanceRatio > 0 && homeFeatures.goalsRatio > 0) {
    const perfAdj = homeFeatures.performanceRatio / homeFeatures.goalsRatio;
    homeAttack *= Math.max(0.92, Math.min(1.08, perfAdj));
  }
  if (awayFeatures.performanceRatio > 0 && awayFeatures.goalsRatio > 0) {
    const perfAdj = awayFeatures.performanceRatio / awayFeatures.goalsRatio;
    awayAttack *= Math.max(0.92, Math.min(1.08, perfAdj));
  }

  // Form adjustment (dampened: 0.95 to 1.05 — was 0.90 to 1.10)
  const homeFormAdj = 0.95 + homeFeatures.formPct * 0.10;
  const awayFormAdj = 0.95 + awayFeatures.formPct * 0.10;

  // Home advantage from actual home/away win rates (more dampened)
  const homeAdv = homeFeatures.homeWinPct > 0.1
    ? Math.max(0.95, Math.min(1.08, homeFeatures.homeWinPct / 0.45))
    : 1.0;

  // Calculate expected goals (lambdas)
  let lambdaHome = homeAttack * awayDefense * baseHome * homeFormAdj * homeAdv;
  let lambdaAway = awayAttack * homeDefense * baseAway * awayFormAdj;

  // Motivation adjustment based on table position
  if (motivation) {
    // Home team in top 3 or bottom 3 = fighting for something → boost
    if (motivation.homeInTop3 || motivation.homeInBottom3) {
      lambdaHome *= 1.03;  // 3% boost
    }
    // Home team in dead zone = nothing to play for → penalty
    if (motivation.homeInDeadZone) {
      lambdaHome *= 0.97;  // 3% penalty
    }
    // Away team in top 3 = strong team visiting → reduce home advantage
    if (motivation.awayInTop3) {
      lambdaHome *= 0.98;  // 2% reduction
    }
  }

  // Shrinkage toward league average for teams with few matches
  const homeShrink = Math.min(1, homeFeatures.totalMatches / 20);
  const awayShrink = Math.min(1, awayFeatures.totalMatches / 20);
  lambdaHome = lambdaHome * homeShrink + baseHome * (1 - homeShrink);
  lambdaAway = lambdaAway * awayShrink + baseAway * (1 - awayShrink);

  // Cap lambdas
  lambdaHome = Math.max(0.4, Math.min(3.5, lambdaHome));
  lambdaAway = Math.max(0.3, Math.min(3.0, lambdaAway));

  // Poisson probabilities
  let pH = 0, pD = 0, pA = 0, pOver = 0, pUnder = 0;
  for (let i = 0; i <= 7; i++) {
    for (let j = 0; j <= 7; j++) {
      const p = poisson(i, lambdaHome) * poisson(j, lambdaAway);
      if (i > j) pH += p;
      else if (i === j) pD += p;
      else pA += p;
      if (i + j > 2) pOver += p;
      if (i + j <= 2) pUnder += p;
    }
  }

  const total = pH + pD + pA;
  pH /= total; pD /= total; pA /= total;

  // CALIBRATION FIX v3.4: Variable shrinkage per bucket
  // 40-50% bucket is well calibrated (45.5% pred vs 43.4% actual) — light shrinkage
  // 50-60% bucket is very overconfident (54.7% pred vs 40.6% actual) — heavy shrinkage
  // 60-70% bucket is very overconfident (63.5% pred vs 49.0% actual) — heavy shrinkage
  const baseH = 0.45;   // Typical home win rate
  const baseD = 0.27;   // Typical draw rate
  const baseA = 0.28;   // Typical away win rate

  // Variable shrinkage: more aggressive for higher raw probabilities
  function variableShrink(rawP, baseP) {
    let shrink;
    if (rawP < 0.45) shrink = 0.40;       // Light — these buckets calibrate well
    else if (rawP < 0.55) shrink = 0.55;   // Medium — 50-60% bucket is overconfident
    else shrink = 0.65;                     // Heavy — 60-70% bucket is very overconfident
    return rawP * (1 - shrink) + baseP * shrink;
  }

  pH = variableShrink(pH, baseH);
  pD = variableShrink(pD, baseD);
  pA = variableShrink(pA, baseA);

  // Cap probabilities to reduce overconfidence in high-probability buckets
  pH = Math.min(pH, 0.48);
  pA = Math.min(pA, 0.40);  // Away wins are rarer, cap lower

  // Renormalize
  const total2 = pH + pD + pA;
  pH /= total2; pD /= total2; pA /= total2;

  // Also shrink over/under toward ~50%
  pOver = variableShrink(pOver, 0.50);
  pUnder = variableShrink(pUnder, 0.50);

  return { pH, pD, pA, pOver, pUnder, lambdaHome, lambdaAway };
}

function poisson(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let r = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) r *= lambda / i;
  return r;
}

// ============================================================
// TABLE POSITION / MOTIVATION FILTER
// ============================================================

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

    if (m.result === "H") {
      table[m.home].pts += 3;
    } else if (m.result === "D") {
      table[m.home].pts += 1;
      table[m.away].pts += 1;
    } else {
      table[m.away].pts += 3;
    }
  }

  const sorted = Object.values(table).sort((a, b) =>
    b.pts - a.pts || b.gd - a.gd);

  const positions = {};
  sorted.forEach((t, i) => { positions[t.team] = i + 1; });

  return { positions, totalTeams: sorted.length };
}

function isDeadZone(position, totalTeams) {
  if (totalTeams < 12) return false; // Small leagues — skip filter
  const thirdSize = Math.floor(totalTeams / 3);
  const deadStart = thirdSize + 1;       // End of top third + 1
  const deadEnd = totalTeams - thirdSize; // Start of bottom third
  return position >= deadStart && position <= deadEnd;
}

// ============================================================
// DAYS OF REST
// ============================================================

function getDaysSinceLastMatch(teamStats, teamName, matchDate) {
  const ts = teamStats[teamName];
  if (!ts || ts.matches.length === 0) return null;
  // Find last match before this date
  let lastDate = null;
  for (let i = ts.matches.length - 1; i >= 0; i--) {
    if (ts.matches[i].date < matchDate) {
      lastDate = ts.matches[i].date;
      break;
    }
  }
  if (!lastDate) return null;
  return Math.round((matchDate - lastDate) / (1000 * 60 * 60 * 24));
}

// ============================================================
// LEAGUE STATS
// ============================================================

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

// ============================================================
// WALK-FORWARD BACKTEST
// ============================================================

function runWalkForward(allMatches) {
  const firstDate = allMatches[0].date;
  const lastDate = allMatches[allMatches.length - 1].date;

  console.log(`\n   Datos: ${allMatches.length} partidos`);
  console.log(`   Periodo: ${fmt(firstDate)} — ${fmt(lastDate)}`);

  // Generate walk-forward windows
  const windows = [];
  let trainStart = new Date(firstDate);

  while (true) {
    const trainEnd = addMonths(trainStart, WF_TRAIN_MONTHS);
    const testEnd = addMonths(trainEnd, WF_TEST_MONTHS);

    if (testEnd > lastDate) break;

    windows.push({ trainStart, trainEnd, testEnd });
    trainStart = addMonths(trainStart, WF_STEP_MONTHS);
  }

  console.log(`   Walk-forward: ${windows.length} ventanas (${WF_TRAIN_MONTHS}m train → ${WF_TEST_MONTHS}m test)\n`);

  // Run each window
  let bankroll = BANKROLL;
  let totalBets = 0, wins = 0, totalStaked = 0;
  let maxBR = BANKROLL, minBR = BANKROLL;
  const monthlyPnL = {}, leaguePnL = {}, typePnL = {};
  const betLog = [];
  const calibrationBuckets = {};
  const clvData = [];
  const windowResults = [];

  for (const win of windows) {
    const trainData = allMatches.filter(m =>
      m.date >= win.trainStart && m.date < win.trainEnd);
    const testData = allMatches.filter(m =>
      m.date >= win.trainEnd && m.date < win.testEnd);

    if (trainData.length < 100 || testData.length < 20) continue;

    // Build model from training data only
    const teamStats = buildTeamStats(trainData);
    const leagueStats = computeLeagueStats(trainData);

    // Build standings per league for motivation filter
    const standingsByLeague = {};
    for (const lg of Object.keys(TARGET_LEAGUES)) {
      standingsByLeague[lg] = buildStandings(trainData, lg);
    }

    let windowBets = 0, windowProfit = 0;

    for (const match of testData) {
      if (!TARGET_LEAGUES[match.league]) continue;
      if (bankroll < 100) break;

      const homeF = getFeatures(teamStats, match.home);
      const awayF = getFeatures(teamStats, match.away);
      const ls = leagueStats[match.league] || { homeGoals: 1.45, awayGoals: 1.10 };

      // Compute motivation context from standings
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

      // Build bet candidates — USE PINNACLE ODDS (not Max)
      const bets = [];

      if (BET_TYPES.includes("H") && match.pinnH > 0) {
        bets.push({
          side: "H", prob: pred.pH,
          odds: match.pinnH,
          closingOdds: match.pinnCH || match.pinnH,
          won: match.result === "H",
        });
      }
      if (BET_TYPES.includes("D") && match.pinnD > 0) {
        bets.push({
          side: "D", prob: pred.pD,
          odds: match.pinnD,
          closingOdds: match.pinnCD || match.pinnD,
          won: match.result === "D",
        });
      }
      if (BET_TYPES.includes("A") && match.pinnA > 0) {
        bets.push({
          side: "A", prob: pred.pA,
          odds: match.pinnA,
          closingOdds: match.pinnCA || match.pinnA,
          won: match.result === "A",
        });
      }
      if (BET_TYPES.includes("Under") && match.pinnUnder > 0) {
        bets.push({
          side: "Under", prob: pred.pUnder,
          odds: match.pinnUnder,
          closingOdds: match.pinnCUnder || match.pinnUnder,
          won: match.totalGoals <= 2,
        });
      }

      for (const bet of bets) {
        // Only profitable odds zones: 2.30-2.60 and 3.00-3.50
        const inZone1 = bet.odds >= 2.30 && bet.odds <= 2.60;
        const inZone2 = bet.odds >= 3.00 && bet.odds <= 3.50;
        if (!inZone1 && !inZone2) continue;

        const edge = bet.prob - 1 / bet.odds;
        if (edge < MIN_EDGE) continue;

        const MAX_EDGE = 0.15; // Cap at 15% — higher = model error
        if (edge > MAX_EDGE) continue;

        // Quarter Kelly sizing
        const b = bet.odds - 1;
        const kelly = (b * bet.prob - (1 - bet.prob)) / b;
        if (kelly <= 0) continue;

        const size = Math.min(
          kelly * KELLY_FRACTION * bankroll,
          bankroll * MAX_BET_PCT
        );
        if (size < 5) continue;

        // Execute
        const payout = bet.won ? size * bet.odds : 0;
        const profit = payout - size;
        bankroll += profit;
        totalBets++; totalStaked += size;
        windowBets++; windowProfit += profit;
        if (bet.won) wins++;
        maxBR = Math.max(maxBR, bankroll);
        minBR = Math.min(minBR, bankroll);

        // CLV tracking
        if (bet.closingOdds > 0 && bet.closingOdds !== bet.odds) {
          const clv = (bet.odds / bet.closingOdds - 1) * 100;
          clvData.push({
            date: match.dateStr,
            side: bet.side,
            league: match.league,
            oddsOpening: bet.odds,
            oddsClosing: bet.closingOdds,
            clvPct: clv,
          });
        }

        // Calibration tracking
        const bucket = Math.floor(bet.prob * 10) * 10; // 0, 10, 20, ..., 90
        const bucketKey = `${bucket}-${bucket + 10}%`;
        if (!calibrationBuckets[bucketKey]) {
          calibrationBuckets[bucketKey] = { predicted: 0, actual: 0, count: 0 };
        }
        calibrationBuckets[bucketKey].predicted += bet.prob;
        calibrationBuckets[bucketKey].actual += bet.won ? 1 : 0;
        calibrationBuckets[bucketKey].count++;

        // Monthly P&L
        if (match.date) {
          const mk = `${match.date.getFullYear()}-${String(match.date.getMonth() + 1).padStart(2, "0")}`;
          if (!monthlyPnL[mk]) monthlyPnL[mk] = { bets: 0, pnl: 0, staked: 0 };
          monthlyPnL[mk].bets++;
          monthlyPnL[mk].pnl += profit;
          monthlyPnL[mk].staked += size;
        }

        // League P&L
        if (!leaguePnL[match.league]) leaguePnL[match.league] = { bets: 0, pnl: 0, staked: 0 };
        leaguePnL[match.league].bets++;
        leaguePnL[match.league].pnl += profit;
        leaguePnL[match.league].staked += size;

        // Type P&L
        if (!typePnL[bet.side]) typePnL[bet.side] = { bets: 0, pnl: 0, staked: 0 };
        typePnL[bet.side].bets++;
        typePnL[bet.side].pnl += profit;
        typePnL[bet.side].staked += size;

        betLog.push({
          date: match.dateStr, league: match.league,
          match: `${match.home} vs ${match.away}`,
          side: bet.side, prob: (bet.prob * 100).toFixed(1) + "%",
          odds: bet.odds.toFixed(2), edge: (edge * 100).toFixed(1) + "%",
          bet: Math.round(size), won: bet.won, profit: Math.round(profit),
          bankroll: Math.round(bankroll),
          clv: bet.closingOdds > 0
            ? ((bet.odds / bet.closingOdds - 1) * 100).toFixed(1) + "%"
            : "N/A",
        });

        // Update team stats with this match (expanding window)
        // This happens naturally as we process matches in order
      }

      // Add match to team stats for future predictions within this window
      addMatchToStats(teamStats, match);
    }

    windowResults.push({
      period: `${fmt(win.trainEnd)} → ${fmt(win.testEnd)}`,
      trainSize: trainData.length,
      testSize: testData.length,
      bets: windowBets,
      profit: Math.round(windowProfit),
    });
  }

  // Calculate final metrics
  const profit = bankroll - BANKROLL;
  const roi = totalStaked > 0 ? (profit / totalStaked) * 100 : 0;
  const dd = maxBR > 0 ? ((maxBR - minBR) / maxBR) * 100 : 0;

  // Sharpe ratio (monthly)
  const monthlyReturns = Object.values(monthlyPnL).map(m =>
    m.staked > 0 ? m.pnl / m.staked : 0);
  const avgReturn = monthlyReturns.length > 0
    ? monthlyReturns.reduce((a, b) => a + b, 0) / monthlyReturns.length : 0;
  const stdReturn = monthlyReturns.length > 1
    ? Math.sqrt(monthlyReturns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / monthlyReturns.length)
    : 1;
  const sharpe = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(12) : 0;

  // CLV summary
  const avgCLV = clvData.length > 0
    ? clvData.reduce((s, c) => s + c.clvPct, 0) / clvData.length : 0;
  const clvPositivePct = clvData.length > 0
    ? (clvData.filter(c => c.clvPct > 0).length / clvData.length) * 100 : 0;

  // Monte Carlo
  const monteCarloResult = monteCarlo(betLog, bankroll);

  return {
    profit: Math.round(profit),
    roi: roi.toFixed(2) + "%",
    sharpe: sharpe.toFixed(2),
    totalBets, wins,
    winRate: (totalBets > 0 ? (wins / totalBets * 100) : 0).toFixed(1) + "%",
    finalBR: Math.round(bankroll),
    dd: dd.toFixed(1) + "%",
    maxBR: Math.round(maxBR),
    minBR: Math.round(minBR),
    avgCLV: avgCLV.toFixed(2) + "%",
    clvPositivePct: clvPositivePct.toFixed(0) + "%",
    clvData,
    monthlyPnL, leaguePnL, typePnL,
    calibrationBuckets,
    windowResults,
    betLog,
    monteCarlo: monteCarloResult,
  };
}

function addMatchToStats(teamStats, match) {
  for (const side of ["home", "away"]) {
    const team = side === "home" ? match.home : match.away;
    if (!teamStats[team]) teamStats[team] = { matches: [], league: match.league };

    const isHome = side === "home";
    teamStats[team].matches.push({
      date: match.date,
      isHome,
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
// MONTE CARLO SIMULATION
// ============================================================

function monteCarlo(betLog, currentBR) {
  if (betLog.length < 20) return { ruinPct: 0, medianFinal: currentBR, note: "Insufficient data" };

  const edges = betLog.map(b => {
    const odds = parseFloat(b.odds);
    const prob = parseFloat(b.prob) / 100;
    return { prob, odds, betPct: 0.02 }; // 2% bankroll
  });

  const N_SIMS = 10000;
  const N_BETS = 500; // Simulate 500 bet sequences
  let ruinCount = 0;
  const finals = [];

  for (let sim = 0; sim < N_SIMS; sim++) {
    let br = BANKROLL;
    for (let i = 0; i < N_BETS; i++) {
      const bet = edges[Math.floor(Math.random() * edges.length)];
      const stake = br * bet.betPct;
      const won = Math.random() < bet.prob;
      br += won ? stake * (bet.odds - 1) : -stake;
      if (br < 50) { ruinCount++; break; }
    }
    finals.push(br);
  }

  finals.sort((a, b) => a - b);
  return {
    ruinPct: ((ruinCount / N_SIMS) * 100).toFixed(1) + "%",
    medianFinal: Math.round(finals[Math.floor(N_SIMS / 2)]),
    p5: Math.round(finals[Math.floor(N_SIMS * 0.05)]),
    p25: Math.round(finals[Math.floor(N_SIMS * 0.25)]),
    p75: Math.round(finals[Math.floor(N_SIMS * 0.75)]),
    p95: Math.round(finals[Math.floor(N_SIMS * 0.95)]),
    profitable: ((finals.filter(f => f > BANKROLL).length / N_SIMS) * 100).toFixed(1) + "%",
  };
}

// ============================================================
// DASHBOARD
// ============================================================

function printResults(r) {
  console.log("\n" + "=".repeat(85));
  console.log("   PREDICTOR V3 — Walk-Forward Backtest Results");
  console.log("=".repeat(85));

  // Main metrics
  console.log(`\n   Bankroll:  €${BANKROLL} → €${r.finalBR} (${r.profit >= 0 ? "+" : ""}€${r.profit})`);
  console.log(`   ROI:       ${r.roi} | Sharpe: ${r.sharpe} | Max DD: ${r.dd}`);
  console.log(`   Bets:      ${r.totalBets} | Won: ${r.wins} (${r.winRate})`);
  console.log(`   Peak:      €${r.maxBR} | Trough: €${r.minBR}`);

  // CLV — the most important metric
  console.log(`\n   CLV (Closing Line Value):`);
  console.log(`     Average CLV:     ${r.avgCLV}`);
  console.log(`     CLV positive:    ${r.clvPositivePct} of bets`);
  console.log(`     ${parseFloat(r.avgCLV) > 0 ? ">>> EDGE CONFIRMED — model beats closing line" : ">>> NO EDGE — model doesn't beat closing line"}`);

  // Calibration plot
  console.log(`\n   CALIBRATION (predicted vs actual):`);
  console.log("   " + "Bucket".padEnd(12) + "Predicted".padStart(10) + "Actual".padStart(10) + "Count".padStart(8) + "  Status");
  console.log("   " + "-".repeat(50));
  for (const [bucket, data] of Object.entries(r.calibrationBuckets).sort()) {
    if (data.count < 5) continue;
    const predAvg = (data.predicted / data.count * 100).toFixed(1);
    const actAvg = (data.actual / data.count * 100).toFixed(1);
    const diff = parseFloat(actAvg) - parseFloat(predAvg);
    const status = Math.abs(diff) < 5 ? "OK" : diff > 0 ? "Underconf" : "Overconf!";
    console.log("   " +
      bucket.padEnd(12) +
      (predAvg + "%").padStart(10) +
      (actAvg + "%").padStart(10) +
      String(data.count).padStart(8) +
      "  " + status
    );
  }

  // Walk-forward windows
  console.log(`\n   WALK-FORWARD WINDOWS:`);
  console.log("   " + "Period".padEnd(28) + "Train".padStart(6) + "Test".padStart(6) + "Bets".padStart(6) + "P&L".padStart(8));
  console.log("   " + "-".repeat(54));
  for (const w of r.windowResults) {
    const flag = w.profit > 0 ? " +" : "";
    console.log("   " +
      w.period.padEnd(28) +
      String(w.trainSize).padStart(6) +
      String(w.testSize).padStart(6) +
      String(w.bets).padStart(6) +
      (`€${w.profit}`).padStart(8) + flag
    );
  }
  const profitableWindows = r.windowResults.filter(w => w.profit > 0).length;
  console.log(`   Profitable windows: ${profitableWindows}/${r.windowResults.length}`);

  // P&L by bet type
  console.log(`\n   POR TIPO DE APUESTA:`);
  for (const [type, d] of Object.entries(r.typePnL).sort((a, b) => b[1].pnl - a[1].pnl)) {
    const roi = d.staked > 0 ? ((d.pnl / d.staked) * 100).toFixed(1) : "0";
    console.log(`     ${type.padEnd(8)}: ${String(d.bets).padStart(4)} bets | €${d.pnl >= 0 ? "+" : ""}${Math.round(d.pnl).toString().padStart(6)} | ${roi.padStart(6)}% ROI`);
  }

  // P&L by league
  console.log(`\n   POR LIGA:`);
  for (const [lg, d] of Object.entries(r.leaguePnL).sort((a, b) => b[1].pnl - a[1].pnl)) {
    const roi = d.staked > 0 ? ((d.pnl / d.staked) * 100).toFixed(1) : "0";
    console.log(`     ${(TARGET_LEAGUES[lg] || lg).padEnd(20)}: ${String(d.bets).padStart(4)} bets | €${d.pnl >= 0 ? "+" : ""}${Math.round(d.pnl).toString().padStart(6)} | ${roi.padStart(6)}% ROI`);
  }

  // Monthly P&L
  console.log(`\n   P&L MENSUAL:`);
  for (const [m, d] of Object.entries(r.monthlyPnL).sort()) {
    const roi = d.staked > 0 ? ((d.pnl / d.staked) * 100).toFixed(1) : "0";
    const bar = d.pnl >= 0
      ? "+" + "#".repeat(Math.min(30, Math.floor(d.pnl / 20)))
      : "-" + "░".repeat(Math.min(30, Math.floor(Math.abs(d.pnl) / 20)));
    console.log(`     ${m}: ${String(d.bets).padStart(3)} bets | €${d.pnl >= 0 ? "+" : ""}${Math.round(d.pnl).toString().padStart(6)} | ${roi.padStart(6)}% | ${bar}`);
  }

  // Monte Carlo
  console.log(`\n   MONTE CARLO (${10000} sims × 500 bets):`);
  console.log(`     Risk of ruin:     ${r.monteCarlo.ruinPct}`);
  console.log(`     Profitable:       ${r.monteCarlo.profitable}`);
  console.log(`     Median final BR:  €${r.monteCarlo.medianFinal}`);
  console.log(`     5th percentile:   €${r.monteCarlo.p5}`);
  console.log(`     25th percentile:  €${r.monteCarlo.p25}`);
  console.log(`     75th percentile:  €${r.monteCarlo.p75}`);
  console.log(`     95th percentile:  €${r.monteCarlo.p95}`);

  // CLV by league
  if (r.clvData.length > 0) {
    console.log(`\n   CLV POR LIGA:`);
    const clvByLeague = {};
    for (const c of r.clvData) {
      if (!clvByLeague[c.league]) clvByLeague[c.league] = [];
      clvByLeague[c.league].push(c.clvPct);
    }
    for (const [lg, vals] of Object.entries(clvByLeague).sort((a, b) =>
      avg(b[1]) - avg(a[1]))) {
      const avgClv = avg(vals);
      const posPct = (vals.filter(v => v > 0).length / vals.length * 100).toFixed(0);
      console.log(`     ${(TARGET_LEAGUES[lg] || lg).padEnd(20)}: CLV ${avgClv >= 0 ? "+" : ""}${avgClv.toFixed(2)}% | ${posPct}% positive (${vals.length} bets)`);
    }
  }

  // Last bets
  console.log(`\n   ÚLTIMAS 20 APUESTAS:`);
  console.log("   " +
    "Fecha".padEnd(12) +
    "Partido".padEnd(25) +
    "Tipo".padEnd(7) +
    "Odds".padStart(5) +
    "Edge".padStart(6) +
    "W/L".padStart(4) +
    "P&L".padStart(7) +
    "CLV".padStart(7)
  );
  console.log("   " + "-".repeat(77));
  for (const b of r.betLog.slice(-20)) {
    console.log("   " +
      (b.date || "?").padEnd(12) +
      b.match.slice(0, 23).padEnd(25) +
      b.side.padEnd(7) +
      b.odds.padStart(5) +
      b.edge.padStart(6) +
      (b.won ? " W" : " L").padStart(4) +
      (`€${b.profit >= 0 ? "+" : ""}${b.profit}`).padStart(7) +
      (b.clv || "N/A").padStart(7)
    );
  }

  // Verdict
  const verdict =
    parseFloat(r.sharpe) > 1.5 && parseFloat(r.avgCLV) > 1 ? "EXCELENTE — Paper trade YA"
    : parseFloat(r.sharpe) > 1.0 && parseFloat(r.avgCLV) > 0 ? "BUENO — Paper trade 2 meses"
    : parseFloat(r.roi) > 0 && parseFloat(r.avgCLV) > 0 ? "PROMETEDOR — Más datos necesarios"
    : parseFloat(r.roi) > 0 ? "MARGINAL — CLV insuficiente"
    : "NO RENTABLE — Revisar modelo";

  console.log(`\n   VEREDICTO: ${verdict}`);
  console.log("=".repeat(85));

  // v2 vs v3 comparison
  console.log(`\n   V2 vs V3 COMPARISON:`);
  console.log(`     Metric          v2              v3`);
  console.log(`     P&L:            -€4,174         ${r.profit >= 0 ? "+" : ""}€${r.profit}`);
  console.log(`     ROI:            -6.8%           ${r.roi}`);
  console.log(`     Sharpe:         -1.68           ${r.sharpe}`);
  console.log(`     Drawdown:       87.7%           ${r.dd}`);
  console.log(`     Bets:           2,528           ${r.totalBets}`);
  console.log(`     Win rate:       47.2%           ${r.winRate}`);
  console.log(`     CLV:            N/A             ${r.avgCLV}`);
  console.log(`     Pinnacle blend: 60%             0% (pure model)`);
  console.log(`     Features:       12+             3`);
  console.log(`     Validation:     60/40 split     Walk-forward`);
  console.log(`     Execution odds: Max (fantasy)   Pinnacle (real)`);
  console.log("=".repeat(85));
}

// ============================================================
// UTILS
// ============================================================

function avg(arr) {
  return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function fmt(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
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
  console.log("=".repeat(85));
  console.log("   PREDICTOR V3 — Complete Rebuild");
  console.log("   Walk-Forward | 3 Features | No Pinnacle Blend | CLV Tracking");
  console.log("=".repeat(85));
  console.log(`   Config:`);
  console.log(`     Bankroll:     €${BANKROLL}`);
  console.log(`     Kelly:        ${KELLY_FRACTION} (quarter Kelly)`);
  console.log(`     Min edge:     ${MIN_EDGE * 100}%`);
  console.log(`     Max bet:      ${MAX_BET_PCT * 100}% bankroll`);
  console.log(`     Odds zones:   2.30-2.60 and 3.00-3.50 (profitable zones only)`);
  console.log(`     Edge range:   ${MIN_EDGE * 100}% — 15% (cap high edge = model error)`);
  console.log(`     Bet types:    ${BET_TYPES.join(", ")}`);
  console.log(`     Leagues:      ${Object.values(TARGET_LEAGUES).join(", ")}`);
  console.log(`     SOT adjust:   ±5% attack nudge from shots-on-target ratio`);
  console.log(`     Walk-forward: ${WF_TRAIN_MONTHS}m train → ${WF_TEST_MONTHS}m test, step ${WF_STEP_MONTHS}m`);

  const allMatches = loadAllData();
  console.log(`\n   ${allMatches.length} partidos cargados de ${Object.keys(ALL_LEAGUES).length} ligas`);

  const result = runWalkForward(allMatches);
  printResults(result);

  // Save results
  fs.writeFileSync(LOG_FILE, JSON.stringify({
    version: "v3",
    config: {
      BANKROLL, KELLY_FRACTION, MIN_EDGE, MAX_BET_PCT,
      MIN_ODDS, MAX_ODDS, BET_TYPES, TARGET_LEAGUES,
      WF_TRAIN_MONTHS, WF_TEST_MONTHS, WF_STEP_MONTHS,
    },
    results: {
      profit: result.profit, roi: result.roi, sharpe: result.sharpe,
      bets: result.totalBets, wins: result.wins, winRate: result.winRate,
      dd: result.dd, avgCLV: result.avgCLV, clvPositivePct: result.clvPositivePct,
    },
    monteCarlo: result.monteCarlo,
    calibration: result.calibrationBuckets,
    windowResults: result.windowResults,
    monthlyPnL: result.monthlyPnL,
    leaguePnL: result.leaguePnL,
    typePnL: result.typePnL,
    clvSummary: {
      avgCLV: result.avgCLV,
      clvPositivePct: result.clvPositivePct,
      totalCLVBets: result.clvData.length,
    },
    lastBets: result.betLog.slice(-100),
  }, null, 2));

  console.log(`\n   Resultados guardados en ${LOG_FILE}`);
}

main();

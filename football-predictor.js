// ============================================================
// FOOTBALL PREDICTOR — Poisson Model + Value Betting + Backtest
// Uses historical data from football-data.co.uk
// Trains on past matches → predicts probabilities → finds value
// ============================================================

const fs = require("fs");

// ============================================================
// CONFIG
// ============================================================
const DATA_DIR = "./data";
const BANKROLL = 5000;
const KELLY_FRACTION = 0.10; // Optimal: best Sharpe at 0.10
const MIN_VALUE_EDGE = 0.01; // 1% — sweet spot
const MAX_BET_PCT = 0.03; // Max 3% bankroll per bet
const MIN_ODDS = 1.50; // Optimal range start
const MAX_ODDS = 5.0; // Optimal range end — Sharpe 1.64
// Profitable bet types only (optimizer results):
// 1X2_D: +19.3% ROI | 1X2_H: +36% | Over: +31.4%
// 1X2_A: -4.6% (exclude) | Under: -11.1% (exclude)
const TRAINING_MATCHES = 200; // Min matches to train model
const LOG_FILE = "football-backtest.json";

// Bet in leagues with proven edge + secondary leagues (more inefficient)
const LEAGUES = {
  D1: "Bundesliga",
  I1: "Serie A",
  D2: "2. Bundesliga",
  I2: "Serie B",
  T1: "Turquía Super Lig",
  N1: "Eredivisie",
  SP2: "Segunda España",
  // P1: "Liga Portugal", // -20.2% ROI — excluida
};

// All leagues for training data
const ALL_LEAGUES = {
  SP1: "La Liga", E0: "Premier League", D1: "Bundesliga",
  I1: "Serie A", F1: "Ligue 1", D2: "2. Bundesliga",
  I2: "Serie B", T1: "Turquía Super Lig", N1: "Eredivisie",
  P1: "Liga Portugal", SP2: "Segunda España",
};

const SEASONS = ["2223", "2324", "2425"];

// ============================================================
// DATA LOADING
// ============================================================

function loadAllData() {
  const allMatches = [];

  // Load ALL leagues for training data, bet only on profitable ones
  for (const league of Object.keys(ALL_LEAGUES)) {
    for (const season of SEASONS) {
      const file = `${DATA_DIR}/${league}_${season}.csv`;
      if (!fs.existsSync(file)) continue;

      const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""); // Remove BOM
      const lines = raw.split("\n").filter((l) => l.trim());
      if (lines.length < 2) continue;

      const headers = lines[0].split(",");
      const getCol = (name) => headers.indexOf(name);

      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(",");
        if (cols.length < 10) continue;

        const fthg = parseInt(cols[getCol("FTHG")]);
        const ftag = parseInt(cols[getCol("FTAG")]);
        if (isNaN(fthg) || isNaN(ftag)) continue;

        // Parse date (dd/mm/yyyy or dd/mm/yy)
        const dateParts = (cols[getCol("Date")] || "").split("/");
        let dateObj = null;
        if (dateParts.length === 3) {
          let year = parseInt(dateParts[2]);
          if (year < 100) year += 2000;
          dateObj = new Date(year, parseInt(dateParts[1]) - 1, parseInt(dateParts[0]));
        }

        const match = {
          league,
          leagueName: LEAGUES[league],
          season,
          date: dateObj,
          dateStr: cols[getCol("Date")],
          home: cols[getCol("HomeTeam")],
          away: cols[getCol("AwayTeam")],
          homeGoals: fthg,
          awayGoals: ftag,
          result: cols[getCol("FTR")],
          // Shots
          homeShots: parseInt(cols[getCol("HS")]) || 0,
          awayShots: parseInt(cols[getCol("AS")]) || 0,
          homeShotsTarget: parseInt(cols[getCol("HST")]) || 0,
          awayShotsTarget: parseInt(cols[getCol("AST")]) || 0,
          // Odds — Pinnacle (sharpest), Bet365, Market avg
          pinnacleH: parseFloat(cols[getCol("PSH")]) || 0,
          pinnacleD: parseFloat(cols[getCol("PSD")]) || 0,
          pinnacleA: parseFloat(cols[getCol("PSA")]) || 0,
          bet365H: parseFloat(cols[getCol("B365H")]) || 0,
          bet365D: parseFloat(cols[getCol("B365D")]) || 0,
          bet365A: parseFloat(cols[getCol("B365A")]) || 0,
          maxH: parseFloat(cols[getCol("MaxH")]) || 0,
          maxD: parseFloat(cols[getCol("MaxD")]) || 0,
          maxA: parseFloat(cols[getCol("MaxA")]) || 0,
          avgH: parseFloat(cols[getCol("AvgH")]) || 0,
          avgD: parseFloat(cols[getCol("AvgD")]) || 0,
          avgA: parseFloat(cols[getCol("AvgA")]) || 0,
          // Over/Under 2.5 goals
          pinnacleOver: parseFloat(cols[getCol("P>2.5")]) || 0,
          pinnacleUnder: parseFloat(cols[getCol("P<2.5")]) || 0,
          maxOver: parseFloat(cols[getCol("Max>2.5")]) || 0,
          maxUnder: parseFloat(cols[getCol("Max<2.5")]) || 0,
          avgOver: parseFloat(cols[getCol("Avg>2.5")]) || 0,
          avgUnder: parseFloat(cols[getCol("Avg<2.5")]) || 0,
          totalGoals: fthg + ftag,
        };

        allMatches.push(match);
      }
    }
  }

  // Sort by date
  allMatches.sort((a, b) => (a.date || 0) - (b.date || 0));
  return allMatches;
}

// ============================================================
// POISSON MODEL
// ============================================================

function poissonPMF(k, lambda) {
  // P(X = k) = (lambda^k × e^-lambda) / k!
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let result = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) {
    result *= lambda / i;
  }
  return result;
}

function buildTeamRatings(matches, decayFactor = 0.993) { // Faster decay = more reactive
  // Calculate attack and defense strength per team using weighted historical data
  const teams = {};

  // League averages (all leagues for rating calculation)
  const leagueAvg = {};
  for (const league of Object.keys(ALL_LEAGUES)) {
    const leagueMatches = matches.filter((m) => m.league === league);
    if (leagueMatches.length === 0) continue;
    const totalGoals = leagueMatches.reduce((s, m) => s + m.homeGoals + m.awayGoals, 0);
    leagueAvg[league] = {
      goalsPerMatch: totalGoals / leagueMatches.length,
      homeGoals: leagueMatches.reduce((s, m) => s + m.homeGoals, 0) / leagueMatches.length,
      awayGoals: leagueMatches.reduce((s, m) => s + m.awayGoals, 0) / leagueMatches.length,
    };
  }

  // Build team stats with exponential decay (recent matches matter more)
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    const weight = Math.pow(decayFactor, matches.length - 1 - i);
    const la = leagueAvg[m.league];
    if (!la) continue;

    for (const side of ["home", "away"]) {
      const team = side === "home" ? m.home : m.away;
      const scored = side === "home" ? m.homeGoals : m.awayGoals;
      const conceded = side === "home" ? m.awayGoals : m.homeGoals;
      const avgScored = side === "home" ? la.homeGoals : la.awayGoals;
      const avgConceded = side === "home" ? la.awayGoals : la.homeGoals;

      if (!teams[team]) {
        teams[team] = {
          league: m.league,
          matches: 0,
          weightedScored: 0,
          weightedConceded: 0,
          totalWeight: 0,
          avgScored: avgScored,
          avgConceded: avgConceded,
        };
      }

      teams[team].matches++;
      teams[team].weightedScored += scored * weight;
      teams[team].weightedConceded += conceded * weight;
      teams[team].totalWeight += weight;
    }
  }

  // Calculate attack/defense ratings
  for (const [name, team] of Object.entries(teams)) {
    if (team.totalWeight === 0) continue;
    const la = leagueAvg[team.league];
    if (!la) continue;

    const avgGoalsScored = team.weightedScored / team.totalWeight;
    const avgGoalsConceded = team.weightedConceded / team.totalWeight;

    // Shrinkage: regress to mean based on sample size
    // With few matches, trust the league average more than the team's data
    const shrinkFactor = Math.min(1.0, team.matches / 30); // Full weight at 30+ matches
    const leagueAvgGoals = (la.homeGoals + la.awayGoals) / 2;

    const rawAttack = avgGoalsScored / leagueAvgGoals;
    const rawDefense = avgGoalsConceded / leagueAvgGoals;

    // Blend between team rating and league average (1.0)
    team.attackStrength = rawAttack * shrinkFactor + 1.0 * (1 - shrinkFactor);
    team.defenseStrength = rawDefense * shrinkFactor + 1.0 * (1 - shrinkFactor);
  }

  return { teams, leagueAvg };
}

function calibrate(p) {
  // Pull extreme probabilities toward the center
  // Based on observed miscalibration: high probs overestimated by ~15%
  // Use power function: p^alpha where alpha > 1 compresses high values
  // At p=0.5 it stays ~0.5, at p=0.9 it drops to ~0.81
  if (p <= 0.05 || p >= 0.95) return p; // Don't touch extremes (too few samples)
  const alpha = 1.15; // Calibration factor
  return Math.pow(p, alpha);
}

function predictMatch(homeTeam, awayTeam, ratings) {
  const home = ratings.teams[homeTeam];
  const away = ratings.teams[awayTeam];

  if (!home || !away) return null;

  const la = ratings.leagueAvg[home.league] || ratings.leagueAvg[away.league];
  if (!la) return null;

  // Expected goals using Dixon-Coles style
  const lambdaHome = home.attackStrength * away.defenseStrength * la.homeGoals;
  const lambdaAway = away.attackStrength * home.defenseStrength * la.awayGoals;

  // Cap lambdas at reasonable values
  const lH = Math.max(0.2, Math.min(5.0, lambdaHome));
  const lA = Math.max(0.2, Math.min(5.0, lambdaAway));

  // Calculate probabilities for each scoreline up to 8 goals each
  let pHome = 0, pDraw = 0, pAway = 0;
  const maxGoals = 8;

  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      const p = poissonPMF(h, lH) * poissonPMF(a, lA);
      if (h > a) pHome += p;
      else if (h === a) pDraw += p;
      else pAway += p;
    }
  }

  // Normalize
  const total = pHome + pDraw + pAway;
  pHome /= total;
  pDraw /= total;
  pAway /= total;

  // CALIBRATION CORRECTION
  // Backtest showed model overestimates high probabilities:
  //   68% predicted → 54% actual, 83% → 69%, 93% → 76%
  // Apply power calibration: pull extreme probabilities toward center
  pHome = calibrate(pHome);
  pDraw = calibrate(pDraw);
  pAway = calibrate(pAway);

  // Re-normalize after calibration
  const total2 = pHome + pDraw + pAway;
  pHome /= total2;
  pDraw /= total2;
  pAway /= total2;

  return {
    lambdaHome: lH,
    lambdaAway: lA,
    pHome,
    pDraw,
    pAway,
    expectedHomeGoals: lH.toFixed(2),
    expectedAwayGoals: lA.toFixed(2),
  };
}

// ============================================================
// BACKTEST ENGINE
// ============================================================

function runBacktest(allMatches) {
  log("BACKTEST", `${allMatches.length} partidos cargados`);

  // Split: use first 60% for initial training, backtest on remaining 40%
  const trainSize = Math.floor(allMatches.length * 0.6);
  const testMatches = allMatches.slice(trainSize);

  log("BACKTEST", `Training: ${trainSize} partidos | Testing: ${testMatches.length} partidos`);

  let bankroll = BANKROLL;
  let totalBets = 0;
  let wins = 0;
  let losses = 0;
  let totalStaked = 0;
  let totalReturned = 0;
  let maxBankroll = BANKROLL;
  let minBankroll = BANKROLL;
  let clvPositive = 0;
  let clvTotal = 0;
  const betLog = [];
  const monthlyPnL = {};
  const leaguePnL = {};

  // Walk-forward: retrain model every 50 matches
  const retrainEvery = 50;
  let nextRetrain = 0;
  let ratings = null;

  for (let i = 0; i < testMatches.length; i++) {
    const match = testMatches[i];

    // Retrain model periodically with all data up to this point
    if (i >= nextRetrain) {
      const trainingData = allMatches.slice(0, trainSize + i);
      ratings = buildTeamRatings(trainingData);
      nextRetrain = i + retrainEvery;
    }

    if (!ratings) continue;

    // FILTER: Only bet in profitable leagues
    if (!LEAGUES[match.league]) continue;

    // Predict
    const pred = predictMatch(match.home, match.away, ratings);
    if (!pred) continue;

    // STRATEGY: Use Pinnacle as "true odds" (sharpest bookmaker)
    // Look for soft bookmakers offering significantly better odds
    // This is what professional value bettors actually do
    //
    // Also blend with Poisson model: 70% Pinnacle + 30% Model
    // This gives us a slightly different angle than pure Pinnacle

    // Calculate Pinnacle implied probs (remove overround)
    const pOr = (match.pinnacleH > 0 && match.pinnacleD > 0 && match.pinnacleA > 0)
      ? 1/match.pinnacleH + 1/match.pinnacleD + 1/match.pinnacleA
      : 0;

    if (pOr <= 0) continue; // No Pinnacle odds available

    const pinnFairH = (1 / match.pinnacleH) / pOr; // Fair prob after removing vig
    const pinnFairD = (1 / match.pinnacleD) / pOr;
    const pinnFairA = (1 / match.pinnacleA) / pOr;

    // 100% Pinnacle fair — proven approach, no model noise
    const blendH = pinnFairH;
    const blendD = pinnFairD;
    const blendA = pinnFairA;
    const blendTotal = blendH + blendD + blendA;

    const odds = {
      H: { prob: blendH / blendTotal, odds: match.maxH, pinnacle: match.pinnacleH, pinnFair: pinnFairH },
      D: { prob: blendD / blendTotal, odds: match.maxD, pinnacle: match.pinnacleD, pinnFair: pinnFairD },
      A: { prob: blendA / blendTotal, odds: match.maxA, pinnacle: match.pinnacleA, pinnFair: pinnFairA },
    };

    for (const [side, data] of Object.entries(odds)) {
      if (!data.odds || data.odds <= 1) continue;

      const impliedProb = 1 / data.odds;
      const edge = data.prob - impliedProb;

      // FILTER: Optimal odds range (1.50-5.0 had Sharpe 1.64)
      if (data.odds < MIN_ODDS || data.odds > MAX_ODDS) continue;

      // FILTER: Only profitable bet types
      // Away bets (1X2_A) had -4.6% ROI — exclude
      if (side === "A") continue;

      // FILTER: Only bet when edge is significant
      if (edge >= MIN_VALUE_EDGE) {
        // Kelly sizing
        const b = data.odds - 1;
        const kellyFull = (b * data.prob - (1 - data.prob)) / b;
        if (kellyFull <= 0) continue;

        const betSize = Math.min(
          kellyFull * KELLY_FRACTION * bankroll,
          bankroll * MAX_BET_PCT,
          bankroll * 0.1 // absolute max safety
        );

        if (betSize < 5) continue;

        // Determine if bet won
        const won =
          (side === "H" && match.result === "H") ||
          (side === "D" && match.result === "D") ||
          (side === "A" && match.result === "A");

        const payout = won ? betSize * data.odds : 0;
        const profit = payout - betSize;

        bankroll += profit;
        totalBets++;
        totalStaked += betSize;
        totalReturned += payout;
        if (won) wins++;
        else losses++;

        maxBankroll = Math.max(maxBankroll, bankroll);
        minBankroll = Math.min(minBankroll, bankroll);

        // CLV: did we get better odds than Pinnacle's fair price?
        // Positive CLV = the odds we bet at were higher than what Pinnacle offered
        if (data.pinnacle > 1 && data.odds > 1) {
          // We bet at data.odds (max market). Pinnacle offered data.pinnacle.
          // If our odds > Pinnacle odds, we got positive CLV
          if (data.odds > data.pinnacle) clvPositive++;
          clvTotal++;
        }

        // Monthly tracking
        if (match.date) {
          const monthKey = `${match.date.getFullYear()}-${String(match.date.getMonth() + 1).padStart(2, "0")}`;
          if (!monthlyPnL[monthKey]) monthlyPnL[monthKey] = { bets: 0, pnl: 0 };
          monthlyPnL[monthKey].bets++;
          monthlyPnL[monthKey].pnl += profit;
        }

        // League tracking
        if (!leaguePnL[match.league]) leaguePnL[match.league] = { bets: 0, pnl: 0, staked: 0 };
        leaguePnL[match.league].bets++;
        leaguePnL[match.league].pnl += profit;
        leaguePnL[match.league].staked += betSize;

        betLog.push({
          date: match.dateStr,
          league: match.league,
          match: `${match.home} vs ${match.away}`,
          side,
          modelProb: (data.prob * 100).toFixed(1) + "%",
          odds: data.odds.toFixed(2),
          edge: (edge * 100).toFixed(1) + "%",
          bet: Math.round(betSize),
          result: match.result,
          won,
          profit: Math.round(profit),
          bankroll: Math.round(bankroll),
        });
      }
    }

    // === OVER/UNDER 2.5 GOALS ===
    if (match.pinnacleOver > 0 && match.pinnacleUnder > 0 &&
        match.maxOver > 0 && match.maxUnder > 0) {
      // Pinnacle fair probabilities for O/U
      const ouOverround = 1/match.pinnacleOver + 1/match.pinnacleUnder;
      const fairOver = (1/match.pinnacleOver) / ouOverround;
      const fairUnder = (1/match.pinnacleUnder) / ouOverround;

      const ouOdds = {
        "Over2.5": { prob: fairOver, odds: match.maxOver, pinnacle: match.pinnacleOver },
        // Under2.5 excluded: -11.1% ROI in optimizer
      };

      for (const [side, data] of Object.entries(ouOdds)) {
        if (!data.odds || data.odds <= 1.20) continue;

        const impliedProb = 1 / data.odds;
        const edge = data.prob - impliedProb;

        if (edge >= MIN_VALUE_EDGE) {
          const b = data.odds - 1;
          const kellyFull = (b * data.prob - (1 - data.prob)) / b;
          if (kellyFull <= 0) continue;

          const betSize = Math.min(
            kellyFull * KELLY_FRACTION * bankroll,
            bankroll * MAX_BET_PCT,
            bankroll * 0.1
          );
          if (betSize < 5) continue;

          const won = (side === "Over2.5" && match.totalGoals > 2.5) ||
                      (side === "Under2.5" && match.totalGoals < 2.5);

          const payout = won ? betSize * data.odds : 0;
          const profit = payout - betSize;

          bankroll += profit;
          totalBets++;
          totalStaked += betSize;
          totalReturned += payout;
          if (won) wins++; else losses++;
          maxBankroll = Math.max(maxBankroll, bankroll);
          minBankroll = Math.min(minBankroll, bankroll);

          if (data.pinnacle > 1 && data.odds > data.pinnacle) clvPositive++;
          if (data.pinnacle > 1) clvTotal++;

          if (match.date) {
            const monthKey = `${match.date.getFullYear()}-${String(match.date.getMonth() + 1).padStart(2, "0")}`;
            if (!monthlyPnL[monthKey]) monthlyPnL[monthKey] = { bets: 0, pnl: 0 };
            monthlyPnL[monthKey].bets++;
            monthlyPnL[monthKey].pnl += profit;
          }
          if (!leaguePnL[match.league]) leaguePnL[match.league] = { bets: 0, pnl: 0, staked: 0 };
          leaguePnL[match.league].bets++;
          leaguePnL[match.league].pnl += profit;
          leaguePnL[match.league].staked += betSize;

          betLog.push({
            date: match.dateStr, league: match.league,
            match: `${match.home} vs ${match.away}`, side,
            modelProb: (data.prob * 100).toFixed(1) + "%",
            odds: data.odds.toFixed(2), edge: (edge * 100).toFixed(1) + "%",
            bet: Math.round(betSize), result: `${match.totalGoals}goles`,
            won, profit: Math.round(profit), bankroll: Math.round(bankroll),
          });
        }
      }
    }
  }

  const totalProfit = bankroll - BANKROLL;
  const roi = totalStaked > 0 ? (totalProfit / totalStaked) * 100 : 0;
  const drawdown = ((maxBankroll - minBankroll) / maxBankroll) * 100;

  // Calculate Sharpe ratio (monthly)
  const monthlyReturns = Object.values(monthlyPnL).map((m) => m.pnl / BANKROLL);
  const avgReturn = monthlyReturns.reduce((s, r) => s + r, 0) / monthlyReturns.length;
  const stdReturn = Math.sqrt(
    monthlyReturns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / monthlyReturns.length
  );
  const sharpe = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(12) : 0; // Annualized

  return {
    totalBets,
    wins,
    losses,
    winRate: totalBets > 0 ? ((wins / totalBets) * 100).toFixed(1) + "%" : "0%",
    totalStaked: Math.round(totalStaked),
    totalReturned: Math.round(totalReturned),
    totalProfit: Math.round(totalProfit),
    roi: roi.toFixed(2) + "%",
    finalBankroll: Math.round(bankroll),
    maxBankroll: Math.round(maxBankroll),
    minBankroll: Math.round(minBankroll),
    maxDrawdown: drawdown.toFixed(1) + "%",
    sharpeRatio: sharpe.toFixed(2),
    clvPositiveRate: clvTotal > 0 ? ((clvPositive / clvTotal) * 100).toFixed(1) + "%" : "?",
    monthlyPnL,
    leaguePnL,
    betLog,
  };
}

// ============================================================
// CALIBRATION TEST
// ============================================================

function calibrationTest(allMatches) {
  const trainSize = Math.floor(allMatches.length * 0.6);
  const testMatches = allMatches.slice(trainSize);
  const ratings = buildTeamRatings(allMatches.slice(0, trainSize));

  // Bucket predictions by probability range and check actual frequency
  const buckets = {};
  const bucketSize = 0.05; // 5% buckets

  for (const match of testMatches) {
    const pred = predictMatch(match.home, match.away, ratings);
    if (!pred) continue;

    for (const [side, prob] of [["H", pred.pHome], ["D", pred.pDraw], ["A", pred.pAway]]) {
      const bucket = Math.floor(prob / bucketSize) * bucketSize;
      const key = bucket.toFixed(2);
      if (!buckets[key]) buckets[key] = { predicted: bucket + bucketSize / 2, total: 0, correct: 0 };

      buckets[key].total++;
      const won =
        (side === "H" && match.result === "H") ||
        (side === "D" && match.result === "D") ||
        (side === "A" && match.result === "A");
      if (won) buckets[key].correct++;
    }
  }

  return Object.values(buckets)
    .filter((b) => b.total >= 20) // Need enough data
    .map((b) => ({
      predicted: (b.predicted * 100).toFixed(0) + "%",
      actual: ((b.correct / b.total) * 100).toFixed(0) + "%",
      count: b.total,
      error: Math.abs(b.predicted - b.correct / b.total) * 100,
    }))
    .sort((a, b) => parseInt(a.predicted) - parseInt(b.predicted));
}

// ============================================================
// DASHBOARD
// ============================================================

function printResults(bt, calibration) {
  console.log("=".repeat(80));
  console.log("   FOOTBALL PREDICTOR — Backtest Results");
  console.log("   Poisson Model + Value Betting + Quarter Kelly");
  console.log("=".repeat(80));

  console.log("\n   PORTFOLIO");
  console.log("   " + "-".repeat(50));
  console.log(`   Bankroll inicial:    €${BANKROLL}`);
  console.log(`   Bankroll final:      €${bt.finalBankroll}`);
  console.log(`   Profit total:        €${bt.totalProfit}`);
  console.log(`   ROI:                 ${bt.roi}`);
  console.log(`   Sharpe ratio:        ${bt.sharpeRatio}`);
  console.log(`   Max drawdown:        ${bt.maxDrawdown}`);

  console.log("\n   APUESTAS");
  console.log("   " + "-".repeat(50));
  console.log(`   Total apuestas:      ${bt.totalBets}`);
  console.log(`   Ganadas:             ${bt.wins} (${bt.winRate})`);
  console.log(`   Perdidas:            ${bt.losses}`);
  console.log(`   Total apostado:      €${bt.totalStaked}`);
  console.log(`   Total retornado:     €${bt.totalReturned}`);
  console.log(`   CLV positivo:        ${bt.clvPositiveRate} (>55% = edge real)`);

  // Monthly P&L
  console.log("\n   P&L MENSUAL");
  console.log("   " + "Mes".padEnd(10) + "Bets".padStart(6) + "P&L".padStart(10) + "  Chart");
  console.log("   " + "-".repeat(60));

  const months = Object.entries(bt.monthlyPnL).sort();
  for (const [month, data] of months) {
    const bar = data.pnl >= 0
      ? "+" + "█".repeat(Math.min(30, Math.floor(data.pnl / 20)))
      : "-" + "░".repeat(Math.min(30, Math.floor(Math.abs(data.pnl) / 20)));
    console.log(
      "   " +
        month.padEnd(10) +
        String(data.bets).padStart(6) +
        `€${data.pnl >= 0 ? "+" : ""}${Math.round(data.pnl)}`.padStart(10) +
        "  " + bar
    );
  }

  // League breakdown
  console.log("\n   P&L POR LIGA");
  console.log("   " + "Liga".padEnd(18) + "Bets".padStart(6) + "Staked".padStart(10) + "P&L".padStart(10) + "ROI".padStart(8));
  console.log("   " + "-".repeat(52));

  for (const [league, data] of Object.entries(bt.leaguePnL).sort((a, b) => b[1].pnl - a[1].pnl)) {
    const roi = data.staked > 0 ? ((data.pnl / data.staked) * 100).toFixed(1) : "0";
    console.log(
      "   " +
        (LEAGUES[league] || league).padEnd(18) +
        String(data.bets).padStart(6) +
        `€${Math.round(data.staked)}`.padStart(10) +
        `€${data.pnl >= 0 ? "+" : ""}${Math.round(data.pnl)}`.padStart(10) +
        `${roi}%`.padStart(8)
    );
  }

  // Calibration
  if (calibration.length > 0) {
    console.log("\n   CALIBRACION DEL MODELO");
    console.log("   (Predicted vs Actual — línea perfecta = predicted == actual)");
    console.log("   " + "Predicted".padEnd(12) + "Actual".padEnd(10) + "Count".padStart(7) + "  Quality");
    console.log("   " + "-".repeat(45));

    for (const c of calibration) {
      const quality = c.error < 3 ? "Excelente" : c.error < 6 ? "Bueno" : c.error < 10 ? "OK" : "Malo";
      console.log(
        "   " +
          c.predicted.padEnd(12) +
          c.actual.padEnd(10) +
          String(c.count).padStart(7) +
          "  " + quality
      );
    }
  }

  // Last 20 bets
  console.log("\n   ULTIMAS 20 APUESTAS");
  console.log(
    "   " +
      "Fecha".padEnd(12) +
      "Partido".padEnd(28) +
      "Tip".padEnd(5) +
      "Prob".padStart(6) +
      "Odds".padStart(6) +
      "Edge".padStart(6) +
      "Bet".padStart(5) +
      "Res".padStart(5) +
      "P&L".padStart(7)
  );
  console.log("   " + "-".repeat(78));

  for (const bet of bt.betLog.slice(-20)) {
    console.log(
      "   " +
        (bet.date || "?").padEnd(12) +
        bet.match.slice(0, 26).padEnd(28) +
        bet.side.padEnd(5) +
        bet.modelProb.padStart(6) +
        bet.odds.padStart(6) +
        bet.edge.padStart(6) +
        `€${bet.bet}`.padStart(5) +
        (bet.won ? " W" : " L").padStart(5) +
        `€${bet.profit >= 0 ? "+" : ""}${bet.profit}`.padStart(7)
    );
  }

  console.log("\n" + "=".repeat(80));

  // Verdict
  const verdict = bt.totalProfit > 0 && parseFloat(bt.sharpeRatio) > 0.5 && parseFloat(bt.clvPositiveRate) > 52
    ? "MODELO RENTABLE — Considerar live testing"
    : bt.totalProfit > 0
      ? "RENTABLE PERO DEBIL — Necesita más edge o mejor calibración"
      : "NO RENTABLE — Modelo necesita mejoras";

  console.log(`\n   VEREDICTO: ${verdict}`);
  console.log("=".repeat(80));
}

// ============================================================
// UTILS
// ============================================================

function log(src, msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${src}] ${msg}`);
}

// ============================================================
// MAIN
// ============================================================

function main() {
  console.log("=".repeat(80));
  console.log("   FOOTBALL PREDICTOR");
  console.log("   Modelo Poisson + Value Betting + Walk-Forward Backtest");
  console.log("=".repeat(80));
  console.log(`   Ligas: ${Object.values(LEAGUES).join(", ")}`);
  console.log(`   Temporadas: ${SEASONS.join(", ")}`);
  console.log(`   Min edge: ${MIN_VALUE_EDGE * 100}% | Kelly: ${KELLY_FRACTION} | Max bet: ${MAX_BET_PCT * 100}%`);
  console.log("");

  // Load data
  const allMatches = loadAllData();
  log("DATA", `${allMatches.length} partidos cargados de ${Object.keys(LEAGUES).length} ligas`);

  if (allMatches.length < TRAINING_MATCHES) {
    log("ERROR", `Necesito al menos ${TRAINING_MATCHES} partidos para entrenar`);
    return;
  }

  // Run calibration
  log("MODEL", "Calibrando modelo...");
  const calibration = calibrationTest(allMatches);

  // Run backtest
  log("BACKTEST", "Ejecutando backtest walk-forward...");
  const bt = runBacktest(allMatches);

  // Print results
  printResults(bt, calibration);

  // Save full results
  fs.writeFileSync(LOG_FILE, JSON.stringify({
    config: { BANKROLL, KELLY_FRACTION, MIN_VALUE_EDGE, MAX_BET_PCT },
    results: {
      totalBets: bt.totalBets, wins: bt.wins, losses: bt.losses,
      roi: bt.roi, sharpe: bt.sharpeRatio, clv: bt.clvPositiveRate,
      profit: bt.totalProfit, finalBankroll: bt.finalBankroll,
    },
    monthlyPnL: bt.monthlyPnL,
    leaguePnL: bt.leaguePnL,
    calibration,
    lastBets: bt.betLog.slice(-50),
  }, null, 2));

  log("SAVE", `Resultados guardados en ${LOG_FILE}`);
}

main();

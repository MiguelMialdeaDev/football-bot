// ============================================================
// OPTIMIZER — Find the best parameters and filters
// Tests every dimension: odds range, bet type, Kelly fraction,
// edge threshold, league, market type
// ============================================================

const fs = require("fs");

// Load the predictor's data loading and model functions
const ALL_LEAGUES = {
  SP1: "La Liga", E0: "Premier League", D1: "Bundesliga",
  I1: "Serie A", F1: "Ligue 1", D2: "2. Bundesliga",
  I2: "Serie B", T1: "Turquía Super Lig", N1: "Eredivisie",
  P1: "Liga Portugal", SP2: "Segunda España",
  B1: "Bélgica", G1: "Grecia", SC0: "Escocia",
};

const SEASONS = ["2223", "2324", "2425"];
const DATA_DIR = "./data";

// ============================================================
// DATA LOADING (same as predictor)
// ============================================================

function loadAllData() {
  const allMatches = [];
  for (const league of Object.keys(ALL_LEAGUES)) {
    for (const season of SEASONS) {
      const file = `${DATA_DIR}/${league}_${season}.csv`;
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
      const lines = raw.split("\n").filter(l => l.trim());
      if (lines.length < 2) continue;
      const headers = lines[0].split(",");
      const g = (n) => headers.indexOf(n);

      for (let i = 1; i < lines.length; i++) {
        const c = lines[i].split(",");
        if (c.length < 10) continue;
        const fthg = parseInt(c[g("FTHG")]), ftag = parseInt(c[g("FTAG")]);
        if (isNaN(fthg) || isNaN(ftag)) continue;

        const dp = (c[g("Date")] || "").split("/");
        let date = null;
        if (dp.length === 3) { let y = parseInt(dp[2]); if (y < 100) y += 2000; date = new Date(y, parseInt(dp[1])-1, parseInt(dp[0])); }

        allMatches.push({
          league, date, dateStr: c[g("Date")],
          home: c[g("HomeTeam")], away: c[g("AwayTeam")],
          homeGoals: fthg, awayGoals: ftag, result: c[g("FTR")],
          totalGoals: fthg + ftag,
          pinnacleH: parseFloat(c[g("PSH")]) || 0,
          pinnacleD: parseFloat(c[g("PSD")]) || 0,
          pinnacleA: parseFloat(c[g("PSA")]) || 0,
          maxH: parseFloat(c[g("MaxH")]) || 0,
          maxD: parseFloat(c[g("MaxD")]) || 0,
          maxA: parseFloat(c[g("MaxA")]) || 0,
          avgH: parseFloat(c[g("AvgH")]) || 0,
          avgD: parseFloat(c[g("AvgD")]) || 0,
          avgA: parseFloat(c[g("AvgA")]) || 0,
          pinnacleOver: parseFloat(c[g("P>2.5")]) || 0,
          pinnacleUnder: parseFloat(c[g("P<2.5")]) || 0,
          maxOver: parseFloat(c[g("Max>2.5")]) || 0,
          maxUnder: parseFloat(c[g("Max<2.5")]) || 0,
        });
      }
    }
  }
  allMatches.sort((a, b) => (a.date || 0) - (b.date || 0));
  return allMatches;
}

// ============================================================
// BACKTEST ENGINE (parameterized)
// ============================================================

function backtest(allMatches, config) {
  const {
    leagues, minEdge, kellyFraction, maxBetPct,
    minOdds, maxOdds, useMaxOdds, betTypes, bankroll: startBankroll
  } = config;

  const trainSize = Math.floor(allMatches.length * 0.6);
  const testMatches = allMatches.slice(trainSize);

  let bankroll = startBankroll;
  let totalBets = 0, wins = 0, totalStaked = 0, totalReturned = 0;
  let maxBankroll = startBankroll, minBankroll = startBankroll;
  const monthlyReturns = [];
  let currentMonth = null, monthPnL = 0;
  const byType = {}; // Track P&L by bet type

  for (const match of testMatches) {
    if (!leagues[match.league]) continue;
    if (bankroll < 50) break; // Bust

    // Track monthly
    if (match.date) {
      const mk = `${match.date.getFullYear()}-${match.date.getMonth()}`;
      if (currentMonth && mk !== currentMonth) {
        monthlyReturns.push(monthPnL / startBankroll);
        monthPnL = 0;
      }
      currentMonth = mk;
    }

    // === 1X2 MARKET ===
    if (betTypes.includes("1X2")) {
      const pOr = (match.pinnacleH > 0 && match.pinnacleD > 0 && match.pinnacleA > 0)
        ? 1/match.pinnacleH + 1/match.pinnacleD + 1/match.pinnacleA : 0;
      if (pOr > 0) {
        const fairH = (1/match.pinnacleH)/pOr, fairD = (1/match.pinnacleD)/pOr, fairA = (1/match.pinnacleA)/pOr;

        const sides = [
          { side: "H", prob: fairH, odds: useMaxOdds ? match.maxH : match.avgH, result: match.result === "H" },
          { side: "D", prob: fairD, odds: useMaxOdds ? match.maxD : match.avgD, result: match.result === "D" },
          { side: "A", prob: fairA, odds: useMaxOdds ? match.maxA : match.avgA, result: match.result === "A" },
        ];

        for (const s of sides) {
          if (!s.odds || s.odds < minOdds || s.odds > maxOdds) continue;
          const edge = s.prob - 1/s.odds;
          if (edge < minEdge) continue;

          const b = s.odds - 1;
          const kelly = (b * s.prob - (1 - s.prob)) / b;
          if (kelly <= 0) continue;

          const bet = Math.min(kelly * kellyFraction * bankroll, bankroll * maxBetPct);
          if (bet < 5) continue;

          const payout = s.result ? bet * s.odds : 0;
          const profit = payout - bet;
          bankroll += profit;
          totalBets++; totalStaked += bet; totalReturned += payout;
          if (s.result) wins++;
          maxBankroll = Math.max(maxBankroll, bankroll);
          minBankroll = Math.min(minBankroll, bankroll);
          monthPnL += profit;

          const typeKey = `1X2_${s.side}`;
          if (!byType[typeKey]) byType[typeKey] = { bets: 0, pnl: 0, staked: 0 };
          byType[typeKey].bets++; byType[typeKey].pnl += profit; byType[typeKey].staked += bet;
        }
      }
    }

    // === OVER/UNDER 2.5 ===
    if (betTypes.includes("OU")) {
      if (match.pinnacleOver > 0 && match.pinnacleUnder > 0) {
        const ouOr = 1/match.pinnacleOver + 1/match.pinnacleUnder;
        const fairOver = (1/match.pinnacleOver)/ouOr, fairUnder = (1/match.pinnacleUnder)/ouOr;

        const sides = [
          { side: "Over", prob: fairOver, odds: useMaxOdds ? match.maxOver : ((match.maxOver+match.pinnacleOver)/2), result: match.totalGoals > 2.5 },
          { side: "Under", prob: fairUnder, odds: useMaxOdds ? match.maxUnder : ((match.maxUnder+match.pinnacleUnder)/2), result: match.totalGoals < 2.5 },
        ];

        for (const s of sides) {
          if (!s.odds || s.odds < minOdds || s.odds > maxOdds) continue;
          const edge = s.prob - 1/s.odds;
          if (edge < minEdge) continue;

          const b = s.odds - 1;
          const kelly = (b * s.prob - (1 - s.prob)) / b;
          if (kelly <= 0) continue;

          const bet = Math.min(kelly * kellyFraction * bankroll, bankroll * maxBetPct);
          if (bet < 5) continue;

          const payout = s.result ? bet * s.odds : 0;
          const profit = payout - bet;
          bankroll += profit;
          totalBets++; totalStaked += bet; totalReturned += payout;
          if (s.result) wins++;
          maxBankroll = Math.max(maxBankroll, bankroll);
          minBankroll = Math.min(minBankroll, bankroll);
          monthPnL += profit;

          const typeKey = `OU_${s.side}`;
          if (!byType[typeKey]) byType[typeKey] = { bets: 0, pnl: 0, staked: 0 };
          byType[typeKey].bets++; byType[typeKey].pnl += profit; byType[typeKey].staked += bet;
        }
      }
    }
  }

  // Final month
  if (monthPnL !== 0) monthlyReturns.push(monthPnL / startBankroll);

  const profit = bankroll - startBankroll;
  const roi = totalStaked > 0 ? (profit / totalStaked) * 100 : 0;
  const drawdown = maxBankroll > 0 ? ((maxBankroll - minBankroll) / maxBankroll) * 100 : 0;
  const avgR = monthlyReturns.length > 0 ? monthlyReturns.reduce((a, b) => a + b, 0) / monthlyReturns.length : 0;
  const stdR = monthlyReturns.length > 1 ? Math.sqrt(monthlyReturns.reduce((s, r) => s + (r - avgR) ** 2, 0) / monthlyReturns.length) : 1;
  const sharpe = stdR > 0 ? (avgR / stdR) * Math.sqrt(12) : 0;

  return { profit: Math.round(profit), roi: roi.toFixed(1), sharpe: sharpe.toFixed(2), totalBets, wins, drawdown: drawdown.toFixed(1), bankroll: Math.round(bankroll), byType };
}

// ============================================================
// OPTIMIZATION RUNS
// ============================================================

function main() {
  console.log("=".repeat(80));
  console.log("   OPTIMIZER — Testing all parameter combinations");
  console.log("=".repeat(80));

  const allMatches = loadAllData();
  console.log(`\n   ${allMatches.length} partidos cargados\n`);

  const baseConfig = {
    bankroll: 5000,
    minEdge: 0.01,
    kellyFraction: 0.25,
    maxBetPct: 0.03,
    minOdds: 1.30,
    maxOdds: 50,
    useMaxOdds: true,
    betTypes: ["1X2", "OU"],
    leagues: { D1:1, I1:1, D2:1, I2:1, T1:1, N1:1, SP2:1 },
  };

  // ============================================
  // TEST 1: Max odds vs Average odds
  // ============================================
  console.log("   === TEST 1: Max Odds vs Average Odds ===");
  const maxOddsResult = backtest(allMatches, { ...baseConfig, useMaxOdds: true });
  const avgOddsResult = backtest(allMatches, { ...baseConfig, useMaxOdds: false });
  console.log(`   Max odds:  €${maxOddsResult.profit} | ${maxOddsResult.roi}% ROI | Sharpe ${maxOddsResult.sharpe} | ${maxOddsResult.totalBets} bets`);
  console.log(`   Avg odds:  €${avgOddsResult.profit} | ${avgOddsResult.roi}% ROI | Sharpe ${avgOddsResult.sharpe} | ${avgOddsResult.totalBets} bets`);
  console.log(`   >>> ${maxOddsResult.profit > avgOddsResult.profit ? "Max odds mejor" : "Avg odds mejor (más realista!)"}`);

  // ============================================
  // TEST 2: Kelly Fraction
  // ============================================
  console.log("\n   === TEST 2: Kelly Fraction ===");
  for (const kf of [0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40]) {
    const r = backtest(allMatches, { ...baseConfig, kellyFraction: kf });
    const bar = r.profit > 0 ? "+".repeat(Math.min(30, Math.floor(r.profit / 100))) : "-".repeat(Math.min(30, Math.floor(Math.abs(r.profit) / 100)));
    console.log(`   Kelly ${kf.toFixed(2)}: €${String(r.profit).padStart(6)} | ${r.roi.padStart(5)}% | Sharpe ${r.sharpe.padStart(5)} | DD ${r.drawdown.padStart(5)}% | ${bar}`);
  }

  // ============================================
  // TEST 3: Minimum Edge
  // ============================================
  console.log("\n   === TEST 3: Minimum Edge ===");
  for (const me of [0.005, 0.01, 0.015, 0.02, 0.025, 0.03, 0.04, 0.05]) {
    const r = backtest(allMatches, { ...baseConfig, minEdge: me });
    const bar = r.profit > 0 ? "+".repeat(Math.min(30, Math.floor(r.profit / 100))) : "-".repeat(Math.min(30, Math.floor(Math.abs(r.profit) / 100)));
    console.log(`   Edge ${(me*100).toFixed(1).padStart(4)}%: €${String(r.profit).padStart(6)} | ${r.roi.padStart(5)}% | Sharpe ${r.sharpe.padStart(5)} | Bets ${String(r.totalBets).padStart(4)} | ${bar}`);
  }

  // ============================================
  // TEST 4: Odds Range
  // ============================================
  console.log("\n   === TEST 4: Odds Range ===");
  for (const [min, max, label] of [
    [1.30, 50, "All (1.30-50)"],
    [1.30, 3.0, "Low (1.30-3.0)"],
    [1.50, 5.0, "Mid (1.50-5.0)"],
    [2.00, 10.0, "High (2.0-10)"],
    [3.00, 50, "Longshot (3.0+)"],
    [1.50, 8.0, "Sweet (1.50-8)"],
  ]) {
    const r = backtest(allMatches, { ...baseConfig, minOdds: min, maxOdds: max });
    const bar = r.profit > 0 ? "+".repeat(Math.min(30, Math.floor(r.profit / 100))) : "-".repeat(Math.min(30, Math.floor(Math.abs(r.profit) / 100)));
    console.log(`   ${label.padEnd(18)}: €${String(r.profit).padStart(6)} | ${r.roi.padStart(5)}% | Sharpe ${r.sharpe.padStart(5)} | Bets ${String(r.totalBets).padStart(4)} | ${bar}`);
  }

  // ============================================
  // TEST 5: Bet Type breakdown
  // ============================================
  console.log("\n   === TEST 5: Market Type ===");
  const r1x2 = backtest(allMatches, { ...baseConfig, betTypes: ["1X2"] });
  const rou = backtest(allMatches, { ...baseConfig, betTypes: ["OU"] });
  const rboth = backtest(allMatches, { ...baseConfig, betTypes: ["1X2", "OU"] });
  console.log(`   1X2 only:  €${String(r1x2.profit).padStart(6)} | ${r1x2.roi.padStart(5)}% | Sharpe ${r1x2.sharpe.padStart(5)} | ${r1x2.totalBets} bets`);
  console.log(`   O/U only:  €${String(rou.profit).padStart(6)} | ${rou.roi.padStart(5)}% | Sharpe ${rou.sharpe.padStart(5)} | ${rou.totalBets} bets`);
  console.log(`   Both:      €${String(rboth.profit).padStart(6)} | ${rboth.roi.padStart(5)}% | Sharpe ${rboth.sharpe.padStart(5)} | ${rboth.totalBets} bets`);

  // Breakdown by side
  console.log("\n   Breakdown by bet side (current config):");
  for (const [type, data] of Object.entries(rboth.byType).sort((a, b) => b[1].pnl - a[1].pnl)) {
    const roi = data.staked > 0 ? ((data.pnl / data.staked) * 100).toFixed(1) : "0";
    console.log(`     ${type.padEnd(12)}: ${String(data.bets).padStart(4)} bets | €${data.pnl >= 0 ? "+" : ""}${Math.round(data.pnl).toString().padStart(5)} | ${roi.padStart(5)}% ROI`);
  }

  // ============================================
  // TEST 6: League by league
  // ============================================
  console.log("\n   === TEST 6: Individual League Performance ===");
  for (const [code, name] of Object.entries(ALL_LEAGUES)) {
    const r = backtest(allMatches, { ...baseConfig, leagues: { [code]: 1 } });
    if (r.totalBets < 5) continue;
    const bar = r.profit > 0 ? "+".repeat(Math.min(20, Math.floor(r.profit / 50))) : "-".repeat(Math.min(20, Math.floor(Math.abs(r.profit) / 50)));
    console.log(`   ${name.padEnd(18)}: €${String(r.profit).padStart(6)} | ${r.roi.padStart(6)}% | Sharpe ${r.sharpe.padStart(5)} | Bets ${String(r.totalBets).padStart(4)} | ${bar}`);
  }

  // ============================================
  // TEST 7: OPTIMAL CONFIG
  // ============================================
  console.log("\n   === TEST 7: OPTIMAL vs CURRENT ===");

  // Best config based on tests above
  const optimal = backtest(allMatches, {
    bankroll: 5000,
    minEdge: 0.01,
    kellyFraction: 0.15, // Lower Kelly for safety
    maxBetPct: 0.03,
    minOdds: 1.50,
    maxOdds: 8.0,
    useMaxOdds: true,
    betTypes: ["1X2", "OU"],
    leagues: { D1:1, I1:1, D2:1, I2:1, T1:1, N1:1, SP2:1 },
  });

  const current = backtest(allMatches, baseConfig);

  console.log(`   Current: €${current.profit} | ${current.roi}% ROI | Sharpe ${current.sharpe} | DD ${current.drawdown}% | ${current.totalBets} bets`);
  console.log(`   Optimal: €${optimal.profit} | ${optimal.roi}% ROI | Sharpe ${optimal.sharpe} | DD ${optimal.drawdown}% | ${optimal.totalBets} bets`);

  console.log("\n" + "=".repeat(80));
}

main();

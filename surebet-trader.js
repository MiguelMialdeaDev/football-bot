// ============================================================
// SUREBET PAPER TRADER
// Detecta surebets → apuesta automáticamente → verifica
// resultados → calcula P&L real
// ============================================================

const fs = require("fs");

// ============================================================
// CONFIG
// ============================================================
const API_KEY = "400df6d994cce4079380c2bcdf229ae5";
const BANKROLL = 5000;
const BET_PER_SUREBET = 100; // €100 por surebet
const MIN_PROFIT_PCT = 0.5; // 0.5% mínimo (subido — los <0.5% no cubren slippage)
const SCAN_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3 horas (conservar API calls)
const SETTLE_INTERVAL_MS = 2 * 60 * 60 * 1000; // Check results cada 2h
const MAX_API_CALLS_PER_SCAN = 6; // Conservar: ~48 calls/dia max
const DATA_FILE = "surebet-portfolio.json";

const SPORTS = [
  "soccer_spain_la_liga",
  "soccer_uefa_champs_league",
  "soccer_epl",
  "soccer_germany_bundesliga",
  "soccer_italy_serie_a",
  "soccer_france_ligue_one",
  "basketball_nba",
  "basketball_euroleague",
  "mma_mixed_martial_arts",
];

// ============================================================
// STATE
// ============================================================
let state = loadState();

function defaultState() {
  return {
    bankroll: BANKROLL,
    totalBet: 0,
    totalSettled: 0,
    totalProfit: 0,
    winCount: 0,
    lossCount: 0,
    openBets: [],     // Surebets placed, waiting for result
    settledBets: [],  // Completed with result
    scans: 0,
    apiCalls: 0,
    apiCallsRemaining: 500,
    startTime: Date.now(),
  };
}

function loadState() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const s = JSON.parse(raw);
    // Ensure all fields exist
    return { ...defaultState(), ...s };
  } catch {
    return defaultState();
  }
}

function saveState() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

// ============================================================
// SCAN FOR SUREBETS
// ============================================================

async function scanAndBet() {
  state.scans++;
  log("SCAN", `#${state.scans} — Buscando surebets...`);

  // Get active sports
  let activeSports;
  try {
    const res = await fetch(`https://api.the-odds-api.com/v4/sports/?apiKey=${API_KEY}`);
    state.apiCalls++;
    activeSports = (await res.json()).filter(s => s.active).map(s => s.key);
  } catch (err) {
    log("ERROR", `Sports list: ${err.message}`);
    return;
  }

  const toScan = SPORTS.filter(s => activeSports.includes(s));
  let newBets = 0;
  let callsThisScan = 1; // Already used 1 for sports list

  for (const sport of toScan) {
    if (callsThisScan >= MAX_API_CALLS_PER_SCAN) {
      log("API", `Limite de ${MAX_API_CALLS_PER_SCAN} calls/scan alcanzado, parando`);
      break;
    }
    await sleep(500);

    try {
      const res = await fetch(
        `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${API_KEY}&regions=eu,uk&markets=h2h&oddsFormat=decimal`
      );
      state.apiCalls++;
      callsThisScan++;

      const remaining = res.headers?.get("x-requests-remaining");
      if (remaining) {
        state.apiCallsRemaining = parseInt(remaining);
        if (parseInt(remaining) < 50) {
          log("API", `CUIDADO: solo ${remaining} calls restantes este mes!`);
        }
      }

      const events = await res.json();
      if (!Array.isArray(events)) continue;

      for (const event of events) {
        if (!event.bookmakers || event.bookmakers.length < 2) continue;

        // Skip events we already have bets on
        const eventId = `${event.home_team}_${event.away_team}_${event.commence_time}`;
        if (state.openBets.some(b => b.eventId === eventId)) continue;

        // Find best odds per outcome
        const bestOdds = {};
        for (const bm of event.bookmakers) {
          const market = bm.markets.find(m => m.key === "h2h");
          if (!market) continue;
          for (const outcome of market.outcomes) {
            if (!bestOdds[outcome.name] || outcome.price > bestOdds[outcome.name].price) {
              bestOdds[outcome.name] = {
                price: outcome.price,
                bookmaker: bm.title || bm.key,
              };
            }
          }
        }

        const outcomes = Object.keys(bestOdds);
        if (outcomes.length < 2) continue;

        // Calculate arbitrage
        const sumInverse = outcomes.reduce((s, k) => s + 1 / bestOdds[k].price, 0);
        const profitPct = (1 - sumInverse) * 100;

        if (profitPct >= MIN_PROFIT_PCT) {
          // Place paper bet!
          const totalStake = BET_PER_SUREBET;
          const bets = outcomes.map(name => {
            const stakePct = (1 / bestOdds[name].price) / sumInverse;
            const stake = totalStake * stakePct;
            return {
              outcome: name,
              odds: bestOdds[name].price,
              bookmaker: bestOdds[name].bookmaker,
              stake: Math.round(stake * 100) / 100,
              payout: Math.round(stake * bestOdds[name].price * 100) / 100,
            };
          });

          const guaranteedReturn = bets[0].payout; // All payouts should be ~equal
          const profit = guaranteedReturn - totalStake;

          const bet = {
            eventId,
            sport: formatSport(sport),
            sportKey: sport,
            homeTeam: event.home_team,
            awayTeam: event.away_team,
            event: `${event.home_team} vs ${event.away_team}`,
            date: event.commence_time,
            dateFormatted: formatDate(event.commence_time),
            placedAt: new Date().toISOString(),
            totalStake,
            profitPct: profitPct.toFixed(2) + "%",
            profitNum: profitPct,
            guaranteedReturn: Math.round(guaranteedReturn * 100) / 100,
            expectedProfit: Math.round(profit * 100) / 100,
            bets,
            status: "OPEN",
            result: null,
          };

          state.openBets.push(bet);
          state.totalBet += totalStake;
          state.bankroll -= totalStake;
          newBets++;

          log("BET", `${bet.event} | ${bet.profitPct} profit | €${totalStake} staked`);
          for (const b of bets) {
            log("BET", `  ${b.outcome.padEnd(22)} @ ${b.odds.toFixed(2)} (${b.bookmaker}) — €${b.stake}`);
          }
        }
      }
    } catch (err) {
      log("ERROR", `${sport}: ${err.message}`);
    }
  }

  log("SCAN", `${newBets} nuevas surebets colocadas | ${state.openBets.length} abiertas total`);
}

// ============================================================
// VERIFY ODDS — Check if surebets still alive
// ============================================================

async function verifyOdds() {
  if (state.openBets.length === 0) return;

  // Only verify bets happening in next 48h (save API calls)
  const soon = state.openBets.filter(b => {
    const hoursUntil = (new Date(b.date) - new Date()) / 3600000;
    return hoursUntil > 0 && hoursUntil < 48;
  });

  if (soon.length === 0) return;

  log("VERIFY", `Verificando ${soon.length} apuestas proximas...`);

  // Group by sport to minimize API calls
  const sports = [...new Set(soon.map(b => b.sportKey))];

  for (const sport of sports) {
    if (state.apiCalls > 480) {
      log("API", "Guardando calls — cerca del limite mensual");
      break;
    }

    await sleep(500);
    try {
      const res = await fetch(
        `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${API_KEY}&regions=eu,uk&markets=h2h&oddsFormat=decimal`
      );
      state.apiCalls++;
      const events = await res.json();
      if (!Array.isArray(events)) continue;

      for (const bet of soon.filter(b => b.sportKey === sport)) {
        const event = events.find(e =>
          e.home_team === bet.homeTeam && e.away_team === bet.awayTeam
        );

        if (!event || !event.bookmakers) continue;

        // Recalculate current surebet status
        const bestOdds = {};
        for (const bm of event.bookmakers) {
          const market = bm.markets.find(m => m.key === "h2h");
          if (!market) continue;
          for (const outcome of market.outcomes) {
            if (!bestOdds[outcome.name] || outcome.price > bestOdds[outcome.name].price) {
              bestOdds[outcome.name] = { price: outcome.price, bookmaker: bm.title || bm.key };
            }
          }
        }

        const outcomes = Object.keys(bestOdds);
        if (outcomes.length < 2) continue;

        const sumInverse = outcomes.reduce((s, k) => s + 1 / bestOdds[k].price, 0);
        const currentProfit = (1 - sumInverse) * 100;

        // Compare with original
        const originalProfit = bet.profitNum;
        const change = currentProfit - originalProfit;

        if (currentProfit < 0) {
          bet.oddsStatus = "EDGE LOST";
          log("VERIFY", `EDGE LOST! ${bet.event} — era ${bet.profitPct}, ahora ${currentProfit.toFixed(2)}%`);
        } else if (Math.abs(change) > 0.3) {
          bet.oddsStatus = currentProfit > originalProfit ? "IMPROVED" : "REDUCED";
          log("VERIFY", `${bet.event} — ${bet.profitPct} → ${currentProfit.toFixed(2)}% (${change > 0 ? "+" : ""}${change.toFixed(2)}%)`);
        } else {
          bet.oddsStatus = "STABLE";
        }

        bet.currentProfitPct = currentProfit.toFixed(2) + "%";
        bet.lastVerified = new Date().toISOString();
      }
    } catch {}
  }
}

// ============================================================
// SETTLE BETS — Check results
// ============================================================

async function settleBets() {
  if (state.openBets.length === 0) return;

  log("SETTLE", `Verificando ${state.openBets.length} apuestas abiertas...`);

  // Group open bets by sport
  const sportKeys = [...new Set(state.openBets.map(b => b.sportKey))];

  for (const sport of sportKeys) {
    await sleep(500);

    try {
      const res = await fetch(
        `https://api.the-odds-api.com/v4/sports/${sport}/scores/?apiKey=${API_KEY}&daysFrom=3`
      );
      state.apiCalls++;

      const scores = await res.json();
      if (!Array.isArray(scores)) continue;

      for (const score of scores) {
        if (!score.completed) continue;

        // Find matching open bet
        const betIdx = state.openBets.findIndex(b =>
          b.homeTeam === score.home_team &&
          b.awayTeam === score.away_team &&
          b.sportKey === sport
        );

        if (betIdx === -1) continue;

        const bet = state.openBets[betIdx];

        // Determine winner
        const homeScore = parseInt(score.scores?.find(s => s.name === score.home_team)?.score || "0");
        const awayScore = parseInt(score.scores?.find(s => s.name === score.away_team)?.score || "0");

        let winner;
        if (homeScore > awayScore) winner = score.home_team;
        else if (awayScore > homeScore) winner = score.away_team;
        else winner = "Draw";

        // Calculate actual P&L
        // In a surebet, we bet on ALL outcomes → we always win one leg
        const winningBet = bet.bets.find(b => b.outcome === winner);
        const actualReturn = winningBet ? winningBet.payout : 0;
        const actualProfit = actualReturn - bet.totalStake;

        bet.status = "SETTLED";
        bet.result = {
          homeScore,
          awayScore,
          winner,
          actualReturn: Math.round(actualReturn * 100) / 100,
          actualProfit: Math.round(actualProfit * 100) / 100,
          settledAt: new Date().toISOString(),
          profitable: actualProfit > 0,
        };

        // Update state
        state.bankroll += actualReturn;
        state.totalSettled++;
        state.totalProfit += actualProfit;
        if (actualProfit > 0) state.winCount++;
        else state.lossCount++;

        // Move to settled
        state.settledBets.push(bet);
        state.openBets.splice(betIdx, 1);

        const icon = actualProfit > 0 ? "WIN" : "LOSS";
        log("SETTLE", `${icon} | ${bet.event} | ${homeScore}-${awayScore} (${winner})`);
        log("SETTLE", `  Staked: €${bet.totalStake} → Return: €${actualReturn} → P&L: €${actualProfit.toFixed(2)}`);
      }
    } catch (err) {
      log("ERROR", `Settle ${sport}: ${err.message}`);
    }
  }
}

// ============================================================
// BACKTEST — Check historical results
// ============================================================

async function backtest() {
  log("BACKTEST", "Buscando resultados recientes para backtesting...");

  const sportKeys = [...new Set(SPORTS)];
  let totalEvents = 0;
  let surebetsFound = 0;
  let totalBacktestProfit = 0;

  for (const sport of sportKeys.slice(0, 5)) { // Limit API calls
    await sleep(500);

    try {
      // Get scores from last 3 days
      const scoresRes = await fetch(
        `https://api.the-odds-api.com/v4/sports/${sport}/scores/?apiKey=${API_KEY}&daysFrom=3&dateFormat=iso`
      );
      state.apiCalls++;

      const scores = await scoresRes.json();
      if (!Array.isArray(scores)) continue;

      const completed = scores.filter(s => s.completed);
      totalEvents += completed.length;

      for (const event of completed) {
        // For completed events, check if there was a surebet at kickoff
        // We can't get historical odds, but we can log which events completed
        const homeScore = parseInt(event.scores?.find(s => s.name === event.home_team)?.score || "0");
        const awayScore = parseInt(event.scores?.find(s => s.name === event.away_team)?.score || "0");
        const winner = homeScore > awayScore ? event.home_team
          : awayScore > homeScore ? event.away_team
          : "Draw";

        // Check against our settled bets
        const settled = state.settledBets.find(b =>
          b.homeTeam === event.home_team && b.awayTeam === event.away_team
        );

        if (settled) {
          totalBacktestProfit += settled.result.actualProfit;
        }
      }
    } catch {}
  }

  log("BACKTEST", `${totalEvents} eventos completados en 3 días`);
  if (state.settledBets.length > 0) {
    log("BACKTEST", `P&L verificado: €${totalBacktestProfit.toFixed(2)} en ${state.settledBets.length} apuestas`);
  }
}

// ============================================================
// DASHBOARD
// ============================================================

function printDashboard() {
  console.clear();
  const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
  const hrs = Math.floor(elapsed / 3600);
  const mins = Math.floor((elapsed % 3600) / 60);

  console.log("=".repeat(80));
  console.log("   SUREBET PAPER TRADER — Auto-betting & P&L tracking");
  console.log("=".repeat(80));

  // Portfolio summary
  console.log(`   Tiempo: ${hrs}h ${mins}m | Scans: ${state.scans} | API: ${state.apiCalls} calls`);
  console.log("-".repeat(80));
  console.log(`   Bankroll:        €${state.bankroll.toFixed(2)} / €${BANKROLL}`);
  console.log(`   En juego:        €${state.totalBet.toFixed(2)} (${state.openBets.length} apuestas abiertas)`);
  console.log(`   Liquidadas:      ${state.totalSettled} (${state.winCount}W / ${state.lossCount}L)`);
  console.log(`   P&L total:       €${state.totalProfit.toFixed(2)}`);
  if (state.totalSettled > 0) {
    const roi = (state.totalProfit / (state.totalSettled * BET_PER_SUREBET) * 100).toFixed(2);
    const avgProfit = (state.totalProfit / state.totalSettled).toFixed(2);
    console.log(`   ROI:             ${roi}%`);
    console.log(`   Profit medio:    €${avgProfit}/apuesta`);
  }
  console.log("-".repeat(80));

  // Open bets
  if (state.openBets.length > 0) {
    console.log("\n   APUESTAS ABIERTAS");
    console.log(
      "   " +
        "Partido".padEnd(35) +
        "Liga".padEnd(14) +
        "Fecha".padEnd(12) +
        "Stake".padStart(7) +
        "Profit".padStart(8)
    );
    console.log("   " + "-".repeat(76));

    // Sort by date
    const sorted = [...state.openBets].sort(
      (a, b) => new Date(a.date) - new Date(b.date)
    );

    for (const bet of sorted) {
      const oddsTag = bet.oddsStatus === "EDGE LOST" ? " !!LOST"
        : bet.oddsStatus === "REDUCED" ? " ~down"
        : bet.oddsStatus === "IMPROVED" ? " ^up"
        : "";
      console.log(
        "   " +
          bet.event.slice(0, 33).padEnd(35) +
          bet.sport.slice(0, 12).padEnd(14) +
          bet.dateFormatted.padEnd(12) +
          `+€${bet.expectedProfit.toFixed(2)}`.padStart(8) +
          oddsTag
      );
    }

    const totalExpected = state.openBets.reduce((s, b) => s + b.expectedProfit, 0);
    console.log("   " + "-".repeat(76));
    console.log(
      "   " +
        `TOTAL: ${state.openBets.length} apuestas`.padEnd(35) +
        "".padEnd(14) +
        "".padEnd(12) +
        `€${state.openBets.reduce((s, b) => s + b.totalStake, 0)}`.padStart(7) +
        `+€${totalExpected.toFixed(2)}`.padStart(8)
    );
  }

  // Recent settled bets
  if (state.settledBets.length > 0) {
    console.log("\n   HISTORIAL (últimas 15)");
    console.log(
      "   " +
        "Partido".padEnd(30) +
        "Score".padEnd(8) +
        "Winner".padEnd(16) +
        "P&L".padStart(10) +
        "  Status"
    );
    console.log("   " + "-".repeat(76));

    const recent = state.settledBets.slice(-15);
    for (const bet of recent) {
      const r = bet.result;
      const icon = r.profitable ? " OK" : " !!";
      console.log(
        "   " +
          bet.event.slice(0, 28).padEnd(30) +
          `${r.homeScore}-${r.awayScore}`.padEnd(8) +
          r.winner.slice(0, 14).padEnd(16) +
          `€${r.actualProfit >= 0 ? "+" : ""}${r.actualProfit.toFixed(2)}`.padStart(10) +
          icon
      );
    }

    // Stats
    console.log("\n   ESTADISTICAS");
    console.log(`   Total apostado:  €${(state.totalSettled * BET_PER_SUREBET).toFixed(0)}`);
    console.log(`   Total retorno:   €${(state.totalSettled * BET_PER_SUREBET + state.totalProfit).toFixed(2)}`);
    console.log(`   Profit neto:     €${state.totalProfit.toFixed(2)}`);
    console.log(`   Win rate:        ${state.totalSettled > 0 ? ((state.winCount / state.totalSettled) * 100).toFixed(0) : 0}%`);

    // Profit by sport
    const bySport = {};
    for (const bet of state.settledBets) {
      if (!bySport[bet.sport]) bySport[bet.sport] = { count: 0, profit: 0 };
      bySport[bet.sport].count++;
      bySport[bet.sport].profit += bet.result.actualProfit;
    }
    console.log("\n   Por deporte:");
    for (const [sport, data] of Object.entries(bySport)) {
      console.log(`     ${sport.padEnd(20)} ${data.count} apuestas  €${data.profit >= 0 ? "+" : ""}${data.profit.toFixed(2)}`);
    }
  }

  console.log("\n" + "=".repeat(80));
  console.log(`   Scan: ${SCAN_INTERVAL_MS / 60000}min | Settle: ${SETTLE_INTERVAL_MS / 60000}min | Ctrl+C = resumen`);
  console.log("=".repeat(80));
}

// ============================================================
// UTILS
// ============================================================

function formatSport(key) {
  const n = {
    soccer_spain_la_liga: "La Liga",
    soccer_uefa_champs_league: "Champions",
    soccer_epl: "Premier League",
    soccer_germany_bundesliga: "Bundesliga",
    soccer_italy_serie_a: "Serie A",
    soccer_france_ligue_one: "Ligue 1",
    basketball_nba: "NBA",
    basketball_euroleague: "Euroleague",
    mma_mixed_martial_arts: "MMA/UFC",
  };
  return n[key] || key.replace(/_/g, " ").slice(0, 18);
}

function formatDate(iso) {
  if (!iso) return "?";
  const d = new Date(iso);
  return `${d.getDate()}/${d.getMonth() + 1} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function getTimeLeft(iso) {
  const diff = new Date(iso) - new Date();
  if (diff < 0) return "En juego/pasado";
  const hrs = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  return `${hrs}h ${mins}m`;
}

function log(src, msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${src}] ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

process.on("SIGINT", () => {
  saveState();
  console.log("\n\n" + "=".repeat(60));
  console.log("   RESUMEN FINAL — SUREBET PAPER TRADER");
  console.log("=".repeat(60));
  console.log(`   Scans:           ${state.scans}`);
  console.log(`   Bankroll:        €${state.bankroll.toFixed(2)}`);
  console.log(`   Abiertas:        ${state.openBets.length}`);
  console.log(`   Liquidadas:      ${state.totalSettled}`);
  console.log(`   P&L:             €${state.totalProfit.toFixed(2)}`);
  console.log(`   API calls:       ${state.apiCalls}`);
  console.log(`   Portfolio:       ${DATA_FILE}`);
  console.log("=".repeat(60));
  process.exit(0);
});

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("=".repeat(80));
  console.log("   SUREBET PAPER TRADER");
  console.log("   Auto-detect → Auto-bet → Auto-settle → Track P&L");
  console.log("=".repeat(80));
  console.log(`   Bankroll: €${state.bankroll.toFixed(2)} | Bet size: €${BET_PER_SUREBET}`);
  console.log(`   Min profit: ${MIN_PROFIT_PCT}% | Scan: ${SCAN_INTERVAL_MS / 60000}min`);
  console.log(`   Estado previo: ${state.openBets.length} abiertas, ${state.totalSettled} liquidadas`);
  console.log("");

  // Initial scan + bet
  await scanAndBet();

  // Verify odds on existing bets
  await verifyOdds();

  // Check results for any open bets
  await settleBets();

  // Show dashboard
  printDashboard();
  saveState();

  // Calculate API budget
  const callsPerDay = MAX_API_CALLS_PER_SCAN * (24 / (SCAN_INTERVAL_MS / 3600000));
  const daysLeft = Math.floor((state.apiCallsRemaining || 400) / callsPerDay);
  log("API", `~${callsPerDay.toFixed(0)} calls/dia, ~${daysLeft} dias de API restantes`);

  // Continuous operation
  setInterval(async () => {
    await scanAndBet();
    await verifyOdds();
    printDashboard();
    saveState();
  }, SCAN_INTERVAL_MS);

  setInterval(async () => {
    await settleBets();
    printDashboard();
    saveState();
  }, SETTLE_INTERVAL_MS);
}

main().catch(console.error);

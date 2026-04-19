// ============================================================
// RESOLVE ORPHANS — Resolver manualmente señales pendientes
// cuando ya pasaron más de 3 días (fuera de la ventana que
// acepta The Odds API en /scores/ endpoint).
//
// Uso:
//   node scripts/resolve-orphans.js list
//       → muestra todas las señales PENDING de más de 3 días
//
//   node scripts/resolve-orphans.js settle <keyword> <homeScore> <awayScore>
//       → liquida la primera señal PENDING cuyo match contenga <keyword>
//       → ej: node scripts/resolve-orphans.js settle Rodez 2 1
//
//   node scripts/resolve-orphans.js cancel <keyword>
//       → marca como CANCELLED sin afectar al bankroll
//       → para señales que no quieres contar (no se apostó de verdad)
// ============================================================

const fs = require("fs");
const path = require("path");

const STATE_FILES = [
  { key: "baseline", file: path.join(__dirname, "..", "paper-baseline.json") },
  { key: "extend-up", file: path.join(__dirname, "..", "paper-extend-up.json") },
];

const DAYS_MS = 24 * 60 * 60 * 1000;

function loadStates() {
  return STATE_FILES.map(({ key, file }) => ({
    key, file,
    state: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null,
  }));
}

function saveState(file, state) {
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

function daysAgo(iso) {
  return Math.floor((Date.now() - new Date(iso).getTime()) / DAYS_MS);
}

function listOrphans() {
  const states = loadStates();
  let count = 0;
  for (const { key, state } of states) {
    if (!state) continue;
    const orphans = (state.signals || []).filter(s =>
      s.status === "PENDING" && daysAgo(s.commenceTime) > 3
    );
    if (!orphans.length) continue;
    console.log(`\n=== ${key.toUpperCase()} — ${orphans.length} huérfanos ===`);
    orphans.forEach(s => {
      const age = daysAgo(s.commenceTime);
      console.log(`  ${s.homeTeam} vs ${s.awayTeam} (${s.leagueName}) — hace ${age}d | ${s.sideLabel} @${s.odds.toFixed(2)} | stake €${s.stake}`);
    });
  }
}

function findSignal(state, keyword) {
  const needle = keyword.toLowerCase();
  return (state.signals || []).find(s =>
    s.status === "PENDING" && (
      s.homeTeam.toLowerCase().includes(needle) ||
      s.awayTeam.toLowerCase().includes(needle)
    )
  );
}

function settleSignal(keyword, homeScore, awayScore) {
  const states = loadStates();
  let touched = 0;
  for (const { key, file, state } of states) {
    if (!state) continue;
    const signal = findSignal(state, keyword);
    if (!signal) continue;
    const won = (signal.side === "H" && homeScore > awayScore) ||
                (signal.side === "A" && awayScore > homeScore) ||
                (signal.side === "D" && homeScore === awayScore);
    const profit = won ? signal.stake * (signal.odds - 1) : -signal.stake;

    signal.status = "SETTLED";
    signal.won = won;
    signal.homeScore = homeScore;
    signal.awayScore = awayScore;
    signal.profit = Math.round(profit * 100) / 100;
    signal.settledAt = new Date().toISOString();
    signal.settledManually = true;

    state.bankroll += profit;
    state.totalBets = (state.totalBets || 0) + 1;
    state.totalStaked = (state.totalStaked || 0) + signal.stake;
    state.totalProfit = (state.totalProfit || 0) + profit;
    if (won) state.wins = (state.wins || 0) + 1;
    else state.losses = (state.losses || 0) + 1;
    (state.results = state.results || []).push({ ...signal });

    saveState(file, state);
    touched++;
    console.log(`  [${key.toUpperCase()}] ${signal.homeTeam} ${homeScore}-${awayScore} ${signal.awayTeam} → ${won ? "WIN" : "LOSS"} (${profit >= 0 ? "+" : ""}${profit.toFixed(2)}€). Bankroll: ${state.bankroll.toFixed(2)}€`);
  }
  if (!touched) {
    console.log(`No se encontró ninguna señal PENDING que contenga "${keyword}".`);
  }
}

function cancelSignal(keyword) {
  const states = loadStates();
  let touched = 0;
  for (const { key, file, state } of states) {
    if (!state) continue;
    const signal = findSignal(state, keyword);
    if (!signal) continue;
    signal.status = "CANCELLED";
    signal.cancelledAt = new Date().toISOString();
    saveState(file, state);
    touched++;
    console.log(`  [${key.toUpperCase()}] Cancelada: ${signal.homeTeam} vs ${signal.awayTeam}`);
  }
  if (!touched) {
    console.log(`No se encontró ninguna señal PENDING que contenga "${keyword}".`);
  }
}

// ============================================================
// CLI
// ============================================================
const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case "list":
    listOrphans();
    break;
  case "settle": {
    const [keyword, h, a] = args;
    if (!keyword || h === undefined || a === undefined) {
      console.error("Uso: node scripts/resolve-orphans.js settle <keyword> <homeScore> <awayScore>");
      process.exit(1);
    }
    settleSignal(keyword, parseInt(h, 10), parseInt(a, 10));
    break;
  }
  case "cancel":
    if (!args[0]) {
      console.error("Uso: node scripts/resolve-orphans.js cancel <keyword>");
      process.exit(1);
    }
    cancelSignal(args[0]);
    break;
  default:
    console.log(`Comandos disponibles:
  list                              Listar señales pendientes de más de 3 días
  settle <keyword> <home> <away>    Liquidar con resultado (ej: settle Rodez 2 1)
  cancel <keyword>                  Cancelar sin afectar bankroll`);
}

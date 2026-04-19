const WebSocket = require("ws");

// ============================================================
// CONFIG
// ============================================================
const PAPER_BALANCE = 5000; // Capital inicial simulado (€)
const BET_SIZE = 50; // Apuesta por operación (€)
const POLL_INTERVAL_MS = 2000; // Polling Polymarket cada 2s
const MIN_EDGE = 0.10; // Edge mínimo para apostar (10%)
const LOG_FILE = "trades.json";

// ============================================================
// STATE
// ============================================================
let btcPrice = null;
let btcPriceTimestamp = null;
let balance = PAPER_BALANCE;
let trades = [];
let markets = []; // Polymarket BTC markets
let opportunities = 0;
let totalPnL = 0;
let startTime = Date.now();

// ============================================================
// BINANCE — Real-time BTC price via WebSocket
// ============================================================
function connectBinance() {
  const ws = new WebSocket("wss://stream.binance.com:9443/ws/btcusdt@trade");

  ws.on("open", () => {
    log("BINANCE", "Conectado — recibiendo precio BTC en tiempo real");
  });

  ws.on("message", (data) => {
    const trade = JSON.parse(data);
    btcPrice = parseFloat(trade.p);
    btcPriceTimestamp = Date.now();
  });

  ws.on("close", () => {
    log("BINANCE", "Desconectado — reconectando en 3s...");
    setTimeout(connectBinance, 3000);
  });

  ws.on("error", (err) => {
    log("BINANCE", `Error: ${err.message}`);
  });
}

// ============================================================
// POLYMARKET — Find BTC binary markets
// ============================================================
async function fetchBtcMarkets() {
  try {
    const res = await fetch(
      "https://gamma-api.polymarket.com/events?closed=false&tag=Crypto&order=volume24hr&ascending=false&limit=50"
    );
    const events = await res.json();

    const btcEvents = events.filter(
      (e) =>
        e.title &&
        (e.title.toLowerCase().includes("bitcoin above") ||
          e.title.toLowerCase().includes("btc above"))
    );

    const allMarkets = [];

    for (const event of btcEvents) {
      if (!event.markets) continue;
      for (const market of event.markets) {
        if (!market.clobTokenIds || !market.enableOrderBook) continue;

        const strike = extractStrike(market.question || event.title);
        if (!strike) continue;

        let tokenIds;
        try {
          tokenIds =
            typeof market.clobTokenIds === "string"
              ? JSON.parse(market.clobTokenIds)
              : market.clobTokenIds;
        } catch {
          continue;
        }

        allMarkets.push({
          id: market.id,
          question: market.question || event.title,
          strike,
          yesTokenId: tokenIds[0],
          noTokenId: tokenIds[1],
          endDate: market.endDate || event.endDate,
          conditionId: market.conditionId,
        });
      }
    }

    if (allMarkets.length > 0) {
      markets = allMarkets;
      log(
        "POLYMARKET",
        `${markets.length} mercados BTC binarios encontrados (strikes: ${markets.map((m) => "$" + m.strike.toLocaleString()).join(", ")})`
      );
    } else {
      log("POLYMARKET", "No se encontraron mercados BTC binarios activos");
    }
  } catch (err) {
    log("POLYMARKET", `Error buscando mercados: ${err.message}`);
  }
}

function extractStrike(text) {
  // Match patterns like "$70,000" or "$70000" or "70,000" or "70000"
  const match = text.match(/\$?([\d,]+)/);
  if (match) {
    const num = parseInt(match[1].replace(/,/g, ""), 10);
    if (num > 10000 && num < 500000) return num;
  }
  return null;
}

// ============================================================
// POLYMARKET — Get current odds for a market
// ============================================================
async function getMarketOdds(tokenId) {
  try {
    const res = await fetch(
      `https://clob.polymarket.com/price?token_id=${tokenId}&side=buy`
    );
    const data = await res.json();
    return parseFloat(data.price);
  } catch {
    return null;
  }
}

async function getOrderBook(tokenId) {
  try {
    const res = await fetch(
      `https://clob.polymarket.com/book?token_id=${tokenId}`
    );
    const data = await res.json();

    const bestBid =
      data.bids && data.bids.length > 0 ? parseFloat(data.bids[0].price) : 0;
    const bestAsk =
      data.asks && data.asks.length > 0 ? parseFloat(data.asks[0].price) : 1;
    const bidSize =
      data.bids && data.bids.length > 0 ? parseFloat(data.bids[0].size) : 0;
    const askSize =
      data.asks && data.asks.length > 0 ? parseFloat(data.asks[0].size) : 0;

    return { bestBid, bestAsk, bidSize, askSize };
  } catch {
    return null;
  }
}

// ============================================================
// ARBITRAGE ENGINE
// ============================================================
async function scanForOpportunities() {
  if (!btcPrice || markets.length === 0) return;

  for (const market of markets) {
    try {
      // Get YES token price and order book
      const [yesPrice, book] = await Promise.all([
        getMarketOdds(market.yesTokenId),
        getOrderBook(market.yesTokenId),
      ]);

      if (yesPrice === null || book === null) continue;

      const noPrice = 1 - yesPrice;

      // Calculate fair value based on current BTC price vs strike
      const diff = btcPrice - market.strike;
      const diffPct = (diff / market.strike) * 100;

      // Determine what the odds SHOULD be based on BTC price
      // If BTC is clearly above strike → YES should be ~0.95+
      // If BTC is clearly below strike → YES should be ~0.05-
      let fairYes = null;
      let signal = null;

      if (diffPct > 2) {
        // BTC is >2% above strike — YES should be very high
        fairYes = 0.95;
        signal = "BUY_YES";
      } else if (diffPct > 1) {
        fairYes = 0.85;
        signal = "BUY_YES";
      } else if (diffPct < -2) {
        // BTC is >2% below strike — NO should be very high
        fairYes = 0.05;
        signal = "BUY_NO";
      } else if (diffPct < -1) {
        fairYes = 0.15;
        signal = "BUY_NO";
      }

      if (fairYes === null) continue;

      // Calculate edge
      let edge = 0;
      let action = "";
      let entryPrice = 0;

      if (signal === "BUY_YES" && yesPrice < fairYes) {
        edge = fairYes - yesPrice;
        action = "BUY YES";
        entryPrice = book.bestAsk; // We'd buy at ask
      } else if (signal === "BUY_NO" && noPrice < 1 - fairYes) {
        edge = 1 - fairYes - noPrice;
        action = "BUY NO";
        entryPrice = 1 - book.bestBid; // Buying NO = selling YES at bid
      }

      if (edge >= MIN_EDGE) {
        opportunities++;

        const trade = {
          timestamp: new Date().toISOString(),
          market: market.question,
          strike: market.strike,
          btcPrice: btcPrice,
          diffPct: diffPct.toFixed(2) + "%",
          action,
          marketOdds: yesPrice,
          fairValue: fairYes,
          edge: (edge * 100).toFixed(1) + "%",
          entryPrice: entryPrice || yesPrice,
          betSize: BET_SIZE,
          availableLiquidity: book.bidSize || book.askSize,
          potentialProfit: (BET_SIZE * edge).toFixed(2),
        };

        trades.push(trade);
        totalPnL += BET_SIZE * edge;

        log("OPPORTUNITY", "");
        console.log(
          `   Strike:     $${market.strike.toLocaleString()}`
        );
        console.log(`   BTC ahora:  $${btcPrice.toLocaleString()}`);
        console.log(`   Diferencia: ${diffPct.toFixed(2)}%`);
        console.log(`   Accion:     ${action}`);
        console.log(
          `   Odds PM:    ${(yesPrice * 100).toFixed(1)}% YES / ${(noPrice * 100).toFixed(1)}% NO`
        );
        console.log(`   Fair value: ${(fairYes * 100).toFixed(1)}% YES`);
        console.log(`   Edge:       ${(edge * 100).toFixed(1)}%`);
        console.log(
          `   Liquidez:   $${(book.bidSize || book.askSize || 0).toFixed(0)}`
        );
        console.log(
          `   Beneficio:  €${(BET_SIZE * edge).toFixed(2)} (apuesta €${BET_SIZE})`
        );
        console.log("");
      }

      // Log status for each market (less verbose)
      logMarketStatus(market, yesPrice, diffPct, edge, signal);
    } catch (err) {
      // Silently skip failed markets
    }
  }
}

function logMarketStatus(market, yesPrice, diffPct, edge, signal) {
  const indicator =
    edge >= MIN_EDGE ? ">>>" : diffPct > 0 ? " + " : " - ";
  const edgeStr =
    edge > 0 ? ` | edge: ${(edge * 100).toFixed(1)}%` : "";
  process.stdout.write(
    `\r   ${indicator} $${market.strike.toLocaleString().padEnd(8)} | BTC: $${btcPrice.toLocaleString().padEnd(10)} | diff: ${diffPct.toFixed(2).padStart(6)}% | YES: ${(yesPrice * 100).toFixed(1).padStart(5)}%${edgeStr}      `
  );
}

// ============================================================
// DASHBOARD
// ============================================================
function printDashboard() {
  console.clear();
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const hrs = Math.floor(elapsed / 3600);
  const mins = Math.floor((elapsed % 3600) / 60);
  const secs = elapsed % 60;

  console.log("=".repeat(65));
  console.log("   POLYMARKET PAPER TRADER — Arbitraje BTC");
  console.log("=".repeat(65));
  console.log(
    `   BTC/USDT:        $${btcPrice ? btcPrice.toLocaleString() : "cargando..."}`
  );
  console.log(
    `   Mercados activos: ${markets.length}`
  );
  console.log(
    `   Tiempo corriendo: ${hrs}h ${mins}m ${secs}s`
  );
  console.log("-".repeat(65));
  console.log(
    `   Balance papel:    €${balance.toFixed(2)}`
  );
  console.log(
    `   Oportunidades:   ${opportunities}`
  );
  console.log(
    `   P&L estimado:    €${totalPnL.toFixed(2)}`
  );
  console.log(
    `   Trades:          ${trades.length}`
  );
  console.log("-".repeat(65));

  if (trades.length > 0) {
    console.log("   Ultimos trades:");
    const recent = trades.slice(-5);
    for (const t of recent) {
      console.log(
        `     ${t.timestamp.slice(11, 19)} | ${t.action.padEnd(8)} | Strike $${t.strike.toLocaleString()} | Edge ${t.edge} | +€${t.potentialProfit}`
      );
    }
    console.log("-".repeat(65));
  }

  console.log("   Mercados monitorizados:");
  for (const m of markets) {
    const diff = btcPrice ? (((btcPrice - m.strike) / m.strike) * 100).toFixed(2) : "?";
    console.log(
      `     $${m.strike.toLocaleString().padEnd(8)} | diff: ${String(diff).padStart(6)}% | ${m.question.slice(0, 45)}`
    );
  }
  console.log("=".repeat(65));
  console.log("   Ctrl+C para parar. Datos en trades.json");
  console.log("");
}

// ============================================================
// PERSISTENCE
// ============================================================
const fs = require("fs");

function saveTrades() {
  const data = {
    startTime: new Date(startTime).toISOString(),
    lastUpdate: new Date().toISOString(),
    balance,
    totalPnL,
    opportunities,
    totalTrades: trades.length,
    trades,
  };
  fs.writeFileSync(LOG_FILE, JSON.stringify(data, null, 2));
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log("Iniciando Polymarket Paper Trader...\n");

  // 1. Connect to Binance
  connectBinance();

  // 2. Wait for first BTC price
  log("SYSTEM", "Esperando precio de Binance...");
  while (!btcPrice) {
    await sleep(500);
  }
  log("SYSTEM", `BTC precio inicial: $${btcPrice.toLocaleString()}`);

  // 3. Fetch Polymarket markets
  await fetchBtcMarkets();

  if (markets.length === 0) {
    log(
      "SYSTEM",
      "No hay mercados BTC activos en Polymarket ahora mismo. Reintentando cada 60s..."
    );
    setInterval(fetchBtcMarkets, 60000);
  }

  // 4. Refresh markets every 5 minutes
  setInterval(fetchBtcMarkets, 5 * 60 * 1000);

  // 5. Scan for opportunities
  setInterval(async () => {
    await scanForOpportunities();
    saveTrades();
  }, POLL_INTERVAL_MS);

  // 6. Dashboard every 10 seconds
  setInterval(printDashboard, 10000);

  // 7. Initial dashboard after 3s
  setTimeout(printDashboard, 3000);
}

// ============================================================
// UTILS
// ============================================================
function log(source, msg) {
  const time = new Date().toISOString().slice(11, 19);
  console.log(`[${time}] [${source}] ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n\nGuardando trades...");
  saveTrades();

  console.log("\n========== RESUMEN FINAL ==========");
  console.log(`Tiempo total: ${Math.floor((Date.now() - startTime) / 60000)} minutos`);
  console.log(`Oportunidades detectadas: ${opportunities}`);
  console.log(`Trades simulados: ${trades.length}`);
  console.log(`P&L estimado: €${totalPnL.toFixed(2)}`);
  console.log(`Datos guardados en: ${LOG_FILE}`);
  console.log("====================================\n");
  process.exit(0);
});

main().catch(console.error);

# Football Betting Bot

Bot de value betting de fútbol con modelo Poisson. Detecta oportunidades con edge
positivo en varias ligas europeas, envía señales a Telegram y registra los
resultados en paper trading para comparar dos variantes de estrategia (baseline y
extend-up).

## Qué hace

- **Entrenamiento:** carga 20.574 partidos históricos de `football-data.co.uk`
  (temporadas 22/23, 23/24, 24/25) de 11 ligas.
- **Modelo:** Poisson + ajuste por equipo (ataque/defensa/home advantage).
- **Value betting:** busca desviaciones entre probabilidad real y cuotas de The
  Odds API. Filtra por edge 6-15% y Kelly fraction 33% con tope 3% del bankroll.
- **Ligas operativas:** Bundesliga, Serie A, Serie B, 2. Bundesliga, Eredivisie,
  Turquía Süper Lig, Segunda España, + algunas en pruebas.
- **Dos variantes:** `baseline` (zonas estrechas) y `extend-up` (zona alta
  ampliada, más volumen) — cada una con su propio portfolio.
- **Telegram:** envía señales con match, cuota, edge, tamaño de apuesta sugerido.
- **Extras:** surebet/dutch-book para arbitraje, weather bot, optimizer de
  parámetros.

## Modos

```bash
node paper-trade-compare.js --scan      # Buscar fixtures y enviar señales nuevas
node paper-trade-compare.js --results   # Recoger resultados de partidos terminados
node paper-trade-compare.js --report    # Mostrar comparativa baseline vs extend-up
node paper-trade-compare.js --reset     # Borrar portfolios (¡cuidado!)
```

## Setup local

1. **Node.js 20+** instalado.
2. Clona el repo e instala dependencias:
   ```bash
   npm install
   ```
3. Copia `.env.example` a `.env` y rellena las variables:
   ```
   ODDS_API_KEY=...
   TELEGRAM_BOT_TOKEN=...
   TELEGRAM_CHANNEL_ID=...
   ```
4. Ejecuta:
   ```bash
   node paper-trade-compare.js --scan
   ```

## Setup en GitHub Actions (correr 24/7 sin tu PC)

El workflow en `.github/workflows/bot.yml` ejecuta el bot en los runners de
GitHub — no necesita tu PC encendido.

### Pasos:

1. **Crear el repositorio en GitHub.** Recomendado **público** para minutos de
   Actions ilimitados (nada del código es sensible si los secrets están bien
   configurados).

2. **Push inicial desde esta carpeta:**
   ```bash
   git remote add origin https://github.com/TU_USUARIO/football-bot.git
   git branch -M main
   git push -u origin main
   ```

3. **Añadir secrets** en GitHub: Settings → Secrets and variables → Actions →
   New repository secret. Añade:

   | Secret | De dónde sacarlo |
   |---|---|
   | `ODDS_API_KEY` | https://the-odds-api.com/ |
   | `TELEGRAM_BOT_TOKEN` | @BotFather en Telegram |
   | `TELEGRAM_CHANNEL_ID` | @userinfobot o el ID de tu canal |
   | `HEALTHCHECK_URL` (opcional) | https://healthchecks.io/ |

4. **Activar Actions** en la pestaña Actions → "I understand my workflows".

5. **Primer run manual** para comprobar que todo funciona: Actions → Football
   Betting Bot → Run workflow.

### Schedule por defecto

- **Scan:** 09:00 y 18:00 UTC (2 veces/día)
- **Results:** 23:00 UTC (cada noche)

El schedule es conservador para caber en el free tier de The Odds API (500
requests/mes). Si quieres más frecuencia, pasa a plan pago o ajusta el cron en
`bot.yml`.

### Persistencia del estado

Tras cada run el workflow hace commit automático de los archivos de estado
(`paper-baseline.json`, `paper-extend-up.json`, `telegram-bot-state.json`,
etc.) con el mensaje `chore: update bot state [skip ci]`. Así cada ejecución
parte del estado de la anterior, igual que si corriera en un servidor continuo.

### Alertas de fallo

Si una ejecución falla, te llega un mensaje al mismo chat de Telegram con enlace
al log. Si el workflow deja de correr entero (cron pausado, cuota agotada), el
healthcheck de [healthchecks.io](https://healthchecks.io) te avisa — configura
el secret `HEALTHCHECK_URL` y crea un check con periodo 8h para recibir avisos.

## Archivos clave

```
paper-trade-compare.js   Script principal (scan/results/report)
football-predictor.js    Modelo Poisson + value betting
predictor-v3.js          Versión más reciente del predictor
data/                    CSVs históricos de football-data.co.uk
paper-baseline.json      Estado portfolio baseline (auto-commit)
paper-extend-up.json     Estado portfolio extend-up (auto-commit)
telegram-bot-state.json  Señales pendientes y resultados (auto-commit)
.github/workflows/bot.yml  Workflow de GitHub Actions
```

## Límites a tener en cuenta

- **The Odds API:** 500 req/mes en free. Cada scan gasta ~7-10 req (una por
  liga). Con el schedule actual: 2 scans × 30 días × 7 ligas = 420 req/mes.
  Cabe con margen pero revisa tu uso.
- **GitHub Actions:** si el repo es privado, 2.000 min/mes gratis. Cada run
  tarda ~2 min. 3 runs/día × 30 días = 180 min/mes. Sobra.
- **Sobreajuste del backtest:** los ROIs históricos del predictor
  (`1X2_H +36%`, `Over +31.4%`) son de backtest. La realidad live puede
  divergir. Validar con 4-8 semanas de paper trading antes de arriesgar dinero
  real o ofrecerlo como tipster.

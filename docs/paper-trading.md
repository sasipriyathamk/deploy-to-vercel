# Paper Trading & Strategy Research

This document describes the paper trading, confidence calibration, drawdown research, and portfolio simulation architecture in Keel.

## Overview

The paper trading engine is built entirely on top of Keel's observational pipeline (`telegram_alerts`, `alert_observations`, and `tokens`). It evaluates simulated strategies and statistical calibration without introducing duplicate background loops or competing workers.

## Key Design Principles

1. **No Look-Ahead Bias**: Signal evaluation and confidence calibration always use the confidence value and entry baseline recorded at the exact moment of signal delivery. Later revisions never retroactively alter historical signals.
2. **Quote Price vs. Fill Price**: Hypothetical quote prices are never assumed to be fill prices. Configurable entry/exit slippage and transaction fees are deducted consistently.
3. **Execution Realism**: Simulating returns with unlimited capital or summing independent trade returns leads to false confidence. The engine enforces portfolio capital constraints: available cash, position limits, token exposure ceilings, and reserved margin.
4. **Censoring Awareness**: Forward observation windows (15m, 1h, 6h, 24h, 72h) explicitly report incomplete or censored tracks. A token that hasn't doubled yet within a 24-hour window is not treated as a failed signal.
5. **Distinct Recovery Milestones**: Drawdown analysis tracks four distinct milestones:
   - Recovery of entry price
   - Recovery of local peak prior to the dip
   - Recovery of prior All-Time-High (ATH)
   - Formation of a new ATH
6. **Resource Safety**: The adaptive sampler adheres to Helius Free-tier rate limits and existing DexScreener budget gates, scheduling bounded rechecks through the existing queue.

## Database Schema (Migration `0010_paper_trading.sql`)

- `paper_signals`: Stores qualifying confidence signals across all tiers (`alert`, `research`, `watching`, `candidate`).
- `paper_observations`: Enriched observations for signals with freshness status, liquidity, and volume tracking.
- `paper_calibration`: Pre-aggregated statistical matrix mapping confidence bands to forward window outcomes.
- `paper_drawdown_episodes`: Detailed peak-trough-rebound lifecycle records.
- `paper_portfolios`: Portfolio configurations including capital, sizing rules, and exposure limits.
- `paper_positions`: Individual simulated trade positions with fill prices, MAE/MFE, peaks, and exit reasons.
- `paper_equity_snapshots`: Periodic equity curves and portfolio drawdowns.
- `paper_strategies`: Versioned strategy definitions and parameter sets.

## API Endpoints

- `GET /api/paper/calibration`: Retrieve confidence band calibration metrics.
- `POST /api/paper/calibration`: Trigger recalibration across all bands and timeframes.
- `GET /api/paper/stats`: Summary of signal universe, recent alert performance, and drawdown recovery charts.
- `POST /api/paper/stats`: Sync alerts to paper signals and advance the portfolio simulation engine.
- `GET /api/paper/portfolio`: List portfolios or view individual equity curve and positions.
- `POST /api/paper/portfolio`: Create a portfolio or initialize the default portfolio.
- `GET /api/paper/drawdown`: Summary of drawdown episodes and recovery probabilities by depth bucket.

## UI Dashboard

Available at `/paper`:
- **Confidence Calibration Tab**: Matrix showing +25%, +50%, +100%, +200%, -30%, -50%, MFE, MAE, 2× vs -30% race, and censored counts for each confidence tier.
- **Drawdown Research Tab**: Peak-to-trough episode statistics, median recovery time, and recovery rate by dip depth bucket.
- **Portfolio Simulation Tab**: Capital tracking, open positions, win/loss metrics, and equity curve visualization.
- **Recent Alerts Tab**: Granular per-alert performance with MFE, MAE, max drawdown, and milestone achievement indicators.

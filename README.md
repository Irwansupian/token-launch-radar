# Token Launch Radar

An entry to [make.fun's token-radar-01](https://make.fun/bounty/token-radar-01): rank every
pre-token protocol in a sealed DefiLlama snapshot by what its token launch would be worth, and
show the board, a detail view per protocol, and the steps to farm each one.

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Irwansupian/token-launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Irwansupian/token-launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

## The model

One function scores every protocol; no name is special-cased.

1. **Calibrate.** Each tokenized protocol is a market observation, ratio = market cap / TVL,
   winsorized to [0.02, 5]. A category's multiple is the median of its ratios, shrunk toward the
   global median (0.2138) with a pseudo-count of 5 and clamped to [0.05, 3].
2. **Base.** implied base = TVL × the protocol's category multiple.
3. **Momentum.** × (1 + clamp(7-day TVL change, −50%, +100%) × 0.5); unreported is neutral.
4. **Maturity.** × (0.7 + 0.3 × min(age in days, 1460) / 1460); 0.85 when no listing date.

The board carries every watchlist protocol plus every other protocol that records no token and
is not a wrapped, staked or bridged product of one that trades (bridge and staking wrapper
categories, version-marker names, wrapped/staked name markers, exchange-fronted names). Tokenized
protocols are never ranked; the dashboard shows them apart, at market value, as the calibration
set. Each row's farm plan is generated from its own category, chain, TVL tier and age, with a cost
and a duration on every step.

## Run it

```
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

Node 22, standard library only. The run writes `board.json`, `data.js`, `dashboard/`,
`screenshots/` and `dossier.json` into the output directory, byte-identically on every run.
Open `dashboard/index.html` from the output directory to read the board.

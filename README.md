# FairFun Rewards

Built for Solana Frontier Hackathon.

FairFun rewards the holders who held.

The core metric is `USD-minutes`.

Every minute:

```text
gravity += current USD value of the wallet's token balance
```

That means:

- hold more value -> earn gravity faster
- hold longer -> accumulate more gravity
- sell down -> future gravity slows down
- past gravity stays earned

When rewards are distributed:

```text
user share = user gravity / total gravity
user payout = reward pool * user share
```

This repo now contains the full FairFun stack:

- the Solana program
- a separate offchain indexer process
- a separate TradJS app

## Repo Layout

- `programs/fairfun-rewards/` onchain rewards program
- `scripts/create-pool.ts` pool registration helper
- `indexer.ts` separate worker process
- `server.ts` TradJS web app
- `app/` frontend routes and pages
- `lib/` shared config, Solana, DB, and indexing logic
- `.config.example.toml` deployment template

## Architecture

FairFun is split into three layers.

### 1. Onchain program

Program: `fairfun_rewards`

Program ID:

`HsydRBzU6Bcw6ku3h4K6JqimRTxTeCfvZQL6yDBvAi4A`

The program owns:

- global config PDA
- per-token rewards pool PDA
- per-token treasury PDA
- per-user claim state PDA

Main PDA derivations:

```text
config   = PDA(["rewards_config"], program_id)
pool     = PDA(["rewards_pool", token_mint], program_id)
treasury = PDA(["rewards_treasury", token_mint], program_id)
user     = PDA(["rewards_user_claim", pool, wallet], program_id)
```

### 2. Indexer process

The indexer is a separate Bun worker started from [indexer.ts](/C:/Code/fairfun-protocol/indexer.ts:1).

It does four jobs:

- reads token holders from Solana RPC
- fetches price and computes `USD-minutes`
- tracks treasury inflows
- updates the local SQLite leaderboard database

The web app does not own this job anymore.

### 3. TradJS app

The app is a separate Bun server started from [server.ts](/C:/Code/fairfun-protocol/server.ts:1).

It does three jobs:

- renders the landing page and leaderboard
- reads indexed state from SQLite
- optionally proxies claim requests to an external signer service

Branding, token identity, RPC, treasury address, and site title all come from `.config.toml`.

## Config

Copy the template:

```bash
Copy-Item .config.example.toml .config.toml
```

Then set:

- `app.site_title`
- `app.project_name`
- `app.hero_badge`
- `app.hero_title`
- `app.hero_description`
- `chain.rpc_url`
- `token.mint`
- `token.symbol`
- `rewards.program_id`
- `rewards.treasury_address`
- `rewards.claim_api_url` if you run an external claim signer
- `indexer.db_path`
- `indexer.interval_ms`
- `indexer.launch_timestamp`
- `indexer.token_price_usd` if you want to pin price manually

## Install

You need:

- Rust + Anchor for the program
- Bun for the indexer and web app

Install JavaScript dependencies:

```bash
npm install
```

## Run Locally

Start the app:

```bash
bun run start:web
```

Start the indexer in a second terminal:

```bash
bun run start:indexer
```

For development with file watching:

```bash
bun run dev:web
bun run dev:indexer
```

## Build And Test

Build the program:

```bash
npm run build
```

Run all checks:

```bash
npm test
```

This runs:

- `cargo build-sbf`
- `cargo test -p fairfun-rewards`
- `cargo check --workspace`
- `tsc --noEmit`

## Deploy Your Own Program

The sequence is:

1. build the program
2. deploy the binary
3. initialize global config with your backend signer pubkey
4. register a rewards pool for your token mint
5. fund the treasury PDA with SOL

Build:

```bash
cargo build-sbf --manifest-path programs/fairfun-rewards/Cargo.toml
```

Initialize:

```text
initialize(backend_authority: Pubkey)
```

Register a pool with [scripts/create-pool.ts](/C:/Code/fairfun-protocol/scripts/create-pool.ts:1):

```bash
bun scripts/create-pool.ts <YOUR_TOKEN_MINT>
```

That script derives:

```text
PDA(["rewards_config"], program_id)
PDA(["rewards_pool", token_mint], program_id)
PDA(["rewards_treasury", token_mint], program_id)
```

## Deploy Your Own Indexer

The indexer is stateful because it writes SQLite.

For deployment:

1. copy `.config.example.toml` to `.config.toml`
2. point `chain.rpc_url` to your RPC
3. set `token.mint`
4. set `rewards.treasury_address`
5. choose a persistent `indexer.db_path`
6. run `bun run start:indexer`
7. supervise it with systemd, pm2, Docker, or your platform's process manager

Important notes:

- the app reads the database, so the DB path must be persistent
- the indexer should be the only process writing gravity state
- `indexer.interval_ms` controls how often holder state is refreshed

## Deploy Your Own Frontend

The frontend is just the TradJS app.

For deployment:

1. use the same `.config.toml` values for branding and chain identity
2. make sure it can read the SQLite DB produced by the indexer
3. run `bun run start:web`
4. put a reverse proxy in front if needed

Optional claim support:

- if `rewards.claim_api_url` is empty, the app stays read-only
- if you provide `rewards.claim_api_url`, the app will proxy:
  - `POST /api/claim-transaction`
  - `POST /api/claim-confirmed`
  - `GET /api/earnings/:wallet`

## Claim Model

The external signer should sign cumulative earned value, not a one-off payout:

```text
[user | pool | cumulative_earned | observed_total_deposits | expires_at]
```

The program then computes:

```text
claimable = cumulative_earned - previously_claimed
```

This keeps accounting monotonic and prevents replaying old claims.

## Program Safety Checks

Before paying, the program checks:

- signature validity
- signer matches configured backend authority
- payload not expired
- pool active
- cumulative earned did not go backwards
- observed deposits do not exceed onchain received funds
- treasury has enough SOL

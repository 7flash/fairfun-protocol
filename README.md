# FairFun Rewards

Built for Solana Frontier Hackathon.

## Reward The Holders Who Held

FairFun is a Solana rewards program that measures loyalty in `USD-minutes`.

Every minute, each wallet earns gravity equal to the current dollar value of the project's token it holds. Revenue share, continuous airdrops, and other recurring distributions flow to gravity, not to whoever showed up an hour ago.

The current FairFun landing flow and backend in this repo are built around that model.

## Live Example: `$GXY`

The live FairFun demo uses `$GXY` leaderboard data to simulate a continuous airdrop:

- heartbeat: `60s`
- metric: `USD-minutes`
- network: `Solana`
- revenue shared continuously with gravity-weighted distribution
- mint: `PKikg1HNZinFvMgqk76aBDY4fF1fgGYQ3tv9kKypump`

In the product, the simulation shows:

- current revenue-per-minute inflow
- simulated time progression
- each wallet's USD-held position
- accumulated gravity
- gravity share
- projected payout

The point of the demo is simple: gravity increases every minute a wallet actually holds value, and payout share follows that gravity.

### `$GXY` Onchain Addresses

For the current live `$GXY` setup:

- rewards program: `HsydRBzU6Bcw6ku3h4K6JqimRTxTeCfvZQL6yDBvAi4A`
- token mint: `PKikg1HNZinFvMgqk76aBDY4fF1fgGYQ3tv9kKypump`
- rewards pool PDA: `JymMcQ1vgbBexcx8QHTNDSyzGvN5aYkmaUGJ4U7YGwq`
- rewards treasury PDA: `9PjzMHWupLg8WmHhrHpZ8ksFDunYoNexpVWosyna7qh`

They are derived deterministically from the program ID and token mint:

```text
pool PDA     = PDA(["rewards_pool", token_mint], program_id)
treasury PDA = PDA(["rewards_treasury", token_mint], program_id)
```

So for `$GXY` specifically:

```text
pool PDA     = PDA(["rewards_pool", "PKikg1HNZinFvMgqk76aBDY4fF1fgGYQ3tv9kKypump"], "HsydRBzU6Bcw6ku3h4K6JqimRTxTeCfvZQL6yDBvAi4A")
treasury PDA = PDA(["rewards_treasury", "PKikg1HNZinFvMgqk76aBDY4fF1fgGYQ3tv9kKypump"], "HsydRBzU6Bcw6ku3h4K6JqimRTxTeCfvZQL6yDBvAi4A")
```

This is the same derivation used by the backend and pool registration helper in:

- [backend/server.ts](/C:/Code/fairfun-protocol/backend/server.ts:123)
- [scripts/create-pool.ts](/C:/Code/fairfun-protocol/scripts/create-pool.ts:1)

## How It Works

FairFun reduces holder rewards to one number per wallet: `gravity`.

Gravity is a monotonic integer that tracks cumulative `USD-minutes` of holding.

### 1. A holder buys the token

The wallet becomes part of the tracked holder set for the configured mint.

### 2. Every minute, gravity ticks up

For each holder:

```text
gravity += current_usd_value_of_wallet_balance
```

Hold `$1,000` for `60` minutes and that wallet earns `60,000` gravity.

### 3. Selling cools future accrual

Gravity is based on the balance actually held now. If the wallet sells or transfers out, future accrual drops with it. Previously earned gravity remains earned.

### 4. Rewards flow by gravity share

When revenue or airdrop capital enters the system, distribution is proportional to each wallet's share of total gravity at that moment.

That is the core FairFun claim:

- long-term holders keep compounding their weight
- short-term entrants do not get equal treatment just for appearing near distribution time
- recurring rewards can run continuously instead of as ad hoc snapshots

## Program Model

The onchain program currently implemented in this repo is `fairfun_rewards`.

It uses:

- one global config PDA with an admin and backend signing authority
- one reward pool PDA per tracked token mint
- one SOL treasury PDA per pool
- one user-claim PDA per `(pool, user)` pair
- backend-authorized claims verified with Solana Ed25519 instruction introspection

Current deployed program ID:

`HsydRBzU6Bcw6ku3h4K6JqimRTxTeCfvZQL6yDBvAi4A`

Recorded IDs in [Anchor.toml](/C:/Code/fairfun-protocol/Anchor.toml:1):

- `fairfun_rewards` localnet: `HsydRBzU6Bcw6ku3h4K6JqimRTxTeCfvZQL6yDBvAi4A`
- `fairfun_rewards` devnet: `HsydRBzU6Bcw6ku3h4K6JqimRTxTeCfvZQL6yDBvAi4A`
- `fairfun_rewards` mainnet: `HsydRBzU6Bcw6ku3h4K6JqimRTxTeCfvZQL6yDBvAi4A`

Program source:

- [programs/fairfun-rewards/src/lib.rs](/C:/Code/fairfun-protocol/programs/fairfun-rewards/src/lib.rs:1)

## Current Claim Flow

The current backend/frontend flow in this repo is:

1. The backend derives the reward pool and treasury PDAs for the configured token mint.
2. The backend computes each wallet's current cumulative earned amount.
3. The backend signs a short-lived claim payload.
4. The frontend requests an unsigned claim transaction.
5. The user signs and submits it.
6. The program verifies the signature and transfers the unclaimed SOL delta from the treasury PDA.

The signed message is:

```text
[user | pool | cumulative_earned | observed_total_deposits | expires_at]
```

The contract stores prior claimed cumulative value and only lets the wallet withdraw the delta.

## Why This Design

The important design choice is that the backend signs `cumulative_earned`, not a one-off reward amount.

That gives FairFun:

- monotonic accounting
- replay resistance via expiry and cumulative claim state
- pool-bounded payouts
- flexible offchain gravity calculation without losing onchain settlement guarantees

## Repository Layout

- `programs/fairfun-rewards/` onchain rewards program
- `backend/` Bun backend that prepares claim payloads and unsigned transactions
- `frontend/` Bun + React landing and wallet flow
- `scripts/create-pool.ts` helper for registering a rewards pool
- `tests/` and Rust tests under `programs/fairfun-rewards/tests/`

This workspace also still contains adjacent modules such as `anchor_fairfun`, `wheel`, and `star_nft`, but FairFun Rewards is the main production-facing holder rewards flow documented here.

## Integrate

Ship fair rewards in an afternoon.

The intended integration model is:

1. point FairFun at your token mint
2. track holder balances and price them in USD
3. accumulate gravity continuously
4. fund the rewards treasury with revenue, incentives, or airdrop budget
5. let holders claim their gravity-weighted share

What FairFun handles:

- gravity bookkeeping
- pool state
- claim authorization format
- proportional payout settlement
- recurring, automated reward claims against a funded treasury

## Local Development

Prerequisites:

1. Rust toolchain
2. Solana/Agave CLI
3. `cargo-build-sbf`
4. Node.js and npm
5. Anchor-compatible wallet config

Install dependencies:

```bash
npm install
```

Build:

```bash
npm run build
```

Test:

```bash
npm test
```

This currently:

- builds all workspace programs
- runs `anchor_fairfun` Rust tests
- runs `fairfun_rewards` Rust tests
- runs `cargo check --workspace`

## Runtime Configuration

Secret-bearing runtime files are intentionally not tracked.

Use:

- [local-config.example.json](/C:/Code/fairfun-protocol/local-config.example.json:1)
- [mainnet-config.example.json](/C:/Code/fairfun-protocol/mainnet-config.example.json:1)
- [backend/test-users.example.json](/C:/Code/fairfun-protocol/backend/test-users.example.json:1)

Important backend values:

- `programId`: deployed `fairfun_rewards` program ID
- `authority.secretKey`: backend signer used for claim signatures
- `starTokenMint`: tracked token mint whose holders accrue rewards

## Deploying `fairfun_rewards`

This repo includes a tracked pool-registration helper, but not a full polished tracked deployment runner for the entire initialize flow. The safe deployment order is:

1. build the program
2. deploy the `fairfun_rewards` binary
3. initialize the global config with your backend signer public key
4. register a pool for your token mint
5. fund the pool treasury PDA with SOL
6. point the backend at the deployed program ID, signer, and token mint

### Build

```bash
cargo build-sbf --manifest-path programs/fairfun-rewards/Cargo.toml
```

### Initialize

Call:

```text
initialize(backend_authority: Pubkey)
```

Accounts:

- `admin`
- `config = PDA("rewards_config")`
- `system_program`

### Register A Pool

Use [scripts/create-pool.ts](/C:/Code/fairfun-protocol/scripts/create-pool.ts:1) with your preferred TypeScript runner in an Anchor-aware environment. It derives:

- `rewards_config`
- `rewards_pool + token_mint`
- `rewards_treasury + token_mint`

and sends:

```text
register_pool(token_mint)
```

### Fund The Treasury

After pool creation, send SOL into the treasury PDA. The `deposit(amount)` instruction is the intended path when you want onchain pool accounting to track inflow consistently.

## Production Notes

- claims expire if the signed payload is stale
- claims fail if cumulative earned decreases
- claims fail if observed deposits exceed onchain received funds
- claims fail if the pool is paused
- the treasury PDA must hold enough SOL for settlement
- the backend signer is critical secret material and should be handled accordingly

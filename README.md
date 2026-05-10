# FairFun Rewards

Built for Solana Frontier Hackathon.

## What FairFun Is

FairFun is a Solana rewards program.

Its job is simple:

- measure how long people really held
- measure how much value they really held
- pay rewards to those holders fairly

Most airdrops are based on a snapshot.

That is weak.

Someone can buy right before the snapshot and get treated like a real long-term holder.

FairFun uses a different idea.

FairFun measures loyalty in `USD-minutes`.

## The Core Idea

Every wallet has one number:

`gravity`

Gravity means:

how much dollar value this wallet held, multiplied by how long it held it.

Every minute:

```text
gravity += current USD value of the wallet's token balance
```

Example:

- hold `$1,000` for `60` minutes -> earn `60,000 gravity`
- hold `$5,000` for `10` minutes -> earn `50,000 gravity`

If a holder sells, future gravity grows more slowly.

Past gravity stays earned.

That is the whole system.

## Why This Is Better

Snapshot rewards measure presence.

FairFun rewards measure commitment.

That means:

- long-term holders naturally gain more weight
- late entrants do not get the same treatment as loyal holders
- rewards can run continuously instead of through one-off snapshot games

## How Rewards Are Split

When a project wants to share revenue or run an airdrop, FairFun looks at each wallet's share of total gravity.

Formula:

```text
user share = user gravity / total gravity
user payout = reward pool * user share
```

So rewards go to the wallets that actually held value over time.

## Live Example: `$GXY`

The current FairFun demo uses `$GXY`.

It simulates a continuous airdrop with:

- heartbeat: `60s`
- metric: `USD-minutes`
- network: `Solana`
- revenue shared continuously by gravity weight
- mint: `PKikg1HNZinFvMgqk76aBDY4fF1fgGYQ3tv9kKypump`

The live demo shows:

- revenue per minute
- each wallet's USD-held amount
- gravity
- gravity share
- payout projection

The point of the demo is simple:

if a wallet holds more value for more time, it earns more gravity, and therefore gets a larger share of rewards.

### `$GXY` Onchain Addresses

For the current live `$GXY` setup:

- rewards program: `HsydRBzU6Bcw6ku3h4K6JqimRTxTeCfvZQL6yDBvAi4A`
- token mint: `PKikg1HNZinFvMgqk76aBDY4fF1fgGYQ3tv9kKypump`
- rewards pool PDA: `JymMcQ1vgbBexcx8QHTNDSyzGvN5aYkmaUGJ4U7YGwq`
- rewards treasury PDA: `9PjzMHWupLg8WmHhrHpZ8ksFDunYoNexpVWosyna7qh`

They are derived deterministically:

```text
pool PDA     = PDA(["rewards_pool", token_mint], program_id)
treasury PDA = PDA(["rewards_treasury", token_mint], program_id)
```

For `$GXY` specifically:

```text
pool PDA     = PDA(["rewards_pool", "PKikg1HNZinFvMgqk76aBDY4fF1fgGYQ3tv9kKypump"], "HsydRBzU6Bcw6ku3h4K6JqimRTxTeCfvZQL6yDBvAi4A")
treasury PDA = PDA(["rewards_treasury", "PKikg1HNZinFvMgqk76aBDY4fF1fgGYQ3tv9kKypump"], "HsydRBzU6Bcw6ku3h4K6JqimRTxTeCfvZQL6yDBvAi4A")
```

This is the same derivation used in:

- [backend/server.ts](/C:/Code/fairfun-protocol/backend/server.ts:123)
- [scripts/create-pool.ts](/C:/Code/fairfun-protocol/scripts/create-pool.ts:1)

## How The System Is Built

FairFun has two parts:

1. offchain gravity calculation
2. onchain reward settlement

### Offchain

The backend:

- tracks holder balances
- prices those balances in USD
- updates each wallet's cumulative earned amount
- signs claim payloads for users

### Onchain

The Solana program:

- verifies the backend signature
- verifies that the claim is still valid
- verifies that the pool has enough funds
- transfers only the user's unclaimed amount

This hybrid design is intentional.

Computing holder balances and USD value continuously is much easier offchain.

Moving money must still be guarded onchain.

## The Onchain Program

The current production-facing program in this repo is:

`fairfun_rewards`

Program ID:

`HsydRBzU6Bcw6ku3h4K6JqimRTxTeCfvZQL6yDBvAi4A`

Recorded IDs in [Anchor.toml](/C:/Code/fairfun-protocol/Anchor.toml:1):

- `fairfun_rewards` localnet: `HsydRBzU6Bcw6ku3h4K6JqimRTxTeCfvZQL6yDBvAi4A`
- `fairfun_rewards` devnet: `HsydRBzU6Bcw6ku3h4K6JqimRTxTeCfvZQL6yDBvAi4A`
- `fairfun_rewards` mainnet: `HsydRBzU6Bcw6ku3h4K6JqimRTxTeCfvZQL6yDBvAi4A`

Program source:

- [programs/fairfun-rewards/src/lib.rs](/C:/Code/fairfun-protocol/programs/fairfun-rewards/src/lib.rs:1)

## Program Structure

The program uses four main accounts.

### 1. Global config PDA

`rewards_config`

Stores:

- admin
- backend authority public key

### 2. Pool PDA

`rewards_pool + token_mint`

Stores:

- which token mint this pool is for
- total deposited
- total claimed
- whether the pool is active

### 3. Treasury PDA

`rewards_treasury + token_mint`

Stores:

- the SOL used to pay rewards

### 4. User claim PDA

`rewards_user_claim + pool + user`

Stores:

- how much cumulative value the user has already claimed

## How Claims Work

The backend does not sign "pay this wallet exactly X right now".

It signs the user's cumulative earned amount.

That is important.

The signed message is:

```text
[user | pool | cumulative_earned | observed_total_deposits | expires_at]
```

The program then calculates:

```text
claimable = cumulative_earned - previously_claimed
```

That means the user can only withdraw the delta.

This makes accounting simple and monotonic.

## What The Program Checks

Before paying, the program checks:

- the signature is valid
- the signer matches the configured backend authority
- the signature is not expired
- the pool is active
- `cumulative_earned` did not go backwards
- the observed deposits do not exceed onchain received funds
- the treasury has enough SOL

If those checks pass, the program sends the user's unclaimed amount from the treasury PDA.

## Trust Model

FairFun is not fully trustless.

The backend is trusted to:

- compute gravity correctly
- use correct price data
- sign honest cumulative values

But payout settlement is still protected onchain.

That is the tradeoff:

- heavy continuous accounting happens offchain
- money movement and claim limits are enforced onchain

## Integrate

The integration model is simple:

1. choose your token mint
2. deploy `fairfun_rewards`
3. initialize the backend signer
4. register a pool for your mint
5. fund the treasury PDA with SOL
6. run gravity accounting offchain
7. let users claim their share

FairFun handles:

- gravity-based reward logic
- pool accounting
- claim authorization format
- onchain payout settlement

## Repository Layout

- `programs/fairfun-rewards/` onchain rewards program
- `backend/` Bun backend that prepares claim payloads and unsigned transactions
- `frontend/` Bun + React landing and wallet flow
- `scripts/create-pool.ts` helper for registering a rewards pool
- `tests/` and Rust tests under `programs/fairfun-rewards/tests/`

This workspace also contains older and adjacent modules such as `anchor_fairfun`, `wheel`, and `star_nft`, but `fairfun_rewards` is the main holder-rewards program documented here.

## Local Development

Prerequisites:

1. Rust toolchain
2. Solana/Agave CLI
3. `cargo-build-sbf`
4. Node.js and npm
5. Anchor-compatible wallet config

Install:

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

The deployment order is:

1. build the program
2. deploy the binary
3. initialize the global config with the backend signer public key
4. register a pool for the token mint
5. fund the treasury PDA with SOL
6. point the backend at the correct program ID, signer, and mint

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

Use [scripts/create-pool.ts](/C:/Code/fairfun-protocol/scripts/create-pool.ts:1) with your preferred TypeScript runner in an Anchor-aware environment.

It derives:

- `rewards_config`
- `rewards_pool + token_mint`
- `rewards_treasury + token_mint`

and sends:

```text
register_pool(token_mint)
```

### Fund The Treasury

After pool creation, send SOL into the treasury PDA.

If you want onchain accounting to reflect inflow cleanly, use the program's `deposit(amount)` path.

## Production Notes

- claims expire if the signed payload is stale
- claims fail if cumulative earned decreases
- claims fail if observed deposits exceed onchain received funds
- claims fail if the pool is paused
- treasury must hold enough SOL
- the backend signer is critical secret material

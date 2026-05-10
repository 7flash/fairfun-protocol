# FairFun Rewards

Built for Solana Frontier Hackathon.

## What This Repo Is

This repository is the protocol repo for `fairfun_rewards`.

It is intentionally focused on one thing:

- the Solana program
- its tests
- one small helper script for registering pools

It does not include the app frontend.

It does not include the production oracle or production backend.

Those are separate concerns.

## What FairFun Does

FairFun rewards holders based on how much value they held and how long they held it.

The metric is:

`USD-minutes`

Every wallet has one number:

`gravity`

Every minute:

```text
gravity += current USD value of the wallet's token balance
```

Examples:

- hold `$1,000` for `60` minutes -> `60,000 gravity`
- hold `$5,000` for `10` minutes -> `50,000 gravity`

If a wallet sells, future gravity grows more slowly.

Past gravity stays earned.

## Why This Exists

Most airdrops are based on snapshots.

Snapshots reward presence.

FairFun is built to reward commitment.

That means:

- long-term holders naturally gain more weight
- late entrants do not get the same treatment as loyal holders
- distributions can run continuously instead of through one-off snapshot games

## How Rewards Are Split

When a project funds a reward pool, payout is proportional to gravity:

```text
user share = user gravity / total gravity
user payout = reward pool * user share
```

So rewards go to wallets that actually held value over time.

## The Onchain Program

Program:

`fairfun_rewards`

Program ID:

`HsydRBzU6Bcw6ku3h4K6JqimRTxTeCfvZQL6yDBvAi4A`

Source:

- [programs/fairfun-rewards/src/lib.rs](/C:/Code/fairfun-protocol/programs/fairfun-rewards/src/lib.rs:1)

Current IDs in [Anchor.toml](/C:/Code/fairfun-protocol/Anchor.toml:1):

- localnet: `HsydRBzU6Bcw6ku3h4K6JqimRTxTeCfvZQL6yDBvAi4A`
- devnet: `HsydRBzU6Bcw6ku3h4K6JqimRTxTeCfvZQL6yDBvAi4A`
- mainnet: `HsydRBzU6Bcw6ku3h4K6JqimRTxTeCfvZQL6yDBvAi4A`

## Program Structure

The program uses four main PDA types.

### 1. Global config

```text
PDA(["rewards_config"], program_id)
```

Stores:

- admin
- backend authority public key

### 2. Reward pool

```text
PDA(["rewards_pool", token_mint], program_id)
```

Stores:

- token mint
- total deposited
- total claimed
- active / paused flag

### 3. Treasury

```text
PDA(["rewards_treasury", token_mint], program_id)
```

Stores:

- the SOL used to pay claims

### 4. User claim state

```text
PDA(["rewards_user_claim", pool, user], program_id)
```

Stores:

- how much cumulative value the user has already claimed

## How Claims Work

The offchain signer does not sign "pay this wallet exactly X".

It signs a cumulative amount.

Signed message:

```text
[user | pool | cumulative_earned | observed_total_deposits | expires_at]
```

The program then calculates:

```text
claimable = cumulative_earned - previously_claimed
```

This keeps accounting monotonic and prevents double-claiming of old value.

## What The Program Checks

Before paying, the program checks:

- the signature is valid
- the signer matches the configured backend authority
- the signature is not expired
- the pool is active
- `cumulative_earned` did not go backwards
- observed deposits do not exceed onchain received funds
- the treasury has enough SOL

If those checks pass, the treasury PDA transfers the user's unclaimed amount.

## `$GXY` Example

Current live example mint:

`PKikg1HNZinFvMgqk76aBDY4fF1fgGYQ3tv9kKypump`

Current `$GXY` pool PDA:

`JymMcQ1vgbBexcx8QHTNDSyzGvN5aYkmaUGJ4U7YGwq`

Current `$GXY` treasury PDA:

`9PjzMHWupLg8WmHhrHpZ8ksFDunYoNexpVWosyna7qh`

Derived as:

```text
pool PDA     = PDA(["rewards_pool", token_mint], program_id)
treasury PDA = PDA(["rewards_treasury", token_mint], program_id)
```

For `$GXY` specifically:

```text
pool PDA     = PDA(["rewards_pool", "PKikg1HNZinFvMgqk76aBDY4fF1fgGYQ3tv9kKypump"], "HsydRBzU6Bcw6ku3h4K6JqimRTxTeCfvZQL6yDBvAi4A")
treasury PDA = PDA(["rewards_treasury", "PKikg1HNZinFvMgqk76aBDY4fF1fgGYQ3tv9kKypump"], "HsydRBzU6Bcw6ku3h4K6JqimRTxTeCfvZQL6yDBvAi4A")
```

## Repo Layout

- `programs/fairfun-rewards/` onchain rewards program
- `scripts/create-pool.ts` helper for pool registration

## Build And Test

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

This runs:

- `cargo build-sbf` for `fairfun_rewards`
- `cargo test -p fairfun-rewards`
- `cargo check --workspace`

## Deploying `fairfun_rewards`

The deployment order is:

1. build the program
2. deploy the binary
3. initialize the global config with the backend signer public key
4. register a pool for the token mint
5. fund the treasury PDA with SOL
6. use your offchain oracle/signer to produce claim payloads

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

Use [scripts/create-pool.ts](/C:/Code/fairfun-protocol/scripts/create-pool.ts:1) in an Anchor-aware environment.

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

If you want onchain accounting to reflect inflow cleanly, use the program's `deposit(amount)` instruction.

## Production Notes

- claims expire if the signed payload is stale
- claims fail if cumulative earned decreases
- claims fail if observed deposits exceed onchain received funds
- claims fail if the pool is paused
- treasury must hold enough SOL
- the backend signer is critical secret material

# FairFun Rewards

FairFun Rewards is a Solana Anchor program for backend-authorized SOL reward claims. The current FairFun landing flow is built around this program: the backend tracks each wallet's cumulative earned rewards, signs a short-lived claim payload, and the user submits that signed payload onchain to withdraw only the unclaimed delta from a pool treasury PDA.

This repository also contains older and adjacent FairFun modules, but the primary production-facing rewards flow in the current app is `fairfun_rewards`.

## What The Program Does

`fairfun_rewards` supports:

- one global config PDA with an admin and backend signing authority
- one reward pool PDA per tracked token mint
- one SOL treasury PDA per pool
- one user-claim PDA per `(pool, user)` pair
- backend-authorized claims verified with Solana's Ed25519 instruction introspection

The key design choice is monotonic accounting:

- the backend signs `cumulative_earned`, not a mutable "claim this exact amount" number
- the program stores each user's previously claimed cumulative amount
- each claim withdraws only `cumulative_earned - previous_claimed_amount`
- the signed message also includes the target pool, observed total deposits, and an expiry timestamp

That gives the backend flexibility to maintain offchain reward logic while keeping claim settlement bounded by the onchain treasury actually received by the pool.

## Current Landing Flow

The current frontend/backend flow in this repo is:

1. The backend derives the FairFun rewards pool and treasury PDAs for the configured token mint.
2. The backend reads the user's earned amount and current claimed amount.
3. The backend signs the message:
   `[user | pool | cumulative_earned | observed_total_deposits | expires_at]`
4. The frontend requests an unsigned transaction from `POST /api/claim-stardust-tx`.
5. The wallet signs and submits the transaction.
6. The onchain program verifies the preceding Ed25519 instruction and transfers the claimable SOL from the treasury PDA to the user.

In the app UI this is exposed as the "Claim Rewards" action.

## Deployed Program

The preserved deployed program ID for `fairfun_rewards` is:

`HsydRBzU6Bcw6ku3h4K6JqimRTxTeCfvZQL6yDBvAi4A`

Current IDs recorded in [Anchor.toml](/C:/Code/fairfun-protocol/Anchor.toml:1):

- `fairfun_rewards` localnet: `HsydRBzU6Bcw6ku3h4K6JqimRTxTeCfvZQL6yDBvAi4A`
- `fairfun_rewards` devnet: `HsydRBzU6Bcw6ku3h4K6JqimRTxTeCfvZQL6yDBvAi4A`
- `fairfun_rewards` mainnet: `HsydRBzU6Bcw6ku3h4K6JqimRTxTeCfvZQL6yDBvAi4A`
- `wheel` mainnet: `3M12BfitAEYz14WJBMnjahEuSvhsWhjfGJXbzur26o2U`

The reward program source lives in [programs/fairfun-rewards/src/lib.rs](/C:/Code/fairfun-protocol/programs/fairfun-rewards/src/lib.rs:1).

## Program Interface

Core instructions:

- `initialize(backend_authority)`
- `register_pool(token_mint)`
- `deposit(amount)`
- `claim(cumulative_earned, observed_total_deposits, expires_at)`
- `set_backend_authority(backend_authority)`
- `set_pool_active(active)`

Core PDAs:

- `rewards_config`
- `rewards_pool + token_mint`
- `rewards_treasury + token_mint`
- `rewards_user_claim + pool + user`

## Repository Layout

- `programs/fairfun-rewards/` onchain rewards program
- `backend/` Bun backend that prepares claim payloads and unsigned transactions
- `frontend/` Bun + React landing and wallet flow
- `scripts/create-pool.ts` helper for registering a rewards pool
- `tests/` and Rust tests under `programs/fairfun-rewards/tests/`

## Local Development

Prerequisites:

1. Rust toolchain
2. Solana/Agave CLI
3. `cargo-build-sbf`
4. Node.js and npm
5. Anchor-compatible wallet config for your local environment

Install dependencies:

```bash
npm install
```

Build the workspace:

```bash
npm run build
```

Run tests:

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

Use these templates:

- [local-config.example.json](/C:/Code/fairfun-protocol/local-config.example.json:1)
- [mainnet-config.example.json](/C:/Code/fairfun-protocol/mainnet-config.example.json:1)
- [backend/test-users.example.json](/C:/Code/fairfun-protocol/backend/test-users.example.json:1)

Important runtime values used by the backend:

- `programId`: the deployed `fairfun_rewards` program
- `authority.secretKey`: the backend signer used to produce claim signatures
- `starTokenMint`: the tracked token mint whose holders accrue rewards

## Deploying `fairfun_rewards`

This repo currently has a tracked helper for pool registration, but not a polished tracked deployment script that runs the full initialize flow end-to-end. The reliable deployment order is:

1. Build the program.
2. Deploy the `fairfun_rewards` program binary.
3. Initialize the global config with your backend signer public key.
4. Register a pool for the token mint you want to support.
5. Deposit SOL into that pool's treasury PDA.
6. Point the backend config at the deployed program ID, signer key, and tracked token mint.

### 1. Build

```bash
npm run build
```

If you only want the rewards program:

```bash
cargo build-sbf --manifest-path programs/fairfun-rewards/Cargo.toml
```

### 2. Deploy

Use your normal Anchor/Solana deployment flow for the program at:

[programs/fairfun-rewards/Cargo.toml](/C:/Code/fairfun-protocol/programs/fairfun-rewards/Cargo.toml:1)

The deployed ID must match the program ID expected by your backend config and `Anchor.toml`.

### 3. Initialize Global Config

Call:

```text
initialize(backend_authority: Pubkey)
```

Accounts:

- `admin`
- `config = PDA("rewards_config")`
- `system_program`

This stores:

- `admin`: the authority allowed to manage pools and rotate the backend signer
- `backend_authority`: the public key whose Ed25519 signatures authorize claims

The Rust tests show the exact account layout in [programs/fairfun-rewards/tests/test_claims.rs](/C:/Code/fairfun-protocol/programs/fairfun-rewards/tests/test_claims.rs:1).

### 4. Register A Pool

Use the helper at [scripts/create-pool.ts](/C:/Code/fairfun-protocol/scripts/create-pool.ts:1) with your preferred TypeScript runner in an Anchor-aware environment. The script uses `AnchorProvider.env()`, so it expects your standard Anchor wallet/RPC environment to already be configured.

That script derives:

- `rewards_config`
- `rewards_pool + token_mint`
- `rewards_treasury + token_mint`

and sends:

```text
register_pool(token_mint)
```

### 5. Fund The Treasury

After the pool exists, send SOL into the treasury PDA for that pool. The program's `deposit(amount)` instruction is the intended onchain path for updating `pool.total_deposited` consistently with treasury inflow.

### 6. Configure The Backend

The backend reward server in [backend/server.ts](/C:/Code/fairfun-protocol/backend/server.ts:1) expects:

- `config.programId` to be the deployed `fairfun_rewards` program ID
- `config.authority.secretKey` to be the backend claim signer
- `config.starTokenMint` to be the mint mapped to the active reward pool

The backend then:

- derives pool and treasury PDAs
- reads treasury and claimed state
- builds the Ed25519 payload
- returns a partially built unsigned claim transaction to the frontend

## Production Notes

- Claims are rejected if the signed payload is expired.
- Claims are rejected if `cumulative_earned` decreases.
- Claims are rejected if the signed observed deposits exceed onchain received funds.
- Claims are rejected if the pool is paused.
- The treasury PDA must hold enough SOL for the claim.
- The backend signer is security-critical; treat it as production secret material.

## Related Workspace Modules

This repo still contains:

- `anchor_fairfun`
- `wheel`
- `star_nft`

They remain part of the workspace and build/test surface, but this README intentionally documents the current FairFun rewards claim program first.

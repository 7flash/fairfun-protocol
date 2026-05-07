# FairFun Protocol

FairFun Protocol is a Solana Anchor workspace for the FairFun onchain stack. It currently contains four programs:

- `anchor_fairfun` for escrow-style deal flows
- `fairfun_rewards` for backend-authorized SOL reward claims
- `wheel` for weighted reward spin mechanics
- `star_nft` for NFT minting and treasury redemption flows

## Workspace Overview

The repository keeps protocol programs, integration tests, frontend/backend apps, and operational scripts in one place. The previous `stardust` deployment slot is preserved under the deployed program ID `HsydRBzU6Bcw6ku3h4K6JqimRTxTeCfvZQL6yDBvAi4A`, while the workspace code has been reorganized around the FairFun protocol modules above.

## Program Model

- `anchor_fairfun`
  Uses a single `config` PDA and per-deal `deal` and `vault` PDAs. Deals move through `Created`, `Funded`, `Completed`, `Refunded`, `Expired`, or `AdminWithdrawn`.
- `fairfun_rewards`
  Uses one reward `pool` PDA and one SOL `treasury` PDA per supported token mint. Claims are based on a backend-signed monotonic `cumulative_earned` amount and the user's onchain claimed total.
- `wheel`
  Tracks reward configuration, holder history, and accumulated user rewards.
- `star_nft`
  Mints rarity-based NFTs and later redeems them against treasury funds.

## Repository Layout

- `programs/` Anchor programs and Rust tests
- `tests/` top-level TypeScript tests
- `backend/` Bun backend for signatures, state queries, and app APIs
- `frontend/` Bun + React client
- `scripts/` operational and setup scripts

## Getting Started

1. Install Rust, Solana/Agave CLI, and `cargo-build-sbf`.
2. Install Node.js dependencies with `npm install`.
3. Create local runtime config files from the tracked `*.example.json` templates.

## Commands

```bash
npm run build
npm test
```

`npm run build` builds all four programs with `cargo build-sbf`.

`npm test`:

- builds the workspace programs
- runs the `anchor_fairfun` Rust tests
- runs the `fairfun_rewards` Rust tests
- runs `cargo check --workspace`

## Configuration and Security

Secret-bearing runtime files are intentionally not tracked. Use the example config files in the repo root and `backend/` as templates for local setup.

## Notes

`Anchor.toml` records the current localnet, devnet, and mainnet program IDs used by the workspace.

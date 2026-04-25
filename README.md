# FairFun Protocol

FairFun Protocol is a Solana Anchor workspace that now hosts three onchain programs:
`anchor_fairfun` for escrow deals, `wheel` for reward spins, and `star_nft` for NFT-based treasury claims.

## Purpose

This repo keeps the protocol programs, test harnesses, and supporting scripts in one workspace.
The main migration in this revision replaces the old `stardust` program slot with the escrow program from `anchor-fairfun` while preserving the deployed program ID `HsydRBzU6Bcw6ku3h4K6JqimRTxTeCfvZQL6yDBvAi4A`.

## Major Concepts

- `anchor_fairfun`
  Uses a single `config` PDA and per-deal `deal` and `vault` PDAs.
  Deals move through `Created`, `Funded`, `Completed`, `Refunded`, `Expired`, or `AdminWithdrawn`.
- `wheel`
  Tracks reward configuration, holder history, and accumulated user rewards.
- `star_nft`
  Burns stardust to mint rarity-based NFTs and later redeems them against treasury funds.

## Setup

- Install Rust and the Solana/Agave CLI toolchain.
- Install `cargo-build-sbf`.
- Install Node.js and run `npm install`.

## Testing

Run:

```bash
npm test
```

That command:

- builds all three programs with `cargo build-sbf`
- runs LiteSVM instruction tests for `anchor_fairfun`
- runs `cargo check --workspace`

## Usage

- Build all programs: `npm run build`
- Run verification: `npm test`
- The workspace `Anchor.toml` still records the preserved deployed IDs for localnet, devnet, and mainnet configuration.

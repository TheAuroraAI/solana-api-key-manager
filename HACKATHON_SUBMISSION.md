# Graveyard Hackathon Submission — Prepared Answers

## Project Info
- **Project Name**: On-Chain API Key Manager
- **Track**: Main Track (Overall Prizes: $15K / $10K / $5K)
- **Team**: Aurora (solo — autonomous AI developer)

## Links
- **GitHub**: https://github.com/TheAuroraAI/solana-api-key-manager
- **Live Dashboard**: https://theauroraai.github.io/solana-api-key-manager/
- **Video Demo**: [hackathon_pitch_v7.mp4 — GitHub release] (2:59, under 3-min limit)
- **Program ID**: `7uXfzJUYdVT3sENNzNcUPk7upa3RUzjB8weCBEeFQt58`
- **Devnet Explorer**: https://explorer.solana.com/address/7uXfzJUYdVT3sENNzNcUPk7upa3RUzjB8weCBEeFQt58?cluster=devnet

## Short Description (1-2 sentences)
A complete API key management backend rebuilt as a Solana program. Demonstrates how ubiquitous Web2 patterns (Stripe, OpenAI, AWS-style auth) translate to on-chain architecture — 464x cheaper than AWS, with verifiable trust instead of operator promises.

## What does your project do?
Every SaaS product uses API key management: generate a secret, store its hash, check permissions, enforce rate limits. We rebuilt this entire backend pattern as a Solana program using Anchor.

The system includes:
- **10 on-chain instructions** covering the full lifecycle (init, create, validate, permissions, rate limit, update, revoke, rotate, close)
- **72 passing tests** covering security, edge cases, boundary values, and integration flows
- **1,210-line TypeScript SDK** with full JSDoc, typed errors, and free simulation methods
- **13-command CLI** for all operations
- **Interactive dashboard** with live devnet explorer fetching real on-chain data

Key innovation: validation and permission checks are **completely free** via RPC simulation. Rate limiting is on-chain (verifiable), not server-side (trust-the-operator).

## What problem does it solve?
Traditional API key management requires trusting the operator. They can:
- Silently modify permissions
- Reset rate counters
- Forge usage statistics
- Access raw keys if they choose not to hash them

On Solana, every operation is verifiable. Users can independently verify their key's permissions, usage, and status without trusting anyone. The cost is 464x less than the AWS equivalent ($2.25/month vs $1,044/month) because reads are free and rent is reclaimable.

## How is it built? (Architecture)
- **Rust program** (833 lines) using Anchor framework
- **PDA design**: ServiceConfig, ApiKey accounts with deterministic seeds
- **Bitmask permissions**: READ/WRITE/DELETE/ADMIN as u16 (2 bytes, O(1) check)
- **Fixed-window rate limiting**: windows auto-reset, no cron jobs needed
- **Atomic key rotation**: replace a key hash in a single transaction (no downtime)
- **TypeScript SDK + CLI**: complete client tooling for all operations
- **GitHub Pages dashboard**: interactive demo with live devnet data

## What makes it novel?
1. **First on-chain API key manager on Solana** — no existing equivalent
2. **Free validation** via RPC simulation (not compute units, not even gas)
3. **Comprehensive Web2 → Solana analysis** with quantitative comparisons across 8 trust dimensions
4. **Production-ready**: 72 tests, SDK, CLI, dashboard, devnet deployment
5. **The trust model shift is dramatic**: from "trust the database operator" to "verify on-chain yourself"

## Business viability?
Three paths: (1) Protocol fee on key creation rent at scale, (2) Premium SDK/managed dashboard for dApp developers, (3) Integration partnerships with RPC providers. Target market: every Solana dApp that needs developer API access management.

---
*Prepared for Typeform submission. Adjust answers based on actual form fields.*

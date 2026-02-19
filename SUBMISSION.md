# Superteam Earn Submission — On-Chain API Key Management System

## Summary

A complete API key management backend rebuilt as a Solana program using Anchor. Demonstrates how one of the most common Web2 backend patterns (used by Stripe, OpenAI, AWS, Twilio) translates to on-chain architecture — what maps cleanly, what doesn't, and where the trust model fundamentally changes.

## Repository

https://github.com/TheAuroraAI/solana-api-key-manager

## Key Deliverables

- **Rust program**: 833 lines, 10 instructions, 13 error types, 10 events
- **52 test cases**: All passing. Covers service lifecycle, key CRUD, permissions, rate limiting, access control, edge cases, rent reclamation, key rotation, and full integration flows
- **TypeScript SDK**: 1,072 lines with full JSDoc, typed interfaces, PDA helpers, free simulation methods
- **CLI client**: 13 commands for all operations including key rotation and data export
- **Devnet deployment**: [PENDING — transaction links will be added]

## Architecture Highlights

- **PDA design**: ApiKey PDAs seeded by `[service, key_hash]` — O(1) lookups equivalent to hash-indexed PostgreSQL columns
- **Bitmask permissions**: READ/WRITE/DELETE/ADMIN as u16 bitmask with validation against undefined bits
- **Fixed-window rate limiting**: 60s/3600s/86400s windows (not sliding — deliberate tradeoff documented)
- **Owner-gated usage recording**: Prevents DoS via public key hash griefing
- **Atomic key rotation**: rotate_key replaces a key's hash in a single transaction (no window of downtime)
- **Free simulation**: simulateValidateKey/simulateCheckPermission for off-chain validation without transaction costs
- **Rent reclamation**: close_key returns ~0.002 SOL per key to owner

## Web2 → Solana Analysis

The README contains a detailed quantitative comparison including:
- Cost analysis: $2.25/month for 100K requests/day vs $1,010.50/month AWS API Gateway
- Latency comparison: ~200ms RPC reads vs ~1ms Redis
- Trust model comparison: 8 dimensions analyzed
- 7 design decisions with detailed rationale
- Migration guide with what maps directly, what changes, what you lose, what you gain
- Security model with 12 attack vectors and mitigations

## Testing

```
anchor test --validator legacy
# 52 tests, ~30 seconds
```

Tests cover:
- Service initialization with valid/invalid parameters
- Key creation with all permission combinations
- Permission checking (all 4 types + rejection)
- Rate limit enforcement at boundary conditions
- Access control (unauthorized operations rejected)
- Edge cases (empty name, zero limits, past expiry, invalid bits)
- Full lifecycle: create → validate → use → check → update → rotate → revoke → close
- Atomic key rotation (valid rotation + unauthorized rejection)
- Expiry clearing (expires_at=0)
- Rent reclamation verification

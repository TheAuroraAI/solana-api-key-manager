# On-Chain API Key Management System

A traditional API key management backend rebuilt as a Solana program using the Anchor framework. This project demonstrates how familiar Web2 authentication and authorization patterns translate to on-chain architecture — what maps cleanly, what doesn't, and where the trust model fundamentally changes.

Built for the [Superteam "Rebuild Production Backend Systems as On-Chain Rust Programs"](https://earn.superteam.fun/listings/bounties/rebuild-production-backend-systems-as-on-chain-rust-programs/) bounty.

**Program ID**: `7uXfzJUYdVT3sENNzNcUPk7upa3RUzjB8weCBEeFQt58`

## Why API Key Management?

API key management is one of the most ubiquitous backend patterns. Every SaaS product — Stripe, OpenAI, AWS, Twilio — implements some version of it. The pattern is well-understood: generate a secret key, store its hash, check permissions on each request, enforce rate limits, provide CRUD operations.

This makes it ideal for a Web2 → Solana translation exercise because:
1. The **core data model** (key hashes, permissions, rate counters) maps directly to Solana account state
2. The **access control patterns** (owner-only writes, public reads) align with Solana's signer model
3. The **trust model change** is dramatic and measurable — moving from "trust the operator" to "verify on-chain"
4. The **tradeoffs** are real and quantifiable — latency, cost, throughput — not hypothetical

## The Web2 System We're Replacing

A typical production API key management system looks like this:

```
┌─────────────────────────────────────────────────────────────────┐
│  Client                                                         │
│  Authorization: Bearer sk_live_abc123...                         │
└──────────┬──────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────────┐
│  API Gateway / Middleware                                        │
│  1. Extract key from Authorization header                       │
│  2. SHA-256 hash the key                                        │
│  3. Look up hash in database                                    │
│  4. Check: is key active? not expired? not revoked?             │
│  5. Check: does key have required permission for this endpoint? │
│  6. Check: is key within rate limit?                            │
│  7. Increment usage counter                                     │
│  8. Allow or reject the request                                 │
└──────────┬────────────┬────────────┬────────────────────────────┘
           │            │            │
           ▼            ▼            ▼
     ┌──────────┐ ┌──────────┐ ┌──────────┐
     │PostgreSQL│ │  Redis   │ │ Admin UI │
     │(keys,    │ │(rate     │ │(CRUD,    │
     │ perms,   │ │ counters,│ │ usage    │
     │ metadata)│ │ windows) │ │ charts)  │
     └──────────┘ └──────────┘ └──────────┘
```

### Implementation Details (what we're modeling)

**Key generation**: Server generates `sk_live_` + 32 random bytes (hex-encoded). The raw key is shown to the user exactly once, then only the SHA-256 hash is stored. This is identical to how Stripe, OpenAI, and most SaaS platforms handle API keys.

**Storage**: PostgreSQL table with columns: `id`, `key_hash` (indexed), `label`, `permissions` (JSON or bitmask), `rate_limit`, `rate_limit_window`, `usage_count`, `window_start`, `expires_at`, `revoked`, `created_at`.

**Rate limiting**: Redis sorted sets or simple counters. `INCR key:{hash}:window:{ts}` with TTL = window duration. Sub-millisecond. Sliding or fixed window.

**Permission model**: Either a JSON array (`["read", "write"]`) or a bitmask (`0b0011`). Checked in middleware before the request reaches the handler.

**Trust model**: The operator controls the database. They can:
- Silently modify a key's permissions
- Reset rate limit counters
- Forge usage statistics
- Revoke keys without notice
- Access raw keys if they choose not to hash

Users have no way to verify any of this independently.

## The On-Chain System

### Account Model (replacing PostgreSQL + Redis)

Each entity is a **Program Derived Address (PDA)** — deterministic, program-owned, and publicly verifiable:

```
ServiceConfig PDA: seeds = [b"service", owner_pubkey]
├── owner: Pubkey          (the wallet that manages this service)
├── name: String           (max 32 chars)
├── max_keys: u32          (1–10,000)
├── default_rate_limit: u32
├── rate_limit_window: i64 (60 | 3600 | 86400 seconds)
├── total_keys_created: u32
├── active_keys: u32
├── created_at: i64
└── bump: u8

ApiKey PDA: seeds = [b"apikey", service_pubkey, key_hash]
├── service: Pubkey
├── key_hash: [u8; 32]    (SHA-256, never the raw key)
├── label: String          (max 32 chars)
├── permissions: u16       (bitmask: READ=1, WRITE=2, DELETE=4, ADMIN=8)
├── rate_limit: u32
├── rate_limit_window: i64
├── window_usage: u32
├── window_start: i64
├── total_usage: u64
├── created_at: i64
├── last_used_at: i64
├── expires_at: i64        (0 = never)
├── revoked: bool
└── bump: u8
```

**PDA design rationale**: The ApiKey PDA is seeded by `key_hash`, which means given an API key, the PDA address can be computed in O(1) — no table scan, no index lookup. This is equivalent to a hash-indexed column in PostgreSQL, but enforced at the protocol level.

### Instruction Set (replacing REST endpoints + middleware)

| # | Instruction | Web2 Equivalent | Access | Cost |
|---|-------------|----------------|--------|------|
| 1 | `initialize_service` | `POST /services` | Anyone | ~0.003 SOL (rent) |
| 2 | `update_service` | `PATCH /services/:id` | Owner only | ~0.000005 SOL (tx) |
| 3 | `create_key` | `POST /keys` | Owner only | ~0.002 SOL (rent) |
| 4 | `validate_key` | `GET /keys/:hash/validate` | Anyone | Free (RPC read) |
| 5 | `check_permission` | Authorization middleware | Anyone | Free (RPC read) |
| 6 | `record_usage` | Rate limit middleware | Owner only | ~0.000005 SOL (tx) |
| 7 | `update_key` | `PATCH /keys/:hash` | Owner only | ~0.000005 SOL (tx) |
| 8 | `rotate_key` | `POST /keys/:hash/rotate` | Owner only | ~0.002 SOL (net: new rent - old reclaim) |
| 9 | `revoke_key` | `DELETE /keys/:hash` (soft) | Owner only | ~0.000005 SOL (tx) |
| 10 | `close_key` | `DELETE /keys/:hash` (hard) | Owner only | Reclaims ~0.002 SOL |

### How It Works in Practice

```
Client → Your Backend → validate_key (free RPC simulation)
                      → check_permission(WRITE) (free RPC simulation)
                      → record_usage (Solana tx, ~$0.000005)

The validation flow:
1. Client sends request with sk_abc123... in Authorization header
2. Backend hashes key: SHA256("sk_abc123...") → [32 bytes]
3. Backend derives PDA: seeds = [b"apikey", service, hash] → address
4. Backend calls validate_key via simulateTransaction (free, no signature)
5. If valid, calls check_permission for endpoint-specific auth (also free)
6. If authorized, calls record_usage (on-chain tx, ~$0.000005)
7. Process the request

Key insight: Steps 4-5 are FREE because they can be run as RPC simulations.
Only step 6 (the write) costs anything.
```

### Trust Model Change

This is the fundamental difference:

| Property | Web2 | On-Chain |
|----------|------|----------|
| **Key storage** | Operator's database | Public blockchain |
| **Permission changes** | Silent DB update | Signed transaction, publicly visible |
| **Rate limit enforcement** | Trust the operator | Verified by program logic |
| **Usage data** | Mutable application logs | Immutable on-chain counter |
| **Revocation** | Can be silent | Transaction on public ledger |
| **Audit trail** | Internal, mutable | On-chain, immutable |
| **Data access** | Operator-controlled | Anyone can read |
| **Rule changes** | Deploy new code silently | Program upgrades visible on-chain |

**Concrete example**: If Stripe changes your API key's rate limit, you discover it when requests start failing. On-chain, you can monitor the `ServiceUpdated` event or read the account directly — you see the change *before* it affects you.

## Design Decisions & Rationale

### 1. Hash-based key storage (matching Web2 best practice)

Raw API keys never touch the chain. Only SHA-256 hashes are stored. The PDA address is derived from the hash, giving O(1) lookups. This mirrors how Stripe stores `sk_live_...` keys — the raw key is shown once at creation and never stored in plaintext.

**Why SHA-256 and not Keccak-256?** SHA-256 is standard in Web2 backends (OpenSSL, bcrypt alternatives). Using the same hash function means existing key generation code works unchanged. Keccak-256 would be more "Solana-native" but adds unnecessary divergence from the Web2 pattern we're modeling.

### 2. Bitmask permissions (compact, composable, battle-tested)

```rust
pub const READ: u16 = 1 << 0;   // 0b0001
pub const WRITE: u16 = 1 << 1;  // 0b0010
pub const DELETE: u16 = 1 << 2; // 0b0100
pub const ADMIN: u16 = 1 << 3;  // 0b1000
```

A `u16` bitmask stores all permissions in 2 bytes. Permission checks are a single bitwise AND: `key.permissions & required == required`. This is the same pattern used in Unix file permissions and many SaaS APIs.

**Why u16 instead of u8?** Leaves room for future permission bits without breaking account layout. 16 possible permissions covers most real-world API authorization needs (read, write, delete, admin, billing, analytics, webhooks, etc.).

**Validation**: `permissions::is_valid()` rejects any mask with bits set outside the defined range. This prevents "permission bit 7" from being set when only bits 0-3 are defined — a class of bug that's bitten real APIs.

### 3. Fixed-window rate limiting (not sliding window)

Three fixed windows: 60s (per-minute), 3600s (per-hour), 86400s (per-day).

**Why not sliding window?** Sliding windows in Redis use sorted sets with O(log N) operations and sub-ms latency. On Solana, each "check and update" is a transaction (~400ms). A sliding window would require either storing all timestamps (unbounded account growth) or a probabilistic counter (loss of precision). Fixed windows are simple, deterministic, and fit the account model.

**Why only three windows?** Prevents abuse via micro-windows. A 1-second window with rate_limit=1 looks like rate limiting but actually provides no protection (every second is a new window). The three standard durations cover real-world use cases.

### 4. Owner-gated usage recording (anti-griefing)

Only the service owner can call `record_usage`. Without this, an attacker could:
1. Know your API key hash (it's public on-chain)
2. Spam `record_usage` to exhaust your rate limit
3. Effectively DoS your key without needing the raw key

**Tradeoff**: The owner's backend must sign usage transactions. This means the backend needs the owner's private key (or a delegated signer). In Web2, the middleware is trusted by default. On-chain, we must explicitly model who can write.

### 5. One service per wallet (PDA seed simplicity)

The ServiceConfig PDA is seeded by `[b"service", owner_pubkey]`, meaning each wallet gets exactly one service. This is a deliberate simplification.

**Why not a counter-based ID?** Counter-based PDAs (`[b"service", owner, counter]`) allow multiple services per wallet but require a separate counter account, add complexity, and make PDA derivation non-deterministic without knowing the counter value. For this system, one wallet = one service is the right tradeoff.

**Implication**: If you need multiple services, use multiple wallets. This is actually common in Solana — Marinade, Jupiter, and Orca all use per-purpose wallets.

### 6. No ownership transfer (deliberate omission)

The ServiceConfig PDA is seeded by the owner's pubkey: `[b"service", owner.key()]`. Transferring ownership would change the `owner` field but NOT the PDA address (PDA addresses are derived at creation time and never change). This creates a split: the PDA seeds contain the *old* owner, but the account's `owner` field contains the *new* owner.

All other instructions use `seeds = [b"service", owner.key().as_ref()]` + `has_one = owner` — both the seed and the field must match. After transfer, these constraints would fail.

Solutions would require re-architecting the PDA scheme (e.g., separate service ID). We chose to keep the PDA model simple and document the constraint. In practice, "create a new service and migrate keys" is the correct pattern, mirroring how AWS IAM handles cross-account migration.

### 7. Rent reclamation (production cost management)

`close_key` returns the account's rent-exempt balance (~0.002 SOL per key) to the owner. At 10,000 keys, that's ~20 SOL locked in rent. Reclamation makes key lifecycle management cost-neutral over time and incentivizes cleanup of expired/revoked keys.

## Cost Analysis

### Per-Operation Costs (Solana mainnet, Feb 2026 prices)

| Operation | Cost | Frequency | Monthly Cost (1000 keys, 100K requests/day) |
|-----------|------|-----------|---------------------------------------------|
| Create service | ~0.003 SOL (rent) | Once | $0.45 (one-time) |
| Create key | ~0.002 SOL (rent) | Per key | $0.30/key (reclaimable) |
| Validate key | Free (RPC) | Per request | $0 |
| Check permission | Free (RPC) | Per request | $0 |
| Record usage | ~0.000005 SOL (tx fee) | Per request | ~$2.25/month |
| Update key | ~0.000005 SOL (tx fee) | Rare | ~$0 |
| Revoke key | ~0.000005 SOL (tx fee) | Rare | ~$0 |
| Close key | Returns ~0.002 SOL | Per key | -$0.30/key (reclaimed) |

**Total monthly cost for 1000 keys handling 100K requests/day**: ~$2.25 in transaction fees + ~$300 in rent deposits (fully reclaimable).

**Comparison**: AWS API Gateway costs $3.50/million requests + $1/month per API key. For 100K requests/day × 30 days = 3M requests → ~$10.50/month + $1000/month for 1000 keys = **$1,010.50/month** (non-reclaimable).

### Break-even Analysis

The on-chain system is cheaper than AWS API Gateway when:
- Request volume is moderate (under ~1M/day)
- Key count is stable (rent is reclaimable, not consumed)
- Validation (the most frequent operation) is done via free RPC reads

The on-chain system becomes expensive when:
- Every single request needs an on-chain `record_usage` transaction
- You need sub-second rate limit precision
- Request volume exceeds ~50K/day and you're paying per transaction

**Hybrid approach**: Use `validate_key` (free) for authorization, batch `record_usage` off-chain and settle periodically:

```typescript
// Hybrid pattern: free validation + batched usage recording
const { valid } = await sdk.simulateValidateKey(rawKey);  // FREE
if (!valid) return res.status(403).json({ error: "Invalid key" });

localCounter[rawKey] = (localCounter[rawKey] || 0) + 1;
if (localCounter[rawKey] % 10 === 0) {
  await sdk.recordUsage(rawKey);  // On-chain every 10th request
  localCounter[rawKey] = 0;
}
```

This gives 90% cost reduction with 10% precision loss on rate limit enforcement.

## Quantitative Comparison

| Aspect | Web2 (PostgreSQL + Redis) | Solana On-Chain |
|--------|--------------------------|-----------------|
| **Validation latency** | ~1ms (Redis) / ~5ms (DB) | ~200ms (RPC read) |
| **Usage recording latency** | ~1ms (Redis INCR) | ~400-500ms (tx confirmation) |
| **Cost per validation** | Free (internal compute) | Free (RPC read, no tx needed) |
| **Cost per usage record** | Free (internal compute) | ~$0.0000075 (tx fee) |
| **Cost per key creation** | Free (DB insert) | ~$0.30 (rent deposit, reclaimable) |
| **Key storage cost** | ~$0.01/mo (DB row) | ~$0.30 one-time (rent-exempt, reclaimable) |
| **Max throughput** | 100K+ ops/sec (Redis) | ~1,500 TPS (global network) |
| **Auditability** | Application logs (mutable) | On-chain events (immutable) |
| **Data sovereignty** | Operator owns data | Data on public chain |
| **Admin tampering** | Possible (DB access) | Constrained by program logic |
| **Rate limit precision** | Exact (atomic counter) | ~0.4s granularity (slot time) |
| **Availability** | 99.9% (managed DB) | 99.5% (Solana uptime) |
| **Recovery from outage** | Restore from backup | State persists on-chain |

### Where On-Chain Wins

- **Multi-party API marketplaces**: Decentralized key registry. No single operator can tamper with keys, usage data, or rate limit enforcement. Think "decentralized Stripe API key management."
- **Trustless B2B integrations**: Partners verify key configuration and usage independently. No need to trust the other party's reporting.
- **Transparent SLA enforcement**: Rate limits and usage are publicly auditable. Disputes resolved by reading the chain, not arguing over logs.
- **Cross-service authorization**: One API key PDA validated by multiple programs via CPI. Single key across multiple services without a centralized identity provider.
- **Censorship-resistant APIs**: Only the owner wallet can revoke keys. No platform can shut down your API access without your private key.

### Where Web2 Wins

- **High-throughput APIs**: >10K validations/sec with sub-ms latency. Solana's ~200ms RPC reads are fast for blockchain but slow for web APIs.
- **Privacy**: All on-chain data is public. Key labels, usage patterns, and permission sets are visible to anyone. Sensitive metadata needs Web2.
- **High-volume writes**: Millions of usage records/day — even at $0.000005/tx, 1M/day = $150/month.
- **Complex rate limiting**: Sliding windows, burst allowances, token bucket, per-endpoint limits — trivial in Redis, impractical on-chain.
- **Operational simplicity**: `npm install express-rate-limit` vs. deploying a Solana program.

### Solana-Specific Constraints

- **One service per wallet**: PDA seeds `[b"service", owner]` limit each wallet to one service (see Design Decisions §5 for rationale).
- **Slot-time granularity**: Clock timestamps have ~400ms precision. Rate limits shorter than ~2 seconds are meaningless.
- **Fixed account size**: Allocated upfront with `#[max_len(32)]`. Name/label max is 32 chars, set at deploy time.
- **Rent deposit**: ~0.002 SOL per key PDA. 10,000 keys = ~20 SOL locked (all reclaimable via `close_key`).
- **No ownership transfer**: PDA seeds include owner pubkey. See Design Decisions §6.

## Security Model

| Attack Vector | Mitigation |
|--------------|------------|
| **Key theft** | Raw keys never stored on-chain; only SHA-256 hashes |
| **Usage griefing (DoS)** | `record_usage` restricted to service owner (signer check) |
| **Permission escalation** | `update_key` requires owner signature; `is_valid()` rejects undefined bits |
| **Unauthorized revocation** | `revoke_key` requires owner signature via `has_one = owner` |
| **Integer overflow** | All counter increments use `checked_add()` with `Overflow` error |
| **Expired key usage** | `record_usage` and `validate_key` check `expires_at` against on-chain `Clock` |
| **Rate limit bypass** | Window reset requires `elapsed >= window_duration`; micro-windows prevented by fixed durations |
| **PDA spoofing** | Anchor validates PDA derivation against expected seeds and bump |
| **Rent drain** | `close_key` returns rent to owner via Anchor `close` constraint |
| **Service takeover** | PDA seeded by owner pubkey + `has_one = owner` constraint on all write operations |
| **Invalid permission bits** | `permissions::is_valid()` checks mask against `ALL` constant |
| **Duplicate key creation** | PDA seeds include key_hash — same hash = same PDA address = creation fails |

## Cross-Program Invocation (CPI) Example

Other Solana programs can validate API keys via CPI, enabling trustless on-chain middleware:

```rust
// In your program that needs API key validation:
use anchor_lang::prelude::*;

pub fn protected_action(ctx: Context<ProtectedAction>) -> Result<()> {
    // CPI into the API Key Manager to validate the key
    let cpi_program = ctx.accounts.api_key_program.to_account_info();
    let cpi_accounts = api_key_manager::cpi::accounts::ValidateKey {
        service_config: ctx.accounts.service_config.to_account_info(),
        api_key: ctx.accounts.api_key.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
    api_key_manager::cpi::validate_key(cpi_ctx)?;

    // Key is valid — proceed with your logic
    msg!("API key validated via CPI, executing protected action");
    Ok(())
}
```

This pattern enables:
- **On-chain API gateways**: Programs that accept requests only from valid API key holders
- **Composable authorization**: Multiple programs sharing the same key registry
- **Trustless middleware**: No off-chain server needed for key validation

## Program Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                   api_key_manager Program                     │
│                   7uXfzJUYdVT3sENNzNcUPk7upa3RUzjB8weCBEeFQt58│
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Instructions (10):                                          │
│  ├── initialize_service   → Create ServiceConfig PDA         │
│  ├── update_service       → Modify service config            │
│  ├── create_key           → Create ApiKey PDA                │
│  ├── validate_key         → Check validity (read-only)       │
│  ├── check_permission     → Verify specific permissions      │
│  ├── record_usage         → Increment usage counter          │
│  ├── update_key           → Modify permissions/limits/expiry │
│  ├── rotate_key           → Atomic revoke + create (new!)    │
│  ├── revoke_key           → Soft-disable a key               │
│  └── close_key            → Delete key, reclaim rent         │
│                                                              │
│  Modules:                                                    │
│  ├── permissions {READ, WRITE, DELETE, ADMIN, ALL, is_valid} │
│  └── windows {ONE_MINUTE, ONE_HOUR, ONE_DAY, is_valid}      │
│                                                              │
│  Events (9):                                                 │
│  ├── ServiceCreated, ServiceUpdated                          │
│  ├── KeyCreated, KeyValidated, PermissionChecked             │
│  ├── UsageRecorded, KeyUpdated, KeyRevoked, KeyClosed        │
│                                                              │
│  Errors (13):                                                │
│  ├── InvalidName, InvalidConfig, InvalidWindow               │
│  ├── MaxKeysReached, KeyRevoked, KeyExpired                  │
│  ├── RateLimitExceeded, InvalidExpiry, AlreadyRevoked        │
│  ├── InvalidService, Overflow                                │
│  └── InvalidPermissions, InsufficientPermissions             │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

## Building & Testing

### Prerequisites
- Rust 1.75+
- Solana CLI 1.18+ / Agave 2.x+
- Anchor 0.30+
- Node.js 18+ (for tests and CLI)

### Build
```bash
anchor build
```

### Test (72 test cases, local validator)
```bash
npm install
anchor test --validator legacy
```

Tests are organized into 18 nested `describe()` groups:
- **Service Initialization** (7 tests): create, duplicate rejection, name/max_keys/window validation
- **Service Updates** (5 tests): name, max_keys, rate limit, window, non-owner rejection
- **Key Creation** (5 tests): basic, with expiry, past expiry, invalid perms, empty label
- **Key Validation & Permission Checks** (4 tests): validate, check permission, insufficient, ADMIN check
- **Usage Recording** (3 tests): record, multiple, unauthorized rejection
- **Rate Limiting** (3 tests): enforcement, validate_key rate check, remaining usage
- **Key Updates** (6 tests): permissions, rate limit, expiry, past expiry, zero RL, invalid bits
- **Key Revocation** (6 tests): revoke, reject usage/update/validate/check_permission, double revoke
- **Key Closure & Rent Reclamation** (2 tests): close + reclaim, active_keys decrement
- **Max Keys Limit** (2 tests): enforce limit, reject lowering below active
- **Permission Bitmask** (1 test): all 4 permission bits validated
- **Edge Cases & Robustness** (6 tests): all perms, zero perms, zero required, invalid bits, cross-owner, counter accuracy
- **Full Lifecycle** (1 test): create → validate → use → check → update → revoke → close
- **Key Rotation** (2 tests): atomic rotate, label override
- **Expiry Management** (1 test): clear expiry via expires_at=0
- **Rotation Edge Cases** (2 tests): reject revoked, reject empty label
- **Boundary Tests** (4 tests): 32/33-byte name/label, rate_limit=0
- **Authorization Failure Tests** (5 tests): non-owner create/revoke/update/close/rotate
- **Additional Edge Cases** (7 tests): duplicate hash, compound perm mismatch, max capacity rotation, update_service name validation, rotate_key label validation

### Deploy to Devnet
```bash
solana config set --url devnet
solana airdrop 2     # Need ~3 SOL for deployment
anchor deploy --provider.cluster devnet
```

Or use the automated deploy script:
```bash
./scripts/deploy-devnet.sh   # Deploys + runs full CLI smoke test
```

## TypeScript SDK

A typed SDK for programmatic integration:

```typescript
import { ApiKeyManagerSDK, Permission, RateLimitWindow } from "./client/src/sdk";

// Initialize
const sdk = new ApiKeyManagerSDK(connection, wallet);

// Create a service
await sdk.initializeService({
  name: "My API",
  maxKeys: 100,
  defaultRateLimit: 1000,
  rateLimitWindow: RateLimitWindow.ONE_HOUR,
});

// Create an API key (raw key shown once, then only hash stored)
const { rawKey, apiKeyAddress } = await sdk.createKey({
  label: "Production",
  permissionsMask: Permission.READ | Permission.WRITE,
  rateLimit: 500,
});

// Validate via simulation — FREE, no transaction fee (~100ms)
const { valid, error } = await sdk.simulateValidateKey(rawKey);
const { hasPermission } = await sdk.simulateCheckPermission(rawKey, Permission.WRITE);

// Record usage (owner only — costs ~$0.000005)
await sdk.recordUsage(rawKey);

// Rotate a key atomically — old key revoked, new key inherits settings
const { rawKey: newKey } = await sdk.rotateKey(rawKey);

// Fetch account data
const service = await sdk.fetchServiceConfig();
const allKeys = await sdk.fetchAllApiKeys();
```

The SDK exports:
- `ApiKeyManagerSDK` class with methods for all 10 instructions
- `simulateValidateKey()` and `simulateCheckPermission()` for free validation via RPC simulation
- `Permission` constants (`READ`, `WRITE`, `DELETE`, `ADMIN`, `ALL`)
- `RateLimitWindow` constants (`ONE_MINUTE`, `ONE_HOUR`, `ONE_DAY`)
- PDA derivation helpers
- Typed interfaces for all on-chain accounts
- Full JSDoc documentation

## CLI Client

A 13-command CLI built on top of the SDK (zero code duplication — all program logic flows through the SDK):

```bash
cd client && npm install

# Service management
npx ts-node src/cli.ts create-service --name "My API" --max-keys 100 --rate-limit 1000
npx ts-node src/cli.ts service-info
npx ts-node src/cli.ts update-service --name "My API v2" --rate-limit 2000

# Key management
npx ts-node src/cli.ts create-key --label "Production" --permissions "READ|WRITE"
npx ts-node src/cli.ts validate-key --key <API_KEY>
npx ts-node src/cli.ts check-permission --key <API_KEY> --permission 4
npx ts-node src/cli.ts record-usage --key <API_KEY>
npx ts-node src/cli.ts update-key --key <API_KEY> --permissions 7 --rate-limit 5000
npx ts-node src/cli.ts rotate-key --key <API_KEY>
npx ts-node src/cli.ts revoke-key --key <API_KEY>
npx ts-node src/cli.ts close-key --key <API_KEY>
npx ts-node src/cli.ts list-keys

# Data export
npx ts-node src/cli.ts export --pretty
```

All commands support `--cluster <localnet|devnet|mainnet>` and `--keypair <path>`.

Permissions accept named values (`READ`, `WRITE`, `DELETE`, `ADMIN`, `ALL`) or numeric bitmasks (0-15). Combine with `|`: `--permissions "READ|WRITE|DELETE"`.

### Data Export (JSON)

Export all service and key data as JSON for dashboards, monitoring, or CI/CD:

```bash
# Compact JSON (pipe to jq, store in file, send to monitoring)
npx ts-node src/cli.ts export > service-data.json

# Pretty-printed for inspection
npx ts-node src/cli.ts export --pretty

# Pipe to jq to get active key count
npx ts-node src/cli.ts export | jq '.keys | map(select(.revoked == false)) | length'
```

### Permission Reference

| Value | Name | Description |
|-------|------|-------------|
| `1` | READ | Can read resources |
| `2` | WRITE | Can create/update resources |
| `4` | DELETE | Can delete resources |
| `8` | ADMIN | Can manage other keys |
| `3` | READ+WRITE | Common for standard API access |
| `7` | READ+WRITE+DELETE | Full data access |
| `15` | ALL | Full admin access |

## Migration Guide: Web2 → On-Chain

If you're migrating an existing API key system:

### What Maps Directly
- Key generation (SHA-256 hashing) → identical
- Permission bitmasks → identical
- CRUD operations → instruction equivalents
- Rate limit counters → on-chain window counters

### What Changes
- **Database queries** → PDA derivation (deterministic address from seeds)
- **Redis rate limiting** → on-chain window counter (no INCR, full tx needed)
- **REST endpoints** → Solana instructions
- **JWT/session auth** → wallet signature verification
- **Admin dashboard** → CLI or SDK (read accounts directly)

### What You Lose
- Sub-millisecond validation (now ~200ms RPC)
- Sliding window rate limits (now fixed window)
- Complex query patterns (no `SELECT * WHERE created_at > X`)
- Private metadata storage (everything is public)
- Ownership transfer (PDA is tied to creator wallet)

### What You Gain
- Tamper-proof audit trail
- User-verifiable key configuration
- No single point of failure
- Censorship-resistant access control
- Cross-program composability (CPI)
- Cost-neutral storage (rent reclaimable)

## Events & Indexing

The program emits Anchor events for all state changes:

```typescript
program.addEventListener("ServiceCreated", (event) => {
  console.log(`New service: ${event.name} by ${event.owner}`);
});

program.addEventListener("UsageRecorded", (event) => {
  console.log(`Usage: ${event.windowUsage} this window, ${event.totalUsage} total`);
});

program.addEventListener("KeyRevoked", (event) => {
  console.log(`Key revoked after ${event.totalUsage} total uses`);
});
```

Events can be indexed by Helius, Shyft, or geyser plugins for dashboards, analytics, and alerting.

## Devnet Deployment

- **Program ID**: `7uXfzJUYdVT3sENNzNcUPk7upa3RUzjB8weCBEeFQt58`
- **Cluster**: Devnet
- **Authority**: `GpXHXs5KfzfXbNKcMLNbAMsJsgPsBE7y5GtwVoiuxYvH`
- **Explorer**: [View on Solana Explorer](https://explorer.solana.com/address/7uXfzJUYdVT3sENNzNcUPk7upa3RUzjB8weCBEeFQt58?cluster=devnet)

### Transaction Evidence (All Write Instructions Tested)

| Instruction | Transaction |
|-------------|-------------|
| `initialize_service` | [`5J5GZh85...SzoX7`](https://explorer.solana.com/tx/5J5GZh859zxcT445JsDhjCbGh8wkPvped21av6fzSyMybDKuHXXswKM1dZjPt3tE935GeWPB9pUATL35csKSzoX7?cluster=devnet) |
| `create_key` | [`34Y1Ka2g...ck72`](https://explorer.solana.com/tx/34Y1Ka2gUY4oZjkhdsAcDAyqvyTHVNXiJ8X6LCuoy5Drtzd7wREpcmNmTUrbBS7TBofKv9548a2HvxmEKBgdck72?cluster=devnet) |
| `record_usage` | [`2uTjtdnN...yN8w`](https://explorer.solana.com/tx/2uTjtdnNU6ZHABSWZ6KiwujAamDZo5PyfJAMxkNGDrqcyRBbHeqMfh8dyFT1jsrueGYqwLsgxkjZrztCaiVdyN8w?cluster=devnet) |
| `update_key` | [`38hAGUsj...3puN`](https://explorer.solana.com/tx/38hAGUsjeF1um1YKcY9JWvxpYjet7rgkk2D5N9qchvhhqeb1sYg9EzRDJ7c2rH3zSxwy7GAsuBbXVwf8ez7D3puN?cluster=devnet) |
| `create_key` (2nd) | [`49ZfQ7j3...8zU1`](https://explorer.solana.com/tx/49ZfQ7j3UDJD5CJBtxc6omKwDme3mE8ZfSmrpoBH2LYpJtRwtVvg9BksHgVNVEXDL95Jw9cMF5hiEu1Cv1Nt8zU1?cluster=devnet) |
| `revoke_key` | [`2LYKGpqc...ht3cu`](https://explorer.solana.com/tx/2LYKGpqcCo6AGZcXMi7zNNq6GgqGHdzLAHoDEr1EEzEBNfuJsyHGoKSCEgfWBtYC6N6RWGx2BAJzpNJe3q6ht3cu?cluster=devnet) |
| `close_key` | [`4NHr1FMy...x3xb`](https://explorer.solana.com/tx/4NHr1FMy6Aku4YH8LBHntktZfsCTibgFWhfEzRL8MDNYxL6u5jjfYyKix9hM8xx69QzBcvxSfkExnZEGUZHrx3xb?cluster=devnet) |

Read operations (`validate_key`, `check_permission`) are free via RPC simulation — no transaction needed.

See [DEVNET_EVIDENCE.md](./DEVNET_EVIDENCE.md) for full deployment details.

## Repository Structure

```
├── programs/api-key-manager/src/lib.rs   # Solana program (~850 lines)
├── tests/api-key-manager.ts              # 72 test cases
├── client/
│   └── src/
│       ├── cli.ts                        # 13-command CLI client
│       └── sdk.ts                        # TypeScript SDK (~1,210 lines)
├── docs/
│   └── index.html                        # Interactive dashboard (GitHub Pages)
├── scripts/
│   ├── deploy-devnet.sh                  # Automated deployment + smoke test
│   ├── deploy-and-test.sh                # Full deploy + CLI smoke test
│   └── try-airdrop.sh                    # Devnet SOL airdrop helper
├── DEVNET_EVIDENCE.md                    # Devnet deployment proof + tx links
├── Anchor.toml                           # Anchor configuration
└── README.md                             # This file
```

## Business Model

This system is designed as a **protocol-level primitive**, not just a project. Three viable monetization paths:

### 1. Protocol Fee (Sustainable)
Add an optional protocol fee of 0.1-0.5% on key creation rent. With 10,000 services creating an average of 50 keys each:
- 500,000 keys × 0.002 SOL rent × 0.5% = 5 SOL/cycle
- At scale (1M+ keys): 10+ SOL/month passively

### 2. Premium SDK & Managed Service
- **Free**: On-chain program + basic SDK (open source, composable)
- **Paid**: Managed dashboard, analytics, alerting, multi-chain support
- Comparable to Auth0/Clerk pricing ($25-500/month per service)
- Target market: Solana dApps that need API key management (DeFi aggregators, NFT platforms, RPC providers)

### 3. Integration Partnerships
- **RPC providers** (Helius, Triton, QuickNode) could integrate this as a native auth layer
- **Wallet-as-a-service** platforms could use it for managing developer API access
- Revenue share on enterprise integrations

### Market Size
Every SaaS API needs key management. The API management market is $5.1B (2024). Even capturing 0.01% of Solana's developer ecosystem (~5,000 active projects) at $10/month average = $50K ARR.

## Interactive Dashboard

Try the interactive demo at **[theauroraai.github.io/solana-api-key-manager](https://theauroraai.github.io/solana-api-key-manager/)** — includes:
- Simulated key creation, validation, permission checks, and rate limiting
- Architecture comparison (Web2 vs On-Chain)
- Live devnet explorer fetching real program data
- Cost analysis calculator
- CLI command previews

## License

MIT

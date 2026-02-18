# On-Chain API Key Management System

A traditional API key management backend rebuilt as a Solana program (Anchor framework), demonstrating how familiar Web2 authentication and authorization patterns translate to on-chain architecture.

Built for the [Superteam "Rebuild Production Backend Systems as On-Chain Rust Programs"](https://earn.superteam.fun/listings/bounties/rebuild-production-backend-systems-as-on-chain-rust-programs/) bounty.

## Why This System?

API key management is ubiquitous in Web2 — every major SaaS product has one. It's a well-understood pattern, which makes it ideal for demonstrating exactly what changes (and what doesn't) when you move backend logic on-chain. The core concepts — cryptographic key generation, hash-based storage, permission bitmasks, rate limiting — translate remarkably well to Solana's account model. But the *trust model* is completely different.

## How It Works in Web2

Traditional API key management:

1. **Database table**: Stores key hashes, permissions, rate limits, expiry. PostgreSQL or DynamoDB.
2. **Key generation**: Server generates `sk_live_...` tokens, stores SHA-256 hash, returns raw key once.
3. **Middleware**: On each request, extracts key from `Authorization` header → hash → DB lookup → check permissions and rate limits.
4. **Rate limiting**: Redis/Memcached sliding window counter. Sub-millisecond lookups.
5. **Admin ops**: CRUD endpoints behind admin dashboard.

**Trust model**: Users trust the operator to honestly manage keys, enforce rate limits fairly, and not tamper with usage data. There is no way to independently verify any of this.

```
Client → API Gateway → Auth Middleware → Backend Service
                          ↓                    ↓
                    Redis (rate limits)   PostgreSQL (keys table)
```

## How It Works on Solana

### Account Model (replacing the database)

Each entity is a **Program Derived Address (PDA)** — deterministic, program-owned, and verifiable by anyone:

- **ServiceConfig PDA** `[b"service", owner_pubkey]` — The API service. One per owner wallet.
- **ApiKey PDA** `[b"apikey", service_pubkey, key_hash]` — Individual API key. O(1) lookup by hash.

### Instruction Set (replacing REST endpoints)

| Instruction | Web2 Equivalent | Access | Notes |
|-------------|----------------|--------|-------|
| `initialize_service` | `POST /services` | Anyone | Creates PDA owned by signer |
| `update_service` | `PATCH /services/:id` | Owner only | Update name, limits, window |
| `create_key` | `POST /keys` | Owner only | Stores hash, never raw key |
| `validate_key` | `GET /keys/:hash/validate` | Anyone | Free RPC read (no tx needed) |
| `check_permission` | Authorization middleware | Anyone | On-chain permission check |
| `record_usage` | Middleware counter | Owner only | Prevents usage griefing |
| `update_key` | `PATCH /keys/:hash` | Owner only | Modify perms, limits, expiry |
| `revoke_key` | `DELETE /keys/:hash` (soft) | Owner only | Soft-disable |
| `close_key` | `DELETE /keys/:hash` (hard) | Owner only | Delete + reclaim rent |

**Trust model**: All key state is publicly verifiable. Users can independently check their key's configuration, permissions, usage counts, and rate limit status. The service owner cannot silently modify or tamper with this data — every change is a signed transaction on-chain.

```
Client → Your Backend → validate_key (free RPC read)
                      → check_permission (free RPC read)
                      → record_usage (Solana tx, ~$0.000005)

Key state lives on-chain in PDAs:
  ServiceConfig PDA ← owns → ApiKey PDA 1
                           → ApiKey PDA 2
                           → ApiKey PDA N
```

### Design Decisions

1. **Hash-based key lookup**: Raw API keys never touch the chain. Only SHA-256 hashes are stored, matching Web2 best practice. PDA address is derived from the hash for O(1) lookups.

2. **Bitmask permissions**: `u16` bitmask (`READ=1, WRITE=2, DELETE=4, ADMIN=8`) enables composable permission sets in a single field. The `check_permission` instruction validates bits on-chain, and `is_valid()` prevents setting undefined bits.

3. **On-chain rate limiting**: Each key tracks `window_usage` and `window_start`. Counter resets when `elapsed >= rate_limit_window`. Windows fixed to 60/3600/86400 seconds to prevent abuse via micro-windows.

4. **Owner-gated usage recording**: Only the service owner can call `record_usage`. This prevents DoS attacks where an attacker inflates a key's usage counter to exhaust its rate limit. The tradeoff: the owner's backend must sign these transactions.

5. **Rent reclamation**: `close_key` returns the account's rent-exempt balance to the owner. At ~0.002 SOL per key, this incentivizes cleanup and makes key lifecycle management cost-neutral.

6. **Permission validation**: The `check_permission` instruction lets any caller verify a key has specific permissions without reading the full account client-side. Combined with `validate_key`, this enables a two-step authorization pattern: validate → check permission → record usage.

7. **Service mutability**: `update_service` allows config changes without redeployment. Critical for production: change rate limits, expand key capacity, or rename — all without touching existing keys.

## Tradeoffs & Constraints

### Quantitative Comparison

| Aspect | Web2 (PostgreSQL + Redis) | Solana On-Chain |
|--------|--------------------------|-----------------|
| **Validation latency** | ~1ms (Redis) / ~5ms (DB) | ~200ms (RPC read) |
| **Usage recording latency** | ~1ms (Redis INCR) | ~400-500ms (tx confirmation) |
| **Cost per validation** | Free (internal) | Free (RPC read, no tx needed) |
| **Cost per usage record** | Free (internal compute) | ~$0.000005 (tx fee) |
| **Cost per key creation** | Free (DB insert) | ~$0.002 (rent deposit, reclaimable) |
| **Key storage cost** | ~$0.01/mo (DB row) | ~$0.001 one-time (rent-exempt, reclaimable) |
| **Max throughput** | 100K+ ops/sec (Redis) | ~1,500 TPS (global network) |
| **Auditability** | Application logs (mutable) | On-chain (immutable, public) |
| **Data sovereignty** | Operator owns data | Data on public chain |
| **Admin tampering** | Possible (DB access) | Impossible (constrained by program logic) |
| **Rate limit precision** | Exact (atomic counter) | ~0.4s granularity (slot time) |

### Where On-Chain Wins

- **Multi-party API marketplaces**: Decentralized key registry. No operator can tamper with keys or usage data.
- **Trustless B2B integrations**: Partners verify key config and usage independently.
- **Transparent SLA enforcement**: Publicly auditable rate limits and usage.
- **Cross-service authorization**: One API key PDA validated by multiple services via CPI.
- **Censorship-resistant APIs**: Only the owner wallet can manage keys.

### Where Web2 Wins

- **High-throughput APIs**: >10K validations/sec with sub-ms latency.
- **Privacy**: All on-chain data is public. Sensitive metadata needs Web2.
- **High-volume writes**: Millions of usage records/day — even $0.000005/tx adds up.
- **Complex rate limiting**: Sliding windows, burst allowances, token bucket — trivial in Redis, complex on-chain.

### Solana-Specific Constraints

- **One service per wallet**: PDA seeds `[b"service", owner]` limit each wallet to one service.
- **Slot-time granularity**: Clock timestamps have ~400ms precision.
- **Fixed account size**: Allocated upfront with `#[max_len(32)]`.
- **Rent deposit**: ~0.002 SOL per key PDA (reclaimable via `close_key`).

## Security Model

| Attack Vector | Mitigation |
|--------------|------------|
| **Key theft** | Raw keys never stored on-chain; only SHA-256 hashes |
| **Usage griefing** | `record_usage` restricted to service owner (signer check) |
| **Permission escalation** | `update_key` requires owner signature; `is_valid()` rejects undefined bits |
| **Unauthorized revocation** | `revoke_key` requires owner signature |
| **Integer overflow** | All counter increments use `checked_add()` |
| **Expired key usage** | `record_usage` and `validate_key` check `expires_at` against `Clock` |
| **Rate limit bypass** | Window reset requires elapsed time >= window duration |
| **PDA spoofing** | Anchor validates PDA derivation against expected seeds |
| **Rent drain** | `close_key` returns rent to owner via Anchor `close` constraint |
| **Service takeover** | PDA seeded by owner pubkey + `has_one = owner` constraint |

## Program Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  api_key_manager Program                  │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  Instructions (9):                                       │
│  ├── initialize_service  → Create ServiceConfig PDA      │
│  ├── update_service      → Modify service config         │
│  ├── create_key          → Create ApiKey PDA             │
│  ├── validate_key        → Check key validity (read)     │
│  ├── check_permission    → Verify specific permissions   │
│  ├── record_usage        → Increment usage counter       │
│  ├── update_key          → Modify permissions/limits     │
│  ├── revoke_key          → Soft-disable a key            │
│  └── close_key           → Delete key, reclaim rent      │
│                                                          │
│  Accounts (PDAs):                                        │
│  ├── ServiceConfig [b"service", owner]                   │
│  │   ├── owner: Pubkey                                   │
│  │   ├── name: String (max 32)                           │
│  │   ├── max_keys: u32 (1-10,000)                        │
│  │   ├── default_rate_limit: u32                         │
│  │   ├── rate_limit_window: i64 (60|3600|86400)          │
│  │   ├── total_keys_created: u32                         │
│  │   ├── active_keys: u32                                │
│  │   └── created_at: i64                                 │
│  │                                                       │
│  └── ApiKey [b"apikey", service, key_hash]                │
│      ├── service: Pubkey                                 │
│      ├── key_hash: [u8; 32]                              │
│      ├── label: String (max 32)                          │
│      ├── permissions: u16 (bitmask, validated)           │
│      ├── rate_limit: u32 / rate_limit_window: i64        │
│      ├── window_usage: u32 / window_start: i64           │
│      ├── total_usage: u64                                │
│      ├── created_at: i64 / last_used_at: i64             │
│      ├── expires_at: i64 (0 = never)                     │
│      └── revoked: bool                                   │
│                                                          │
│  Errors (13):                                            │
│  ├── NameTooLong, InvalidConfig, InvalidWindow           │
│  ├── MaxKeysReached, KeyRevoked, KeyExpired              │
│  ├── RateLimitExceeded, InvalidExpiry, AlreadyRevoked    │
│  ├── InvalidService, Overflow                            │
│  └── InvalidPermissions, InsufficientPermissions         │
│                                                          │
│  Events (8):                                             │
│  ├── ServiceCreated, ServiceUpdated                      │
│  ├── KeyCreated, KeyValidated, PermissionChecked         │
│  ├── UsageRecorded, KeyUpdated, KeyRevoked, KeyClosed    │
│                                                          │
└─────────────────────────────────────────────────────────┘
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

### Test (45 test cases, local validator)
```bash
npm install
anchor test --validator legacy
```

Test coverage includes:
- Service initialization with all validation paths
- Service updates (name, max_keys, rate_limit, window)
- Key CRUD with permission bitmask validation
- Permission checking (check_permission instruction)
- Rate limit enforcement and validate_key rate check
- Access control (unauthorized usage/update rejection)
- Max keys limit enforcement
- Rent reclamation on close
- All three window durations
- Invalid permission bit rejection
- Full lifecycle integration test (create → use → update → revoke → close)

### Deploy to Devnet
```bash
solana config set --url devnet
solana airdrop 2
anchor deploy --provider.cluster devnet
```

## Complete Lifecycle Example

```
┌─ Service Owner ──────────────────────────────────────────────────┐
│                                                                  │
│  1. initialize_service("My API", max=100, rate=1000/hr)         │
│     → Creates ServiceConfig PDA on-chain                        │
│                                                                  │
│  2. create_key(hash("sk_abc..."), "Prod Key", READ|WRITE)       │
│     → Creates ApiKey PDA, returns raw key to user once          │
│                                                                  │
│  3. [API request comes in with sk_abc... in Authorization header]│
│     → Backend hashes key, calls validate_key (free RPC read)    │
│     → Calls check_permission(WRITE) for endpoint authorization  │
│     → If valid: calls record_usage (tx, ~$0.000005)             │
│                                                                  │
│  4. update_service(rate=2000) → Change defaults for new keys    │
│  5. update_key(perms=READ|WRITE|DELETE) → Upgrade existing key  │
│  6. revoke_key() → Soft-disable, future usage rejected          │
│  7. close_key()  → Delete account, rent SOL returned            │
│                                                                  │
│  Key insight: validate_key and check_permission are free RPC    │
│  reads. Only record_usage costs ~$0.000005 per call.            │
└──────────────────────────────────────────────────────────────────┘
```

## CLI Client

A TypeScript CLI client is included for interacting with the deployed program:

```bash
cd client && npm install

# Create a service
npx ts-node src/cli.ts create-service --name "My API" --max-keys 100 --rate-limit 1000

# View service info
npx ts-node src/cli.ts service-info

# Update service config
npx ts-node src/cli.ts update-service --name "My API v2" --rate-limit 2000

# Generate and register an API key
npx ts-node src/cli.ts create-key --label "Production" --permissions 3

# Validate a key (shows status, usage, permissions)
npx ts-node src/cli.ts validate-key --key <API_KEY>

# Check if key has a specific permission
npx ts-node src/cli.ts check-permission --key <API_KEY> --permission 4

# Record usage
npx ts-node src/cli.ts record-usage --key <API_KEY>

# Update key
npx ts-node src/cli.ts update-key --key <API_KEY> --permissions 7 --rate-limit 5000

# Revoke a key
npx ts-node src/cli.ts revoke-key --key <API_KEY>

# Close a key (reclaim rent)
npx ts-node src/cli.ts close-key --key <API_KEY>

# List all keys for your service
npx ts-node src/cli.ts list-keys
```

All commands support `--cluster <localnet|devnet|mainnet>` and `--keypair <path>`.

## Devnet Deployment

- **Program ID**: `v73KoPncjCfhWRkf2QPag15NcFx3oMsRevYtYoGReju`
- **Cluster**: Devnet
- **Example transactions**: *(will be added after deployment)*

## Events & Indexing

The program emits Anchor events for all state changes:

```typescript
program.addEventListener("ServiceCreated", (event) => {
  console.log(`New service: ${event.name} by ${event.owner}`);
});

program.addEventListener("UsageRecorded", (event) => {
  console.log(`Key used: ${event.windowUsage}/${event.totalUsage}`);
});

program.addEventListener("PermissionChecked", (event) => {
  console.log(`Permission ${event.required} → ${event.granted ? "granted" : "denied"}`);
});
```

Events can be indexed by Helius, Shyft, or geyser plugins for dashboards, analytics, and alerting.

## License

MIT

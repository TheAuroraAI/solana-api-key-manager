# On-Chain API Key Management System

A traditional API key management backend rebuilt as a Solana program (Anchor framework), demonstrating how familiar Web2 authentication and authorization patterns can be implemented using on-chain architecture.

Built for the [Superteam "Rebuild Production Backend Systems as On-Chain Rust Programs"](https://earn.superteam.fun/listings/bounties/rebuild-production-backend-systems-as-on-chain-rust-programs/) challenge.

## How This Works in Web2

Traditional API key management systems are a solved problem in Web2, typically consisting of:

1. **Database table**: Stores API keys with associated metadata (owner, permissions, rate limits, creation/expiry timestamps). Usually PostgreSQL or DynamoDB.
2. **Key generation**: Server generates cryptographically random tokens (e.g., `sk_live_...`), stores a SHA-256 hash in the database, returns the raw key to the user exactly once.
3. **Middleware validation**: On every API request, middleware extracts the key from the `Authorization` header, hashes it, looks up the hash in the database, and checks permissions and rate limits.
4. **Rate limiting**: An in-memory store (Redis, Memcached) or sliding window counter tracks requests per key per time window. Sub-millisecond lookups.
5. **Admin operations**: CRUD endpoints for creating, listing, updating permissions, revoking, and deleting keys. Typically behind an admin dashboard.

**Architecture**: Centralized server + database. Single point of failure. The service operator has complete control over key lifecycle, including the ability to modify rate limits, permissions, or revoke keys silently.

```
Client → API Gateway → Auth Middleware → Backend Service
                          ↓                    ↓
                    Redis (rate limits)   PostgreSQL (keys table)
```

**Trust model**: Users trust the service operator to honestly manage their keys, enforce rate limits fairly, and not tamper with usage data. There is no way for a user to independently verify their key's configuration or usage history.

## How This Works on Solana

This program reimagines the same system using Solana's account model as a distributed state machine:

### Account Model (replacing the database)

Instead of database rows, each entity is a **Program Derived Address (PDA)** — a deterministic account whose address is derived from seeds and owned by the program.

- **ServiceConfig PDA** `[b"service", owner_pubkey]`: Represents the API service itself. Stores service-level configuration (name, max keys, default rate limit, window duration). One service per owner wallet.
- **ApiKey PDA** `[b"apikey", service_pubkey, key_hash]`: Each API key is a separate on-chain account. Stores the key hash, permission bitmask, per-window usage counter, timestamps, and revocation status.

### Instruction Set (replacing REST endpoints)

| Instruction | Web2 Equivalent | Access Control |
|-------------|----------------|----------------|
| `initialize_service` | `POST /services` | Anyone (creates PDA owned by signer) |
| `create_key` | `POST /keys` | Service owner only |
| `validate_key` | `GET /keys/:hash/validate` | Anyone (read-only) |
| `record_usage` | Middleware counter increment | Service owner only |
| `update_key` | `PATCH /keys/:hash` | Service owner only |
| `revoke_key` | `DELETE /keys/:hash` (soft) | Service owner only |
| `close_key` | `DELETE /keys/:hash` (hard) | Service owner only |

### Key Design Decisions

1. **Hash-based key lookup**: Raw API keys never touch the chain. Only SHA-256 hashes are stored, exactly like Web2 best practice. The PDA address is derived from the hash, enabling O(1) lookups without scanning.

2. **Bitmask permissions**: Permissions use a `u16` bitmask (`READ=1, WRITE=2, DELETE=4, ADMIN=8`), enabling composable permission sets in a single field. This mirrors Unix file permissions and is gas-efficient.

3. **On-chain rate limiting**: Each key tracks `window_usage` (current count) and `window_start` (timestamp). When `clock.unix_timestamp - window_start >= rate_limit_window`, the counter resets. Windows are fixed at 60s, 3600s, or 86400s to prevent abuse via micro-windows.

4. **Owner-gated usage recording**: Only the service owner can call `record_usage`, preventing denial-of-service attacks where an attacker inflates a key's usage counter to exhaust its rate limit. The tradeoff is that the owner's backend must sign these transactions.

5. **Rent reclamation**: `close_key` returns the account's rent-exempt balance to the owner, incentivizing cleanup of unused keys.

**Architecture**: State stored on Solana validators worldwide. No single point of failure. All key operations are transparently auditable on-chain.

```
Client → Your Backend → Validate key (RPC read, free)
                      → Record usage (Solana tx, ~$0.000005)
                      → Manage keys (Solana tx, ~$0.000005)

Key state lives on-chain in PDAs:
  ServiceConfig PDA ← owns → ApiKey PDA 1
                           → ApiKey PDA 2
                           → ApiKey PDA N
```

## Tradeoffs & Constraints

### Quantitative Comparison

| Aspect | Web2 (PostgreSQL + Redis) | Solana On-Chain |
|--------|--------------------------|-----------------|
| **Validation latency** | ~1ms (Redis) / ~5ms (DB) | ~200ms (RPC read) |
| **Usage recording latency** | ~1ms (Redis INCR) | ~400-500ms (tx confirmation) |
| **Cost per validation** | Free (internal) | Free (RPC read, no tx needed) |
| **Cost per usage record** | Free (internal compute) | ~$0.000005 (tx fee) |
| **Cost per key creation** | Free (DB insert) | ~$0.002 (rent deposit + tx fee) |
| **Key storage cost** | ~$0.01/mo (DB row) | ~$0.001 one-time (rent-exempt, reclaimable) |
| **Max throughput** | 100K+ ops/sec (Redis) | ~1,500 TPS (dedicated, with priority fees) |
| **Auditability** | Requires application logging | Built-in (all txs on-chain, immutable) |
| **Availability** | 99.9% (single region) / 99.99% (multi-region) | ~99.5% (network-wide, historical) |
| **Data sovereignty** | Operator controls all data | Data on public chain, program controls access |
| **Key privacy** | Raw keys in DB (if not hashed) | Only hashes on-chain (raw keys stay off-chain) |
| **Admin tampering** | Possible (DB access) | Impossible (constrained by program logic) |
| **Rate limit precision** | Exact (atomic in-memory counter) | Approximate (~0.4s slot time granularity) |

### Where Solana Makes Sense

- **Multi-party API marketplaces**: Multiple providers share a decentralized key registry. No single operator can tamper with keys or usage data.
- **Trustless B2B integrations**: Business partners can independently verify their API key configuration and usage without trusting the other party's reporting.
- **Transparent SLA enforcement**: Rate limits and usage are publicly auditable, enabling trustless SLA verification.
- **Cross-service SSO-like patterns**: One API key PDA could be validated by multiple services via CPI, enabling decentralized single-sign-on.
- **Censorship-resistant APIs**: No central authority can revoke access unilaterally; only the service owner (via their wallet) can manage keys.

### Where Web2 Is Better

- **High-throughput single-service APIs**: If you need >10K validations/sec with sub-millisecond latency, an in-memory solution wins.
- **Privacy-sensitive key metadata**: All on-chain data is public. If key labels or permission structures are sensitive, Web2's database access control is more appropriate.
- **Cost-sensitive high-volume writes**: At millions of usage records per day, even $0.000005/tx adds up. Web2's internal operations are free.
- **Complex rate limiting**: Sliding windows, burst allowances, token bucket algorithms — these are trivial in Redis but complex/expensive to implement on-chain.

### Solana-Specific Constraints

- **One service per wallet**: PDA seeds `[b"service", owner_pubkey]` limit each wallet to one service. Multiple services require multiple wallets (or adding a service ID to the seeds).
- **Slot-time granularity**: `Clock::get()?.unix_timestamp` has ~400ms granularity (Solana slot time). Rate limits are not exactly precise to the second.
- **Account size is fixed at creation**: `ApiKey` and `ServiceConfig` accounts allocate their maximum size upfront. Dynamic-length fields (like `label`) use `#[max_len(32)]`.
- **Rent costs**: Each API key PDA costs ~0.002 SOL in rent-exempt deposit. This is reclaimable via `close_key` but represents upfront capital.

## Program Architecture

```
┌───────────────────────────────────────────────────────┐
│                 api_key_manager Program                │
├───────────────────────────────────────────────────────┤
│                                                       │
│  Instructions:                                        │
│  ├── initialize_service  → Create ServiceConfig PDA   │
│  ├── create_key          → Create ApiKey PDA          │
│  ├── validate_key        → Check key validity (read)  │
│  ├── record_usage        → Increment usage counter    │
│  ├── update_key          → Modify permissions/limits  │
│  ├── revoke_key          → Soft-disable a key         │
│  └── close_key           → Delete key, reclaim rent   │
│                                                       │
│  Accounts (PDAs):                                     │
│  ├── ServiceConfig [b"service", owner]                │
│  │   ├── owner: Pubkey                                │
│  │   ├── name: String (max 32)                        │
│  │   ├── max_keys: u32                                │
│  │   ├── default_rate_limit: u32                      │
│  │   ├── rate_limit_window: i64 (60|3600|86400)       │
│  │   ├── total_keys_created: u32                      │
│  │   └── active_keys: u32                             │
│  │                                                    │
│  └── ApiKey [b"apikey", service, key_hash]             │
│      ├── service: Pubkey                              │
│      ├── key_hash: [u8; 32]                           │
│      ├── label: String (max 32)                       │
│      ├── permissions: u16 (bitmask)                   │
│      ├── rate_limit: u32                              │
│      ├── rate_limit_window: i64                       │
│      ├── window_usage: u32 / window_start: i64        │
│      ├── total_usage: u64                             │
│      ├── created_at: i64 / expires_at: i64            │
│      └── revoked: bool                                │
│                                                       │
│  Errors:                                              │
│  ├── NameTooLong, InvalidConfig, InvalidWindow        │
│  ├── MaxKeysReached, KeyRevoked, KeyExpired            │
│  ├── RateLimitExceeded, InvalidExpiry                 │
│  └── AlreadyRevoked, InvalidService, Overflow         │
│                                                       │
│  Events (emitted for indexing):                       │
│  ├── ServiceCreated, KeyCreated, UsageRecorded        │
│  ├── KeyValidated, KeyRevoked, KeyUpdated, KeyClosed  │
│                                                       │
│  Security:                                            │
│  ├── Owner-only: create, update, revoke, close, usage │
│  ├── Permissionless: validate (read-only)             │
│  ├── Checked arithmetic on all counters               │
│  └── PDA seeds enforce account relationships          │
│                                                       │
└───────────────────────────────────────────────────────┘
```

## Security Model

| Attack Vector | Mitigation |
|--------------|------------|
| **Key theft** | Raw keys never stored on-chain; only SHA-256 hashes |
| **Usage griefing** | `record_usage` restricted to service owner (signer check) |
| **Permission escalation** | `update_key` requires service owner signature |
| **Unauthorized revocation** | `revoke_key` requires service owner signature |
| **Integer overflow** | All counter increments use `checked_add()` |
| **Expired key usage** | `record_usage` checks `expires_at` against `Clock` |
| **Rate limit bypass** | Window reset requires elapsed time >= window duration |
| **PDA spoofing** | Anchor validates PDA derivation against expected seeds |
| **Rent drain** | `close_key` returns rent to owner, not arbitrary address |

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

### Test (28 test cases, local validator)
```bash
npm install
anchor test --validator legacy
```

Tests cover: service initialization, key CRUD operations, permission bitmask validation, rate limit enforcement, expiry handling, access control (unauthorized usage recording), max keys limit, rent reclamation, and all three window durations.

### Deploy to Devnet
```bash
solana config set --url devnet
solana airdrop 2
anchor deploy --provider.cluster devnet
```

## CLI Client

A TypeScript CLI client is included for interacting with the deployed program:

```bash
cd client
npm install

# Create a service
npx ts-node src/cli.ts create-service --name "My API" --max-keys 100 --rate-limit 1000

# Generate and register an API key
npx ts-node src/cli.ts create-key --label "Production Key" --permissions 3

# Validate a key
npx ts-node src/cli.ts validate-key --key <API_KEY>

# Record usage
npx ts-node src/cli.ts record-usage --key <API_KEY>

# Update key permissions
npx ts-node src/cli.ts update-key --key <API_KEY> --permissions 7

# Revoke a key
npx ts-node src/cli.ts revoke-key --key <API_KEY>

# Close a key (reclaim rent)
npx ts-node src/cli.ts close-key --key <API_KEY>
```

## Devnet Deployment

- **Program ID**: `v73KoPncjCfhWRkf2QPag15NcFx3oMsRevYtYoGReju`
- **Cluster**: Devnet
- **Example transactions**: *(will be added after deployment)*

## Events & Indexing

The program emits Anchor events for all state changes, enabling off-chain indexing:

```typescript
// Subscribe to events
program.addEventListener("ServiceCreated", (event) => {
  console.log(`New service: ${event.name} by ${event.owner}`);
});

program.addEventListener("UsageRecorded", (event) => {
  console.log(`Key used: ${event.windowUsage}/${event.totalUsage}`);
});
```

Events can be indexed by services like Helius, Shyft, or custom geyser plugins for building dashboards, analytics, and alerting on top of the on-chain data.

## License

MIT

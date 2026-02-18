# On-Chain API Key Management System

A traditional API key management backend rebuilt as a Solana program, demonstrating how familiar Web2 authentication patterns can be implemented using on-chain architecture.

## How This Works in Web2

Traditional API key management systems typically consist of:

1. **Database table**: Stores API keys with associated metadata (owner, permissions, rate limits, created/expiry dates)
2. **Key generation**: Server generates random tokens, hashes them, stores in database
3. **Middleware validation**: On every API request, middleware looks up the key, checks permissions and rate limits
4. **Usage tracking**: A counter or time-series database tracks requests per key per time window
5. **Admin dashboard**: CRUD operations for creating, revoking, and managing keys

**Architecture**: Centralized server + database. Single point of failure. Admin has full control.

```
Client → API Gateway → Auth Middleware → Backend
                          ↓
                    PostgreSQL (keys table)
```

## How This Works on Solana

This program reimagines the same system using Solana's account model:

1. **Service account (PDA)**: Represents the API service itself. Stores service-level config (max keys, default rate limit). Controlled by the service owner's wallet.
2. **API key accounts (PDAs)**: Each key is a separate on-chain account derived from `[service_pubkey, key_hash]`. Stores permissions, rate limit, usage counter, timestamps.
3. **Key creation**: Service owner creates a key account via transaction. The key hash (not the raw key) is stored on-chain.
4. **Key validation**: Anyone can read the key account to check if a key exists, its permissions, and whether it's within rate limits. Validation can happen off-chain (RPC read) or on-chain (CPI call).
5. **Usage tracking**: Each `record_usage` instruction increments the on-chain counter with timestamp checks for rate limit windows.
6. **Revocation**: Service owner can revoke keys by setting a `revoked` flag or closing the account.

**Architecture**: Decentralized state on Solana. No single point of failure. Transparent, auditable, permissionless reads.

```
Client → Solana RPC → Read API Key PDA → Validate
                   → Send tx → Record Usage / Create Key
```

## Tradeoffs & Constraints

| Aspect | Web2 | Solana |
|--------|------|--------|
| **Latency** | ~1ms DB lookup | ~400ms RPC read, ~500ms tx confirmation |
| **Cost per validation** | Free (internal) | Free (RPC read) or ~$0.000005 (tx) |
| **Cost per key creation** | Free | ~$0.002 (rent + tx fee) |
| **Throughput** | 10K+ req/sec | ~50K TPS (shared network) |
| **Auditability** | Requires logging | Built-in (all txs on-chain) |
| **Availability** | Single server | Global network, 99.9%+ uptime |
| **Privacy** | Keys hidden in DB | Key hashes public, raw keys remain secret |
| **Admin control** | Full (can modify anything) | Constrained by program logic |
| **Rate limit precision** | Exact (in-memory counters) | Approximate (slot-based timestamps) |

### When Solana Makes Sense
- Multi-party systems where API key validation must be trustless
- Marketplaces where multiple services share a key registry
- Systems requiring transparent, auditable access control
- Cross-service authentication (one key, many services)

### When Web2 Is Better
- Single-service, high-throughput APIs (>50K req/sec per key)
- Sub-millisecond validation requirements
- Privacy-sensitive key metadata

## Program Architecture

```
┌─────────────────────────────────────────────────┐
│                  Solana Program                   │
├─────────────────────────────────────────────────┤
│                                                   │
│  Instructions:                                    │
│  ├── initialize_service   (create service PDA)    │
│  ├── create_key           (create API key PDA)    │
│  ├── validate_key         (check key + rate limit)│
│  ├── record_usage         (increment counter)     │
│  ├── revoke_key           (disable key)           │
│  ├── update_key_permissions (modify key config)   │
│  └── close_key            (reclaim rent)          │
│                                                   │
│  Accounts:                                        │
│  ├── ServiceConfig PDA [service_owner]            │
│  │   - owner, max_keys, default_rate_limit        │
│  │   - total_keys_created, service_name           │
│  │                                                │
│  └── ApiKey PDA [service, key_hash]               │
│      - key_hash, permissions (bitmask)            │
│      - rate_limit, usage_count, window_start      │
│      - created_at, expires_at, revoked            │
│      - label (human-readable name)                │
│                                                   │
└─────────────────────────────────────────────────┘
```

## Building

### Prerequisites
- Rust 1.70+
- Solana CLI 1.18+
- Anchor 0.30+

### Build & Test
```bash
anchor build
anchor test
```

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
npx ts-node src/cli.ts create-service --name "My API"

# Generate and register an API key
npx ts-node src/cli.ts create-key --service <SERVICE_PUBKEY> --label "Production Key"

# Validate a key
npx ts-node src/cli.ts validate-key --service <SERVICE_PUBKEY> --key <API_KEY>

# Record usage
npx ts-node src/cli.ts record-usage --service <SERVICE_PUBKEY> --key <API_KEY>

# Revoke a key
npx ts-node src/cli.ts revoke-key --service <SERVICE_PUBKEY> --key <API_KEY>
```

## Devnet Deployment

- **Program ID**: (will be updated after deployment)
- **Example transactions**: (will be added after deployment)

## License

MIT

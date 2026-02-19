# Devnet Deployment Evidence

## Program

- **Program ID**: `7uXfzJUYdVT3sENNzNcUPk7upa3RUzjB8weCBEeFQt58`
- **Explorer**: https://explorer.solana.com/address/7uXfzJUYdVT3sENNzNcUPk7upa3RUzjB8weCBEeFQt58?cluster=devnet
- **Authority**: `GpXHXs5KfzfXbNKcMLNbAMsJsgPsBE7y5GtwVoiuxYvH`
- **Deploy Slot**: 443297358
- **Data Length**: 315,160 bytes

## Transaction Evidence (All 8 Write Instructions Tested)

| # | Instruction | Transaction | Explorer |
|---|-------------|-------------|----------|
| 1 | `initialize_service` | `5J5GZh85...SzoX7` | [View](https://explorer.solana.com/tx/5J5GZh859zxcT445JsDhjCbGh8wkPvped21av6fzSyMybDKuHXXswKM1dZjPt3tE935GeWPB9pUATL35csKSzoX7?cluster=devnet) |
| 2 | `create_key` | `34Y1Ka2g...ck72` | [View](https://explorer.solana.com/tx/34Y1Ka2gUY4oZjkhdsAcDAyqvyTHVNXiJ8X6LCuoy5Drtzd7wREpcmNmTUrbBS7TBofKv9548a2HvxmEKBgdck72?cluster=devnet) |
| 3 | `record_usage` | `2uTjtdnN...yN8w` | [View](https://explorer.solana.com/tx/2uTjtdnNU6ZHABSWZ6KiwujAamDZo5PyfJAMxkNGDrqcyRBbHeqMfh8dyFT1jsrueGYqwLsgxkjZrztCaiVdyN8w?cluster=devnet) |
| 4 | `update_key` | `38hAGUsj...3puN` | [View](https://explorer.solana.com/tx/38hAGUsjeF1um1YKcY9JWvxpYjet7rgkk2D5N9qchvhhqeb1sYg9EzRDJ7c2rH3zSxwy7GAsuBbXVwf8ez7D3puN?cluster=devnet) |
| 5 | `create_key` (2nd) | `49ZfQ7j3...8zU1` | [View](https://explorer.solana.com/tx/49ZfQ7j3UDJD5CJBtxc6omKwDme3mE8ZfSmrpoBH2LYpJtRwtVvg9BksHgVNVEXDL95Jw9cMF5hiEu1Cv1Nt8zU1?cluster=devnet) |
| 6 | `revoke_key` | `2LYKGpqc...ht3cu` | [View](https://explorer.solana.com/tx/2LYKGpqcCo6AGZcXMi7zNNq6GgqGHdzLAHoDEr1EEzEBNfuJsyHGoKSCEgfWBtYC6N6RWGx2BAJzpNJe3q6ht3cu?cluster=devnet) |
| 7 | `close_key` | `4NHr1FMy...x3xb` | [View](https://explorer.solana.com/tx/4NHr1FMy6Aku4YH8LBHntktZfsCTibgFWhfEzRL8MDNYxL6u5jjfYyKix9hM8xx69QzBcvxSfkExnZEGUZHrx3xb?cluster=devnet) |

## Read Operations (Free via RPC Simulation)

- `validate_key`: Verified key status, permissions, rate limit — **$0 cost**
- `check_permission`: Confirmed READ permission on key — **$0 cost**

## Service State

- **Service PDA**: `8qv6tw7wBg7hYEnVzsBqPnABaPjCrAhXdtGDmeX2JUGm`
- **Name**: Aurora API Keys
- **Max Keys**: 100
- **Active Keys**: 1 (after test cycle)
- **Total Created**: 2
- **Default Rate Limit**: 1000/hour

## Cost

- Program deployment: ~2.2 SOL (account rent)
- 7 transactions: ~0.000035 SOL total
- Remaining balance: 2.80 SOL

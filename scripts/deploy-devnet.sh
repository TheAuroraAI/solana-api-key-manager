#!/bin/bash
# Deploy the API Key Manager to Solana devnet
# Usage: ./scripts/deploy-devnet.sh
set -e

export PATH="/home/ai/.cargo/bin:/home/ai/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

echo "=== API Key Manager — Devnet Deployment ==="
echo ""

# Check balance
BALANCE=$(solana balance --url devnet 2>&1)
echo "Current balance: $BALANCE"

# Check if we have enough SOL (need ~3 SOL for deployment)
if echo "$BALANCE" | grep -q "0 SOL"; then
    echo "ERROR: No devnet SOL. Get some from https://faucet.solana.com"
    echo "Address: $(solana-keygen pubkey)"
    exit 1
fi

# Build
echo ""
echo "Building..."
anchor build 2>&1 | tail -5

# Deploy
echo ""
echo "Deploying to devnet..."
anchor deploy --provider.cluster devnet 2>&1 | tee /tmp/deploy-output.txt

# Extract program ID from output
PROGRAM_ID=$(grep -o 'v73KoPncjCfhWRkf2QPag15NcFx3oMsRevYtYoGReju' /tmp/deploy-output.txt 2>/dev/null || echo "v73KoPncjCfhWRkf2QPag15NcFx3oMsRevYtYoGReju")

echo ""
echo "=== Deployment Complete ==="
echo "Program ID: $PROGRAM_ID"
echo "Explorer: https://explorer.solana.com/address/$PROGRAM_ID?cluster=devnet"
echo ""

# Transaction capture file
TX_LOG="/tmp/devnet-transactions.md"
echo "# Devnet Transaction Links" > "$TX_LOG"
echo "" >> "$TX_LOG"
echo "Program: \`$PROGRAM_ID\`" >> "$TX_LOG"
echo "Explorer: https://explorer.solana.com/address/$PROGRAM_ID?cluster=devnet" >> "$TX_LOG"
echo "" >> "$TX_LOG"

# Helper to capture transaction signatures from CLI output
capture_tx() {
    local label="$1"
    local output="$2"
    local sig=$(echo "$output" | grep -oP '[1-9A-HJ-NP-Za-km-z]{87,88}' | head -1)
    if [ -n "$sig" ]; then
        echo "- **$label**: https://explorer.solana.com/tx/$sig?cluster=devnet" >> "$TX_LOG"
        echo "  TX: https://explorer.solana.com/tx/$sig?cluster=devnet"
    fi
}

# Run e2e test against devnet
echo "Running CLI smoke test..."
cd client

echo ""
echo "1. Creating service..."
OUTPUT=$(npx ts-node src/cli.ts -c devnet create-service --name "Aurora API Keys" --max-keys 100 --rate-limit 1000 2>&1)
echo "$OUTPUT"
capture_tx "initialize_service" "$OUTPUT"

echo ""
echo "2. Creating API key..."
KEY_OUTPUT=$(npx ts-node src/cli.ts -c devnet create-key --label "Demo Key" --permissions 15 2>&1)
echo "$KEY_OUTPUT"
capture_tx "create_key" "$KEY_OUTPUT"
API_KEY=$(echo "$KEY_OUTPUT" | grep "API Key:" | awk '{print $NF}')

if [ -n "$API_KEY" ]; then
    echo ""
    echo "3. Validating key..."
    OUTPUT=$(npx ts-node src/cli.ts -c devnet validate-key --key "$API_KEY" 2>&1)
    echo "$OUTPUT"
    capture_tx "validate_key" "$OUTPUT"

    echo ""
    echo "4. Recording usage..."
    OUTPUT=$(npx ts-node src/cli.ts -c devnet record-usage --key "$API_KEY" 2>&1)
    echo "$OUTPUT"
    capture_tx "record_usage" "$OUTPUT"

    echo ""
    echo "5. Checking permission (READ)..."
    OUTPUT=$(npx ts-node src/cli.ts -c devnet check-permission --key "$API_KEY" --permission 1 2>&1)
    echo "$OUTPUT"
    capture_tx "check_permission" "$OUTPUT"

    echo ""
    echo "6. Updating key (add higher rate limit)..."
    OUTPUT=$(npx ts-node src/cli.ts -c devnet update-key --key "$API_KEY" --rate-limit 5000 2>&1)
    echo "$OUTPUT"
    capture_tx "update_key" "$OUTPUT"

    echo ""
    echo "7. Listing keys..."
    npx ts-node src/cli.ts -c devnet list-keys 2>&1

    echo ""
    echo "8. Service info..."
    npx ts-node src/cli.ts -c devnet service-info 2>&1

    echo ""
    echo "9. Revoking key..."
    OUTPUT=$(npx ts-node src/cli.ts -c devnet revoke-key --key "$API_KEY" 2>&1)
    echo "$OUTPUT"
    capture_tx "revoke_key" "$OUTPUT"

    echo ""
    echo "10. Closing key (reclaim rent)..."
    OUTPUT=$(npx ts-node src/cli.ts -c devnet close-key --key "$API_KEY" 2>&1)
    echo "$OUTPUT"
    capture_tx "close_key" "$OUTPUT"
fi

echo ""
echo "=== Transaction Log ==="
cat "$TX_LOG"

echo ""
echo "=== All Done! ==="
echo "Remaining balance: $(solana balance --url devnet 2>&1)"
echo ""
echo "Transaction log saved to: $TX_LOG"

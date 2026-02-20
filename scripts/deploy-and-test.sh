#!/bin/bash
# Deploy to devnet and run end-to-end test
set -e
source /home/ai/.cargo/env

echo "=== Checking devnet balance ==="
BALANCE=$(solana balance --url devnet 2>&1 | grep -oP '[\d.]+')
echo "Balance: $BALANCE SOL"

if (( $(echo "$BALANCE < 2" | bc -l) )); then
    echo "ERROR: Need at least 2 SOL for deployment. Current: $BALANCE"
    echo "Trying airdrop..."
    solana airdrop 2 --url devnet || {
        echo "Airdrop failed. Try again later or use a web faucet."
        exit 1
    }
fi

echo ""
echo "=== Building program ==="
cd /opt/autonomous-ai/projects/solana-api-keys
anchor build

echo ""
echo "=== Deploying to devnet ==="
anchor deploy --provider.cluster devnet

PROGRAM_ID=$(solana-keygen pubkey target/deploy/api_key_manager-keypair.json)
echo "Program deployed at: $PROGRAM_ID"

echo ""
echo "=== Running end-to-end test via CLI ==="
cd client

# Test 1: Create service
echo "1. Creating service..."
npx ts-node src/cli.ts create-service -n "Test API Service" -m 100 -r 1000 -w 3600 -c devnet

# Test 2: Create API key
echo ""
echo "2. Creating API key..."
OUTPUT=$(npx ts-node src/cli.ts create-key -l "Test Key" -p 3 -c devnet 2>&1)
echo "$OUTPUT"
API_KEY=$(echo "$OUTPUT" | grep "API Key:" | awk '{print $NF}')
echo "Captured key: $API_KEY"

# Test 3: Validate key
echo ""
echo "3. Validating key..."
OWNER=$(solana-keygen pubkey ~/.config/solana/id.json)
npx ts-node src/cli.ts validate-key --key "$API_KEY" --service-owner "$OWNER" -c devnet

# Test 4: Record usage
echo ""
echo "4. Recording usage..."
npx ts-node src/cli.ts record-usage --key "$API_KEY" -c devnet

# Test 5: List keys
echo ""
echo "5. Listing keys..."
npx ts-node src/cli.ts list-keys -c devnet

# Test 6: Update key
echo ""
echo "6. Updating key permissions..."
npx ts-node src/cli.ts update-key --key "$API_KEY" -p 7 -r 2000 -c devnet

# Test 7: Validate again (should show updated perms)
echo ""
echo "7. Validating updated key..."
npx ts-node src/cli.ts validate-key --key "$API_KEY" --service-owner "$OWNER" -c devnet

# Test 8: Revoke key
echo ""
echo "8. Revoking key..."
npx ts-node src/cli.ts revoke-key --key "$API_KEY" -c devnet

# Test 9: Try usage on revoked key (should fail)
echo ""
echo "9. Testing usage on revoked key (should fail)..."
npx ts-node src/cli.ts record-usage --key "$API_KEY" -c devnet 2>&1 || echo "Expected error: key is revoked"

echo ""
echo "=== All tests completed! ==="
echo "Program ID: $PROGRAM_ID"
echo "Devnet explorer: https://explorer.solana.com/address/$PROGRAM_ID?cluster=devnet"

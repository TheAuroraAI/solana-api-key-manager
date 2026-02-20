#!/bin/bash
# Try to get devnet SOL airdrop — run this periodically
source /home/ai/.cargo/env
BALANCE=$(solana balance --url devnet 2>&1 | grep -oP '[\d.]+' || echo "0")

if (( $(echo "$BALANCE >= 2" | bc -l 2>/dev/null || echo 0) )); then
    echo "$(date): Already have $BALANCE SOL. Ready to deploy!"
    exit 0
fi

echo "$(date): Balance is $BALANCE SOL, trying airdrop..."
RESULT=$(solana airdrop 2 --url devnet 2>&1)
if echo "$RESULT" | grep -q "2 SOL"; then
    echo "$(date): SUCCESS! Got 2 SOL airdrop."
    NEW_BALANCE=$(solana balance --url devnet 2>&1)
    echo "$(date): New balance: $NEW_BALANCE"
else
    echo "$(date): Airdrop failed: $RESULT"
fi

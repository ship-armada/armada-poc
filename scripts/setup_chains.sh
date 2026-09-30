#!/bin/bash

# CCTP POC - Local Chain Setup
# Starts Anvil instances for the Hub plus CLIENT_COUNT client chains (default 2).
# Hub:      port 8545 / chain 31337 (matches Railgun SDK's Hardhat network config).
# Client i: port 8545+i / chain 31337+i (client1 → 8546/31338, client2 → 8547/31339, ...).

CLIENT_COUNT=${CLIENT_COUNT:-2}

echo "=== Starting Local EVM Chains (hub + ${CLIENT_COUNT} clients) ==="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

# Check if anvil is installed
if ! command -v anvil &> /dev/null; then
    echo -e "${RED}Error: anvil not found. Install Foundry first:${NC}"
    echo "  curl -L https://foundry.paradigm.xyz | bash"
    echo "  foundryup"
    exit 1
fi

# Kill any existing anvil instances on the ports we use
echo "Cleaning up existing instances..."
lsof -ti:8545 | xargs kill -9 2>/dev/null
for ((i = 1; i <= CLIENT_COUNT; i++)); do
    lsof -ti:$((8545 + i)) | xargs kill -9 2>/dev/null
done
sleep 1

# Start Hub Chain (uses 31337 and port 8545 to match Railgun SDK's Hardhat network config)
echo ""
echo -e "${GREEN}Starting Hub Chain...${NC}"
echo "  Port: 8545"
echo "  Chain ID: 31337"
anvil --port 8545 --chain-id 31337 --block-time 1 --accounts 200 &
HUB_PID=$!

# Start client chains
CLIENT_PIDS=()
for ((i = 1; i <= CLIENT_COUNT; i++)); do
    PORT=$((8545 + i))
    CHAIN_ID=$((31337 + i))
    echo ""
    echo -e "${GREEN}Starting Client Chain ${i}...${NC}"
    echo "  Port: ${PORT}"
    echo "  Chain ID: ${CHAIN_ID}"
    anvil --port "$PORT" --chain-id "$CHAIN_ID" --block-time 1 &
    CLIENT_PIDS+=($!)
done

# Wait for chains to start
sleep 2

echo ""
echo "=== $((CLIENT_COUNT + 1)) Chains Running ==="
echo ""
echo "Hub Chain (Railgun SDK compatible):"
echo "  RPC: http://localhost:8545"
echo "  Chain ID: 31337"
echo "  PID: $HUB_PID"
for ((i = 1; i <= CLIENT_COUNT; i++)); do
    echo ""
    echo "Client Chain ${i}:"
    echo "  RPC: http://localhost:$((8545 + i))"
    echo "  Chain ID: $((31337 + i))"
    echo "  PID: ${CLIENT_PIDS[$((i - 1))]}"
done
echo ""
echo "Default Funded Accounts (same on all chains):"
echo "  Account 0: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
echo "  Account 1: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
echo "  Account 2: 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
echo ""
echo "See .env for account private keys"
echo ""
echo "Press Ctrl+C to stop all chains"
echo ""

# Handle cleanup on exit
cleanup() {
    echo ""
    echo "Shutting down chains..."
    kill $HUB_PID 2>/dev/null
    for pid in "${CLIENT_PIDS[@]}"; do
        kill "$pid" 2>/dev/null
    done
    echo "Done."
    exit 0
}

trap cleanup SIGINT SIGTERM

# Wait for processes
wait

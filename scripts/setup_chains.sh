#!/bin/bash

# CCTP POC - Local Chain Setup
# Starts three Anvil instances for Client A, Hub, and Client B chains

echo "=== Starting Local EVM Chains ==="
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

# Kill any existing anvil instances on these ports
echo "Cleaning up existing instances..."
lsof -ti:8545 | xargs kill -9 2>/dev/null
lsof -ti:8546 | xargs kill -9 2>/dev/null
lsof -ti:8547 | xargs kill -9 2>/dev/null
sleep 1

# Start Hub Chain (uses 31337 and port 8545 to match Railgun SDK's Hardhat network config)
echo ""
echo -e "${GREEN}Starting Hub Chain...${NC}"
echo "  Port: 8545"
echo "  Chain ID: 31337"
anvil --port 8545 --chain-id 31337 --block-time 1 &
HUB_PID=$!

# Start Client Chain A
echo ""
echo -e "${GREEN}Starting Client Chain A...${NC}"
echo "  Port: 8546"
echo "  Chain ID: 31338"
anvil --port 8546 --chain-id 31338 --block-time 1 &
CLIENT_A_PID=$!

# Start Client Chain B
echo ""
echo -e "${GREEN}Starting Client Chain B...${NC}"
echo "  Port: 8547"
echo "  Chain ID: 31339"
anvil --port 8547 --chain-id 31339 --block-time 1 &
CLIENT_B_PID=$!

# Wait for chains to start
sleep 2

echo ""
echo "=== Three Chains Running ==="
echo ""
echo "Hub Chain (Railgun SDK compatible):"
echo "  RPC: http://localhost:8545"
echo "  Chain ID: 31337"
echo "  PID: $HUB_PID"
echo ""
echo "Client Chain A:"
echo "  RPC: http://localhost:8546"
echo "  Chain ID: 31338"
echo "  PID: $CLIENT_A_PID"
echo ""
echo "Client Chain B:"
echo "  RPC: http://localhost:8547"
echo "  Chain ID: 31339"
echo "  PID: $CLIENT_B_PID"
echo ""
echo "Default Funded Accounts (same on all chains):"
echo "  Account 0: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
echo "  Account 1: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
echo "  Account 2: 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
echo ""
echo "Private Keys (for testing only):"
echo "  Account 0: 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
echo "  Account 1: 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
echo "  Account 2: 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"
echo ""
echo "Press Ctrl+C to stop all chains"
echo ""

# Handle cleanup on exit
cleanup() {
    echo ""
    echo "Shutting down chains..."
    kill $CLIENT_A_PID 2>/dev/null
    kill $HUB_PID 2>/dev/null
    kill $CLIENT_B_PID 2>/dev/null
    echo "Done."
    exit 0
}

trap cleanup SIGINT SIGTERM

# Wait for processes
wait

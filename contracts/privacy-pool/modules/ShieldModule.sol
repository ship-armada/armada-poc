// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "../storage/PrivacyPoolStorage.sol";
import "../interfaces/IShieldModule.sol";
import "../interfaces/IMerkleModule.sol";
import "../types/CCTPTypes.sol";
import "../../railgun/logic/Poseidon.sol";
import "../../governance/IShieldPauseController.sol";
import "../../fees/IArmadaFeeModule.sol";

/**
 * @title ShieldModule
 * @notice Handles shield operations for the privacy pool
 * @dev Called via delegatecall from PrivacyPool router.
 *      Based on Railgun's RailgunSmartWallet.shield() and RailgunLogic.transferTokenIn().
 *
 *      Supports two shield flows:
 *      1. Local shield: User on Hub chain calls shield() directly
 *      2. Cross-chain shield: Client sends CCTP message, Hub calls processIncomingShield()
 */
contract ShieldModule is PrivacyPoolStorage, IShieldModule {
    using SafeERC20 for IERC20;

    /// @notice Basis points denominator (100% = 10000)
    uint120 private constant BASIS_POINTS = 10000;

    /**
     * @notice Shield tokens locally (user on Hub chain)
     * @dev Transfers tokens from sender, creates commitments, inserts into merkle tree.
     *      Fees are deducted from the shielded amount.
     *
     * @param _shieldRequests Array of shield requests to process
     * @param integrator Integrator address for fee split (address(0) for no integrator)
     */
    function shield(ShieldRequest[] calldata _shieldRequests, address integrator) external override onlyDelegatecall {
        _requireShieldsNotPaused();
        uint256 numRequests = _shieldRequests.length;
        require(numRequests > 0, "ShieldModule: No requests");

        // Prepare arrays for merkle insertion and events
        bytes32[] memory insertionLeaves = new bytes32[](numRequests);
        CommitmentPreimage[] memory commitments = new CommitmentPreimage[](numRequests);
        ShieldCiphertext[] memory shieldCiphertext = new ShieldCiphertext[](numRequests);
        uint256[] memory fees = new uint256[](numRequests);

        // Process each shield request
        for (uint256 i = 0; i < numRequests; i++) {
            // Validate the commitment preimage
            _validateCommitmentPreimage(_shieldRequests[i].preimage);

            // Transfer tokens in and calculate fee-adjusted commitment
            (commitments[i], fees[i]) = _transferTokenIn(_shieldRequests[i].preimage, integrator);

            // Hash commitment for merkle tree
            insertionLeaves[i] = _hashCommitment(commitments[i]);

            // Store ciphertext for event
            shieldCiphertext[i] = _shieldRequests[i].ciphertext;
        }

        // Get insertion position before inserting
        (uint256 insertionTreeNumber, uint256 insertionStartIndex) = IMerkleModule(address(this))
            .getInsertionTreeNumberAndStartingIndex(numRequests);

        // Emit Shield event (for wallet sync)
        emit Shield(insertionTreeNumber, insertionStartIndex, commitments, shieldCiphertext, fees);

        // Insert leaves into merkle tree via delegatecall to MerkleModule
        IMerkleModule(address(this)).insertLeaves(insertionLeaves);

        // Update last event block for wallet sync
        lastEventBlock = block.number;
    }

    /**
     * @notice Process an incoming cross-chain shield from a Client
     * @dev Called by Router when CCTP message arrives with MessageType.SHIELD.
     *      USDC has already been minted to the PrivacyPool by CCTP.
     *      This function creates a commitment and inserts it into the merkle tree.
     *
     * @param amount Amount of USDC received (from CCTP)
     * @param data Shield data from the CCTP payload
     */
    function processIncomingShield(uint256 amount, ShieldData calldata data) external override onlyDelegatecall {
        _requireShieldsNotPaused();
        // Verify caller is the router (self, since we're called via delegatecall)
        // This is implicitly enforced by the router only calling this on valid CCTP messages

        // Verify amount doesn't exceed declared value
        // amount = grossAmount - feeExecuted (CCTP deducts fee at protocol level)
        // data.value = gross amount the user burned on the client chain
        require(amount <= uint256(data.value), "ShieldModule: Amount exceeds declared value");

        uint256 commitmentAmount = amount;

        // Construct shield request from CCTP data
        // Token is always USDC on Hub
        ShieldRequest[] memory requests = new ShieldRequest[](1);
        requests[0] = ShieldRequest({
            preimage: CommitmentPreimage({
                npk: data.npk,
                token: TokenData({
                    tokenType: TokenType.ERC20,
                    tokenAddress: usdc,
                    tokenSubID: 0
                }),
                value: uint120(commitmentAmount)
            }),
            ciphertext: ShieldCiphertext({
                encryptedBundle: data.encryptedBundle,
                shieldKey: data.shieldKey
            })
        });

        // Process as internal shield
        // Note: Tokens already in contract from CCTP mint, so we use _processInternalShield
        _processInternalShield(requests[0], data.integrator);
    }

    /**
     * @notice Process a shield where tokens are already in the contract
     * @dev Used for cross-chain shields where CCTP has already minted tokens to us
     * @param _request The shield request to process
     * @param integrator Integrator address for fee split (address(0) for no integrator)
     */
    function _processInternalShield(ShieldRequest memory _request, address integrator) internal {
        // Validate the commitment preimage
        _validateCommitmentPreimageMemory(_request.preimage);

        // Calculate fee (if any). Privileged callers bypass fee.
        uint256 fee = 0;
        CommitmentPreimage memory adjustedPreimage = _request.preimage;

        if (!privilegedShieldCallers[msg.sender]) {
            if (feeModule != address(0)) {
                // Fee module path: centralized fee calculation with integrator support
                uint256 amount = uint256(_request.preimage.value);
                (uint256 armadaTake, uint256 integratorFee, uint256 totalFee) =
                    IArmadaFeeModule(feeModule).calculateShieldFee(integrator, amount);

                adjustedPreimage.value = uint120(amount - totalFee);
                fee = totalFee;

                // Transfer armada take to treasury
                if (armadaTake > 0 && treasury != address(0)) {
                    IERC20(usdc).safeTransfer(treasury, armadaTake);
                }

                // Transfer integrator fee directly to integrator
                if (integratorFee > 0 && integrator != address(0)) {
                    IERC20(usdc).safeTransfer(integrator, integratorFee);
                }

                // Record fee in fee module
                IArmadaFeeModule(feeModule).recordShieldFee(integrator, amount, armadaTake, integratorFee);
            } else if (shieldFee > 0) {
                // Flat fee fallback path (used when feeModule == address(0))
                (uint120 base, uint120 feeAmount) = _getFee(_request.preimage.value, true, shieldFee);
                adjustedPreimage.value = base;
                fee = feeAmount;

                // Transfer fee to treasury
                if (feeAmount > 0 && treasury != address(0)) {
                    IERC20(usdc).safeTransfer(treasury, feeAmount);
                }
            }
        }

        // Prepare arrays for merkle insertion and events
        bytes32[] memory insertionLeaves = new bytes32[](1);
        CommitmentPreimage[] memory commitments = new CommitmentPreimage[](1);
        ShieldCiphertext[] memory shieldCiphertext = new ShieldCiphertext[](1);
        uint256[] memory fees = new uint256[](1);

        commitments[0] = adjustedPreimage;
        shieldCiphertext[0] = _request.ciphertext;
        fees[0] = fee;
        insertionLeaves[0] = _hashCommitment(adjustedPreimage);

        // Get insertion position
        (uint256 insertionTreeNumber, uint256 insertionStartIndex) = IMerkleModule(address(this))
            .getInsertionTreeNumberAndStartingIndex(1);

        // Emit Shield event
        emit Shield(insertionTreeNumber, insertionStartIndex, commitments, shieldCiphertext, fees);

        // Insert into merkle tree
        IMerkleModule(address(this)).insertLeaves(insertionLeaves);

        // Update last event block
        lastEventBlock = block.number;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // INTERNAL HELPERS
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Validate a commitment preimage (calldata version)
     * @param _note The commitment preimage to validate
     */
    function _validateCommitmentPreimage(CommitmentPreimage calldata _note) internal view {
        require(_note.value > 0, "ShieldModule: Invalid value");
        require(!tokenBlocklist[_note.token.tokenAddress], "ShieldModule: Token blocked");
        require(uint256(_note.npk) < SNARK_SCALAR_FIELD, "ShieldModule: Invalid npk");

        // ERC721 notes should have value of 1
        if (_note.token.tokenType == TokenType.ERC721) {
            require(_note.value == 1, "ShieldModule: Invalid NFT value");
        }
    }

    /**
     * @notice Validate a commitment preimage (memory version)
     * @param _note The commitment preimage to validate
     */
    function _validateCommitmentPreimageMemory(CommitmentPreimage memory _note) internal view {
        require(_note.value > 0, "ShieldModule: Invalid value");
        require(!tokenBlocklist[_note.token.tokenAddress], "ShieldModule: Token blocked");
        require(uint256(_note.npk) < SNARK_SCALAR_FIELD, "ShieldModule: Invalid npk");

        // ERC721 notes should have value of 1
        if (_note.token.tokenType == TokenType.ERC721) {
            require(_note.value == 1, "ShieldModule: Invalid NFT value");
        }
    }

    /**
     * @notice Transfer tokens into the contract and calculate fee-adjusted commitment
     * @param _note The commitment preimage (with original value)
     * @param integrator Integrator address for fee split (address(0) for no integrator)
     * @return adjustedNote The fee-adjusted commitment preimage
     * @return fee The fee amount
     */
    function _transferTokenIn(
        CommitmentPreimage calldata _note,
        address integrator
    ) internal returns (CommitmentPreimage memory adjustedNote, uint256 fee) {
        require(_note.token.tokenType == TokenType.ERC20, "ShieldModule: Only ERC20 supported");

        IERC20 token = IERC20(_note.token.tokenAddress);

        if (privilegedShieldCallers[msg.sender]) {
            // Privileged callers (e.g. yield adapter) bypass all fees
            adjustedNote = CommitmentPreimage({
                npk: _note.npk,
                token: _note.token,
                value: _note.value
            });
            fee = 0;

            // Transfer full amount to this contract
            uint256 balanceBefore = token.balanceOf(address(this));
            token.safeTransferFrom(msg.sender, address(this), _note.value);
            uint256 balanceAfter = token.balanceOf(address(this));
            require(balanceAfter - balanceBefore == _note.value, "ShieldModule: Transfer failed");
        } else if (feeModule != address(0)) {
            // Fee module path: centralized fee calculation with integrator support
            uint256 amount = uint256(_note.value);
            (uint256 armadaTake, uint256 integratorFee, uint256 totalFee) =
                IArmadaFeeModule(feeModule).calculateShieldFee(integrator, amount);

            uint120 base = uint120(amount - totalFee);
            adjustedNote = CommitmentPreimage({
                npk: _note.npk,
                token: _note.token,
                value: base
            });
            fee = totalFee;

            // Transfer base amount to this contract
            uint256 balanceBefore = token.balanceOf(address(this));
            token.safeTransferFrom(msg.sender, address(this), base);
            uint256 balanceAfter = token.balanceOf(address(this));
            require(balanceAfter - balanceBefore == base, "ShieldModule: Transfer failed");

            // Transfer armada take to treasury
            if (armadaTake > 0 && treasury != address(0)) {
                token.safeTransferFrom(msg.sender, treasury, armadaTake);
            }

            // Transfer integrator fee directly to integrator
            if (integratorFee > 0 && integrator != address(0)) {
                token.safeTransferFrom(msg.sender, integrator, integratorFee);
            }

            // Record fee in fee module
            IArmadaFeeModule(feeModule).recordShieldFee(integrator, amount, armadaTake, integratorFee);
        } else {
            // Flat fee fallback path (used when feeModule == address(0))
            (uint120 base, uint120 feeAmount) = _getFee(_note.value, true, shieldFee);
            adjustedNote = CommitmentPreimage({
                npk: _note.npk,
                token: _note.token,
                value: base
            });
            fee = feeAmount;

            // Transfer base amount to this contract
            uint256 balanceBefore = token.balanceOf(address(this));
            token.safeTransferFrom(msg.sender, address(this), base);
            uint256 balanceAfter = token.balanceOf(address(this));
            require(balanceAfter - balanceBefore == base, "ShieldModule: Transfer failed");

            // Transfer fee to treasury
            if (feeAmount > 0 && treasury != address(0)) {
                token.safeTransferFrom(msg.sender, treasury, feeAmount);
            }
        }
    }

    /**
     * @notice Calculate base and fee amounts
     * @param _amount The total amount
     * @param _isInclusive Whether the amount includes the fee
     * @param _feeBP Fee in basis points
     * @return base The base amount (after fee)
     * @return fee The fee amount
     */
    function _getFee(
        uint136 _amount,
        bool _isInclusive,
        uint120 _feeBP
    ) internal pure returns (uint120 base, uint120 fee) {
        if (_feeBP == 0) {
            return (uint120(_amount), 0);
        }

        if (_isInclusive) {
            // Fee is included in amount
            base = uint120(_amount - (_amount * _feeBP) / BASIS_POINTS);
            fee = uint120(_amount) - base;
        } else {
            // Fee is on top of amount
            base = uint120(_amount);
            fee = uint120((BASIS_POINTS * _amount) / (BASIS_POINTS - _feeBP) - _amount);
        }
    }

    /**
     * @notice Hash a commitment preimage
     * @param _note The commitment preimage
     * @return The Poseidon hash of (npk, tokenId, value)
     */
    function _hashCommitment(CommitmentPreimage memory _note) internal pure returns (bytes32) {
        return PoseidonT4.poseidon([
            _note.npk,
            _getTokenID(_note.token),
            bytes32(uint256(_note.value))
        ]);
    }

    /**
     * @notice Get token ID from token data
     * @param _tokenData The token data
     * @return Token ID (address for ERC20, hash for others)
     */
    function _getTokenID(TokenData memory _tokenData) internal pure returns (bytes32) {
        if (_tokenData.tokenType == TokenType.ERC20) {
            return bytes32(uint256(uint160(_tokenData.tokenAddress)));
        }
        return bytes32(uint256(keccak256(abi.encode(_tokenData))) % SNARK_SCALAR_FIELD);
    }

    /// @notice Reverts if shields are currently paused. No-op if no pause contract is set.
    function _requireShieldsNotPaused() internal view {
        if (shieldPauseContract != address(0)) {
            require(
                !IShieldPauseController(shieldPauseContract).shieldsPaused(),
                "ShieldModule: shields paused"
            );
        }
    }
}

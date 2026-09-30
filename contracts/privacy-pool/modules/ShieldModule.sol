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
import "../../governance/IArmadaGovernance.sol";
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
     * @param amount Amount of USDC received (from CCTP) = grossAmount - feeExecuted
     * @param datas Shield note array from the CCTP payload. Index 0 is the recipient note (which
     *        absorbs the CCTP protocol fee); any further notes (e.g. a relayer fee note) are minted
     *        at their full declared value.
     */
    function processIncomingShield(uint256 amount, ShieldData[] calldata datas) external override onlyDelegatecall {
        _requireShieldsNotPaused();
        // Verify caller is the router (self, since we're called via delegatecall)
        // This is implicitly enforced by the router only calling this on valid CCTP messages

        uint256 n = datas.length;
        require(n > 0, "ShieldModule: no shield notes");

        // Fee notes (index >= 1) are minted at their full declared value; the recipient note (index 0)
        // absorbs the CCTP protocol fee. `amount = grossAmount - feeExecuted` (CCTP deducts the fee at
        // protocol level), so the recipient is credited `amount - feeSum`.
        uint256 feeSum = 0;
        for (uint256 i = 1; i < n; i++) {
            feeSum += uint256(datas[i].value);
        }
        require(amount > feeSum, "ShieldModule: fee notes exceed received amount");

        // Sanity: never credit the recipient more than the total declared (gross) burn on the source.
        require(amount <= _sumDeclared(datas), "ShieldModule: Amount exceeds declared value");

        // Build every note, apply its (per-note integrator) shield fee, then insert ALL leaves in one
        // batch with a SINGLE Shield event — matching the same-chain shield() event shape (one event
        // with N commitments) rather than emitting one event per note. Tokens are already in the
        // contract from the CCTP mint, so the fee helper transfers out but never pulls.
        bytes32[] memory insertionLeaves = new bytes32[](n);
        CommitmentPreimage[] memory commitments = new CommitmentPreimage[](n);
        ShieldCiphertext[] memory shieldCiphertext = new ShieldCiphertext[](n);
        uint256[] memory fees = new uint256[](n);

        for (uint256 i = 0; i < n; i++) {
            // Recipient (index 0) is credited net of the fee notes + the CCTP fee; fee notes at full value.
            uint256 noteValue = i == 0 ? amount - feeSum : uint256(datas[i].value);
            ShieldRequest memory request = _shieldRequestFromData(datas[i], noteValue);
            _validateCommitmentPreimageMemory(request.preimage);
            (CommitmentPreimage memory adjustedPreimage, uint256 fee) =
                _applyShieldFee(request.preimage, datas[i].integrator);
            commitments[i] = adjustedPreimage;
            shieldCiphertext[i] = request.ciphertext;
            fees[i] = fee;
            insertionLeaves[i] = _hashCommitment(adjustedPreimage);
        }

        (uint256 insertionTreeNumber, uint256 insertionStartIndex) =
            IMerkleModule(address(this)).getInsertionTreeNumberAndStartingIndex(n);
        emit Shield(insertionTreeNumber, insertionStartIndex, commitments, shieldCiphertext, fees);
        IMerkleModule(address(this)).insertLeaves(insertionLeaves);
        lastEventBlock = block.number;
    }

    /// @dev Sum the declared (gross) values across all incoming shield notes.
    function _sumDeclared(ShieldData[] calldata datas) internal pure returns (uint256 total) {
        for (uint256 i = 0; i < datas.length; i++) {
            total += uint256(datas[i].value);
        }
    }

    /// @dev Build a USDC ShieldRequest from a CCTP ShieldData with an explicit (fee/CCTP-adjusted) value.
    function _shieldRequestFromData(ShieldData calldata data, uint256 value)
        internal
        view
        returns (ShieldRequest memory)
    {
        return ShieldRequest({
            preimage: CommitmentPreimage({
                npk: data.npk,
                token: TokenData({tokenType: TokenType.ERC20, tokenAddress: usdc, tokenSubID: 0}),
                value: uint120(value)
            }),
            ciphertext: ShieldCiphertext({
                encryptedBundle: data.encryptedBundle,
                shieldKey: data.shieldKey
            })
        });
    }

    /**
     * @notice Apply the shield fee to a note whose tokens are ALREADY in the contract (cross-chain
     *         CCTP mint — no pull). Transfers the fee out (armada take → treasury, integrator fee →
     *         integrator), records it, and returns the fee-adjusted preimage + total fee. Does NOT
     *         hash, insert, or emit — `processIncomingShield` batches those across all notes so a
     *         multi-note cross-chain shield produces a single Shield event.
     * @param preimage The commitment preimage (with its gross value) to fee-adjust.
     * @param integrator Integrator address for fee split (address(0) for no integrator).
     */
    function _applyShieldFee(CommitmentPreimage memory preimage, address integrator)
        internal
        returns (CommitmentPreimage memory adjustedPreimage, uint256 fee)
    {
        adjustedPreimage = preimage;
        fee = 0;

        // Privileged callers (registered adapters) bypass the fee.
        if (!_isPrivilegedShieldCaller(msg.sender)) {
            if (feeModule != address(0)) {
                // Fee module path: centralized fee calculation with integrator support
                uint256 amount = uint256(preimage.value);
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
                IArmadaFeeModule(feeModule).recordShieldFee(
                    preimage.token.tokenAddress,
                    integrator,
                    amount,
                    armadaTake,
                    integratorFee
                );
            } else if (shieldFee > 0) {
                // Flat fee fallback path (used when feeModule == address(0))
                (uint120 base, uint120 feeAmount) = _getFee(preimage.value, true, shieldFee);
                adjustedPreimage.value = base;
                fee = feeAmount;

                // Transfer fee to treasury
                if (feeAmount > 0 && treasury != address(0)) {
                    IERC20(usdc).safeTransfer(treasury, feeAmount);
                }
            }
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // INTERNAL HELPERS
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * @notice True if `caller` is a trusted yield adapter per the governance registry.
     * @dev Fee-exempt shield path (issue #370). The gate is `authorized OR withdraw-only`, mirroring
     *      ArmadaYieldAdapter._requireAuthorizedOrWithdrawOnly, so an adapter's wind-down exit re-shields
     *      stay fee-exempt until it is fully deauthorized (at which point the adapter blocks itself, so
     *      there is no dangling privilege). When adapterRegistry is unset, no caller is privileged.
     *      The `||` short-circuits, so the common authorized case is a single STATICCALL.
     */
    function _isPrivilegedShieldCaller(address caller) internal view returns (bool) {
        address reg = adapterRegistry;
        if (reg == address(0)) return false;
        return IAdapterRegistry(reg).authorizedAdapters(caller)
            || IAdapterRegistry(reg).withdrawOnlyAdapters(caller);
    }

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

        if (_isPrivilegedShieldCaller(msg.sender)) {
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
            IArmadaFeeModule(feeModule).recordShieldFee(
                _note.token.tokenAddress,
                integrator,
                amount,
                armadaTake,
                integratorFee
            );
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

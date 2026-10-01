// SPDX-License-Identifier: MIT
// ABOUTME: Shield logic module for the privacy pool (local ERC20 shields and inbound
// ABOUTME: cross-chain shields). Executes exclusively via delegatecall from the
// ABOUTME: PrivacyPool router, so all state lives in the router's storage
// ABOUTME: (see PrivacyPoolStorage).
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "../storage/PrivacyPoolStorage.sol";
import "../interfaces/IShieldModule.sol";
import "../interfaces/IMerkleModule.sol";
import "../types/CCTPTypes.sol";
import "../types/PoseidonLibs.sol";
import "../../governance/IShieldPauseController.sol";
import "../../governance/IArmadaGovernance.sol";
import "../../fees/IArmadaFeeModule.sol";

/// @title ShieldModule
/// @notice Entry-point logic for moving value into the pool's commitment tree
///         (behavior spec section 7).
/// @dev Two flows converge on the same leaf-insertion path:
///        1. Local shield — a user on this chain calls the router's `shield`, which
///           delegatecalls here; tokens are pulled from the caller.
///        2. Cross-chain shield-in — a CCTP burn on a client chain mints USDC to the
///           pool and the router's message handler delegatecalls `processIncomingShield`;
///           tokens are already in the pool's balance.
///      Fee selection is three-way (spec section 7.3): privileged callers pay nothing;
///      otherwise the configured `feeModule` prices the shield; with no fee module the
///      flat `shieldFee` basis-point rate applies (spec section 2.4, modeled in the
///      Lean fee reference).
contract ShieldModule is PrivacyPoolStorage, IShieldModule {
    using SafeERC20 for IERC20;

    /// @notice Denominator for basis-point fee rates (100% = 10000).
    uint120 private constant BASIS_POINTS = 10000;

    /// @notice Shields one or more notes in a single atomic batch.
    /// @dev Emits `Shield` with the PRE-insertion tree position (spec OQ-1) before the
    ///      leaves are inserted, so wallets can scan logs in emission order. Any failed
    ///      check reverts the whole batch, including earlier token pulls.
    /// @param _shieldRequests Notes to shield, processed in order.
    /// @param integrator Integrator credited for the fee split (zero address for none).
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

            // Pull tokens from the caller and derive the fee-adjusted note
            (commitments[i], fees[i]) = _transferTokenIn(_shieldRequests[i].preimage, integrator);

            // Hash commitment for merkle tree
            insertionLeaves[i] = _hashCommitment(commitments[i]);

            // Store ciphertext for event
            shieldCiphertext[i] = _shieldRequests[i].ciphertext;
        }

        // Read the insertion position before inserting (router view is pre-insertion)
        (uint256 insertionTreeNumber, uint256 insertionStartIndex) = IMerkleModule(address(this))
            .getInsertionTreeNumberAndStartingIndex(numRequests);

        // Announce the new notes for wallet sync
        emit Shield(insertionTreeNumber, insertionStartIndex, commitments, shieldCiphertext, fees);

        // Append the leaves to the tree via the router's self-call gate
        IMerkleModule(address(this)).insertLeaves(insertionLeaves);

        // Record the liveness marker for wallet sync
        lastEventBlock = block.number;
    }

    /// @notice Processes a cross-chain shield-in after CCTP has minted USDC to the pool.
    /// @dev Reached only from the router's CCTP message handlers. The payload carries one or
    ///      more notes: index 0 is the recipient note (it absorbs the CCTP protocol fee), and any
    ///      further notes (e.g. a relayer fee note) are minted at their full declared value. All
    ///      notes are inserted in one batch with a SINGLE Shield event, matching the local shield()
    ///      event shape. Fees (if any) settle out of the pool's own balance, and the fee-exemption
    ///      check inspects `msg.sender` — here the hook router or token messenger, which is
    ///      normally not a registered adapter.
    /// @param amount Net USDC amount minted to the pool (gross burn minus CCTP protocol fee).
    /// @param datas Decoded shield notes from the CCTP hook data.
    function processIncomingShield(uint256 amount, ShieldData[] calldata datas) external override onlyDelegatecall {
        _requireShieldsNotPaused();

        uint256 n = datas.length;
        require(n > 0, "ShieldModule: no shield notes");

        // Fee notes (index >= 1) mint at full declared value; the recipient note absorbs them
        uint256 feeSum = 0;
        for (uint256 i = 1; i < n; i++) {
            feeSum += uint256(datas[i].value);
        }
        require(amount > feeSum, "ShieldModule: fee notes exceed received amount");

        // Sanity: never credit the recipient more than the total declared gross burn
        require(amount <= _sumDeclared(datas), "ShieldModule: Amount exceeds declared value");

        // Build, fee-adjust and hash every note, then batch-insert with one Shield event
        bytes32[] memory insertionLeaves = new bytes32[](n);
        CommitmentPreimage[] memory commitments = new CommitmentPreimage[](n);
        ShieldCiphertext[] memory shieldCiphertext = new ShieldCiphertext[](n);
        uint256[] memory fees = new uint256[](n);

        for (uint256 i = 0; i < n; i++) {
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

    /// @dev Build a USDC ShieldRequest from a CCTP ShieldData with an explicit
    ///      (fee/CCTP-adjusted) value. Cross-chain value always arrives as USDC on this chain.
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

    /// @notice Applies the shield fee to a note whose tokens are ALREADY held by the pool
    ///         (cross-chain CCTP mint — no pull). Transfers the fee out (protocol share to the
    ///         treasury, integrator share to the integrator), records it, and returns the
    ///         fee-adjusted preimage plus the total fee. Does NOT hash, insert, or emit —
    ///         `processIncomingShield` batches those across all notes.
    /// @param preimage The commitment preimage (gross value) to fee-adjust.
    /// @param integrator Integrator credited for the fee split (zero address for none).
    function _applyShieldFee(CommitmentPreimage memory preimage, address integrator)
        internal
        returns (CommitmentPreimage memory adjustedPreimage, uint256 fee)
    {
        adjustedPreimage = preimage;
        fee = 0;

        // Registered adapters bypass the fee (timelock-governed registry, not owner-set)
        if (!_isPrivilegedShieldCaller(msg.sender)) {
            if (feeModule != address(0)) {
                // Fee module path: centralized fee calculation with integrator support
                uint256 amount = uint256(preimage.value);
                (uint256 armadaTake, uint256 integratorFee, uint256 totalFee) =
                    IArmadaFeeModule(feeModule).calculateShieldFee(integrator, amount);

                adjustedPreimage.value = uint120(amount - totalFee);
                fee = totalFee;

                // Pay the protocol share to the treasury from the pool's balance
                if (armadaTake > 0 && treasury != address(0)) {
                    IERC20(usdc).safeTransfer(treasury, armadaTake);
                }

                // Pay the integrator share directly to the integrator
                if (integratorFee > 0 && integrator != address(0)) {
                    IERC20(usdc).safeTransfer(integrator, integratorFee);
                }

                // Record the fee in the fee module
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

                // Pay the fee to the treasury from the pool's balance
                if (feeAmount > 0 && treasury != address(0)) {
                    IERC20(usdc).safeTransfer(treasury, feeAmount);
                }
            }
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // INTERNAL HELPERS
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice True if `caller` is a trusted yield adapter per the governance registry.
    /// @dev Fee-exempt shield path. The gate is `authorized OR withdraw-only`, mirroring the
    ///      yield adapter's own guard, so an adapter's wind-down exit re-shields stay fee-exempt
    ///      until it is fully deauthorized (at which point the adapter blocks itself, so there is
    ///      no dangling privilege). When adapterRegistry is unset, no caller is privileged. The
    ///      `||` short-circuits, so the common authorized case costs a single STATICCALL.
    function _isPrivilegedShieldCaller(address caller) internal view returns (bool) {
        address reg = adapterRegistry;
        if (reg == address(0)) return false;
        return IAdapterRegistry(reg).authorizedAdapters(caller)
            || IAdapterRegistry(reg).withdrawOnlyAdapters(caller);
    }

    /// @notice Enforces the per-note shield constraints (spec section 7.1 step a).
    /// @dev Check order is pinned: positive value, blocklist, field-element npk, then the
    ///      (currently unreachable) ERC721 value check.
    /// @param _note The commitment preimage to validate.
    function _validateCommitmentPreimage(CommitmentPreimage calldata _note) internal view {
        require(_note.value > 0, "ShieldModule: Invalid value");
        require(!tokenBlocklist[_note.token.tokenAddress], "ShieldModule: Token blocked");
        require(uint256(_note.npk) < SNARK_SCALAR_FIELD, "ShieldModule: Invalid npk");

        // ERC721 notes must carry a value of exactly 1
        if (_note.token.tokenType == TokenType.ERC721) {
            require(_note.value == 1, "ShieldModule: Invalid NFT value");
        }
    }

    /// @notice Memory-struct variant of `_validateCommitmentPreimage` for the
    ///         cross-chain path, where the request is constructed on-chain.
    /// @param _note The commitment preimage to validate.
    function _validateCommitmentPreimageMemory(CommitmentPreimage memory _note) internal view {
        require(_note.value > 0, "ShieldModule: Invalid value");
        require(!tokenBlocklist[_note.token.tokenAddress], "ShieldModule: Token blocked");
        require(uint256(_note.npk) < SNARK_SCALAR_FIELD, "ShieldModule: Invalid npk");

        // ERC721 notes must carry a value of exactly 1
        if (_note.token.tokenType == TokenType.ERC721) {
            require(_note.value == 1, "ShieldModule: Invalid NFT value");
        }
    }

    /// @notice Pulls the tokens for a local shield and applies the fee (spec section 7.3).
    /// @dev Every pull into the pool's own balance is balance-delta checked, which rejects
    ///      fee-on-transfer and rebasing tokens; the fee legs to treasury/integrator are
    ///      not delta-checked. Selects one of three branches, in order: privileged caller
    ///      (no fee), configured fee module (split fee), flat basis-point fallback.
    /// @param _note The commitment preimage as requested (gross value).
    /// @param integrator Integrator credited for the fee split (zero address for none).
    /// @return adjustedNote The note with its value reduced by the fee taken.
    /// @return fee The total fee charged.
    function _transferTokenIn(
        CommitmentPreimage calldata _note,
        address integrator
    ) internal returns (CommitmentPreimage memory adjustedNote, uint256 fee) {
        require(_note.token.tokenType == TokenType.ERC20, "ShieldModule: Only ERC20 supported");

        IERC20 token = IERC20(_note.token.tokenAddress);

        if (_isPrivilegedShieldCaller(msg.sender)) {
            // Privileged callers (e.g. the yield adapter) bypass all fees
            adjustedNote = CommitmentPreimage({
                npk: _note.npk,
                token: _note.token,
                value: _note.value
            });
            fee = 0;

            // Pull the full amount into the pool
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

            // Pull the net amount into the pool
            uint256 balanceBefore = token.balanceOf(address(this));
            token.safeTransferFrom(msg.sender, address(this), base);
            uint256 balanceAfter = token.balanceOf(address(this));
            require(balanceAfter - balanceBefore == base, "ShieldModule: Transfer failed");

            // Pull the protocol share to the treasury
            if (armadaTake > 0 && treasury != address(0)) {
                token.safeTransferFrom(msg.sender, treasury, armadaTake);
            }

            // Pull the integrator share directly to the integrator
            if (integratorFee > 0 && integrator != address(0)) {
                token.safeTransferFrom(msg.sender, integrator, integratorFee);
            }

            // Record the fee in the fee module
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

            // Pull the net amount into the pool
            uint256 balanceBefore = token.balanceOf(address(this));
            token.safeTransferFrom(msg.sender, address(this), base);
            uint256 balanceAfter = token.balanceOf(address(this));
            require(balanceAfter - balanceBefore == base, "ShieldModule: Transfer failed");

            // Pull the fee to the treasury
            if (feeAmount > 0 && treasury != address(0)) {
                token.safeTransferFrom(msg.sender, treasury, feeAmount);
            }
        }
    }

    /// @notice Splits an amount into base and fee at a basis-point rate (spec section 2.4).
    /// @dev The inclusive path (`fee = amount * feeBP / BASIS_POINTS`, floor division) is
    ///      the only live path; its rounding behavior is pinned by the Lean fee model
    ///      (conservation `base + fee = amount`, zero fee on small amounts). The exclusive
    ///      path is unreachable dead code retained for parity (spec OQ-5).
    /// @param _amount The gross amount.
    /// @param _isInclusive Whether the fee is carved out of `_amount` (true) or added on top (false).
    /// @param _feeBP Fee rate in basis points.
    /// @return base The amount net of the fee.
    /// @return fee The fee amount.
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

    /// @notice Computes the commitment leaf hash (spec section 2.2).
    /// @param _note The commitment preimage.
    /// @return Poseidon digest of (npk, tokenID, value).
    function _hashCommitment(CommitmentPreimage memory _note) internal pure returns (bytes32) {
        return PoseidonT4.poseidon([
            _note.npk,
            _getTokenID(_note.token),
            bytes32(uint256(_note.value))
        ]);
    }

    /// @notice Derives the field-element token identifier (spec section 2.2).
    /// @dev ERC20 tokens are identified by their address, zero-extended. Other token
    ///      types hash the full token data into the field (currently unreachable — both
    ///      token in/out paths require ERC20).
    /// @param _tokenData The token data.
    /// @return The token ID as a bytes32 field element.
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

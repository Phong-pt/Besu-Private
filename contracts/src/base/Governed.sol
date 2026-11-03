// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Governance is immutable; migration requires deploying a new registry.
abstract contract Governed {
    address public immutable governance;

    error Unauthorized();
    error InvalidInput();
    error NotFound();
    error AlreadyExists();
    error InvalidState();

    constructor(address governance_) {
        if (governance_ == address(0) || governance_.code.length == 0) revert InvalidInput();
        governance = governance_;
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert Unauthorized();
        _;
    }
}

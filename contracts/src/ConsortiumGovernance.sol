// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Fixed 3-of-5 application governance, independent of QBFT validators.
/// @dev Owner rotation invalidates every outstanding proposal using councilEpoch.
contract ConsortiumGovernance is ReentrancyGuard {
    uint256 public constant THRESHOLD = 3;
    address[5] public owners;
    mapping(address => bool) public isOwner;
    uint256 public councilEpoch = 1;
    uint256 public proposalCount;

    struct Proposal {
        address target;
        address proposer;
        bytes data;
        uint256 epoch;
        uint64 deadline;
        uint8 confirmations;
        bool executed;
        bool cancelled;
    }

    mapping(uint256 => Proposal) private _proposals;
    mapping(uint256 => mapping(address => bool)) public approved;

    error Unauthorized();
    error InvalidInput();
    error InvalidProposal();
    error AlreadyApproved();
    error NotApproved();
    error InsufficientApprovals();
    error CallFailed(bytes reason);

    event ProposalSubmitted(uint256 indexed proposalId, address indexed proposer, address indexed target, bytes data, uint64 deadline, uint256 epoch);
    event ProposalConfirmed(uint256 indexed proposalId, address indexed owner);
    event ConfirmationRevoked(uint256 indexed proposalId, address indexed owner);
    event ProposalCancelled(uint256 indexed proposalId);
    event ProposalExecuted(uint256 indexed proposalId);
    event OwnerReplaced(address indexed previousOwner, address indexed newOwner, uint256 epoch);

    constructor(address[5] memory owners_) {
        for (uint256 i; i < 5; ++i) {
            address owner = owners_[i];
            if (owner == address(0) || owner == address(this) || isOwner[owner]) revert InvalidInput();
            owners[i] = owner;
            isOwner[owner] = true;
        }
    }

    modifier onlyOwner() {
        if (!isOwner[msg.sender]) revert Unauthorized();
        _;
    }

    function submit(address target, bytes calldata data, uint64 deadline) external onlyOwner returns (uint256 id) {
        if (target.code.length == 0 || data.length < 4 || deadline <= block.timestamp) revert InvalidInput();
        id = ++proposalCount;
        _proposals[id] = Proposal(target, msg.sender, data, councilEpoch, deadline, 1, false, false);
        approved[id][msg.sender] = true;
        emit ProposalSubmitted(id, msg.sender, target, data, deadline, councilEpoch);
        emit ProposalConfirmed(id, msg.sender);
    }

    function confirm(uint256 id) external onlyOwner {
        Proposal storage p = _pending(id);
        if (approved[id][msg.sender]) revert AlreadyApproved();
        approved[id][msg.sender] = true;
        ++p.confirmations;
        emit ProposalConfirmed(id, msg.sender);
    }

    function revokeConfirmation(uint256 id) external onlyOwner {
        Proposal storage p = _pending(id);
        if (!approved[id][msg.sender]) revert NotApproved();
        approved[id][msg.sender] = false;
        --p.confirmations;
        emit ConfirmationRevoked(id, msg.sender);
    }

    function cancel(uint256 id) external {
        Proposal storage p = _pending(id);
        if (msg.sender != p.proposer && msg.sender != address(this)) revert Unauthorized();
        p.cancelled = true;
        emit ProposalCancelled(id);
    }

    function execute(uint256 id) external nonReentrant returns (bytes memory result) {
        Proposal storage p = _pending(id);
        if (p.confirmations < THRESHOLD) revert InsufficientApprovals();
        p.executed = true;
        (bool success, bytes memory returned) = p.target.call(p.data);
        if (!success) revert CallFailed(returned);
        emit ProposalExecuted(id);
        return returned;
    }

    function replaceOwner(address previousOwner, address newOwner) external {
        if (msg.sender != address(this)) revert Unauthorized();
        if (!isOwner[previousOwner] || newOwner == address(0) || newOwner == address(this) || isOwner[newOwner]) revert InvalidInput();
        for (uint256 i; i < 5; ++i) {
            if (owners[i] == previousOwner) {
                owners[i] = newOwner;
                break;
            }
        }
        isOwner[previousOwner] = false;
        isOwner[newOwner] = true;
        ++councilEpoch;
        emit OwnerReplaced(previousOwner, newOwner, councilEpoch);
    }

    function getProposal(uint256 id) external view returns (Proposal memory) {
        if (_proposals[id].target == address(0)) revert InvalidProposal();
        return _proposals[id];
    }

    function _pending(uint256 id) private view returns (Proposal storage p) {
        p = _proposals[id];
        if (p.target == address(0) || p.executed || p.cancelled || p.epoch != councilEpoch || block.timestamp >= p.deadline) revert InvalidProposal();
    }
}

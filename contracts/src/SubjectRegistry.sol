// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Governed} from "./base/Governed.sol";

/// @notice Pseudonymous subject-to-key binding. Identity checks occur off-chain.
contract SubjectRegistry is Governed {
    struct Subject { address key; uint64 epoch; }
    mapping(bytes32 => Subject) private _subjects;
    event SubjectRegistered(bytes32 indexed subjectRef, address indexed key);
    event SubjectKeyChanged(bytes32 indexed subjectRef, address indexed oldKey, address indexed newKey, uint64 epoch, bool recovery);
    event SubjectEpochAdvanced(bytes32 indexed subjectRef, uint64 epoch);

    constructor(address governance_) Governed(governance_) {}

    function registerSubject(bytes32 subjectRef, address key) external onlyGovernance {
        if (subjectRef == bytes32(0) || key == address(0)) revert InvalidInput();
        if (_subjects[subjectRef].key != address(0)) revert AlreadyExists();
        _subjects[subjectRef] = Subject(key, 1);
        emit SubjectRegistered(subjectRef, key);
    }

    function rotateKey(bytes32 subjectRef, address newKey) external {
        if (msg.sender != _subjects[subjectRef].key) revert Unauthorized();
        _changeKey(subjectRef, newKey, false);
    }

    /// @dev Requires consortium identity recovery off-chain and a 3/5 governance call.
    function recoverKey(bytes32 subjectRef, address newKey) external onlyGovernance {
        _changeKey(subjectRef, newKey, true);
    }

    /// @notice Invalidates all existing consents and pending signed requests for the subject.
    function invalidateAuthorizations(bytes32 subjectRef) external {
        Subject storage subject = _subjects[subjectRef];
        if (msg.sender != subject.key && msg.sender != governance) revert Unauthorized();
        if (subject.key == address(0)) revert NotFound();
        ++subject.epoch;
        emit SubjectEpochAdvanced(subjectRef, subject.epoch);
    }

    function getSubject(bytes32 subjectRef) external view returns (Subject memory subject) {
        subject = _subjects[subjectRef];
        if (subject.key == address(0)) revert NotFound();
    }

    function exists(bytes32 subjectRef) external view returns (bool) { return _subjects[subjectRef].key != address(0); }

    function _changeKey(bytes32 subjectRef, address newKey, bool recovery) private {
        Subject storage subject = _subjects[subjectRef];
        if (subject.key == address(0)) revert NotFound();
        if (newKey == address(0) || newKey == subject.key) revert InvalidInput();
        address oldKey = subject.key;
        subject.key = newKey;
        ++subject.epoch;
        emit SubjectKeyChanged(subjectRef, oldKey, newKey, subject.epoch, recovery);
    }
}

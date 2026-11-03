// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Governed} from "./base/Governed.sol";

/// @notice Stores immutable schema definitions by content digest, never personal data.
contract SchemaRegistry is Governed {
    // Organization kinds: 1 = company, 2 = university, 3 = certification body.
    struct Schema {
        bytes32 definitionHash;
        uint8 issuerKind;
        bool allowsNoExpiry;
        bool enabled;
    }

    mapping(bytes32 => mapping(uint32 => Schema)) private _schemas;
    event SchemaRegistered(bytes32 indexed schemaId, uint32 indexed version, bytes32 definitionHash, uint8 issuerKind, bool allowsNoExpiry);
    event SchemaEnabled(bytes32 indexed schemaId, uint32 indexed version, bool enabled);

    constructor(address governance_) Governed(governance_) {}

    function registerSchema(bytes32 schemaId, uint32 version, bytes32 definitionHash, uint8 issuerKind, bool allowsNoExpiry) external onlyGovernance {
        if (schemaId == bytes32(0) || version == 0 || definitionHash == bytes32(0) || issuerKind < 1 || issuerKind > 3) revert InvalidInput();
        if (_schemas[schemaId][version].definitionHash != bytes32(0)) revert AlreadyExists();
        _schemas[schemaId][version] = Schema(definitionHash, issuerKind, allowsNoExpiry, true);
        emit SchemaRegistered(schemaId, version, definitionHash, issuerKind, allowsNoExpiry);
    }

    /// @dev Disabling only blocks new issuance; previously issued records are unchanged.
    function setEnabled(bytes32 schemaId, uint32 version, bool enabled) external onlyGovernance {
        if (_schemas[schemaId][version].definitionHash == bytes32(0)) revert NotFound();
        _schemas[schemaId][version].enabled = enabled;
        emit SchemaEnabled(schemaId, version, enabled);
    }

    function getSchema(bytes32 schemaId, uint32 version) external view returns (Schema memory s) {
        s = _schemas[schemaId][version];
        if (s.definitionHash == bytes32(0)) revert NotFound();
    }
}

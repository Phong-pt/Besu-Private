
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Governed} from "./base/Governed.sol";
import {SchemaRegistry} from "./SchemaRegistry.sol";

contract OrganizationRegistry is Governed {
    enum Status { NONE, PENDING, ACTIVE, SUSPENDED, REMOVED }
    struct Organization { address admin; uint8 kind; Status status; }
    struct KeyPeriod { uint64 authorizedAt; uint64 revokedAt; uint64 authorizedBlock; uint64 revokedBlock; }

    SchemaRegistry public immutable schemas;
    mapping(bytes32 => Organization) private _organizations;
    mapping(bytes32 => mapping(bytes32 => mapping(uint32 => bool))) public issuerScope;
    mapping(bytes32 => mapping(address => bool)) public authorizedKeys;
    mapping(bytes32 => mapping(address => KeyPeriod[])) private _keyHistory;

    event OrganizationRegistered(bytes32 indexed orgId, address indexed admin, uint8 kind);
    event OrganizationActivated(bytes32 indexed orgId);
    event OrganizationSuspended(bytes32 indexed orgId);
    event OrganizationRemoved(bytes32 indexed orgId);
    event OrganizationAdminChanged(bytes32 indexed orgId, address indexed oldAdmin, address indexed newAdmin);
    event IssuerKeyAuthorized(bytes32 indexed orgId, address indexed key, uint256 period);
    event IssuerKeyRevoked(bytes32 indexed orgId, address indexed key, uint256 period);
    event IssuerScopeChanged(bytes32 indexed orgId, bytes32 indexed schemaId, uint32 indexed version, bool allowed);

    constructor(address governance_, SchemaRegistry schemas_) Governed(governance_) {
        if (address(schemas_).code.length == 0) revert InvalidInput();
        schemas = schemas_;
    }

    /// @dev Applications are submitted off-chain; governance reserves IDs to prevent squatting.
    function registerOrganization(bytes32 orgId, address admin, uint8 kind) external onlyGovernance {
        if (orgId == bytes32(0) || admin == address(0) || kind < 1 || kind > 3) revert InvalidInput();
        if (_organizations[orgId].status != Status.NONE) revert AlreadyExists();
        _organizations[orgId] = Organization(admin, kind, Status.PENDING);
        emit OrganizationRegistered(orgId, admin, kind);
    }

    function activateOrganization(bytes32 orgId) external onlyGovernance {
        Organization storage org = _organization(orgId);
        if (org.status != Status.PENDING && org.status != Status.SUSPENDED) revert InvalidState();
        org.status = Status.ACTIVE;
        emit OrganizationActivated(orgId);
    }

    function suspendOrganization(bytes32 orgId) external onlyGovernance {
        Organization storage org = _organization(orgId);
        if (org.status != Status.ACTIVE) revert InvalidState();
        org.status = Status.SUSPENDED;
        emit OrganizationSuspended(orgId);
    }

    function removeOrganization(bytes32 orgId) external onlyGovernance {
        Organization storage org = _organization(orgId);
        if (org.status == Status.REMOVED) revert InvalidState();
        org.status = Status.REMOVED;
        emit OrganizationRemoved(orgId);
    }

    function setAdmin(bytes32 orgId, address admin) external onlyGovernance {
        Organization storage org = _organization(orgId);
        if (admin == address(0) || org.status == Status.REMOVED) revert InvalidInput();
        emit OrganizationAdminChanged(orgId, org.admin, admin);
        org.admin = admin;
    }

    function setIssuerScope(bytes32 orgId, bytes32 schemaId, uint32 version, bool allowed) external onlyGovernance {
        Organization storage org = _organization(orgId);
        SchemaRegistry.Schema memory schema = schemas.getSchema(schemaId, version);
        if (allowed && (org.status != Status.ACTIVE || schema.issuerKind != org.kind || !schema.enabled)) revert InvalidState();
        issuerScope[orgId][schemaId][version] = allowed;
        emit IssuerScopeChanged(orgId, schemaId, version, allowed);
    }

    function authorizeIssuerKey(bytes32 orgId, address key) external {
        Organization storage org = _organization(orgId);
        _requireAdmin(org);
        if (key == address(0) || org.status != Status.ACTIVE) revert InvalidInput();
        if (authorizedKeys[orgId][key]) revert AlreadyExists();
        authorizedKeys[orgId][key] = true;
        _keyHistory[orgId][key].push(KeyPeriod(uint64(block.timestamp), 0, uint64(block.number), 0));
        emit IssuerKeyAuthorized(orgId, key, _keyHistory[orgId][key].length - 1);
    }

    function revokeIssuerKey(bytes32 orgId, address key) external {
        Organization storage org = _organization(orgId);
        _requireAdmin(org);
        if (!authorizedKeys[orgId][key]) revert NotFound();
        authorizedKeys[orgId][key] = false;
        uint256 period = _keyHistory[orgId][key].length - 1;
        KeyPeriod storage history = _keyHistory[orgId][key][period];
        history.revokedAt = uint64(block.timestamp);
        history.revokedBlock = uint64(block.number);
        emit IssuerKeyRevoked(orgId, key, period);
    }

    function canIssue(bytes32 orgId, address key, bytes32 schemaId, uint32 version) external view returns (bool) {
        return isActive(orgId) && authorizedKeys[orgId][key] && issuerScope[orgId][schemaId][version];
    }

    /// @notice Suspension blocks issuance but still permits an authorized key to revoke.
    function canRevoke(bytes32 orgId, address key) external view returns (bool) {
        Status status = _organizations[orgId].status;
        return (status == Status.ACTIVE || status == Status.SUSPENDED) && authorizedKeys[orgId][key];
    }

    function isActive(bytes32 orgId) public view returns (bool) { return _organizations[orgId].status == Status.ACTIVE; }
    function getOrganization(bytes32 orgId) external view returns (Organization memory) { return _organization(orgId); }
    function keyHistoryCount(bytes32 orgId, address key) external view returns (uint256) { return _keyHistory[orgId][key].length; }
    function getKeyPeriod(bytes32 orgId, address key, uint256 index) external view returns (KeyPeriod memory) { return _keyHistory[orgId][key][index]; }

    function _organization(bytes32 orgId) private view returns (Organization storage org) {
        org = _organizations[orgId];
        if (org.status == Status.NONE) revert NotFound();
    }

    function _requireAdmin(Organization storage org) private view {
        if (msg.sender != governance && msg.sender != org.admin) revert Unauthorized();
    }
}

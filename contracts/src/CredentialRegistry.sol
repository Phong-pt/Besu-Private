// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Governed} from "./base/Governed.sol";
import {OrganizationRegistry} from "./OrganizationRegistry.sol";
import {SchemaRegistry} from "./SchemaRegistry.sol";
import {SubjectRegistry} from "./SubjectRegistry.sol";

contract CredentialRegistry is Governed, EIP712 {
    enum Status { NONE, ISSUED, REVOKED, SUPERSEDED }
    enum EffectiveStatus { NONE, ISSUED, REVOKED, SUPERSEDED, EXPIRED }

    struct CredentialData {
        bytes32 credentialId;
        bytes32 issuerOrgId;
        bytes32 subjectRef;
        bytes32 schemaId;
        uint32 schemaVersion;
        bytes32 commitment;
        uint64 expiresAt;
    }
    struct Credential {
        CredentialData data;
        address issuerKey;
        uint64 issuedAt;
        uint64 issuedBlock;
        uint256 issuerKeyVersion;
        Status status;
        bytes32 replacementId;
    }
    struct Authorization { address signer; uint256 keyVersion; uint256 nonce; uint64 deadline; }

    bytes32 public constant DATA_TYPEHASH = keccak256("CredentialData(bytes32 credentialId,bytes32 issuerOrgId,bytes32 subjectRef,bytes32 schemaId,uint32 schemaVersion,bytes32 commitment,uint64 expiresAt)");
    bytes32 public constant ISSUE_TYPEHASH = keccak256("IssueCredential(CredentialData credential,address signer,uint256 keyVersion,uint256 nonce,uint64 deadline)CredentialData(bytes32 credentialId,bytes32 issuerOrgId,bytes32 subjectRef,bytes32 schemaId,uint32 schemaVersion,bytes32 commitment,uint64 expiresAt)");
    bytes32 public constant REPLACE_TYPEHASH = keccak256("ReplaceCredential(bytes32 previousId,CredentialData credential,address signer,uint256 keyVersion,uint256 nonce,uint64 deadline)CredentialData(bytes32 credentialId,bytes32 issuerOrgId,bytes32 subjectRef,bytes32 schemaId,uint32 schemaVersion,bytes32 commitment,uint64 expiresAt)");
    bytes32 public constant REVOKE_TYPEHASH = keccak256("RevokeCredential(bytes32 credentialId,address signer,uint256 keyVersion,uint256 nonce,uint64 deadline)");

    OrganizationRegistry public immutable organizations;
    SchemaRegistry public immutable schemas;
    SubjectRegistry public immutable subjects;
    mapping(bytes32 => Credential) private _credentials;
    mapping(address => uint256) public nonces;
    bool public issuancePaused;

    error InvalidSignature();
    error InvalidNonce();
    error SignatureExpired();
    error IssuancePaused();

    event CredentialIssued(bytes32 indexed credentialId, bytes32 indexed issuerOrgId, bytes32 indexed subjectRef, address issuerKey, uint256 issuerKeyVersion, bytes32 schemaId, uint32 schemaVersion, bytes32 commitment, uint64 issuedAt, uint64 expiresAt);
    event CredentialRevoked(bytes32 indexed credentialId, address indexed actor, bool emergency);
    event CredentialSuperseded(bytes32 indexed previousId, bytes32 indexed replacementId);
    event IssuancePauseChanged(bool paused);
    event NonceInvalidated(address indexed signer, uint256 nonce);

    constructor(address governance_, OrganizationRegistry organizations_, SubjectRegistry subjects_)
        Governed(governance_) EIP712("BesuCredentialRegistry", "1")
    {
        if (address(organizations_).code.length == 0 || address(subjects_).code.length == 0) revert InvalidInput();
        organizations = organizations_;
        schemas = organizations_.schemas();
        subjects = subjects_;
    }

    function setIssuancePaused(bool paused) external onlyGovernance {
        issuancePaused = paused;
        emit IssuancePauseChanged(paused);
    }

    function invalidateNonce(uint256 newNonce) external {
        if (newNonce <= nonces[msg.sender]) revert InvalidNonce();
        nonces[msg.sender] = newNonce;
        emit NonceInvalidated(msg.sender, newNonce);
    }

    function issueCredential(CredentialData calldata data) external { _issue(data, msg.sender); }

    function issueCredentialBySig(CredentialData calldata data, Authorization calldata auth, bytes calldata signature) external {
        bytes32 structHash = keccak256(abi.encode(ISSUE_TYPEHASH, hashCredentialData(data), auth.signer, auth.keyVersion, auth.nonce, auth.deadline));
        _authorize(data.issuerOrgId, auth, structHash, signature);
        _issue(data, auth.signer);
    }

    function revokeCredential(bytes32 credentialId) external { _revoke(credentialId, msg.sender); }

    function revokeCredentialBySig(bytes32 credentialId, Authorization calldata auth, bytes calldata signature) external {
        Credential storage credential = _credential(credentialId);
        bytes32 structHash = keccak256(abi.encode(REVOKE_TYPEHASH, credentialId, auth.signer, auth.keyVersion, auth.nonce, auth.deadline));
        _authorize(credential.data.issuerOrgId, auth, structHash, signature);
        _revoke(credentialId, auth.signer);
    }

    function replaceCredential(bytes32 previousId, CredentialData calldata replacement) external { _replace(previousId, replacement, msg.sender); }

    function replaceCredentialBySig(bytes32 previousId, CredentialData calldata replacement, Authorization calldata auth, bytes calldata signature) external {
        bytes32 structHash = keccak256(abi.encode(REPLACE_TYPEHASH, previousId, hashCredentialData(replacement), auth.signer, auth.keyVersion, auth.nonce, auth.deadline));
        _authorize(replacement.issuerOrgId, auth, structHash, signature);
        _replace(previousId, replacement, auth.signer);
    }

    function getCredential(bytes32 credentialId) external view returns (Credential memory) { return _credential(credentialId); }

    /// @notice This is a lifecycle status, not a complete verification verdict.
    function getEffectiveStatus(bytes32 credentialId) public view returns (EffectiveStatus) {
        Credential storage credential = _credentials[credentialId];
        if (credential.status == Status.ISSUED && credential.data.expiresAt != 0 && block.timestamp >= credential.data.expiresAt) return EffectiveStatus.EXPIRED;
        return EffectiveStatus(uint8(credential.status));
    }

    function hashCredentialData(CredentialData calldata data) public pure returns (bytes32) {
        return keccak256(abi.encode(DATA_TYPEHASH, data));
    }

    function _issue(CredentialData calldata data, address signer) private {
        if (issuancePaused) revert IssuancePaused();
        if (data.credentialId == bytes32(0) || data.commitment == bytes32(0)) revert InvalidInput();
        if (_credentials[data.credentialId].status != Status.NONE) revert AlreadyExists();
        if (!subjects.exists(data.subjectRef)) revert NotFound();
        if (!organizations.canIssue(data.issuerOrgId, signer, data.schemaId, data.schemaVersion)) revert Unauthorized();
        SchemaRegistry.Schema memory schema = schemas.getSchema(data.schemaId, data.schemaVersion);
        if (!schema.enabled) revert InvalidState();
        if (data.expiresAt == 0 ? !schema.allowsNoExpiry : data.expiresAt <= block.timestamp) revert InvalidInput();

        uint256 keyVersion = organizations.keyHistoryCount(data.issuerOrgId, signer);
        _credentials[data.credentialId] = Credential(data, signer, uint64(block.timestamp), uint64(block.number), keyVersion, Status.ISSUED, bytes32(0));
        emit CredentialIssued(data.credentialId, data.issuerOrgId, data.subjectRef, signer, keyVersion, data.schemaId, data.schemaVersion, data.commitment, uint64(block.timestamp), data.expiresAt);
    }

    function _revoke(bytes32 credentialId, address actor) private {
        Credential storage credential = _credential(credentialId);
        bool emergency = actor == governance;
        if (!emergency && !organizations.canRevoke(credential.data.issuerOrgId, actor)) revert Unauthorized();
        // Superseded records can also be revoked, preserving their replacement link.
        if (credential.status == Status.REVOKED) revert InvalidState();
        credential.status = Status.REVOKED;
        emit CredentialRevoked(credentialId, actor, emergency);
    }

    function _replace(bytes32 previousId, CredentialData calldata replacement, address signer) private {
        Credential storage previous = _credential(previousId);
        if (previous.status != Status.ISSUED) revert InvalidState();
        if (replacement.issuerOrgId != previous.data.issuerOrgId || replacement.subjectRef != previous.data.subjectRef || replacement.schemaId != previous.data.schemaId) revert InvalidInput();
        _issue(replacement, signer);
        previous.status = Status.SUPERSEDED;
        previous.replacementId = replacement.credentialId;
        emit CredentialSuperseded(previousId, replacement.credentialId);
    }

    function _credential(bytes32 credentialId) private view returns (Credential storage credential) {
        credential = _credentials[credentialId];
        if (credential.status == Status.NONE) revert NotFound();
    }

    function _authorize(bytes32 orgId, Authorization calldata auth, bytes32 structHash, bytes calldata signature) private {
        if (block.timestamp >= auth.deadline) revert SignatureExpired();
        if (auth.nonce != nonces[auth.signer]) revert InvalidNonce();
        if (auth.keyVersion != organizations.keyHistoryCount(orgId, auth.signer)) revert InvalidSignature();
        if (!SignatureChecker.isValidSignatureNow(auth.signer, _hashTypedDataV4(structHash), signature)) revert InvalidSignature();
        ++nonces[auth.signer];
    }
}

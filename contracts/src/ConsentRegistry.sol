// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Governed} from "./base/Governed.sol";
import {SubjectRegistry} from "./SubjectRegistry.sol";
import {OrganizationRegistry} from "./OrganizationRegistry.sol";
import {CredentialRegistry} from "./CredentialRegistry.sol";

/// @notice Authorizes delivery of whole off-chain credentials; never hides chain data.
contract ConsentRegistry is Governed, EIP712 {
    enum Status { NONE, GRANTED, REVOKED }
    struct Grant {
        bytes32 consentId;
        bytes32 subjectRef;
        bytes32 granteeOrgId;
        bytes32[] credentialScope;
        uint64 expiresAt;
        uint64 subjectEpoch;
        uint256 nonce;
        uint64 deadline;
    }
    struct Consent {
        bytes32 subjectRef;
        bytes32 granteeOrgId;
        bytes32 scopeHash;
        uint64 expiresAt;
        uint64 subjectEpoch;
        uint256 nonce;
        Status status;
    }

    uint256 public constant MAX_SCOPE = 32;
    bytes32 public constant GRANT_TYPEHASH = keccak256("GrantConsent(bytes32 consentId,bytes32 subjectRef,bytes32 granteeOrgId,bytes32[] credentialScope,uint64 expiresAt,uint64 subjectEpoch,uint256 nonce,uint64 deadline)");
    bytes32 public constant REVOKE_TYPEHASH = keccak256("RevokeConsent(bytes32 consentId,bytes32 subjectRef,uint64 subjectEpoch,uint256 nonce,uint64 deadline)");
    SubjectRegistry public immutable subjects;
    OrganizationRegistry public immutable organizations;
    CredentialRegistry public immutable credentials;

    mapping(bytes32 => Consent) private _consents;
    mapping(bytes32 => bytes32[]) private _scopes;
    mapping(bytes32 => mapping(bytes32 => bool)) public includesCredential;
    mapping(bytes32 => uint256) public nonces;

    error InvalidSignature();
    error InvalidNonce();
    error SignatureExpired();

    event ConsentGranted(bytes32 indexed consentId, bytes32 indexed subjectRef, bytes32 indexed granteeOrgId, bytes32[] credentialScope, uint64 expiresAt, uint64 subjectEpoch, uint256 nonce);
    event ConsentRevoked(bytes32 indexed consentId, bytes32 indexed subjectRef, address indexed actor);
    event NonceInvalidated(bytes32 indexed subjectRef, uint256 nonce);

    constructor(address governance_, CredentialRegistry credentials_)
        Governed(governance_) EIP712("BesuConsentRegistry", "1")
    {
        if (address(credentials_).code.length == 0) revert InvalidInput();
        credentials = credentials_;
        subjects = credentials_.subjects();
        organizations = credentials_.organizations();
    }

    /// @notice Even a relayer must supply the current holder's EIP-712 signature.
    function grantConsent(Grant calldata grant, bytes calldata signature) external {
        if (grant.consentId == bytes32(0) || grant.expiresAt <= block.timestamp || grant.credentialScope.length == 0 || grant.credentialScope.length > MAX_SCOPE) revert InvalidInput();
        if (_consents[grant.consentId].status != Status.NONE) revert AlreadyExists();
        if (!organizations.isActive(grant.granteeOrgId)) revert InvalidState();
        bytes32 scopeHash = keccak256(abi.encodePacked(grant.credentialScope));
        bytes32 structHash = keccak256(abi.encode(GRANT_TYPEHASH, grant.consentId, grant.subjectRef, grant.granteeOrgId, scopeHash, grant.expiresAt, grant.subjectEpoch, grant.nonce, grant.deadline));
        _authorize(grant.subjectRef, grant.subjectEpoch, grant.nonce, grant.deadline, structHash, signature);

        for (uint256 i; i < grant.credentialScope.length; ++i) {
            bytes32 credentialId = grant.credentialScope[i];
            if (includesCredential[grant.consentId][credentialId]) revert InvalidInput();
            CredentialRegistry.Credential memory credential = credentials.getCredential(credentialId);
            if (credential.data.subjectRef != grant.subjectRef || credentials.getEffectiveStatus(credentialId) != CredentialRegistry.EffectiveStatus.ISSUED) revert InvalidState();
            includesCredential[grant.consentId][credentialId] = true;
        }
        _consents[grant.consentId] = Consent(grant.subjectRef, grant.granteeOrgId, scopeHash, grant.expiresAt, grant.subjectEpoch, grant.nonce, Status.GRANTED);
        _scopes[grant.consentId] = grant.credentialScope;
        emit ConsentGranted(grant.consentId, grant.subjectRef, grant.granteeOrgId, grant.credentialScope, grant.expiresAt, grant.subjectEpoch, grant.nonce);
    }

    function revokeConsent(bytes32 consentId) external {
        Consent storage consent = _consent(consentId);
        SubjectRegistry.Subject memory subject = subjects.getSubject(consent.subjectRef);
        if (msg.sender != subject.key && msg.sender != governance) revert Unauthorized();
        _revoke(consentId, consent, msg.sender);
    }

    function revokeConsentBySig(bytes32 consentId, uint64 subjectEpoch, uint256 nonce, uint64 deadline, bytes calldata signature) external {
        Consent storage consent = _consent(consentId);
        bytes32 structHash = keccak256(abi.encode(REVOKE_TYPEHASH, consentId, consent.subjectRef, subjectEpoch, nonce, deadline));
        address signer = _authorize(consent.subjectRef, subjectEpoch, nonce, deadline, structHash, signature);
        _revoke(consentId, consent, signer);
    }

    /// @dev Cancels pending signatures, not already granted consents. For all grants use subject epoch invalidation.
    function invalidateNonce(bytes32 subjectRef, uint256 newNonce) external {
        SubjectRegistry.Subject memory subject = subjects.getSubject(subjectRef);
        if (msg.sender != subject.key) revert Unauthorized();
        if (newNonce <= nonces[subjectRef]) revert InvalidNonce();
        nonces[subjectRef] = newNonce;
        emit NonceInvalidated(subjectRef, newNonce);
    }

    function isConsentValid(bytes32 consentId, bytes32 subjectRef, bytes32 granteeOrgId, bytes32 credentialId) external view returns (bool) {
        Consent storage consent = _consents[consentId];
        if (consent.status != Status.GRANTED || consent.subjectRef != subjectRef || consent.granteeOrgId != granteeOrgId || block.timestamp >= consent.expiresAt || !includesCredential[consentId][credentialId]) return false;
        if (!organizations.isActive(granteeOrgId)) return false;
        SubjectRegistry.Subject memory subject = subjects.getSubject(subjectRef);
        return subject.epoch == consent.subjectEpoch && credentials.getEffectiveStatus(credentialId) == CredentialRegistry.EffectiveStatus.ISSUED;
    }

    function getConsent(bytes32 consentId) external view returns (Consent memory) { return _consent(consentId); }
    function getScope(bytes32 consentId) external view returns (bytes32[] memory) { _consent(consentId); return _scopes[consentId]; }

    function _consent(bytes32 consentId) private view returns (Consent storage consent) {
        consent = _consents[consentId];
        if (consent.status == Status.NONE) revert NotFound();
    }

    function _revoke(bytes32 consentId, Consent storage consent, address actor) private {
        if (consent.status != Status.GRANTED) revert InvalidState();
        consent.status = Status.REVOKED;
        emit ConsentRevoked(consentId, consent.subjectRef, actor);
    }

    function _authorize(bytes32 subjectRef, uint64 epoch, uint256 nonce, uint64 deadline, bytes32 structHash, bytes calldata signature) private returns (address signer) {
        if (block.timestamp >= deadline) revert SignatureExpired();
        if (nonces[subjectRef] != nonce) revert InvalidNonce();
        SubjectRegistry.Subject memory subject = subjects.getSubject(subjectRef);
        if (subject.epoch != epoch || !SignatureChecker.isValidSignatureNow(subject.key, _hashTypedDataV4(structHash), signature)) revert InvalidSignature();
        ++nonces[subjectRef];
        return subject.key;
    }
}

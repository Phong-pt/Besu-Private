-- Demo off-chain data and chain indexes; values here do not prove on-chain state.
BEGIN;
CREATE TABLE organizations (
    org_id text PRIMARY KEY,
    name text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('university', 'certifier', 'employer', 'verifier')),
    status text NOT NULL CHECK (status IN ('pending', 'active', 'suspended', 'removed')),
    chain_org_id text UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE organization_members (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org_id text NOT NULL REFERENCES organizations,
    display_name text NOT NULL,
    role text NOT NULL,
    UNIQUE (org_id, display_name, role)
);
CREATE TABLE issuer_key_history (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org_id text NOT NULL REFERENCES organizations,
    address text NOT NULL,
    authorized_at timestamptz NOT NULL,
    revoked_at timestamptz,
    CHECK (revoked_at IS NULL OR revoked_at >= authorized_at),
    UNIQUE (org_id, address, authorized_at)
);
CREATE TABLE subjects (
    subject_ref text PRIMARY KEY,
    display_name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE subject_key_bindings (
    subject_ref text NOT NULL REFERENCES subjects,
    epoch bigint NOT NULL CHECK (epoch > 0),
    address text NOT NULL,
    bound_at timestamptz NOT NULL,
    ended_at timestamptz,
    PRIMARY KEY (subject_ref, epoch),
    CHECK (ended_at IS NULL OR ended_at >= bound_at)
);
CREATE TABLE credential_schemas (
    schema_id text NOT NULL,
    version integer NOT NULL CHECK (version > 0),
    name text NOT NULL,
    PRIMARY KEY (schema_id, version)
);
CREATE TABLE credential_documents (
    document_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    object_reference text NOT NULL UNIQUE,
    encryption_key_reference text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE credential_index (
    credential_id text PRIMARY KEY,
    issuer_org_id text NOT NULL REFERENCES organizations,
    subject_ref text NOT NULL REFERENCES subjects,
    schema_id text NOT NULL,
    schema_version integer NOT NULL,
    document_id bigint REFERENCES credential_documents,
    commitment text,
    indexed_status text NOT NULL CHECK (indexed_status IN ('issued', 'revoked', 'superseded')),
    issued_at timestamptz NOT NULL,
    expires_at timestamptz,
    replacement_id text REFERENCES credential_index,
    last_indexed_block bigint,
    FOREIGN KEY (schema_id, schema_version) REFERENCES credential_schemas,
    CHECK (expires_at IS NULL OR expires_at > issued_at)
);
CREATE INDEX credential_index_subject ON credential_index (subject_ref);
CREATE TABLE consent_index (
    consent_id text PRIMARY KEY,
    subject_ref text NOT NULL REFERENCES subjects,
    grantee_org_id text NOT NULL REFERENCES organizations,
    indexed_status text NOT NULL CHECK (indexed_status IN ('granted', 'revoked')),
    subject_epoch bigint NOT NULL CHECK (subject_epoch > 0),
    expires_at timestamptz NOT NULL,
    last_indexed_block bigint
);
CREATE TABLE consent_credentials (
    consent_id text NOT NULL REFERENCES consent_index,
    credential_id text NOT NULL REFERENCES credential_index,
    PRIMARY KEY (consent_id, credential_id)
);
CREATE TABLE verification_challenges (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    subject_ref text NOT NULL REFERENCES subjects,
    verifier_org_id text NOT NULL REFERENCES organizations,
    nonce text NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz
);
CREATE TABLE verification_results (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    challenge_id bigint REFERENCES verification_challenges,
    credential_id text NOT NULL REFERENCES credential_index,
    result text NOT NULL CHECK (result IN ('valid', 'invalid', 'indeterminate')),
    checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE operations (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org_id text NOT NULL REFERENCES organizations,
    idempotency_key text NOT NULL,
    operation_type text NOT NULL,
    status text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, idempotency_key)
);
CREATE TABLE processed_chain_events (
    chain_id bigint NOT NULL,
    block_hash text NOT NULL,
    transaction_hash text NOT NULL,
    log_index integer NOT NULL CHECK (log_index >= 0),
    block_number bigint NOT NULL CHECK (block_number >= 0),
    PRIMARY KEY (chain_id, block_hash, transaction_hash, log_index)
);
CREATE TABLE indexer_checkpoints (
    chain_id bigint NOT NULL,
    indexer_name text NOT NULL,
    block_number bigint NOT NULL CHECK (block_number >= 0),
    block_hash text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, indexer_name)
);
CREATE TABLE audit_logs (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org_id text REFERENCES organizations,
    actor text NOT NULL,
    action text NOT NULL,
    target_reference text,
    recorded_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;

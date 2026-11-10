-- Additive migration. Existing mock business data is retained.
CREATE TABLE IF NOT EXISTS demo_chain_events (
    namespace text NOT NULL,
    block_number bigint NOT NULL,
    block_hash text NOT NULL,
    transaction_hash text NOT NULL,
    log_index integer NOT NULL,
    contract_name text NOT NULL,
    event_name text NOT NULL,
    arguments jsonb NOT NULL,
    PRIMARY KEY (namespace, transaction_hash, log_index)
);
CREATE TABLE IF NOT EXISTS demo_index_checkpoints (
    namespace text PRIMARY KEY,
    block_number bigint NOT NULL,
    block_hash text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS demo_event_order ON demo_chain_events(namespace, block_number, log_index);
CREATE OR REPLACE VIEW demo_credential_projection AS
SELECT DISTINCT ON (namespace, arguments->>'credentialId')
    namespace, arguments->>'credentialId' AS credential_id,
    event_name, block_number, block_hash, transaction_hash, arguments
FROM (
    SELECT namespace, event_name, block_number, block_hash, transaction_hash, log_index, arguments
    FROM demo_chain_events WHERE event_name IN ('CredentialIssued', 'CredentialRevoked')
    UNION ALL
    SELECT namespace, event_name, block_number, block_hash, transaction_hash, log_index,
        arguments || jsonb_build_object('credentialId', arguments->>'previousId')
    FROM demo_chain_events WHERE event_name = 'CredentialSuperseded'
) events
ORDER BY namespace, arguments->>'credentialId', block_number DESC, log_index DESC;

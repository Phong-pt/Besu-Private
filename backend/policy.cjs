// Shared response policy. Never include RPC URLs, signed bytes or underlying errors.
const TEMPORARY = new Set(['OPERATION_FAILED', 'CHAIN_NOT_FRESH', 'CHAIN_REORGANIZED',
  'CHAIN_IDENTITY_MISMATCH', 'CONTRACT_UNAVAILABLE', 'DATABASE_UNAVAILABLE',
  'FINALITY_UNAVAILABLE', 'BROADCAST_PENDING_RETRY', 'TRANSACTION_PENDING',
  'DOCUMENT_UNAVAILABLE', 'UNSUPPORTED_SCHEMA', 'SERVER_SHUTTING_DOWN']);

function safeError(error) {
  return /^[A-Z][A-Z0-9_]+$/.test(error?.message || '') ? error.message : 'OPERATION_FAILED';
}
function errorResponse(error) {
  const code = safeError(error);
  const status = code === 'UNAUTHORIZED' ? 401 : code === 'ACCESS_DENIED' ? 403 :
    code === 'REQUEST_TOO_LARGE' ? 413 : ['RATE_LIMITED', 'QUEUE_FULL', 'TOO_MANY_SESSIONS'].includes(code) ? 429 :
    TEMPORARY.has(code) ? 503 : 400;
  return { status, body: { error: code, ...(TEMPORARY.has(code) ? { result: 'INDETERMINATE', retryable: true } : {}) } };
}
function verdict(checks) {
  const integrity = ['commitmentMatches', 'metadataMatches', 'issuerKeyAtIssuance', 'schemaDefinitionMatches'];
  if (integrity.some(name => checks[name] === false)) return 'INVALID';
  if (integrity.some(name => checks[name] == null)) return 'INDETERMINATE';
  return checks.issuerPolicyAccepted ? 'VALID' : 'REVIEW_REQUIRED';
}

async function jobResult(demo, actorKey, key, job) {
  if (!job.output) return undefined;
  const output = demo.decrypt('output:' + key, job.output);
  // Diagnostic results contain no document: a suspended issuer must still be
  // explainable as REVIEW_REQUIRED to the owner of the verification job.
  if (job.action !== 'verify' || !Object.hasOwn(output, 'payload')) return output;
  const input = demo.decrypt('job:' + key, job.encrypted);
  const challenge = demo.state.challenges[input.challengeId];
  if (!challenge || challenge.value.expiresAt <= Math.floor(Date.now() / 1000)) throw new Error('CHALLENGE_EXPIRED');
  const snap = await demo.guard();
  const { holder } = await demo.access(actorKey, challenge.value.credentialId, challenge.value.consentId, snap);
  const [subject] = await demo.call('SubjectRegistry', 'getSubject', [holder.id], snap);
  if (subject.epoch.toString() !== challenge.value.subjectEpoch) throw new Error('ACCESS_DENIED');
  const [credential] = await demo.call('CredentialRegistry', 'getCredential', [challenge.value.credentialId], snap);
  const [issuer] = await demo.call('OrganizationRegistry', 'getOrganization', [credential.data.issuerOrgId], snap);
  if (Number(issuer.status) !== 2) {
    const { payload, ...metadata } = output;
    return { ...metadata, result: 'REVIEW_REQUIRED', reason: 'ISSUER_NOT_ACTIVE',
      checks: { ...metadata.checks, issuerPolicyAccepted: false },
      deliveryCheckedAt: new Date().toISOString(), deliveryBlockHash: snap.blockHash };
  }
  await demo.chain.assertCanonical(snap);
  return output;
}

module.exports = { TEMPORARY, safeError, errorResponse, verdict, jobResult };

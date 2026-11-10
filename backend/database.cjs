// PostgreSQL shares the application container; use its local Unix socket.
// No shell processes user input and no password is passed on command lines.
const { spawn } = require('node:child_process');

function query(sql, variables = {}, writable = false) {
  return new Promise((resolve, reject) => {
    const args = ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
      '-U', 'credentials_demo', '-d', 'credentials_demo'];
    for (const [key, value] of Object.entries(variables)) args.push('-v', `${key}=${value}`);
    const child = spawn('psql', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let finished = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('DATABASE_UNAVAILABLE'));
    }, 6000);
    function finish(error, result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    }
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 4 * 1024 * 1024) {
        child.kill('SIGKILL');
        finish(new Error('DATABASE_UNAVAILABLE'));
      }
    });
    // Avoid leaking connection details through HTTP responses or logs.
    child.stderr.resume();
    child.on('error', () => finish(new Error('DATABASE_UNAVAILABLE')));
    child.stdin.on('error', () => finish(new Error('DATABASE_UNAVAILABLE')));
    child.on('close', code => {
      if (code !== 0) return finish(new Error('DATABASE_UNAVAILABLE'));
      try { finish(null, JSON.parse(output.trim())); }
      catch { finish(new Error('DATABASE_UNAVAILABLE')); }
    });
    child.stdin.end(`BEGIN ${writable ? '' : 'READ ONLY'};\nSET LOCAL statement_timeout = '3s';\n${sql}\nCOMMIT;\n`);
  });
}

async function health() {
  return query("SELECT json_build_object('available', true);");
}

async function credential(id, namespace) {
  if (/^0x[0-9a-fA-F]{64}$/.test(id) && namespace) {
    return query(`SELECT COALESCE((SELECT json_build_object(
      'indexedStatus', CASE event_name WHEN 'CredentialIssued' THEN 'issued'
        WHEN 'CredentialRevoked' THEN 'revoked' WHEN 'CredentialSuperseded' THEN 'superseded' END,
      'lastIndexedBlock', block_number::text,
      'indexerHeight', (SELECT block_number::text FROM demo_index_checkpoints WHERE namespace = :'ns'),
      'source', 'demo_credential_projection', 'namespace', namespace
      ) FROM demo_credential_projection WHERE namespace = :'ns' AND credential_id = :'credential_id'), 'null'::json);`,
    { credential_id: id.toLowerCase(), ns: namespace });
  }
  return query(`SELECT COALESCE((
    SELECT json_build_object(
      'indexedStatus', indexed_status,
      'lastIndexedBlock', last_indexed_block::text,
      'hasCommitment', commitment IS NOT NULL
    ) FROM credential_index WHERE credential_id = :'credential_id'
  ), 'null'::json);`, { credential_id: id });
}

module.exports = { health, credential, query };

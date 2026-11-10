'use strict';
const $ = id => document.getElementById(id);
const actorNames = { ntq: 'NTQ', v: 'Công ty V', m: 'Công ty M', 'university-c': 'Đại học C', 'university-d': 'Đại học D', 'university-e': 'Đại học E', 'cert-1': 'Cert-1', 'cert-2': 'Cert-2', 'cert-3': 'Cert-3', 'holder-a': 'Cá nhân A', 'holder-b': 'Cá nhân B', 'holder-c': 'Cá nhân C' };
let token = '', actor = '', state = null, busy = false;
const errorNames = { ACCESS_DENIED: 'Không có quyền truy cập hoặc consent đã mất hiệu lực.', UNAUTHORIZED: 'Token không đúng hoặc phiên đã hết hạn.', HOLDER_SIGNATURE_REQUIRED: 'Chủ thể cần ký challenge trước.', CHALLENGE_ALREADY_USED: 'Challenge đã sử dụng. Hãy tạo challenge mới.', CHALLENGE_EXPIRED: 'Challenge đã hết hạn. Hãy tạo challenge mới.', CHAIN_NOT_FRESH: 'Chain chưa theo kịp thời gian hiện tại. Chờ node đồng bộ.', IDEMPOTENCY_CONFLICT: 'Mã yêu cầu đã được dùng cho dữ liệu khác.', TRANSACTION_REVERTED: 'Contract đã từ chối giao dịch. Kiểm tra quyền, trạng thái và thời hạn.', OPERATION_FAILED: 'Thao tác chưa hoàn tất. Kiểm tra chain và nhật ký máy chủ.', INTERRUPTED_REQUEST_NEW_CHALLENGE: 'Máy chủ đã khởi động lại. Tạo một challenge mới.' };
Object.assign(errorNames, { RATE_LIMITED: 'Đã thử đăng nhập nhiều lần. Chờ một phút rồi thử lại.',
  TRANSACTION_PENDING: 'Giao dịch đang chờ. Hệ thống sẽ tự đối soát và thử lại cùng giao dịch.',
  CHAIN_REORGANIZED: 'Chain vừa thay đổi lịch sử. Chưa thể kết luận; hãy đọc lại trạng thái.',
  UNSUPPORTED_SCHEMA: 'Chưa có định nghĩa schema phù hợp để kết luận hồ sơ.',
  QUEUE_FULL: 'Hàng đợi đang đầy. Chờ các tác vụ hiện tại hoàn tất.',
  SERVER_SHUTTING_DOWN: 'Máy chủ đang khởi động lại. Thử lại sau ít giây.' });
const names = key => actorNames[key] || key;
const short = id => id.slice(0, 10) + '…' + id.slice(-6);
function el(tag, text, cls) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; }
function message(text, error = false) { $('message').textContent = text; $('message').className = error ? 'error' : ''; }
function options(select, entries) { select.replaceChildren(...entries.map(([value, label]) => { const o = el('option', label); o.value = value; return o; })); }
options($('actor-select'), Object.entries(actorNames)); $('actor-select').value = 'university-c';
async function api(route, method = 'GET', data, key) {
  const headers = { 'Content-Type': 'application/json' }; if (token) headers.Authorization = 'Bearer ' + token;
  if (key) headers['Idempotency-Key'] = key;
  const response = await fetch(route, { method, headers, body: data === undefined ? undefined : JSON.stringify(data) });
  const output = await response.json(); if (!response.ok) throw Error(errorNames[output.error] || output.error || 'Không kết nối được máy chủ');
  return output;
}
function status(text) { return el('span', text, 'status' + (['REVOKED', 'INVALID', 'EXPIRED', 'INVALIDATED', 'SUPERSEDED'].includes(text) ? ' bad' : ['NONE', 'INDETERMINATE', 'REVIEW_REQUIRED'].includes(text) ? ' neutral' : '')); }
function card(title, label, description, id) {
  const box = el('article', undefined, 'card'); const head = el('div', undefined, 'card-top');
  head.append(el('h3', title), status(label)); box.append(head, el('p', description), el('code', id)); return box;
}
function button(label, fn, cls = 'secondary') { const b = el('button', label, cls); b.type = 'button'; b.addEventListener('click', fn); return b; }
function fill(id, nodes, empty) { $(id).replaceChildren(...(nodes.length ? nodes : [el('div', empty, 'empty')])); }
function render() {
  $('workspace').hidden = false; $('actor-name').textContent = names(actor); $('block').textContent = state.blockNumber.toLocaleString('vi-VN');
  $('document-count').textContent = state.documents.length; $('event-count').textContent = state.indexer.events ?? '—';
  $('index-state').textContent = state.indexer.ready ? `Đã finalized đến block ${state.indexer.blockNumber}; cách head ${state.indexer.lagBlocks} block` : 'Indexer: ' + (state.indexer.error || 'đang đồng bộ');
  $('issue-form').hidden = state.actor.role !== 'organization'; $('grant-form').hidden = state.actor.role !== 'holder';
  $('challenge-form').hidden = state.actor.kind !== 1;
  options($('issue-holder'), state.actors.filter(a => a.role === 'holder').map(a => [a.key, a.name]));
  options($('grant-grantee'), state.actors.filter(a => a.kind === 1).map(a => [a.key, a.name])); $('grant-grantee').value = 'v';
  fill('documents', state.documents.map(d => {
    const schema = state.schemas.find(s => s.key === d.schema)?.name || d.schema;
    const box = card(schema, d.status, `${names(d.issuer)} → ${names(d.holder)}`, d.credentialId);
    if (state.actor.role === 'holder' && d.status === 'ISSUED') {
      const label = el('label', undefined, 'select-row'); const check = el('input'); check.type = 'checkbox'; check.value = d.credentialId; check.name = 'scope';
      label.append(check, document.createTextNode('Chọn để chia sẻ')); box.append(label);
    }
    if (d.issuer === actor && d.status === 'ISSUED') {
      const actions = el('div', undefined, 'card-buttons'); actions.append(button('Thu hồi hồ sơ', () => {
        if (confirm('Thu hồi hồ sơ này trên chain? Thao tác không thể hoàn tác.')) action('revoke', { credentialId: d.credentialId });
      }, 'danger')); box.append(actions);
    }
    return box;
  }), 'Chưa có hồ sơ liên quan đến vai trò này.');
  fill('consents', state.consents.map(c => {
    const box = card('Chia sẻ ' + c.credentialIds.length + ' hồ sơ', c.status, `${names(c.holder)} → ${names(c.grantee)} · Đến ${new Date(c.expiresAt * 1000).toLocaleString('vi-VN')}`, c.consentId);
    if (c.holder === actor && c.status === 'GRANTED') {
      const actions = el('div', undefined, 'card-buttons'); actions.append(button('Thu hồi quyền chia sẻ', () => {
        if (confirm('Thu hồi quyền chia sẻ cho doanh nghiệp này?')) action('revoke', { consentId: c.consentId });
      }, 'danger')); box.append(actions);
    }
    return box;
  }), 'Chưa có consent. Chọn vai trò cá nhân để cấp quyền chia sẻ.');
  options($('verify-consent'), state.consents.filter(c => c.grantee === actor && c.status === 'GRANTED').map(c => [c.consentId, names(c.holder) + ' · ' + short(c.consentId)]));
  updateScope();
  fill('challenges', state.challenges.map(c => {
    const expired = c.expiresAt * 1000 <= Date.now();
    const label = c.consumed ? 'ĐÃ DÙNG' : expired ? 'EXPIRED' : c.signed ? 'ĐÃ KÝ' : 'CHỜ KÝ';
    const box = card('Xác minh ' + short(c.credentialId), label, `${names(c.holder)} → ${names(c.verifier)}`, c.challengeId);
    const actions = el('div', undefined, 'card-buttons');
    if (!c.consumed && !expired && c.holder === actor && !c.signed) actions.append(button('Ký challenge', () => action('sign', { challengeId: c.challengeId })));
    if (!c.consumed && !expired && c.verifier === actor && c.signed) {
      actions.append(button('Xác minh hồ sơ', () => action('verify', { challengeId: c.challengeId })));
      actions.append(button('Mô phỏng sửa payload', () => action('verify', { challengeId: c.challengeId, simulateTamper: true }), 'danger'));
    }
    box.append(actions); return box;
  }), 'Chưa có challenge. Doanh nghiệp nhận consent sẽ tạo yêu cầu.');
  const checkNames = { subjectProofValid: 'Chủ thể', consentValid: 'Consent', credentialActive: 'Hiệu lực hồ sơ', commitmentMatches: 'Toàn vẹn', metadataMatches: 'Metadata', issuerKeyAtIssuance: 'Khóa issuer', schemaDefinitionMatches: 'Schema', issuerPolicyAccepted: 'Chính sách issuer' };
  fill('results', [...state.results].reverse().map(r => {
    const box = card(short(r.credentialId), r.result, `Lịch sử tại ${new Date(r.checkedAt).toLocaleString('vi-VN')} · Block ${r.blockNumber} (${r.finality || 'latest'})${r.simulation ? ' · Kịch bản sửa dữ liệu' : ''}`, r.blockHash);
    const checks = el('div', undefined, 'checks'); for (const [name, valid] of Object.entries(r.checks)) checks.append(el('span', `${valid == null ? '?' : valid ? '✓' : '✕'} ${checkNames[name] || name}`, valid === false ? 'failed' : ''));
    box.append(checks); return box;
  }), 'Chưa có kết quả xác minh.');
}
function updateScope() { const consent = state?.consents.find(c => c.consentId === $('verify-consent').value); options($('verify-credential'), (consent?.credentialIds || []).map(id => [id, short(id)])); }
$('verify-consent').addEventListener('change', updateScope);
async function refresh() { state = await api('/api/state'); render(); }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(jobId) {
  for (let i = 0; i < 180; i++) {
    const job = await api('/api/jobs/' + jobId);
    if (job.status === 'SUCCEEDED') return job.result;
    if (job.status === 'FAILED') throw Error(errorNames[job.error] || job.error);
    message(job.status === 'WAITING' ? 'Giao dịch đang chờ; máy chủ tự thử lại cùng giao dịch, không tạo bản cấp mới.' : `Đang xử lý trên chain… ${job.status}. Có thể mất vài block.`); await delay(1500);
  }
  throw Error('Tác vụ vẫn đang xử lý. Bấm lại cùng thao tác để kiểm tra, không đổi dữ liệu.');
}
async function action(name, data) {
  if (busy) return; busy = true;
  document.querySelectorAll('button').forEach(b => b.disabled = true);
  const storeKey = 'besu-request:' + actor + ':' + name + ':' + JSON.stringify(data);
  const requestId = sessionStorage.getItem(storeKey) || crypto.randomUUID(); sessionStorage.setItem(storeKey, requestId);
  sessionStorage.setItem('besu-pending:' + actor, JSON.stringify({ name, data }));
  $('retry-action').hidden = true;
  try {
    message('Đang gửi yêu cầu…');
    const { jobId } = await api('/api/actions/' + name, 'POST', data, requestId);
    const result = await poll(jobId); $('output').textContent = JSON.stringify(result, null, 2);
    sessionStorage.removeItem(storeKey); sessionStorage.removeItem('besu-pending:' + actor);
    await refresh(); message('Đã hoàn tất. Kết quả và trạng thái đã được cập nhật.');
  } catch (error) { message(error.message, true); $('retry-action').hidden = !sessionStorage.getItem('besu-pending:' + actor); }
  finally { busy = false; document.querySelectorAll('button').forEach(b => b.disabled = false); }
}
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  try {
    const result = await api('/api/session', 'POST', { operatorToken: $('operator-token').value, actor: $('actor-select').value });
    token = result.token; actor = result.actor.key; state = null; $('workspace').hidden = true;
    $('output').textContent = 'Chưa có thao tác trong vai trò này.';
    await refresh(); message('Đã chuyển sang ' + names(actor) + '.');
    $('retry-action').hidden = !sessionStorage.getItem('besu-pending:' + actor);
  } catch (error) { message(error.message, true); }
});
$('retry-action').addEventListener('click', () => {
  const saved = sessionStorage.getItem('besu-pending:' + actor);
  if (saved) { const pending = JSON.parse(saved); action(pending.name, pending.data); }
});
$('refresh').addEventListener('click', () => refresh().then(() => message('Đã đọc lại trạng thái trực tiếp từ chain.')).catch(e => message(e.message, true)));
$('issue-form').addEventListener('submit', event => { event.preventDefault(); const minutes = Number($('issue-minutes').value); action('issue', { holder: $('issue-holder').value, title: $('issue-title').value, expiresAt: minutes === 0 ? 0 : Math.floor(Date.now() / 1000) + minutes * 60 }); });
$('grant-form').addEventListener('submit', event => { event.preventDefault(); const credentialIds = [...document.querySelectorAll('input[name="scope"]:checked')].map(c => c.value); if (!credentialIds.length) return message('Chọn ít nhất một hồ sơ để chia sẻ.', true); action('grant', { grantee: $('grant-grantee').value, credentialIds, expiresAt: Math.floor(Date.now() / 1000) + Number($('grant-minutes').value) * 60 }); });
$('challenge-form').addEventListener('submit', event => { event.preventDefault(); if (!$('verify-consent').value || !$('verify-credential').value) return message('Cần consent còn hiệu lực trước khi tạo challenge.', true); action('challenge', { consentId: $('verify-consent').value, credentialId: $('verify-credential').value }); });

const fs = require('node:fs');
const path = require('node:path');
const database = require('./database.cjs');
const profile = require('./network-profile.cjs');
const { json, requireThat } = require('./runtime.cjs');

class Indexer {
  constructor(demo) { this.demo = demo; this.running = null; this.migrated = false; }
  sync() {
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }
  async run() {
    const demo = this.demo;
    try {
      const head = await demo.guard();
      if (!this.migrated) {
        await database.query(fs.readFileSync(path.resolve(__dirname, '../database/index.sql'), 'utf8') + "\nSELECT 'true'::json;", {}, true);
        this.migrated = true;
      }
      const namespace = demo.namespace;
      let checkpoint = await database.query("SELECT COALESCE((SELECT row_to_json(c) FROM demo_index_checkpoints c WHERE namespace = :'ns'), 'null'::json);", { ns: namespace });
      if (checkpoint) {
        const block = await demo.provider.getBlock(Number(checkpoint.block_number));
        if (!block || block.hash !== checkpoint.block_hash) {
          // Only derived rows for this deployment are rebuilt; documents, keys and operations stay intact.
          await database.query("DELETE FROM demo_chain_events WHERE namespace = :'ns'; DELETE FROM demo_index_checkpoints WHERE namespace = :'ns'; SELECT 'true'::json;", { ns: namespace }, true);
          checkpoint = null;
        }
      }
      const finalized = await demo.provider.getBlock('finalized');
      requireThat(finalized, 'FINALITY_UNAVAILABLE');
      const receipts = await Promise.all(Object.values(demo.deployment.contracts).map(c => demo.provider.getTransactionReceipt(c.transactionHash)));
      requireThat(receipts.every(Boolean), 'DEPLOYMENT_RECEIPT_UNAVAILABLE');
      const start = Math.min(...receipts.map(r => r.blockNumber));
      let from = checkpoint ? Number(checkpoint.block_number) + 1 : start;
      const addresses = Object.values(demo.deployment.contracts).map(c => c.address);
      const byAddress = Object.fromEntries(Object.entries(demo.deployment.contracts).map(([name, c]) => [c.address.toLowerCase(), name]));
      while (from <= finalized.number) {
        const to = Math.min(from + profile.logBlockRange - 1, finalized.number);
        const end = await demo.provider.getBlock(to);
        const logs = await demo.provider.getLogs({ address: addresses, fromBlock: from, toBlock: to });
        const records = logs.map(log => {
          const name = byAddress[log.address.toLowerCase()];
          const event = demo.contracts[name].interface.parseLog(log);
          requireThat(event, 'UNKNOWN_CONTRACT_EVENT');
          const args = Object.fromEntries(event.fragment.inputs.map((input, i) => [input.name, event.args[i]]));
          return { block_number: log.blockNumber, block_hash: log.blockHash, transaction_hash: log.transactionHash,
            log_index: log.index, contract_name: name, event_name: event.name, arguments: args };
        });
        requireThat((await demo.provider.getBlock(to))?.hash === end.hash, 'CHAIN_REORGANIZED');
        await database.query(`INSERT INTO demo_chain_events
          SELECT :'ns', e.block_number, e.block_hash, e.transaction_hash, e.log_index, e.contract_name, e.event_name, e.arguments
          FROM jsonb_to_recordset(:'events'::jsonb) AS e(block_number bigint, block_hash text, transaction_hash text,
            log_index integer, contract_name text, event_name text, arguments jsonb)
          ON CONFLICT DO NOTHING;
          INSERT INTO demo_index_checkpoints VALUES (:'ns', :'height'::bigint, :'hash', now())
          ON CONFLICT (namespace) DO UPDATE SET block_number=EXCLUDED.block_number, block_hash=EXCLUDED.block_hash, updated_at=now();
          SELECT 'true'::json;`, { ns: namespace, events: json(records), height: String(to), hash: end.hash }, true);
        checkpoint = { block_number: to, block_hash: end.hash }; from = to + 1;
      }
      const counts = await database.query("SELECT json_build_object('events', count(*)) FROM demo_chain_events WHERE namespace = :'ns';", { ns: namespace });
      demo.indexStatus = { ready: true, blockNumber: checkpoint ? Number(checkpoint.block_number) : null,
        finalizedBlock: finalized.number, headBlock: head.blockNumber, events: counts.events,
        lagBlocks: head.blockNumber - (checkpoint ? Number(checkpoint.block_number) : start - 1), updatedAt: new Date().toISOString() };
      return demo.indexStatus;
    } catch (error) {
      demo.indexStatus = { ready: false, error: /^[A-Z_]+$/.test(error.message) ? error.message : 'INDEXER_UNAVAILABLE' };
      throw error;
    }
  }
}
module.exports = { Indexer };

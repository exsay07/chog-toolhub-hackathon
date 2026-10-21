#!/usr/bin/env node
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { AgentServer, AGENT_VERSION } from './server.js';
import { TaskManager, dataRootDefault } from './tasks.js';
import { defaultAdapters } from './adapters/index.js';

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k!, v ?? 'true'];
  }),
);
const port = Number(args.get('port') ?? 47321);
const origins = (args.get('origin') ?? process.env.CHOG_AGENT_ORIGINS ?? 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim());
const mode = args.get('mode') === 'persistent' ? 'persistent' : 'attended';

for (const o of origins) {
  const u = new URL(o);
  if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) {
    console.error(`Refusing non-https origin ${o}`);
    process.exit(1);
  }
}

const tasks = new TaskManager(defaultAdapters(), args.get('data') ?? dataRootDefault(homedir()));
const agent = new AgentServer({
  port,
  allowedOrigins: origins,
  tasks,
  mode,
  onPairingCode: (code) => {
    console.log(`\n  Pairing code: \x1b[1;35m${code}\x1b[0m   (valid 5 minutes, single use)`);
    console.log('  Enter it in Chog Toolhub → Perps Farm → Local agent.\n');
  },
});

const bound = await agent.listen();
console.log(`Chog Toolhub local agent v${AGENT_VERSION}`);
console.log(
  `Listening on http://127.0.0.1:${bound} (loopback only) · mode=${mode} · allowed origins: ${origins.join(', ')}`,
);
console.log(
  mode === 'attended'
    ? 'Attended mode: tasks auto-pause if the web app disconnects for 60s.'
    : 'Persistent mode: tasks keep running until stopped here or in the web app.',
);
agent.newPairingCode();
console.log('Commands: [p] new pairing code · [s] stop all tasks · [q] quit (stops all tasks)');

const rl = createInterface({ input: process.stdin });
rl.on('line', (l) => {
  const c = l.trim().toLowerCase();
  if (c === 'p') agent.newPairingCode();
  if (c === 's') void tasks.stopAll().then(() => console.log('All tasks stopped.'));
  if (c === 'q') void shutdown();
});

async function shutdown() {
  console.log('Stopping all tasks…');
  await agent.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

const fs = require('fs');
const path = require('path');

function applyPortFromArgs(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if ((arg === '--port' || arg === '-p') && argv[index + 1]) {
      process.env.PORT = process.env.PORT || argv[index + 1];
      return;
    }
    if (arg.startsWith('--port=')) {
      process.env.PORT = process.env.PORT || arg.slice('--port='.length);
      return;
    }
  }
}

applyPortFromArgs(process.argv.slice(2));

const rootDir = process.cwd();
const standaloneDir = path.join(rootDir, '.next', 'standalone');
const serverEntry = path.join(standaloneDir, 'server.js');
const resolvedDataDir = process.env.FUNDING_FEE_DATA_DIR
  ? path.resolve(process.env.FUNDING_FEE_DATA_DIR)
  : path.join(rootDir, 'data');

process.env.FUNDING_FEE_DATA_DIR = resolvedDataDir;

if (!fs.existsSync(serverEntry)) {
  console.error('[start-standalone] missing .next/standalone/server.js. Run "npm run build" first.');
  process.exit(1);
}

if (!fs.existsSync(resolvedDataDir)) {
  fs.mkdirSync(resolvedDataDir, { recursive: true });
}

process.chdir(standaloneDir);
require(serverEntry);

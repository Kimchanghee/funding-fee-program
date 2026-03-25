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

if (!fs.existsSync(serverEntry)) {
  console.error('[start-standalone] missing .next/standalone/server.js. Run "npm run build" first.');
  process.exit(1);
}

process.chdir(standaloneDir);
require(serverEntry);

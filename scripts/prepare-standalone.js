const fs = require('fs');
const path = require('path');

const rootDir = process.cwd();
const standaloneDir = path.join(rootDir, '.next', 'standalone');
const standaloneNextDir = path.join(standaloneDir, '.next');
const sourceStaticDir = path.join(rootDir, '.next', 'static');
const targetStaticDir = path.join(standaloneNextDir, 'static');
const sourcePublicDir = path.join(rootDir, 'public');
const targetPublicDir = path.join(standaloneDir, 'public');

function copyDirIfPresent(sourceDir, targetDir, label) {
  if (!fs.existsSync(sourceDir)) {
    console.log(`[prepare-standalone] skip ${label}: not found`);
    return;
  }

  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true, force: true });
  console.log(`[prepare-standalone] copied ${label}`);
}

if (!fs.existsSync(standaloneDir)) {
  console.error('[prepare-standalone] missing .next/standalone. Run "next build" first.');
  process.exit(1);
}

copyDirIfPresent(sourceStaticDir, targetStaticDir, '.next/static');
copyDirIfPresent(sourcePublicDir, targetPublicDir, 'public');

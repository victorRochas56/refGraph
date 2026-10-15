// Compiles ../main.cpp into bin/<platform>-<arch>/ so the scanner ships inside
// the extension. Run it once per platform you want to support (or cross-compile
// with CXX set to a cross compiler and TARGET set to the platform-arch folder).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const target = process.env.TARGET || `${process.platform}-${process.arch}`;
const outDir = path.join(__dirname, '..', 'bin', target);
const exe = target.startsWith('win32') ? 'refGraph.exe' : 'refGraph';
const cxx = process.env.CXX || 'g++';
const out = path.join(outDir, exe);

fs.mkdirSync(outDir, { recursive: true });
execFileSync(cxx, ['-std=c++17', '-O2', '-Wall', '-o', out, path.join(repoRoot, 'main.cpp')], { stdio: 'inherit' });
console.log(`built ${path.relative(process.cwd(), out)}`);

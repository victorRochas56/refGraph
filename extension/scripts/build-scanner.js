// Compiles ../main.cpp into bin/<platform>-<arch>/ so the scanner ships inside
// the extension. Run it once per platform you want to support (or cross-compile
// with CXX set to a cross compiler and TARGET set to the platform-arch folder).
//
// Compiler: CXX if set. Otherwise MSVC (cl) on Windows when a Visual Studio or
// Build Tools install with the C++ toolset is found, and g++ everywhere else.
// The common MinGW-w64 8.1 g++ cannot build main.cpp (its <filesystem> header is
// broken on Windows) and is 32-bit, while an MSVC build matches process.arch.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const target = process.env.TARGET || `${process.platform}-${process.arch}`;
const outDir = path.join(__dirname, '..', 'bin', target);
const exe = target.startsWith('win32') ? 'refGraph.exe' : 'refGraph';
const src = path.join(repoRoot, 'main.cpp');
const out = path.join(outDir, exe);

const msvc = process.platform === 'win32' ? findMsvc() : null;
const cxx = process.env.CXX || (msvc ? 'cl' : 'g++');

fs.mkdirSync(outDir, { recursive: true });
if (isMsvcStyle(cxx)) {
    buildWithMsvc(cxx);
} else {
    execFileSync(cxx, ['-std=c++17', '-O2', '-Wall', '-o', out, src], { stdio: 'inherit' });
}
console.log(`built ${path.relative(process.cwd(), out)}`);

function isMsvcStyle(compiler) {
    const name = path.basename(compiler).toLowerCase().replace(/\.exe$/, '');
    return name === 'cl' || name === 'clang-cl';
}

// Returns { vcvarsall } when cl needs its environment loaded first, { vcvarsall: null }
// when it is already loaded (Developer Command Prompt), or null when there is no MSVC.
function findMsvc() {
    if (process.env.VCINSTALLDIR) {
        return { vcvarsall: null };
    }
    // vswhere ships with every Visual Studio 2017+ installer, including Build Tools
    const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
        'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    if (!fs.existsSync(vswhere)) {
        return null;
    }
    const installPath = execFileSync(vswhere, [
        '-latest', '-products', '*',
        '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
        '-property', 'installationPath',
    ], { encoding: 'utf8' }).trim();
    const vcvarsall = path.join(installPath, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat');
    return installPath && fs.existsSync(vcvarsall) ? { vcvarsall, installerDir: path.dirname(vswhere) } : null;
}

// vcvarsall wants <host> or <host>_<target>, e.g. x64 or x64_arm64
function vcvarsArch() {
    const names = { x64: 'x64', ia32: 'x86', arm64: 'arm64' };
    const host = names[process.arch];
    const wanted = names[target.split('-')[1]];
    if (!host || !wanted) {
        throw new Error(`no MSVC toolset for ${process.arch} -> ${target}; set CXX to a cross compiler`);
    }
    return host === wanted ? host : `${host}_${wanted}`;
}

function buildWithMsvc(compiler) {
    // cl drops main.obj in the working directory unless told where to put it
    const objDir = fs.mkdtempSync(path.join(os.tmpdir(), 'refgraph-'));
    // /MT links the C runtime statically so the bundled exe does not need the VC++ redistributable
    const args = ['/nologo', '/std:c++17', '/O2', '/EHsc', '/W4', '/MT',
        `/Fo:${path.join(objDir, 'main.obj')}`, `/Fe:${out}`, src];
    try {
        if (msvc && msvc.vcvarsall) {
            // Load the toolset environment and compile in one cmd so it carries over.
            // /s strips the outer quotes; everything inside is quoted per argument.
            const quote = (s) => `"${s}"`;
            const line = `call ${quote(msvc.vcvarsall)} ${vcvarsArch()} >nul && ${compiler} ${args.map(quote).join(' ')}`;
            // vcvarsall runs vswhere.exe by bare name and prints a harmless "not recognized"
            // error unless the Installer folder is on PATH, so add it for this call only
            const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
            const env = { ...process.env, [pathKey]: `${process.env[pathKey] || ''};${msvc.installerDir}` };
            execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`],
                { stdio: 'inherit', windowsVerbatimArguments: true, env });
        } else {
            execFileSync(compiler, args, { stdio: 'inherit' });
        }
    } finally {
        fs.rmSync(objDir, { recursive: true, force: true });
    }
}

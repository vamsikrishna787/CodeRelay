// Runs after `npm install @opensuperlab/coderelay`: sets up the project for GitHub Copilot.
// Never fails the install. Skip with CODERELAY_SKIP_SETUP=1.
const path = require('node:path');
const { existsSync } = require('node:fs');
const { pathToFileURL } = require('node:url');

const pkgRoot = path.resolve(__dirname, '..');
const project = process.env.INIT_CWD;

const skip =
  !project ||
  process.env.CODERELAY_SKIP_SETUP ||
  process.env.CI ||
  process.env.npm_config_global === 'true' ||
  path.resolve(project) === pkgRoot || // developing CodeRelay itself
  !existsSync(path.join(pkgRoot, 'dist', 'setup.js'));

if (!skip) {
  import(pathToFileURL(path.join(pkgRoot, 'dist', 'setup.js')).href)
    .then(({ install }) => {
      const log = install(path.resolve(project));
      if (log.length) {
        console.log('\nCodeRelay: set up GitHub Copilot in this project');
        for (const line of log) console.log(`  ${line}`);
        console.log('  → Open Copilot Chat (Agent mode) and ask for what you want, or pick the "Orchestrator" agent.\n');
      }
    })
    .catch((err) => console.warn(`CodeRelay setup skipped: ${err && err.message}. Run "npx coderelay init" to set up.`));
}

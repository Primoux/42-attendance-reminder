/*
 * Micro test-runner sans dépendance (node:test n'existe pas avant Node 18).
 * API compatible : test('nom', fn). Lance avec `node test/parser.test.js`.
 */

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

async function run() {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn(); // indispensable : sinon un test async échoue en silence
      console.log(`  [32m✔[0m ${t.name}`);
    } catch (err) {
      failed += 1;
      console.log(`  [31m✘[0m ${t.name}`);
      console.log(`      ${(err && err.message ? err.message : err).toString().split('\n').join('\n      ')}`);
    }
  }
  const passed = tests.length - failed;
  console.log(`\n${passed}/${tests.length} tests passés${failed ? ` — [31m${failed} échec(s)[0m` : ''}`);
  process.exitCode = failed ? 1 : 0;
}

process.on('beforeExit', () => {
  if (!run.done) {
    run.done = true;
    run().catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
  }
});

module.exports = { test };

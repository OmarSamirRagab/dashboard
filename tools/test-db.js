// Connection test for the UAT classification DB (read-only SELECT). Uses the same env vars and query as lib/classify.js.
// Exit code 0 = connected and FAILURE_MESSAGES read; 1 = failed. Never prints the password.
'use strict';
const classify = require('../lib/classify');

(async () => {
  if (!classify.configured()) { console.log('  ✗ UAT DB not configured (host, user and password are required)'); process.exit(1); }
  const s = await classify.load();
  if (s.loaded) {
    console.log(`  ✓ Connected to ${s.database}: ${s.count} FAILURE_MESSAGES rows` +
      (s.categories.length ? `, categories: ${s.categories.join(', ')}` : ''));
    process.exit(0);
  }
  console.log(`  ✗ Could not read FAILURE_MESSAGES from ${s.database}`);
  console.log(`    ${s.error}`);
  const hint = /ECONNREFUSED/.test(s.error) ? 'nothing listening on that host:port (check the port / that MySQL allows remote connections)'
    : /ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/.test(s.error) ? 'host not reachable (VPN / network / firewall)'
    : /ENOTFOUND/.test(s.error) ? 'host name not found'
    : /ER_ACCESS_DENIED/.test(s.error) ? 'wrong user or password, or this user may not connect from your PC'
    : /ER_BAD_DB_ERROR/.test(s.error) ? 'database name not found'
    : /ER_NO_SUCH_TABLE|ER_TABLEACCESS_DENIED/.test(s.error) ? 'connected, but FAILURE_MESSAGES / TT_TS_SUPPLIER / TT_ENUM_VALUES not readable by this user'
    : '';
  if (hint) console.log(`    → ${hint}`);
  process.exit(1);
})();

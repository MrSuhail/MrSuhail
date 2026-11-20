const config = require('./config');
const { openDatabase } = require('./db');
const { createApp } = require('./app');
const { seedIfEmpty } = require('./seed');

const db = openDatabase();
if (seedIfEmpty(db)) console.log('Seeded database with a sample menu');

if (config.adminApiKey === 'change-me') {
  console.warn('WARNING: ADMIN_API_KEY is not set; using the insecure default "change-me"');
}

const server = createApp(db).listen(config.port, () => {
  console.log(`Restaurant API listening on http://localhost:${config.port}`);
});

const shutdown = () => server.close(() => { db.close(); process.exit(0); });
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

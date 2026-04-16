const config = require('../config');

module.exports = {
  client: 'pg',
  connection: {
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    user: config.db.user,
    password: config.db.password,
  },
  pool: { min: 2, max: 20 },
  migrations: {
    directory: __dirname + '/migrations',
    tableName: 'knex_migrations',
  },
  seeds: {
    directory: __dirname + '/seeds',
  },
};

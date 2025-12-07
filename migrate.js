const Database = require('better-sqlite3');
const db = new Database('data.db');

function addColumn(sql) {
  try {
    db.prepare(sql).run();
    console.log('OK:', sql);
  } catch (e) {
    console.log('Skip:', sql, '-', e.message);
  }
}

addColumn("ALTER TABLE users ADD COLUMN blocked INTEGER DEFAULT 0");
addColumn("ALTER TABLE users ADD COLUMN profile_locked INTEGER DEFAULT 0");
addColumn("ALTER TABLE users ADD COLUMN messages_visibility TEXT DEFAULT 'public'");

console.log("Migration finished");
db.close();


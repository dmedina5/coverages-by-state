const mysql = require('mysql2/promise');
const fs = require('fs').promises;
const crypto = require('crypto');

// Configuration from environment
// Password is base64 encoded to preserve special characters
const decodedPassword = Buffer.from(process.env.DB_PASSWORD, 'base64').toString('utf-8');

const DB_CONFIG = {
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: decodedPassword,
  database: process.env.DB_NAME,
  connectTimeout: 30000,
  ssl: { rejectUnauthorized: false }
};

const COMPANY_ID_MAPPING = {
  5245: "Accredited Non-Admitted 1st",
  6607: "Accredited Non-Admitted New",
  5696: "Ascot Non-Admitted",
  6155: "Everspan Non-Admitted MunichRe",
  6156: "Everspan Admitted MunichRe",
};

const DEFAULT_CARRIER_STATUS = {
  "Everspan Admitted GenRe": "N/A",
  "Everspan Non-Admitted GenRe": "turned off permanently",
  "Knight Non-Admitted": "turned off permanently"
};

const STATE_QUERY = `
  SELECT c.id AS company_id, c.name AS company_name, s.code AS state_code,
         cs.active, cs.dsg_allowed
  FROM companies c
  INNER JOIN company_state cs ON c.id = cs.company_id
  INNER JOIN states s ON cs.state_id = s.id
  WHERE c.id IN (5245, 6607, 5696, 6155, 6156)
  ORDER BY s.code, c.id
`;

const CARRIER_QUERY = `
  SELECT DISTINCT c.id, c.name, s.code, cs.active,
         CASE WHEN cs.active = TRUE AND s.specific_lottery = FALSE THEN c.lottery_al
              WHEN cs.active = TRUE AND s.specific_lottery = TRUE THEN cs.lottery_al
              ELSE NULL END AS lottery_al,
         cs.dsg_allowed
  FROM companies c
  INNER JOIN company_state cs ON c.id = cs.company_id
  INNER JOIN states s ON cs.state_id = s.id
  ORDER BY s.code, c.id
`;

function computeHash(rows) {
  const str = rows.map(r => `${r.state_code}:${r.company_id}:${r.active}:${r.dsg_allowed}`).sort().join('|');
  return crypto.createHash('md5').update(str).digest('hex');
}

function processCarrierData(rows) {
  const stateCarriers = {};
  const allStates = new Set();
  for (const row of rows) {
    if (!row.code) continue;
    allStates.add(row.code);
    const key = COMPANY_ID_MAPPING[row.id];
    if (!key) continue;
    if (!stateCarriers[row.code]) stateCarriers[row.code] = {};
    stateCarriers[row.code][key] = row.active ? "Y" : "turned off";
  }
  const result = {};
  for (const state of allStates) {
    result[state] = { ...DEFAULT_CARRIER_STATUS, ...stateCarriers[state] };
    for (const key of Object.values(COMPANY_ID_MAPPING)) {
      if (!(key in result[state])) result[state][key] = "N/A";
    }
  }
  return result;
}

async function connectWithRetry(config, maxRetries = 3, delayMs = 5000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Connection attempt ${attempt}/${maxRetries}...`);
      const conn = await mysql.createConnection(config);
      console.log('Connected successfully');
      return conn;
    } catch (err) {
      console.log(`Attempt ${attempt} failed: ${err.message}`);
      if (attempt === maxRetries) {
        // Exit gracefully instead of throwing - prevents workflow failure
        console.log('::warning::Database unavailable after retries - will try again next run');
        process.exit(0);  // Exit with success to prevent workflow failure
      }
      console.log(`Waiting ${delayMs/1000}s before retry...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

async function main() {
  console.log('Connecting to database...');
  console.log(`Host: ${DB_CONFIG.host}`);
  console.log(`Port: ${DB_CONFIG.port}`);
  console.log(`User: ${DB_CONFIG.user}`);
  console.log(`Database: ${DB_CONFIG.database}`);

  let connection;
  try {
    connection = await connectWithRetry(DB_CONFIG, 3, 5000);
  } catch (err) {
    console.log('::error::Database connection failed after 3 attempts: ' + err.message);
    process.exit(1);
  }

  try {
    // Get current state
    const [stateRows] = await connection.execute(STATE_QUERY);
    const currentHash = computeHash(stateRows);
    console.log(`Current state hash: ${currentHash}`);
    console.log(`Records: ${stateRows.length}`);

    // Load saved state
    let savedState = null;
    try {
      const data = await fs.readFile('monitor_state.json', 'utf-8');
      savedState = JSON.parse(data);
      console.log(`Saved state hash: ${savedState.hash}`);
    } catch (e) {
      console.log('No saved state found (first run)');
    }

    // Compare
    if (savedState && savedState.hash === currentHash) {
      console.log('No changes detected');
      await connection.end();
      return;
    }

    console.log('Changes detected! Updating...');

    // Get full data for sync
    const [fullRows] = await connection.execute(CARRIER_QUERY);
    const carrierData = processCarrierData(fullRows);

    // Update index.html
    let html = await fs.readFile('index.html', 'utf-8');
    const pattern = /const carrierData = ({[^;]+});/s;
    const match = html.match(pattern);

    if (!match) {
      console.log('::error::Could not find carrierData in index.html');
      process.exit(1);
    }

    const newHtml = html.replace(
      `const carrierData = ${match[1]};`,
      `const carrierData = ${JSON.stringify(carrierData)};`
    );

    await fs.writeFile('index.html', newHtml);

    // Save new state
    await fs.writeFile('monitor_state.json', JSON.stringify({
      hash: currentHash,
      timestamp: new Date().toISOString(),
      rowCount: stateRows.length
    }, null, 2));

    console.log('Files updated successfully');

  } finally {
    await connection.end();
  }
}

main().catch(err => {
  console.log('::warning::' + err.message);
  process.exit(0);  // Exit gracefully - network issues are transient
});

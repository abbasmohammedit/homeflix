// Headless launcher for HOMEFLIX inside Docker.
// Runs the server bundled in the .deb (app.asar) with Electron in Node mode, no window or display needed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APP = '/opt/HOMEFLIX/resources';
const homeflix = require(path.join(APP, 'app.asar', 'server.js'));

const CONFIG_FILE = process.env.HOMEFLIX_CONFIG || '/config/config.json';
const DATA_DIR = '/data';

let userConfig = {};
if (fs.existsSync(CONFIG_FILE)) {
  try {
    userConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    console.error(`${CONFIG_FILE} is not valid JSON (${err.message}); using defaults.`);
  }
}

// Keep the cookie-signing secret across restarts so phones/TVs stay signed in.
fs.mkdirSync(DATA_DIR, { recursive: true });
const secretFile = path.join(DATA_DIR, 'secret');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(16).toString('hex'), { mode: 0o600 });
const secret = fs.readFileSync(secretFile, 'utf8').trim();

const config = {
  port: Number(process.env.HOMEFLIX_PORT) || 8080,
  folders: ['/videos'],
  minSizeMB: 5,
  secret,
  ...userConfig,
  // Paths inside the container are fixed; mount volumes onto them instead.
  cacheDir: '/cache',
  dataDir: DATA_DIR,
  ffmpeg: path.join(APP, 'ffmpeg', 'ffmpeg'),
  ffprobe: path.join(APP, 'ffmpeg', 'ffprobe'),
};

homeflix.configure(config);
homeflix.start()
  .then(async (port) => {
    const movies = await homeflix.scanLibrary();
    console.log('\n  HOMEFLIX is running (Docker).\n');
    console.log(`  Library: ${movies.length} video(s) from ${config.folders.join(', ')}`);
    console.log('  On your phone, tablet or TV (same Wi-Fi), open:\n');
    for (const ip of homeflix.lanAddresses()) console.log(`     http://${ip}:${port}`);
    console.log(`\n  On this computer: http://localhost:${port}\n`);
  })
  .catch((err) => {
    if (err.code === 'EADDRINUSE') console.error(`Port ${config.port} is already in use. Set "port" in config.json.`);
    else console.error(err);
    process.exit(1);
  });

// Let `docker stop` shut down cleanly.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => homeflix.stop().finally(() => process.exit(0)));
}

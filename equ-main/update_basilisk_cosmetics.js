#!/usr/bin/env node

/**
 * Update Basilisk user cosmetics in the database
 * Adds Thor skin and related cosmetics
 */

const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const path = require('path');

const databaseFile = path.join(__dirname, 'Ah-main', 'forestbrawl.db');

console.log(`📊 Opening database: ${databaseFile}`);

try {
  const db = new DatabaseSync(databaseFile);
  
  // Read current account data
  const result = db.prepare('SELECT state_json FROM game_state WHERE state_key = ?').get('account');
  
  if (!result) {
    console.error('❌ No account data found in database');
    process.exit(1);
  }

  const accountData = JSON.parse(result.state_json);
  
  // Find Basilisk user, create if doesn't exist
  const basiliskKeys = Object.keys(accountData.users).filter(
    key => key.toLowerCase() === 'basilisk'
  );
  let basilisk = basiliskKeys.length ? accountData.users[basiliskKeys[0]] : null;
  
  if (!basilisk) {
    console.log('⚠️  Basilisk user not found, creating...');
    basilisk = {
      id: accountData.nextId || 1,
      username: 'Basilisk',
      name: 'Basilisk',
      email: '',
      salt: crypto.randomBytes(16).toString('hex'),
      hash: '',
      xp: 0,
      gold: 0,
      skin: 'default',
      kills: 0,
      deaths: 0,
      totalXpEarned: 0,
      equippedItems: {}
    };
    accountData.nextId = (accountData.nextId || 1) + 1;
    console.log('✅ Created new Basilisk user');
  }

  for (const key of basiliskKeys) delete accountData.users[key];
  accountData.users.basilisk = basilisk;

  basilisk.username = 'Basilisk';
  basilisk.name = 'Basilisk';
  basilisk.skin = 'thor';
  basilisk.salt = basilisk.salt || crypto.randomBytes(16).toString('hex');
  basilisk.hash = crypto.scryptSync('12345678', basilisk.salt, 64).toString('hex');

  console.log(`✅ Found Basilisk user`);
  console.log(`   Current skin: ${basilisk.skin || 'default'}`);
  console.log(`   Current cosmetics:`, basilisk.equippedItems || 'None');

  // Update cosmetics with Thor skin
  basilisk.equippedItems = {
    deriler: 'thor',
    profil_avatar: 'thor',
    efektler: 'effect_thunder',
    kanatlar: 'w_none',
    sapkalar: 'h_none',
    yuz: 'f_none',
    aksesuarlar: 'a_none',
    baltalar: 'ba_thunder',
    kiliclar: 'ki_thunder',
    izler: 'iz_thunder'
  };

  // Update database
  db.prepare(
    'UPDATE game_state SET state_json = ?, updated_at = ? WHERE state_key = ?'
  ).run(JSON.stringify(accountData), Date.now(), 'account');

  console.log(`\n✅ Successfully updated Basilisk cosmetics!`);
  console.log(`   New skin: ${basilisk.equippedItems.deriler}`);
  console.log(`   Cosmetics:`, basilisk.equippedItems);
  console.log(`\n🌩️ Thor cosmetics added to Basilisk account`);

  db.close();

} catch (error) {
  console.error('❌ Error:', error.message);
  process.exit(1);
}

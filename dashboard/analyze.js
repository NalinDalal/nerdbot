const fs = require('fs');
const content = fs.readFileSync('dist/assets/index-C3KNkIr5.js', 'utf8');

// Check for 'createRoot' 
const createRootCount = (content.match(/createRoot/g) || []).length;
console.log('createRoot occurrences:', createRootCount);

// Check '.render(' 
const renderCount = (content.match(/\.render\(/g) || []).length;
console.log('.render(' occurrences:', renderCount);

// Check for 'App' as a string
const AppStringCount = (content.match(/["']App["']/g) || []).length;
console.log('"App" string occurrences:', AppStringCount);

// Check for 'probing'
const probingCount = (content.match(/probing/g) || []).length;
console.log('probing occurrences:', probingCount);

// Check for 'autoConnectDev'
const autoConnectCount = (content.match(/autoConnectDev/g) || []).length;
console.log('autoConnectDev occurrences:', autoConnectCount);

// Check for 'setConnected'
const setConnectedCount = (content.match(/setConnected/g) || []).length;
console.log('setConnected occurrences:', setConnectedCount);

// Print first 200 chars
console.log('First 200 chars:', content.substring(0, 200));
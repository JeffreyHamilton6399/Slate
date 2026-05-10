const { execSync } = require('child_process');
const fs = require('fs');
const log = [];
try {
  log.push('size: ' + fs.statSync('D:/Slate/Slate/patches.js').size);
  log.push(execSync('git -C D:/Slate/Slate status', {encoding:'utf8'}));
  log.push(execSync('git -C D:/Slate/Slate add patches.js', {encoding:'utf8'}));
  log.push(execSync('git -C D:/Slate/Slate status', {encoding:'utf8'}));
  log.push(execSync('git -C D:/Slate/Slate commit -m "Detachable panels, host audio mute, iOS vis toggle, draw-mute full block"', {encoding:'utf8', stdio:'pipe'}));
  log.push(execSync('git -C D:/Slate/Slate push origin main', {encoding:'utf8', stdio:'pipe'}));
  log.push('DONE');
} catch(e) { log.push('ERROR: ' + e.message + '\n' + (e.stdout||'') + '\n' + (e.stderr||'')); }
fs.writeFileSync('D:/Slate/Slate/_gitout.txt', log.join('\n---\n'));

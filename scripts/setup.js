// Prints production secrets. Usage: npm run setup -- UNITY   (the answer is only used to compute the digest; it is not stored)
const c = require('crypto'), ans = process.argv[2];
if (!ans) { console.error('usage: npm run setup -- <answer>'); process.exit(1); }
const salt = c.randomBytes(16).toString('hex');
console.log(`SESSION_SECRET=${c.randomBytes(32).toString('hex')}\nANSWER_SALT=${salt}\nANSWER_DIGEST=${c.scryptSync(ans.trim().toLowerCase(), salt, 32).toString('hex')}`);

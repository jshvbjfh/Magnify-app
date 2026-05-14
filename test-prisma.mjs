const { PrismaClient } = require('./node_modules/@prisma/client');
process.env.DATABASE_URL = 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require';
const p = new PrismaClient();
p.connect().then(() => { console.log('OK'); return p.disconnect(); }).catch(e => console.error('FAIL:', e.message, e.errorCode));

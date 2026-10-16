// Usage: DATABASE_URL=... node scripts/dbq.js '<sql>' "['param1', 2]"
// Prints rows as JSON. Params JSON must be a valid JS array literal.
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()
const sql = process.argv[2] || 'SELECT 1'
let params = []
try { params = JSON.parse(process.argv[3] || '[]') } catch { params = [] }
p.$queryRawUnsafe(sql, ...params)
  .then((r) => { console.log(JSON.stringify(r)); return p.$disconnect() })
  .catch((e) => { console.error(String(e.message || e)); process.exit(1) })

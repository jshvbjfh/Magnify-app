const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()
p.user.updateMany({
  where: { email: 'axel@gmail.com' },
  data: { isSuperAdmin: true, isActive: true }
}).then(r => {
  if (r.count === 0) {
    console.log('⚠  No user found with email axel@gmail.com — sign up first, then re-run this script.')
  } else {
    console.log('✅  axel@gmail.com is now super admin!')
  }
}).catch(e => console.error('Error:', e.message)).finally(() => p.$disconnect())

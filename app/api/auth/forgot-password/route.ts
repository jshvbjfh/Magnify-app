import { NextRequest, NextResponse } from 'next/server'
import { compare, hash } from 'bcryptjs'
import { prisma } from '@/lib/prisma'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { email, recoveryKey, newPassword } = body

    if (!email || !recoveryKey || !newPassword) {
      return NextResponse.json(
        { error: 'Email, recovery key, and new password are required' },
        { status: 400 }
      )
    }

    if (newPassword.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters long' },
        { status: 400 }
      )
    }

    const user = await prisma.user.findUnique({ where: { email } })

    if (!user || !user.recoveryKeyHash) {
      // Don't reveal whether the account exists
      return NextResponse.json(
        { error: 'Invalid email or recovery key' },
        { status: 400 }
      )
    }

    const keyMatch = await compare(recoveryKey.trim().toUpperCase(), user.recoveryKeyHash)

    if (!keyMatch) {
      return NextResponse.json(
        { error: 'Invalid email or recovery key' },
        { status: 400 }
      )
    }

    const hashedPassword = await hash(newPassword, 12)

    await prisma.user.update({
      where: { email },
      data: { password: hashedPassword }
    })

    return NextResponse.json({ message: 'Password updated successfully' })
  } catch (error) {
    console.error('Forgot password error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

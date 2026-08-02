import { google } from 'googleapis'
import { createServiceClient } from './supabase'

export async function getCalendarClient() {
  const supabase = createServiceClient()

  const { data: tokens, error } = await supabase
    .from('google_tokens')
    .select('*')
    .single()

  if (error || !tokens?.refresh_token) {
    throw new Error('No Google tokens stored. Log in at /api/auth/signin first.')
  }

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  )

  auth.setCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expires_at ? tokens.expires_at * 1000 : undefined,
  })

  auth.on('tokens', async (newTokens) => {
    await supabase.from('google_tokens').update({
      access_token: newTokens.access_token,
      expires_at: newTokens.expiry_date ? Math.floor(newTokens.expiry_date / 1000) : undefined,
    }).eq('id', 1)
  })

  return google.calendar({ version: 'v3', auth })
}

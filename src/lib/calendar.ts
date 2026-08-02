import { getCalendarClient } from './google-auth'

const TZ = 'Europe/Vienna'

export type CalEvent = {
  id: string
  title: string
  start: string | null
  end: string | null
  allDay: boolean
  location: string | null
  description: string | null
  htmlLink: string | null
}

function mapEvent(e: {
  id?: string | null
  summary?: string | null
  start?: { dateTime?: string | null; date?: string | null } | null
  end?: { dateTime?: string | null; date?: string | null } | null
  location?: string | null
  description?: string | null
  htmlLink?: string | null
}): CalEvent {
  return {
    id: e.id ?? '',
    title: e.summary ?? '(no title)',
    start: e.start?.dateTime ?? e.start?.date ?? null,
    end: e.end?.dateTime ?? e.end?.date ?? null,
    allDay: !e.start?.dateTime,
    location: e.location ?? null,
    description: e.description ?? null,
    htmlLink: e.htmlLink ?? null,
  }
}

/** Upcoming events from now, default next 7 days, max 20. */
export async function listUpcomingEvents(opts?: {
  daysAhead?: number
  maxResults?: number
  calendarId?: string
}): Promise<CalEvent[]> {
  const calendar = await getCalendarClient()
  const now = new Date()
  const timeMax = new Date(now)
  timeMax.setDate(timeMax.getDate() + (opts?.daysAhead ?? 7))

  const res = await calendar.events.list({
    calendarId: opts?.calendarId ?? 'primary',
    timeMin: now.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: opts?.maxResults ?? 20,
  })

  return (res.data.items ?? []).map(mapEvent)
}

/** Create an event. Times = ISO strings (with offset) or 'YYYY-MM-DD' for all-day. */
export async function createEvent(input: {
  title: string
  start: string
  end: string
  allDay?: boolean
  location?: string
  description?: string
  calendarId?: string
}): Promise<CalEvent> {
  const calendar = await getCalendarClient()

  const startObj = input.allDay ? { date: input.start } : { dateTime: input.start, timeZone: TZ }
  const endObj = input.allDay ? { date: input.end } : { dateTime: input.end, timeZone: TZ }

  const res = await calendar.events.insert({
    calendarId: input.calendarId ?? 'primary',
    requestBody: {
      summary: input.title,
      location: input.location,
      description: input.description,
      start: startObj,
      end: endObj,
    },
  })

  return mapEvent(res.data)
}

/** Patch an existing event. Only provided fields change. */
export async function updateEvent(input: {
  eventId: string
  title?: string
  start?: string
  end?: string
  allDay?: boolean
  location?: string
  description?: string
  calendarId?: string
}): Promise<CalEvent> {
  const calendar = await getCalendarClient()

  const body: Record<string, unknown> = {}
  if (input.title !== undefined) body.summary = input.title
  if (input.location !== undefined) body.location = input.location
  if (input.description !== undefined) body.description = input.description
  if (input.start !== undefined) {
    body.start = input.allDay ? { date: input.start } : { dateTime: input.start, timeZone: TZ }
  }
  if (input.end !== undefined) {
    body.end = input.allDay ? { date: input.end } : { dateTime: input.end, timeZone: TZ }
  }

  const res = await calendar.events.patch({
    calendarId: input.calendarId ?? 'primary',
    eventId: input.eventId,
    requestBody: body,
  })

  return mapEvent(res.data)
}

/** Delete an event. */
export async function deleteEvent(eventId: string, calendarId = 'primary'): Promise<void> {
  const calendar = await getCalendarClient()
  await calendar.events.delete({ calendarId, eventId })
}

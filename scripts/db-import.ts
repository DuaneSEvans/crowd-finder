import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { parse } from "csv-parse/sync"
import postgres from "postgres"

type CsvRecord = Record<string, string | undefined>

type DateParts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  sortKey: number
  canonical: string
}

type ContactCandidate = {
  email: string
  first_name: string | null
  last_name: string | null
  phone: string | null
  street: string | null
  postcode: string | null
  city: string | null
  country: string | null
  country_code: string | null
}

type StoredContact = ContactCandidate & {
  bookingSortKey: number
}

type EventAggregate = {
  key: string
  name: string
  eventDateParts: DateParts
}

type ContactEventAggregate = {
  contactEmail: string
  eventKey: string
  latestBookingDateParts: DateParts | null
  ticketBarcodes: Set<string>
}

type ImportStats = {
  files: number
  rows: number
  importedRows: number
  skippedMissingEmail: number
  skippedInvalidStatus: number
  skippedMissingEvent: number
  skippedInvalidDates: number
}

type ImportResult = {
  contacts: Map<string, StoredContact>
  events: Map<string, EventAggregate>
  contactEvents: Map<string, ContactEventAggregate>
  stats: ImportStats
}

const defaultInputPath = path.resolve("supabase/rawData")

const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--")
let dryRun = true
let inputPath = defaultInputPath

for (const arg of rawArgs) {
  if (arg === "--write") {
    dryRun = false
    continue
  }

  if (arg === "--dry-run") {
    dryRun = true
    continue
  }

  if (arg.startsWith("--")) {
    console.error(`Unknown argument: ${arg}`)
    console.error("Usage: bun run db:import [--write] [--dry-run] [path]")
    process.exit(1)
  }

  inputPath = path.resolve(arg)
}

const importStartedAt = new Date()

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function cleanValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null
  }

  const normalized = normalizeWhitespace(value)
  return normalized.length > 0 ? normalized : null
}

function cleanEmail(value: unknown): string | null {
  const email = cleanValue(value)
  return email ? email.toLowerCase() : null
}

function normalizeEventName(value: string): string {
  return normalizeWhitespace(value).toLowerCase()
}

function parseDateParts(value: unknown): DateParts | null {
  const normalized = cleanValue(value)
  if (!normalized) {
    return null
  }

  const match = normalized.match(
    /^(\d{2})\/(\d{2})\/(\d{2}|\d{4})\s+(\d{2}):(\d{2})$/,
  )

  if (!match) {
    return null
  }

  const [, dayText, monthText, yearText, hourText, minuteText] = match
  const day = Number.parseInt(dayText, 10)
  const month = Number.parseInt(monthText, 10)
  const rawYear = Number.parseInt(yearText, 10)
  const hour = Number.parseInt(hourText, 10)
  const minute = Number.parseInt(minuteText, 10)
  const year = yearText.length === 2 ? 2000 + rawYear : rawYear

  if (
    Number.isNaN(day) ||
    Number.isNaN(month) ||
    Number.isNaN(year) ||
    Number.isNaN(hour) ||
    Number.isNaN(minute)
  ) {
    return null
  }

  return {
    year,
    month,
    day,
    hour,
    minute,
    sortKey: Date.UTC(year, month - 1, day, hour, minute),
    canonical: `${year.toString().padStart(4, "0")}-${month
      .toString()
      .padStart(2, "0")}-${day.toString().padStart(2, "0")}T${hour
      .toString()
      .padStart(2, "0")}:${minute.toString().padStart(2, "0")}`,
  }
}

function londonTimestamp(
  sql: postgres.Sql,
  parts: DateParts | null,
): postgres.Fragment {
  if (!parts) {
    return sql`null`
  }

  return sql`make_timestamptz(${parts.year}, ${parts.month}, ${parts.day}, ${parts.hour}, ${parts.minute}, 0, 'Europe/London')`
}

function updateContact(
  existing: StoredContact | undefined,
  candidate: ContactCandidate,
  bookingDateParts: DateParts,
): StoredContact {
  if (!existing) {
    return {
      ...candidate,
      bookingSortKey: bookingDateParts.sortKey,
    }
  }

  const nextBookingSortKey = bookingDateParts.sortKey
  const isNewer = nextBookingSortKey >= existing.bookingSortKey
  const fields: Array<keyof ContactCandidate> = [
    "first_name",
    "last_name",
    "phone",
    "street",
    "postcode",
    "city",
    "country",
    "country_code",
  ]

  for (const field of fields) {
    const candidateValue = candidate[field]
    if (!candidateValue) {
      continue
    }

    if (!existing[field] || isNewer) {
      existing[field] = candidateValue
    }
  }

  if (isNewer) {
    existing.bookingSortKey = nextBookingSortKey
  }

  return existing
}

function stripExportPreamble(content: string): string {
  const normalized = content.replace(/^\uFEFF/, "")
  return normalized.startsWith("Table 1")
    ? normalized.slice(normalized.indexOf("\n") + 1)
    : normalized
}

async function resolveCsvPaths(targetPath: string): Promise<string[]> {
  const targetStats = await stat(targetPath)

  if (targetStats.isDirectory()) {
    const entries = await readdir(targetPath, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".csv"))
      .map((entry) => path.join(targetPath, entry.name))
      .sort((left, right) => left.localeCompare(right))
  }

  if (targetStats.isFile() && targetPath.toLowerCase().endsWith(".csv")) {
    return [targetPath]
  }

  throw new Error(`Input path must be a CSV file or directory: ${targetPath}`)
}

async function loadRecords(csvPath: string): Promise<CsvRecord[]> {
  const rawContent = await readFile(csvPath, "utf8")
  const content = stripExportPreamble(rawContent)

  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  }) as CsvRecord[]
}

async function collectImportData(csvPaths: string[]): Promise<ImportResult> {
  const contacts = new Map<string, StoredContact>()
  const events = new Map<string, EventAggregate>()
  const contactEvents = new Map<string, ContactEventAggregate>()
  const stats: ImportStats = {
    files: csvPaths.length,
    rows: 0,
    importedRows: 0,
    skippedMissingEmail: 0,
    skippedInvalidStatus: 0,
    skippedMissingEvent: 0,
    skippedInvalidDates: 0,
  }

  for (const csvPath of csvPaths) {
    const records = await loadRecords(csvPath)

    for (const record of records) {
      stats.rows += 1

      const status = cleanValue(record.Status)?.toLowerCase()
      if (status !== "valid") {
        stats.skippedInvalidStatus += 1
        continue
      }

      const email = cleanEmail(record["E-Mail"])
      if (!email) {
        stats.skippedMissingEmail += 1
        continue
      }

      const eventName = cleanValue(record.Event)
      if (!eventName) {
        stats.skippedMissingEvent += 1
        continue
      }

      const eventDateParts = parseDateParts(record["Event Date"])
      const bookingDateParts = parseDateParts(record.BookingDate)

      if (!eventDateParts || !bookingDateParts) {
        stats.skippedInvalidDates += 1
        continue
      }

      stats.importedRows += 1

      const contactCandidate: ContactCandidate = {
        email,
        first_name: cleanValue(record["First Name"]),
        last_name: cleanValue(record["Last Name"]),
        phone: cleanValue(record.Phone),
        street: cleanValue(record.Street),
        postcode: cleanValue(record.Postcode),
        city: cleanValue(record.City),
        country: cleanValue(record.Country),
        country_code: cleanValue(record.CountryCode)?.toUpperCase() ?? null,
      }

      contacts.set(
        email,
        updateContact(contacts.get(email), contactCandidate, bookingDateParts),
      )

      const eventKey = `${normalizeEventName(eventName)}|${eventDateParts.canonical}`
      if (!events.has(eventKey)) {
        events.set(eventKey, {
          key: eventKey,
          name: eventName,
          eventDateParts,
        })
      }

      const contactEventKey = `${email}|${eventKey}`
      const existingContactEvent = contactEvents.get(contactEventKey) ?? {
        contactEmail: email,
        eventKey,
        latestBookingDateParts: bookingDateParts,
        ticketBarcodes: new Set<string>(),
      }

      const barcode =
        cleanValue(record.Barcode) ?? `${path.basename(csvPath)}:${stats.rows}`
      existingContactEvent.ticketBarcodes.add(barcode)

      if (
        !existingContactEvent.latestBookingDateParts ||
        bookingDateParts.sortKey > existingContactEvent.latestBookingDateParts.sortKey
      ) {
        existingContactEvent.latestBookingDateParts = bookingDateParts
      }

      contactEvents.set(contactEventKey, existingContactEvent)
    }
  }

  return {
    contacts,
    events,
    contactEvents,
    stats,
  }
}

async function upsertEvent(
  tx: postgres.Sql,
  event: EventAggregate,
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    with desired as (
      select
        ${event.name}::text as name,
        ${londonTimestamp(tx, event.eventDateParts)} as event_date
    ),
    existing as (
      select events.id
      from public.events as events
      join desired
        on public.normalize_event_name(events.name) = public.normalize_event_name(desired.name)
       and events.event_date = desired.event_date
      limit 1
    ),
    inserted as (
      insert into public.events (name, event_date)
      select name, event_date
      from desired
      where not exists (select 1 from existing)
      returning id
    )
    select id from inserted
    union all
    select id from existing
    limit 1
  `

  return row.id
}

async function upsertContact(
  tx: postgres.Sql,
  contact: StoredContact,
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into public.contacts (
      email,
      first_name,
      last_name,
      phone,
      street,
      postcode,
      city,
      country,
      country_code,
      last_imported_at
    )
    values (
      ${contact.email},
      ${contact.first_name},
      ${contact.last_name},
      ${contact.phone},
      ${contact.street},
      ${contact.postcode},
      ${contact.city},
      ${contact.country},
      ${contact.country_code},
      ${importStartedAt}
    )
    on conflict (email) do update
    set
      first_name = coalesce(excluded.first_name, public.contacts.first_name),
      last_name = coalesce(excluded.last_name, public.contacts.last_name),
      phone = coalesce(excluded.phone, public.contacts.phone),
      street = coalesce(excluded.street, public.contacts.street),
      postcode = coalesce(excluded.postcode, public.contacts.postcode),
      city = coalesce(excluded.city, public.contacts.city),
      country = coalesce(excluded.country, public.contacts.country),
      country_code = coalesce(excluded.country_code, public.contacts.country_code),
      last_imported_at = excluded.last_imported_at
    returning id
  `

  return row.id
}

async function upsertContactEvent(
  tx: postgres.Sql,
  contactEvent: ContactEventAggregate,
  contactId: string,
  eventId: string,
): Promise<void> {
  await tx`
    insert into public.contact_events (
      contact_id,
      event_id,
      ticket_count,
      latest_booking_date
    )
    values (
      ${contactId},
      ${eventId},
      ${contactEvent.ticketBarcodes.size},
      ${londonTimestamp(tx, contactEvent.latestBookingDateParts)}
    )
    on conflict (contact_id, event_id) do update
    set
      ticket_count = excluded.ticket_count,
      latest_booking_date = case
        when public.contact_events.latest_booking_date is null then excluded.latest_booking_date
        when excluded.latest_booking_date is null then public.contact_events.latest_booking_date
        else greatest(public.contact_events.latest_booking_date, excluded.latest_booking_date)
      end
  `
}

function printSummary(result: ImportResult): void {
  console.log(`CSV files: ${result.stats.files}`)
  console.log(`Rows parsed: ${result.stats.rows}`)
  console.log(`Rows importable: ${result.stats.importedRows}`)
  console.log(`Skipped missing email: ${result.stats.skippedMissingEmail}`)
  console.log(`Skipped invalid status: ${result.stats.skippedInvalidStatus}`)
  console.log(`Skipped missing event: ${result.stats.skippedMissingEvent}`)
  console.log(`Skipped invalid dates: ${result.stats.skippedInvalidDates}`)
  console.log(`Unique contacts: ${result.contacts.size}`)
  console.log(`Unique events: ${result.events.size}`)
  console.log(`Unique contact-events: ${result.contactEvents.size}`)
}

function logProgress(
  label: string,
  completed: number,
  total: number,
  step: number,
): void {
  if (completed === 0 || completed === total || completed % step === 0) {
    console.log(`${label}: ${completed}/${total}`)
  }
}

async function main(): Promise<void> {
  const csvPaths = await resolveCsvPaths(inputPath)

  if (csvPaths.length === 0) {
    throw new Error(`No CSV files found at ${inputPath}`)
  }

  console.log(`Import source: ${inputPath}`)
  console.log(`CSV files found: ${csvPaths.length}`)
  console.log(`Mode: ${dryRun ? "dry-run" : "write"}`)

  const result = await collectImportData(csvPaths)
  printSummary(result)

  if (dryRun) {
    console.log("Dry run complete. No database changes were made.")
    return
  }

  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (!databaseUrl) {
    throw new Error("Missing DATABASE_URL. Set it in .env before running db:import.")
  }

  console.log("Connecting to database...")

  const sql = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 10,
  })

  try {
    await sql.begin(async (tx) => {
      const txSql = tx as unknown as postgres.Sql
      console.log("Connected. Upserting events...")
      const eventIdByKey = new Map<string, string>()
      let eventsProcessed = 0
      for (const event of result.events.values()) {
        eventIdByKey.set(event.key, await upsertEvent(txSql, event))
        eventsProcessed += 1
        logProgress("Events", eventsProcessed, result.events.size, 10)
      }

      console.log("Upserting contacts...")
      const contactIdByEmail = new Map<string, string>()
      let contactsProcessed = 0
      for (const contact of result.contacts.values()) {
        contactIdByEmail.set(contact.email, await upsertContact(txSql, contact))
        contactsProcessed += 1
        logProgress("Contacts", contactsProcessed, result.contacts.size, 100)
      }

      console.log("Upserting contact-events...")
      let contactEventsProcessed = 0
      for (const contactEvent of result.contactEvents.values()) {
        const contactId = contactIdByEmail.get(contactEvent.contactEmail)
        const eventId = eventIdByKey.get(contactEvent.eventKey)

        if (!contactId || !eventId) {
          throw new Error(
            `Missing foreign keys for ${contactEvent.contactEmail} / ${contactEvent.eventKey}`,
          )
        }

        await upsertContactEvent(txSql, contactEvent, contactId, eventId)
        contactEventsProcessed += 1
        logProgress(
          "Contact-events",
          contactEventsProcessed,
          result.contactEvents.size,
          100,
        )
      }
    })
  } finally {
    await sql.end({ timeout: 5 })
  }

  console.log("Database import complete.")
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})

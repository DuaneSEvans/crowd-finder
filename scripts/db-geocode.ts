import postgres from "postgres"

type ContactToGeocode = {
  id: string
  email: string
  street: string | null
  postcode: string | null
  city: string | null
  country: string | null
  country_code: string | null
}

type AddressGroup = {
  query: string
  contacts: ContactToGeocode[]
}

type GeoapifyFeature = {
  properties?: {
    formatted?: string
  }
  geometry?: {
    coordinates?: [number, number]
  }
}

type GeoapifyResponse = {
  features?: GeoapifyFeature[]
}

const requestDelayMs = 500
const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--")
let dryRun = true

for (const arg of rawArgs) {
  if (arg === "--write") {
    dryRun = false
    continue
  }

  console.error(`Unknown argument: ${arg}`)
  console.error("Usage: bun run db:geocode [--write]")
  process.exit(1)
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function cleanValue(value: string | null): string | null {
  if (!value) {
    return null
  }

  const normalized = normalizeWhitespace(value)
  return normalized.length > 0 ? normalized : null
}

function buildAddressQuery(contact: ContactToGeocode): string | null {
  const street = cleanValue(contact.street)
  const postcode = cleanValue(contact.postcode)
  const city = cleanValue(contact.city)
  const country = cleanValue(contact.country) ?? cleanValue(contact.country_code)
  const localityParts = [street, postcode, city].filter(
    (value): value is string => Boolean(value),
  )

  if (localityParts.length < 2) {
    return null
  }

  const addressParts = [street, city, postcode, country].filter(
    (value): value is string => Boolean(value),
  )

  return addressParts.length >= 2 ? addressParts.join(", ") : null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function fetchGeocode(
  apiKey: string,
  query: string,
): Promise<{ lat: number; lng: number; formatted: string | null } | null> {
  const searchParams = new URLSearchParams({
    text: query,
    apiKey,
  })

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(
      `https://api.geoapify.com/v1/geocode/search?${searchParams.toString()}`,
    )

    if (!response.ok) {
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        await sleep(1000 * attempt)
        continue
      }

      throw new Error(`Geoapify request failed with ${response.status}`)
    }

    const data = (await response.json()) as GeoapifyResponse
    const feature = data.features?.[0]
    const coordinates = feature?.geometry?.coordinates

    if (!coordinates || coordinates.length < 2) {
      return null
    }

    const [lng, lat] = coordinates

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return null
    }

    return {
      lat,
      lng,
      formatted: feature?.properties?.formatted ?? null,
    }
  }

  return null
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (!databaseUrl) {
    throw new Error("Missing DATABASE_URL. Set it in .env before running db:geocode.")
  }

  const apiKey = process.env.GEOAPIFY_API_KEY?.trim() ?? ""
  if (!dryRun && !apiKey) {
    throw new Error("Missing GEOAPIFY_API_KEY. Set it in .env before running with --write.")
  }

  console.log(`Mode: ${dryRun ? "dry-run" : "write"}`)
  console.log("Connecting to database...")

  const sql = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 10,
  })

  try {
    const contacts = await sql<ContactToGeocode[]>`
      select
        id,
        email,
        street,
        postcode,
        city,
        country,
        country_code
      from public.contacts
      where lat is null or lng is null
      order by last_imported_at nulls last, created_at, id
    `

    console.log(`Contacts missing coordinates: ${contacts.length}`)

    const addressGroups = new Map<string, AddressGroup>()
    let skippedMissingAddress = 0

    for (const contact of contacts) {
      const query = buildAddressQuery(contact)
      if (!query) {
        skippedMissingAddress += 1
        continue
      }

      const existingGroup = addressGroups.get(query) ?? {
        query,
        contacts: [],
      }

      existingGroup.contacts.push(contact)
      addressGroups.set(query, existingGroup)
    }

    console.log(`Geocodable contacts: ${contacts.length - skippedMissingAddress}`)
    console.log(`Unique address lookups: ${addressGroups.size}`)
    console.log(`Skipped missing usable address: ${skippedMissingAddress}`)

    if (dryRun) {
      const preview = Array.from(addressGroups.keys()).slice(0, 5)

      if (preview.length > 0) {
        console.log("Sample address lookups:")
        preview.forEach((address, index) => {
          console.log(`${index + 1}. ${address}`)
        })
      }

      console.log("Dry run complete. No API requests were made and no database changes were written.")
      return
    }

    let processedAddresses = 0
    let updatedContacts = 0
    let failedLookups = 0
    let emptyResults = 0

    for (const group of addressGroups.values()) {
      processedAddresses += 1
      console.log(`Geocoding ${processedAddresses}/${addressGroups.size}: ${group.query}`)

      try {
        const result = await fetchGeocode(apiKey, group.query)

        if (!result) {
          emptyResults += 1
          console.log("  No result")
        } else {
          console.log(
            `  -> ${result.lat}, ${result.lng}${result.formatted ? ` (${result.formatted})` : ""}`,
          )

          for (const contact of group.contacts) {
            await sql`
              update public.contacts
              set lat = ${result.lat}, lng = ${result.lng}
              where id = ${contact.id}
            `
            updatedContacts += 1
          }
        }
      } catch (error) {
        failedLookups += 1
        console.log(
          `  Error: ${error instanceof Error ? error.message : String(error)}`,
        )
      }

      if (processedAddresses < addressGroups.size) {
        await sleep(requestDelayMs)
      }
    }

    console.log(`Address lookups attempted: ${processedAddresses}`)
    console.log(`Contacts updated: ${updatedContacts}`)
    console.log(`No-result lookups: ${emptyResults}`)
    console.log(`Failed lookups: ${failedLookups}`)
    console.log("Geocoding complete.")
  } finally {
    await sql.end({ timeout: 5 })
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})

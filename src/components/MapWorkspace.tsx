/// <reference types="google.maps" />
import { useEffect, useMemo, useRef, useState } from "react"
import { importLibrary, setOptions } from "@googlemaps/js-api-loader"
import styles from "../App.module.css"
import type { Tables } from "../lib/database.types"
import { supabase } from "../lib/supabase"

type LatLngLiteral = google.maps.LatLngLiteral
type ContactMapRow = Pick<
  Tables<"contacts">,
  | "id"
  | "email"
  | "first_name"
  | "last_name"
  | "street"
  | "postcode"
  | "city"
  | "country"
  | "lat"
  | "lng"
>

type Customer = {
  id: string
  name: string
  email: string
  address: string
  location: LatLngLiteral
}

const GOOGLE_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as
  | string
  | undefined

const MAP_LIBRARIES: Array<"geometry" | "marker"> = ["geometry", "marker"]
const DEFAULT_CENTER: LatLngLiteral = { lat: 55.953251, lng: -3.188267 }
const EMPTY_CUSTOMERS: Customer[] = []

let mapsOptionsSet = false

function isSameLatLng(a: LatLngLiteral, b: LatLngLiteral) {
  return Math.abs(a.lat - b.lat) < 1e-6 && Math.abs(a.lng - b.lng) < 1e-6
}

function escapeCsvValue(value: string | number) {
  const serialized = String(value)
  if (/[",\n]/.test(serialized)) {
    return `"${serialized.replaceAll('"', '""')}"`
  }
  return serialized
}

function createCustomerCsv(customers: Customer[]) {
  const headers = ["name", "email", "address", "lat", "lng"]
  const lines = customers.map((customer) => {
    return [
      customer.name,
      customer.email,
      customer.address,
      customer.location.lat,
      customer.location.lng,
    ]
      .map(escapeCsvValue)
      .join(",")
  })

  return [headers.join(","), ...lines].join("\n")
}

const MAP_STYLES = {
  height: "100%",
  width: "100%",
  borderRadius: "0",
}

function buildCustomerName(contact: ContactMapRow) {
  const fullName = [contact.first_name, contact.last_name]
    .filter((value): value is string => Boolean(value))
    .join(" ")

  return fullName || contact.email
}

function buildCustomerAddress(contact: ContactMapRow) {
  const address = [
    contact.street,
    contact.city,
    contact.postcode,
    contact.country,
  ]
    .filter((value): value is string => Boolean(value))
    .join(", ")

  return address || "No address on file"
}

function buildCustomer(contact: ContactMapRow): Customer | null {
  if (contact.lat === null || contact.lng === null) {
    return null
  }

  return {
    id: contact.id,
    name: buildCustomerName(contact),
    email: contact.email,
    address: buildCustomerAddress(contact),
    location: {
      lat: contact.lat,
      lng: contact.lng,
    },
  }
}

function MapWorkspace() {
  const missingApiKey = !GOOGLE_API_KEY
  const missingSupabase = !supabase
  const [customers, setCustomers] = useState<Customer[]>(EMPTY_CUSTOMERS)
  const [isLoadingCustomers, setIsLoadingCustomers] = useState(
    () => !missingSupabase,
  )
  const [totalContactsCount, setTotalContactsCount] = useState(0)
  const [mapsApi, setMapsApi] = useState<typeof google.maps | null>(null)
  const [error, setError] = useState<string | null>(
    missingApiKey
      ? "Missing VITE_GOOGLE_MAPS_API_KEY env var"
      : missingSupabase
        ? "Missing Supabase configuration."
        : null,
  )
  const [radiusMeters, setRadiusMeters] = useState(25000)
  const [circleCenter, setCircleCenter] = useState<LatLngLiteral>(DEFAULT_CENTER)
  const [isListOpen, setIsListOpen] = useState(false)
  const [panelPosition, setPanelPosition] = useState<{
    x: number
    y: number
  } | null>(null)
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const ghostButtonClassName = `${styles.button} ${styles.ghost}`

  const mapContainerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<google.maps.Map | null>(null)
  const markersRef = useRef<google.maps.Marker[]>([])
  const circleRef = useRef<google.maps.Circle | null>(null)
  const pendingCenterRef = useRef<LatLngLiteral | null>(null)
  const pendingRadiusRef = useRef<number | null>(null)
  const settleTimerRef = useRef<number | null>(null)
  const mapClickListenerRef = useRef<google.maps.MapsEventListener | null>(null)
  const circleListenersRef = useRef<Array<google.maps.MapsEventListener>>([])
  const infoWindowRef = useRef<google.maps.InfoWindow | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const dragOffsetRef = useRef<{ x: number; y: number } | null>(null)
  const dragRafRef = useRef<number | null>(null)
  const draggingRef = useRef(false)
  const toastTimerRef = useRef<number | null>(null)

  useEffect(() => {
    const client = supabase

    if (!client) {
      return
    }

    let isMounted = true

    const loadContacts = async () => {
      setIsLoadingCustomers(true)

      const [contactsResult, countResult] = await Promise.all([
        client
          .from("contacts")
          .select(
            "id, email, first_name, last_name, street, postcode, city, country, lat, lng",
          )
          .not("lat", "is", null)
          .not("lng", "is", null)
          .order("last_name", { ascending: true })
          .order("first_name", { ascending: true }),
        client.from("contacts").select("id", { count: "exact", head: true }),
      ])

      if (!isMounted) {
        return
      }

      if (contactsResult.error) {
        setError(`Failed to load contacts: ${contactsResult.error.message}`)
        setIsLoadingCustomers(false)
        return
      }

      if (countResult.error) {
        setError(`Failed to count contacts: ${countResult.error.message}`)
        setIsLoadingCustomers(false)
        return
      }

      const nextCustomers = (contactsResult.data ?? [])
        .map(buildCustomer)
        .filter((customer): customer is Customer => customer !== null)

      setCustomers(nextCustomers)
      setTotalContactsCount(countResult.count ?? nextCustomers.length)
      setIsLoadingCustomers(false)
    }

    void loadContacts()

    return () => {
      isMounted = false
    }
  }, [])

  useEffect(() => {
    if (!GOOGLE_API_KEY) return
    if (!mapsOptionsSet) {
      setOptions({
        key: GOOGLE_API_KEY,
        v: "weekly",
      })
      mapsOptionsSet = true
    }
    importLibrary("maps")
      .then(async () => {
        await Promise.all(MAP_LIBRARIES.map((library) => importLibrary(library)))
        setMapsApi(google.maps)
      })
      .catch((loadError: unknown) => {
        setError(`Failed to load Google Maps: ${String(loadError)}`)
      })
  }, [])

  useEffect(() => {
    if (!mapsApi || !mapContainerRef.current) return
    if (!mapRef.current) {
      mapRef.current = new mapsApi.Map(mapContainerRef.current, {
        center: DEFAULT_CENTER,
        zoom: 8,
        streetViewControl: false,
        mapTypeControl: false,
        fullscreenControl: false,
      })
      mapClickListenerRef.current = mapRef.current.addListener("click", () => {
        infoWindowRef.current?.close()
      })
    }
  }, [mapsApi])

  useEffect(() => {
    if (!mapRef.current || !mapsApi) return
    markersRef.current.forEach((marker) => {
      mapsApi.event.clearInstanceListeners(marker)
      marker.setMap(null)
    })
    markersRef.current = []
    infoWindowRef.current?.close()

    customers.forEach((customer) => {
      const marker = new mapsApi.Marker({
        position: customer.location,
        map: mapRef.current!,
        title: customer.name,
        zIndex: 1,
        icon: {
          path: mapsApi.SymbolPath.CIRCLE,
          scale: 4,
          fillColor: "#ef4444",
          fillOpacity: 1,
          strokeColor: "#991b1b",
          strokeWeight: 1,
        },
      })
      if (!infoWindowRef.current) {
        infoWindowRef.current = new mapsApi.InfoWindow()
      }
      marker.addListener("click", () => {
        infoWindowRef.current?.setContent(`
          <div class="${styles["info-window"]}">
            <div class="${styles["info-name"]}">${customer.name}</div>
            <div>${customer.email}</div>
            <div>${customer.address}</div>
          </div>
        `)
        infoWindowRef.current?.open({
          anchor: marker,
          map: mapRef.current!,
        })
      })
      markersRef.current.push(marker)
    })
  }, [customers, mapsApi])

  useEffect(() => {
    if (!mapsApi || !mapRef.current) return
    if (!circleRef.current) {
      circleRef.current = new mapsApi.Circle({
        map: mapRef.current,
        center: circleCenter,
        radius: radiusMeters,
        strokeColor: "#2563eb",
        fillColor: "#60a5fa",
        fillOpacity: 0.2,
        zIndex: 2,
        draggable: true,
        editable: true,
      })
      circleListenersRef.current.forEach((listener) => listener.remove())
      circleListenersRef.current = []
      const scheduleSettle = () => {
        if (settleTimerRef.current) {
          window.clearTimeout(settleTimerRef.current)
        }
        settleTimerRef.current = window.setTimeout(() => {
          if (
            pendingCenterRef.current &&
            !isSameLatLng(pendingCenterRef.current, circleCenter)
          ) {
            setCircleCenter(pendingCenterRef.current)
          }
          if (
            pendingRadiusRef.current &&
            Math.abs(pendingRadiusRef.current - radiusMeters) > 1
          ) {
            setRadiusMeters(pendingRadiusRef.current)
          }
          pendingCenterRef.current = null
          pendingRadiusRef.current = null
        }, 200)
      }

      circleListenersRef.current.push(
        circleRef.current.addListener("center_changed", () => {
          const center = circleRef.current?.getCenter()
          if (!center) return
          const nextCenter = center.toJSON()
          if (isSameLatLng(nextCenter, circleCenter)) return
          pendingCenterRef.current = nextCenter
          scheduleSettle()
        }),
      )
      circleListenersRef.current.push(
        circleRef.current.addListener("radius_changed", () => {
          const nextRadius = circleRef.current?.getRadius()
          if (!nextRadius) return
          pendingRadiusRef.current = nextRadius
          scheduleSettle()
        }),
      )
      circleListenersRef.current.push(
        circleRef.current.addListener("dragend", () => {
          if (settleTimerRef.current) {
            window.clearTimeout(settleTimerRef.current)
            settleTimerRef.current = null
          }
          if (
            pendingCenterRef.current &&
            !isSameLatLng(pendingCenterRef.current, circleCenter)
          ) {
            setCircleCenter(pendingCenterRef.current)
          }
          pendingCenterRef.current = null
        }),
      )
    } else {
      const currentCenter = circleRef.current.getCenter()?.toJSON()
      if (currentCenter && !isSameLatLng(currentCenter, circleCenter)) {
        circleRef.current.setCenter(circleCenter)
      }
      circleRef.current.setOptions({ zIndex: 2 })
      const currentRadius = circleRef.current.getRadius()
      if (Math.abs(currentRadius - radiusMeters) > 1) {
        circleRef.current.setRadius(radiusMeters)
      }
    }
  }, [circleCenter, mapsApi, radiusMeters])

  useEffect(() => {
    return () => {
      if (settleTimerRef.current) {
        window.clearTimeout(settleTimerRef.current)
        settleTimerRef.current = null
      }
      circleListenersRef.current.forEach((listener) => listener.remove())
      circleListenersRef.current = []
      if (circleRef.current && mapsApi) {
        mapsApi.event.clearInstanceListeners(circleRef.current)
        circleRef.current.setMap(null)
        circleRef.current = null
      }
      if (mapClickListenerRef.current) {
        mapClickListenerRef.current.remove()
        mapClickListenerRef.current = null
      }
      markersRef.current.forEach((marker) => {
        if (mapsApi) mapsApi.event.clearInstanceListeners(marker)
        marker.setMap(null)
      })
      markersRef.current = []
      infoWindowRef.current?.close()
      infoWindowRef.current = null
      if (mapRef.current && mapsApi) {
        mapsApi.event.clearInstanceListeners(mapRef.current)
        mapRef.current = null
      }
    }
  }, [mapsApi])

  const customersInRadius = useMemo(() => {
    if (!mapsApi) return []
    const centerLatLng = new mapsApi.LatLng(circleCenter)
    return customers.filter((customer) => {
      const distance = mapsApi.geometry.spherical.computeDistanceBetween(
        centerLatLng,
        new mapsApi.LatLng(customer.location),
      )
      return distance <= radiusMeters
    })
  }, [circleCenter, customers, mapsApi, radiusMeters])

  const handleExportCsv = () => {
    const csv = createCustomerCsv(customersInRadius)
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.setAttribute("download", "customers.csv")
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current)
    }
    setToastMessage("Exported CSV")
    toastTimerRef.current = window.setTimeout(() => {
      setToastMessage(null)
    }, 2000)
  }

  const handleCopyEmails = async () => {
    const emails = customersInRadius.map((customer) => customer.email).join(", ")
    await navigator.clipboard.writeText(emails)
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current)
    }
    setToastMessage("Copied emails")
    toastTimerRef.current = window.setTimeout(() => {
      setToastMessage(null)
    }, 2000)
  }

  useEffect(() => {
    const handleMove = (event: PointerEvent) => {
      if (!draggingRef.current || !dragOffsetRef.current || !panelRef.current) {
        return
      }
      const { x: offsetX, y: offsetY } = dragOffsetRef.current
      const panel = panelRef.current
      const padding = 8
      const width = panel.offsetWidth
      const height = panel.offsetHeight
      let x = event.clientX - offsetX
      let y = event.clientY - offsetY
      x = Math.min(window.innerWidth - width - padding, Math.max(padding, x))
      y = Math.min(window.innerHeight - height - padding, Math.max(padding, y))
      if (dragRafRef.current) {
        cancelAnimationFrame(dragRafRef.current)
      }
      dragRafRef.current = requestAnimationFrame(() => {
        setPanelPosition({ x, y })
        dragRafRef.current = null
      })
    }

    const handleUp = () => {
      draggingRef.current = false
      dragOffsetRef.current = null
      if (dragRafRef.current) {
        cancelAnimationFrame(dragRafRef.current)
        dragRafRef.current = null
      }
    }

    window.addEventListener("pointermove", handleMove)
    window.addEventListener("pointerup", handleUp)
    return () => {
      window.removeEventListener("pointermove", handleMove)
      window.removeEventListener("pointerup", handleUp)
    }
  }, [])

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current)
      }
    }
  }, [])

  return (
    <div className={styles["workspace-shell"]}>
      <section className={styles["map-card"]}>
        <div ref={mapContainerRef} style={MAP_STYLES} />
      </section>
      {toastMessage ? <div className={styles.toast}>{toastMessage}</div> : null}
      <div className={styles.overlay}>
        {error ? <div className={styles.error}>{error}</div> : null}
        <main className={styles.layout}>
          <section
            className={styles["side-panel"]}
            ref={panelRef}
            onPointerDown={(event) => {
              if (!panelRef.current) return
              const target = event.target as HTMLElement | null
              if (target?.closest("button")) return

              const rect = panelRef.current.getBoundingClientRect()
              dragOffsetRef.current = {
                x: event.clientX - rect.left,
                y: event.clientY - rect.top,
              }
              draggingRef.current = true
              setPanelPosition({ x: rect.left, y: rect.top })
            }}
            style={
              panelPosition
                ? {
                    left: `${panelPosition.x}px`,
                    top: `${panelPosition.y}px`,
                    right: "auto",
                  }
                : undefined
            }
          >
            <div className={styles.stack}>
              <div className={styles.row}>
                <div>
                  <div className={styles.label}>
                    Selected: {customersInRadius.length}
                  </div>
                  <div className={styles["panel-caption"]}>
                    {customers.length} plotted contact
                    {customers.length === 1 ? "" : "s"}
                    {totalContactsCount > customers.length
                      ? ` • ${totalContactsCount - customers.length} still need geocoding`
                      : ""}
                  </div>
                </div>
                <div className={styles["panel-actions"]}>
                  <button
                    className={styles["list-toggle"]}
                    onClick={() => setIsListOpen((prev) => !prev)}
                    aria-label={isListOpen ? "Collapse list" : "Expand list"}
                  >
                    {isListOpen ? "^" : "v"}
                  </button>
                </div>
              </div>
              <div className={styles["chip-row"]}>
                <button
                  className={ghostButtonClassName}
                  onClick={() => {
                    void handleCopyEmails()
                  }}
                  disabled={!customersInRadius.length}
                >
                  Copy emails
                </button>
                <button
                  className={ghostButtonClassName}
                  onClick={handleExportCsv}
                  disabled={!customersInRadius.length}
                >
                  Export CSV
                </button>
              </div>
              {isListOpen ? (
                <div className={styles.list}>
                  {customersInRadius.map((customer) => (
                    <div key={customer.id} className={styles["list-item"]}>
                      <div className={styles["list-title"]}>{customer.name}</div>
                      <div className={styles["list-sub"]}>{customer.email}</div>
                      <div className={styles["list-sub"]}>{customer.address}</div>
                    </div>
                  ))}
                  {isLoadingCustomers ? (
                    <div className={styles.muted}>Loading contacts…</div>
                  ) : !customersInRadius.length ? (
                    <div className={styles.muted}>
                      {customers.length
                        ? "No plotted contacts fall within the current radius."
                        : totalContactsCount
                          ? "Contacts are loaded, but none have geocodes yet."
                          : "No contacts are in the database yet."}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </section>
        </main>
      </div>
    </div>
  )
}

export default MapWorkspace

import { startTransition, useEffect, useState } from "react"
import type { FormEvent } from "react"
import type { Session } from "@supabase/supabase-js"
import MapWorkspace from "./components/MapWorkspace"
import { supabase, supabaseConfigError } from "./lib/supabase"
import styles from "./App.module.css"

const LOGIN_ROUTE = "/login"
const MAP_ROUTE = "/map"

type AuthStatus = "checking" | "signed-out" | "signed-in"

function replaceRoute(nextRoute: string) {
  if (window.location.pathname !== nextRoute) {
    window.history.replaceState({}, "", nextRoute)
  }
}

function formatAuthError(message: string) {
  if (message.toLowerCase().includes("user not found")) {
    return "This email does not have access yet."
  }

  return message
}

function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatus>(() => {
    return supabase ? "checking" : "signed-out"
  })
  const [session, setSession] = useState<Session | null>(null)
  const [email, setEmail] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [authMessage, setAuthMessage] = useState<string | null>(null)
  const [authError, setAuthError] = useState<string | null>(supabaseConfigError)

  useEffect(() => {
    if (!supabase) {
      replaceRoute(LOGIN_ROUTE)
      return
    }

    let isMounted = true

    void supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (!isMounted) return

        startTransition(() => {
          if (error) {
            setAuthError(error.message)
          }

          const nextSession = data.session ?? null
          setSession(nextSession)
          setAuthStatus(nextSession ? "signed-in" : "signed-out")
          replaceRoute(nextSession ? MAP_ROUTE : LOGIN_ROUTE)
        })
      })
      .catch((error: unknown) => {
        if (!isMounted) return

        startTransition(() => {
          setAuthStatus("signed-out")
          setAuthError(`Unable to restore session: ${String(error)}`)
          replaceRoute(LOGIN_ROUTE)
        })
      })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!isMounted) return

      startTransition(() => {
        setSession(nextSession)
        setAuthStatus(nextSession ? "signed-in" : "signed-out")

        if (event === "SIGNED_IN") {
          setAuthError(null)
          setAuthMessage("Magic link confirmed. You're in.")
          replaceRoute(MAP_ROUTE)
          return
        }

        if (event === "SIGNED_OUT") {
          setAuthMessage(null)
          setAuthError(null)
          replaceRoute(LOGIN_ROUTE)
          return
        }

        replaceRoute(nextSession ? MAP_ROUTE : LOGIN_ROUTE)
      })
    })

    return () => {
      isMounted = false
      subscription.unsubscribe()
    }
  }, [])

  const handleMagicLinkSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!supabase) {
      setAuthError(supabaseConfigError)
      return
    }

    setIsSubmitting(true)
    setAuthError(null)
    setAuthMessage(null)

    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        shouldCreateUser: false,
        emailRedirectTo: window.location.origin,
      },
    })

    if (error) {
      setAuthError(formatAuthError(error.message))
      setIsSubmitting(false)
      return
    }

    setAuthMessage(
      "Magic link sent. Open it in this browser to finish signing in.",
    )
    setIsSubmitting(false)
  }

  const handleSignOut = async () => {
    if (!supabase) return

    const { error } = await supabase.auth.signOut()
    if (error) {
      setAuthError(error.message)
    }
  }

  if (authStatus === "checking") {
    return (
      <div className={styles.app}>
        <section className={styles["auth-shell"]}>
          <div className={styles["auth-card"]}>
            <div className={styles["status-pill"]}>Checking session…</div>
          </div>
        </section>
      </div>
    )
  }

  if (!session) {
    return (
      <div className={styles.app}>
        <section className={styles["auth-shell"]}>
          <div className={styles["auth-card"]}>
            <form
              className={styles["auth-form"]}
              onSubmit={handleMagicLinkSubmit}
            >
              <label className={styles.stack}>
                <span className={styles.label}>Email address</span>
                <input
                  type="email"
                  autoComplete="email"
                  className={styles.input}
                  value={email}
                  onChange={(inputEvent) => setEmail(inputEvent.target.value)}
                  disabled={isSubmitting || Boolean(supabaseConfigError)}
                />
              </label>

              <button
                className={styles.button}
                type="submit"
                disabled={
                  isSubmitting ||
                  Boolean(supabaseConfigError) ||
                  email.trim().length === 0
                }
              >
                {isSubmitting ? "Sending link…" : "Email magic link"}
              </button>
            </form>

            {authError ? <div className={styles.error}>{authError}</div> : null}
            {authMessage ? (
              <div className={styles.info}>{authMessage}</div>
            ) : null}
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className={styles.app}>
      <button
        className={`${styles.button} ${styles.ghost} ${styles["floating-signout"]}`}
        type="button"
        onClick={() => {
          void handleSignOut()
        }}
      >
        Sign out
      </button>

      <MapWorkspace />
    </div>
  )
}

export default App

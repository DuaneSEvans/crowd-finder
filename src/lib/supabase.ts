import { createClient } from "@supabase/supabase-js"
import type { Database } from "./database.types"

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim()
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim()

export const supabaseConfigError = !supabaseUrl
  ? "Missing VITE_SUPABASE_URL env var."
  : !supabaseAnonKey
    ? "Missing VITE_SUPABASE_ANON_KEY env var."
    : null

export const supabase = supabaseConfigError
  ? null
  : createClient<Database>(supabaseUrl, supabaseAnonKey, {
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: true,
        persistSession: true,
        flowType: "pkce",
      },
    })

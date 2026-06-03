"use client";

/**
 * CurrentUserProvider
 *
 * Fetches /api/me exactly ONCE per dashboard session and shares the result
 * through React context. Every component that previously issued its own
 * fetch("/api/me") — sidebar, header, approval-bell, in-app-notification-bell,
 * and all dashboard pages — now reads from this context instead, eliminating
 * 3–5 redundant round-trips per page navigation.
 *
 * Usage:
 *   const { user, loading } = useCurrentUser();
 *   user.role, user.full_name, user.email, user.phone, user.id
 */

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export interface CurrentUser {
  /** DB users.id — needed for realtime subscriptions (in-app-notification-bell) */
  id: string | null;
  role: string | null;
  full_name: string;
  email: string;
  phone: string;
}

interface CurrentUserContextValue {
  user: CurrentUser | null;
  /** true while the initial /api/me fetch is in-flight */
  loading: boolean;
}

const DEFAULT_USER: CurrentUser = {
  id: null,
  role: null,
  full_name: "",
  email: "",
  phone: "",
};

const CurrentUserContext = createContext<CurrentUserContextValue>({
  user: null,
  loading: true,
});

export function CurrentUserProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/me")
      .then((r) => r.json())
      .then((data) => {
        setUser({
          id: data.id ?? null,
          role: data.role ?? null,
          full_name: data.full_name ?? "",
          email: data.email ?? "",
          phone: data.phone ?? "",
        });
      })
      .catch(() => setUser(DEFAULT_USER))
      .finally(() => setLoading(false));
  }, []);

  return (
    <CurrentUserContext.Provider value={{ user, loading }}>
      {children}
    </CurrentUserContext.Provider>
  );
}

export function useCurrentUser(): CurrentUserContextValue {
  return useContext(CurrentUserContext);
}
